import Fuse from 'fuse.js';
import PTT from './util/parse-torrent-title.js';
import axios from 'axios';
import Cinemeta from './util/cinemeta.js';
import * as config from './config.js';
import * as scrapers from './common/scrapers.js';
import * as torrentUtils from './common/torrent-utils.js';
import { processAndFilterTorrents } from './common/debrid-cache-processor.js';
import { buildSeriesContext, matchesCandidateTitle } from './util/episodeMatcher.js';
import { getCachedHashes as sqliteGetCachedHashes, upsertCachedMagnet as sqliteUpsert, getCachedScraperResults, default as sqliteCache } from './util/cache-store.js';
import { obfuscateSensitive } from './common/torrent-utils.js';
import searchCoordinator from './util/search-coordinator.js';
import { orchestrateScrapers } from './util/scraper-selector.js';
import * as debridHelpers from './util/debrid-helpers.js';
import debridProxyManager from './util/debrid-proxy.js';

const { isValidVideo, getHashFromMagnet, createEncodedUrl, delay, filterByYear } = torrentUtils;
const LOG_PREFIX = 'OC';
const OFFCLOUD_API_URL = 'https://offcloud.com/api';

// ===================================================================================
// --- OFFCLOUD API CLIENT (Using Bearer Token Authentication) ---
// ===================================================================================
/**
 * Creates an Offcloud API client with Bearer token authentication.
 * This replaces the deprecated offcloud-api npm package.
 * @param {string} apiKey - The Offcloud API key
 * @returns {Object} API client with cloud methods
 */
function createOffcloudClient(apiKey) {
    const axiosInstance = axios.create({
        ...debridProxyManager.getAxiosConfig('offcloud'),
        baseURL: OFFCLOUD_API_URL,
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        }
    });

    return {
        cloud: {
            /**
             * Get cloud download history
             * GET /api/cloud/history
             */
            history: async () => {
                const response = await axiosInstance.get('/cloud/history');
                return response.data;
            },
            /**
             * Explore files in a multi-file torrent
             * GET /api/cloud/explore/{requestId}
             */
            explore: async (requestId) => {
                const response = await axiosInstance.get(`/cloud/explore/${requestId}`);
                return response.data;
            },
            /**
             * Add URL for cloud downloading
             * POST /api/cloud
             */
            download: async (url) => {
                const response = await axiosInstance.post('/cloud', { url });
                return response.data;
            },
            /**
             * Check status of a cloud download
             * POST /api/cloud/status
             */
            status: async (requestId) => {
                const response = await axiosInstance.post('/cloud/status', { requestId });
                return response.data;
            }
        },
        cache: {
            /**
             * Check if hashes are cached (legacy endpoint)
             * POST /api/cache
             */
            check: async (hashes) => {
                const response = await axiosInstance.post('/cache', { hashes });
                return response.data;
            },
            /**
             * Check cache status for URLs with optional file listings (new endpoint)
             * POST /api/cache/info
             */
            info: async (urls, includeFiles = false) => {
                const response = await axiosInstance.post('/cache/info', { urls, includeFiles });
                return response.data;
            },
            /**
             * Get download URLs for cached torrent files (new endpoint)
             * POST /api/cache/download
             */
            download: async (url) => {
                const response = await axiosInstance.post('/cache/download', { url });
                return response.data;
            }
        },
        account: {
            /**
             * Get account information
             * GET /api/account/info
             */
            info: async () => {
                const response = await axiosInstance.get('/account/info');
                return response.data;
            }
        }
    };
}

// Use debrid-helpers functions
const norm = debridHelpers.norm;
const getQualityCategory = debridHelpers.getQualityCategory;
const addHashToSqlite = (hash, fileName = null, size = null, data = null) => debridHelpers.addHashToSqlite(hash, fileName, size, data, 'offcloud');
const deferSqliteUpserts = debridHelpers.deferSqliteUpserts;
const uniqueUpserts = debridHelpers.uniqueUpserts;

// Helper to get axios with proxy config
const axiosWithProxy = axios.create(debridProxyManager.getAxiosConfig('offcloud'));
const RESOLVE_CACHE_TTL_MS = parseInt(process.env.OFFCLOUD_RESOLVE_TTL_MS || '600000', 10); // 10m success cache
const RESOLVE_FAIL_TTL_MS = parseInt(process.env.OFFCLOUD_RESOLVE_FAIL_TTL_MS || '120000', 10); // 2m failure backoff
const resolveCache = new Map();
const resolveFailCache = new Map();
const resolveInFlight = new Map();
const pendingAddToOffcloud = new Map(); // prevent duplicate add attempts per magnet

const getResolveKey = (url) => {
    const hash = getHashFromMagnet(url);
    if (hash) return hash.toLowerCase();
    return url;
};

function getCachedResolve(key) {
    const cached = resolveCache.get(key);
    if (cached && (Date.now() - cached.ts) < RESOLVE_CACHE_TTL_MS) {
        return cached.url;
    }
    if (cached) resolveCache.delete(key);

    const failTs = resolveFailCache.get(key);
    if (failTs && (Date.now() - failTs) < RESOLVE_FAIL_TTL_MS) {
        return null; // Recent failure - short-circuit
    }
    if (failTs) resolveFailCache.delete(key);
    return undefined; // explicit miss
}

function storeResolveResult(key, url) {
    if (url) {
        resolveCache.set(key, { url, ts: Date.now() });
    } else {
        resolveFailCache.set(key, Date.now());
    }
}

// ===================================================================================
// --- 1. CORE SEARCH ORCHESTRATOR ---
// ===================================================================================
async function searchOffcloudTorrents(apiKey, type, id, userConfig = {}) {
    const imdbId = id.split(':')[0];
    const [season, episode] = id.split(':').slice(1);
    const cinemetaDetails = await Cinemeta.getMeta(type, imdbId);

    if (!cinemetaDetails) { return []; }

    const searchKey = cinemetaDetails.name;
    const alternateTitles = cinemetaDetails.alternateTitles || [];
    const allSearchKeys = [searchKey, ...alternateTitles].filter(Boolean);
    const selectedLanguages = Array.isArray(userConfig.Languages) ? userConfig.Languages : [];
    const baseKey = type === 'series'
        ? `${searchKey} s${String(season).padStart(2, '0')}e${String(episode).padStart(2, '0')}`
        : `${searchKey} ${cinemetaDetails.year || ''}`.trim();

    const specificSearchKey = type === 'series'
        ? `${searchKey} s${String(season).padStart(2, '0')}e${String(episode).padStart(2, '0')}`
        : `${searchKey} ${cinemetaDetails.year || ''}`.trim();
    
    let episodeInfo = null;
    if (type === 'series' && season && episode) {
        episodeInfo = {
            season: parseInt(season, 10),
            episode: parseInt(episode, 10)
        };
    }
    const seriesCtx = type === 'series' ? buildSeriesContext({ search: specificSearchKey, cinemetaTitle: cinemetaDetails.name }) : null;
    const seriesCtxShort = (() => {
        if (type !== 'series') return null;
        const fullTitle = String(cinemetaDetails.name || '').trim();
        if (!fullTitle.includes(':')) return null;
        const shortTitle = fullTitle.split(':')[0].trim();
        if (!shortTitle || shortTitle === fullTitle) return null;
        return buildSeriesContext({ search: specificSearchKey, cinemetaTitle: shortTitle });
    })();
    const matchesSeriesCandidate = (t) => {
        if (!seriesCtx) return true;
        if (matchesCandidateTitle(t, seriesCtx)) return true;
        if (seriesCtxShort && matchesCandidateTitle(t, seriesCtxShort)) return true;
        return false;
    };

    console.log(`[${LOG_PREFIX}] Starting unified search for: "${specificSearchKey}" (and ${alternateTitles.length} alternate titles)`);

    // Create abort controller with 30s timeout to prevent runaway requests
    const SEARCH_TIMEOUT_MS = parseInt(process.env.SEARCH_TIMEOUT_MS || '30000', 10);
    const { signal, cleanup: cleanupAbort } = debridHelpers.createAbortControllerWithTimeout(SEARCH_TIMEOUT_MS, 'OC');
    const searchTimerId = `[${LOG_PREFIX}] Total search time`;

    try {
        console.time(searchTimerId);
        // Execute coordinated scrapers AND cached results lookup IN PARALLEL
        const scraperPromise = searchCoordinator.executeSearch(
            'offcloud',
            async () => {
                return await orchestrateScrapers({
                    type,
                    imdbId,
                    searchKey,
                    baseSearchKey: baseKey,
                    season,
                    episode,
                    signal,
                    logPrefix: LOG_PREFIX,
                    userConfig,
                    selectedLanguages
                });
            },
            type,
            id,
            userConfig
        );

        // Check cached scraper results in parallel
        const cachedScraperResultsPromise = (async () => {
            try {
                const cached = await getCachedScraperResults(type, imdbId, season, episode);
                if (cached.length > 0) {
                    console.log(`[${LOG_PREFIX}] Found ${cached.length} cached scraper results for ${type}:${imdbId}`);
                }
                return cached;
            } catch (err) {
                console.error(`[${LOG_PREFIX}] Error fetching cached scraper results:`, err.message);
                return [];
            }
        })();

        // Only fetch personal files if enablePersonalCloud is not explicitly disabled
        const personalFilesPromise = userConfig.enablePersonalCloud !== false
            ? searchPersonalFiles(apiKey, allSearchKeys, specificSearchKey, type, season, episode)
            : Promise.resolve([]);

        if (userConfig.enablePersonalCloud === false) {
            console.log(`[${LOG_PREFIX}] Personal cloud disabled for this service, skipping personal files`);
        }

        let [scraperResults, cachedScraperResults, personalFiles] = await Promise.all([
            scraperPromise,
            cachedScraperResultsPromise,
            personalFilesPromise
        ]);

        // Combine live and cached scraper results
        scraperResults = [...scraperResults, cachedScraperResults];
        if (seriesCtx) {
            scraperResults = scraperResults.map(list => list.filter(t => matchesSeriesCandidate(t)));
            const s = seriesCtx.season, e = seriesCtx.episode;
            if (Number.isFinite(s) && Number.isFinite(e)) {
                scraperResults = scraperResults.map(list => list.filter(t => {
                    try {
                        const p = PTT.parse(t.Title || t.name || '');
                        if (p && p.season != null && p.episode != null) {
                            return Number(p.season) === Number(s) && Number(p.episode) === Number(e);
                        }
                        if (p && p.season != null && (p.episode === undefined || Array.isArray(p.episode))) {
                            return Number(p.season) === Number(s);
                        }
                    } catch {}
                    return matchesSeriesCandidate(t);
                }));
            }
        }
        try { console.timeEnd(searchTimerId); } catch {}

        let combinedResults = await combineAndMarkResults(apiKey, personalFiles, scraperResults, episodeInfo);

        const bypassStreams = combinedResults.filter(stream => stream.bypassFiltering === true);

        if (type === 'movie') {
            let filtered = combinedResults;
            if (cinemetaDetails.year) {
                const originalCount = filtered.length;
                filtered = filtered.filter(torrent => filterByYear(torrent, cinemetaDetails, LOG_PREFIX));
                console.log(`[${LOG_PREFIX}] Filtered by year (${cinemetaDetails.year}). Removed ${originalCount - filtered.length} mismatched results.`);
            }
            // Apply title matching to filter out unrelated movies
            if (cinemetaDetails.name) {
                const beforeTitleFilter = filtered.length;
                const normalizeTitle = (s) => String(s || '').toLowerCase().replace(/[''`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
                const expectedTitle = normalizeTitle(cinemetaDetails.name);
                filtered = filtered.filter(torrent => {
                    try {
                        const title = torrent.Title || torrent.name || '';
                        const normalizedFullTitle = normalizeTitle(title);
                        const expectedWords = expectedTitle.split(/\s+/).filter(w => w.length > 2);
                        const wordsToMatch = expectedWords.length > 0 ? expectedWords : expectedTitle.split(/\s+/).filter(w => w.length > 0);
                        const matchingWords = wordsToMatch.filter(word => normalizedFullTitle.includes(word));
                        const requiredMatches = wordsToMatch.length <= 2 ? wordsToMatch.length : Math.ceil(wordsToMatch.length * 0.5);
                        return matchingWords.length >= requiredMatches;
                    } catch {
                        return true;
                    }
                });
                if (beforeTitleFilter !== filtered.length) {
                    console.log(`[${LOG_PREFIX}] Filtered by title matching "${cinemetaDetails.name}". Removed ${beforeTitleFilter - filtered.length} unrelated results.`);
                }
            }
            return filtered;
        }

        console.log(`[${LOG_PREFIX}] Returning a combined total of ${combinedResults.length} unique streams.`);
        return combinedResults;
    } catch (error) {
        console.error(`[${LOG_PREFIX}] Error occurred, returning personal files if available: ${error.message}`);
        console.error(`[${LOG_PREFIX}] Stack trace:`, error.stack);
        // Don't abort other scrapers - let them continue
        // We can still attempt to get personal files to return at least those
        const personalFiles = userConfig.enablePersonalCloud !== false
            ? await searchPersonalFiles(apiKey, allSearchKeys, specificSearchKey, type, season, episode)
            : [];
        
        // Since scraperResults failed, we return only personal files
        const combinedResults = await combineAndMarkResults(apiKey, personalFiles, [], episodeInfo);
        
        const bypassStreams = combinedResults.filter(stream => stream.bypassFiltering === true);
        if (bypassStreams.length > 0) {
            console.log(`[${LOG_PREFIX} FINAL ERROR] Found ${bypassStreams.length} bypass streams - returning ONLY these direct cloud links`);
            return bypassStreams;
        }
        
        return combinedResults;
    } finally {
        cleanupAbort(); // Clear the abort timeout
    }
}

// ===================================================================================
// --- 2. SEARCH & COMBINE LOGIC (OC-Specific) ---
// ===================================================================================
async function searchPersonalFiles(apiKey, searchKeys, specificSearchKey, type, season, episode) {
    const personalCloudTimerId = '[OC TIMER] Personal Cloud';
    console.time(personalCloudTimerId);
    const OCClient = createOffcloudClient(apiKey);
    try {
        const keys = Array.isArray(searchKeys) ? searchKeys : [searchKeys];
        const primaryKey = keys[0];

        const historyResponse = await OCClient.cloud.history();
        const history = Array.isArray(historyResponse) ? historyResponse : [];

        if (!Array.isArray(historyResponse)) {
            console.warn(`[${LOG_PREFIX}] Warning: OCClient.cloud.history() returned non-array value:`, typeof historyResponse);
        }

        // **PRIORITY 1: Check for exact archive name matches first**
        const primarySearchTerm = specificSearchKey || primaryKey;
        if (primarySearchTerm && type === 'series' && season && episode) {
            console.log(`[OC EXACT] Checking for exact archive matches for: "${primarySearchTerm}"`);

            const exactArchiveMatch = await findExactArchiveMatch(OCClient, primarySearchTerm, history, season, episode);
            if (exactArchiveMatch) {
                console.log(`[OC EXACT] Found exact archive match, returning ONLY this direct cloud link.`);
                console.log(`[OC EXACT] Final result: ${obfuscateSensitive(JSON.stringify({
                    name: exactArchiveMatch.name,
                    url: exactArchiveMatch.url,
                    bypassFiltering: exactArchiveMatch.bypassFiltering
                }), apiKey)}`);
                try { console.timeEnd(personalCloudTimerId); } catch {}
                // **CRITICAL: Return ONLY the direct match, no other processing**
                return [exactArchiveMatch];
            }
        }

        // **FALLBACK: Only if no exact match found**
        const relevantHistory = filterHistoryByKeywords(history, primaryKey);
        console.log(`[OC] Pre-filtered personal history from ${history.length} to ${relevantHistory.length} relevant items.`);

        const torrents = await processTorrents(OCClient, relevantHistory);
        console.log(`[OC] Expanded personal cloud to ${torrents.length} video files.`);

        if (torrents.length === 0) {
            console.log(`[OC] No video files found after processing relevant history.`);
            try { console.timeEnd(personalCloudTimerId); } catch {}
            return [];
        }

        const enhancedTorrents = torrents.map(torrent => ({
            ...torrent,
            cleanedName: cleanFileName(torrent.name)
        }));

        const fuse = new Fuse(enhancedTorrents, {
            keys: [
                { name: 'searchableName', weight: 0.4 },
                { name: 'name', weight: 0.3 },
                { name: 'info.title', weight: 0.2 },
                { name: 'cleanedName', weight: 0.1 }
            ],
            threshold: 0.6,
            minMatchCharLength: 2,
            ignoreLocation: true,
            includeScore: true,
        });

        const results = fuse.search(primarySearchTerm);
        console.log(`[OC] Fuzzy search "${primarySearchTerm}": found ${results.length} matches`);

        if (results.length > 0) {
            console.log(`[OC] Best fuzzy match: "${results[0].item.name}" (score: ${results[0].score})`);
        }

        const uniqueResults = [...new Map(results.map(result => [result.item.url, result])).values()]
            .sort((a, b) => a.score - b.score);

        console.log(`[OC] Found ${uniqueResults.length} personal files after search.`);
        try { console.timeEnd(personalCloudTimerId); } catch {}
        return uniqueResults.map((result) => ({ ...result.item, source: 'offcloud', isPersonal: true, isCached: true, tracker: 'Personal' }));
    } catch (error) {
        try { console.timeEnd(personalCloudTimerId); } catch {}
        console.error(`[OC] Personal files search error: ${error.message}`);
        return [];
    }
}

async function findExactArchiveMatch(OCClient, searchTerm, history, season, episode) {
    function normalize(str) { return str.toLowerCase().replace(/[\.\-\_\s]/g, ''); }

    const showName = searchTerm.split(' s0')[0];
    const normalizedShowName = normalize(showName);

    const seasonStr = String(season).padStart(2, '0');
    const episodeStr = String(episode).padStart(2, '0');
    const seasonEpisodePatterns = [`s${seasonStr}e${episodeStr}`, `s${season}e${episode}`, `s${season}e${episodeStr}`, `s${seasonStr}e${episode}`];

    for (const item of history) {
        if (!item.fileName) {
            continue;
        }
        const normalizedFileName = normalize(item.fileName);
        const hasShowName = normalizedFileName.includes(normalizedShowName);
        const hasSeasonEpisode = seasonEpisodePatterns.some(p => normalizedFileName.includes(normalize(p)));

        if (hasShowName && hasSeasonEpisode && item.isDirectory) {
            console.log(`[${LOG_PREFIX} EXACT] Found exact match archive: "${item.fileName}"`);
            try {
                const urls = await OCClient.cloud.explore(item.requestId);
                if (!urls || urls.length === 0) continue;

                let largestVideoUrl = null;
                let largestVideoSize = 0;

                // Process each URL and get actual file size via HEAD request
                for (const url of urls) {
                    if (!url) continue;

                    const fileName = decodeURIComponent(url.split('/').pop());

                    // Quick validation before making HEAD request
                    if (!isValidVideo(fileName, 0, 10 * 1024 * 1024, LOG_PREFIX)) continue;

                    // Get actual file size via HEAD request
                    let fileSize = 0;
                    try {
                        const headResponse = await axiosWithProxy.head(url, { timeout: 5000 });
                        fileSize = headResponse.headers['content-length'] ? parseInt(headResponse.headers['content-length'], 10) : 0;
                    } catch (err) {
                        console.log(`[${LOG_PREFIX} EXACT] Could not get file size via HEAD for ${fileName}`);
                        continue;
                    }

                    // Validate again with actual size
                    if (!isValidVideo(fileName, fileSize, 10 * 1024 * 1024, LOG_PREFIX)) continue;

                    if (fileSize > largestVideoSize) {
                        largestVideoUrl = createEncodedUrl(url);
                        largestVideoSize = fileSize;
                    }
                }

                if (largestVideoUrl) {
                    return {
                        id: item.requestId, name: item.fileName, searchableName: item.fileName,
                        info: PTT.parse(item.fileName) || { title: item.fileName }, size: largestVideoSize,
                        hash: getHashFromMagnet(item.originalLink), url: largestVideoUrl,
                        source: 'offcloud', isPersonal: true, tracker: 'Personal Cloud',
                        bypassFiltering: true
                    };
                }
            } catch (error) {
                console.log(`[${LOG_PREFIX} EXACT] Error exploring "${item.fileName}": ${error.message}`);
            }
        }
    }
    return null;
}

async function combineAndMarkResults(apiKey, personalFiles, externalSources, episodeInfo = null) {
    const externalTorrents = [].concat(...externalSources);
    const externalTorrentsMap = new Map(externalTorrents.map(t => [t.InfoHash?.toLowerCase(), t]).filter(([hash]) => hash));

    // **FIX 2 - Enrich personal files with size from external torrents**
    const enrichedPersonalFiles = personalFiles.map(file => {
        if (file.hash && (!file.size || file.size === 0)) {
            const externalMatch = externalTorrentsMap.get(file.hash.toLowerCase());
            if (externalMatch) {
                const newSize = externalMatch.Size || externalMatch.size || externalMatch.filesize || 0;
                if (newSize > 0) {
                    return { ...file, size: newSize };
                }
            }
        }
        return file;
    });

    const personalHashes = new Set(enrichedPersonalFiles.map(f => f.hash).filter(Boolean));
    const markedPersonal = enrichedPersonalFiles.map(file => ({ ...file, source: 'offcloud', isPersonal: true, tracker: 'Personal Cloud' }));
    
    const newExternalTorrents = Array.from(externalTorrentsMap.values()).filter(t => t.InfoHash && !personalHashes.has(t.InfoHash.toLowerCase()));

    const ocHandler = {
        getIdentifier: () => LOG_PREFIX,
        checkCachedHashes: async (hashes) => {
            if (!hashes || hashes.length === 0) return new Set();
            const lower = hashes.map(h => h.toLowerCase());
            const cached = new Set();
            try {
                if (sqliteCache?.isEnabled()) {
                    console.log(`[OC SQLCACHE] Checking ${lower.length} hashes against SQLite cache`);
                    const local = await sqliteGetCachedHashes('offcloud', lower);
                    local.forEach(h => cached.add(h));
                    console.log(`[OC SQLCACHE] Found ${local.size} cached hashes from SQLite for OffCloud`);
                }
            } catch (error) {
                console.error(`[OC SQLCACHE] Error checking SQLite cache: ${error.message}`);
            }
            const remaining = lower.filter(h => !cached.has(h));
            if (remaining.length === 0) return cached;

            // Use /cache/info endpoint instead of /cache - the /cache endpoint is broken
            // and returns all hashes as cached regardless of actual status
            const url = `${OFFCLOUD_API_URL}/cache/info`;
            const BATCH_SIZE = 50; // Process in batches to avoid timeout

            // Valid video extensions (must match torrent-utils.js VIDEO_EXTENSIONS)
            const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.mpg', '.mpeg', '.3gp', '.ogv', '.ts', '.m2ts'];
            const hasVideoFile = (files) => {
                if (!Array.isArray(files) || files.length === 0) return false;
                return files.some(f => {
                    const filename = (f.filename || '').toLowerCase();
                    return VIDEO_EXTENSIONS.some(ext => filename.endsWith(ext));
                });
            };

            try {
                for (let i = 0; i < remaining.length; i += BATCH_SIZE) {
                    const batch = remaining.slice(i, i + BATCH_SIZE);
                    const magnetUrls = batch.map(h => `magnet:?xt=urn:btih:${h}`);

                    const response = await axiosWithProxy.post(url, {
                        urls: magnetUrls,
                        includeFiles: true  // Need file list to filter out fake torrents (.exe, .iso, etc.)
                    }, {
                        headers: { 'Authorization': `Bearer ${apiKey}` }
                    });

                    // Response is an array matching the input order
                    const results = response.data || [];
                    results.forEach((result, idx) => {
                        // Only mark as cached if it has actual video files (not .exe, .iso, etc.)
                        if (result?.cached === true && hasVideoFile(result.files)) {
                            cached.add(batch[idx]);
                        } else if (result?.cached === true && !hasVideoFile(result.files)) {
                            const fileNames = (result.files || []).map(f => f.filename).join(', ');
                            console.log(`[${LOG_PREFIX}] Filtering fake torrent (no video files): ${fileNames || 'unknown'}`);
                        }
                    });
                }

                console.log(`[${LOG_PREFIX}] Cache check: ${cached.size} of ${lower.length} hashes are cached (with video files)`);
                return cached;
            } catch (error) {
                console.error(`[${LOG_PREFIX}] !! FATAL: OffCloud cache check failed. All external results will be hidden.`);
                if (error.response) console.error(`[${LOG_PREFIX}] Cache Check Error: Status ${error.response.status} - ${JSON.stringify(error.response.data)}`);
                else console.error(`[${LOG_PREFIX}] Cache Check Error: ${error.message}`);
                return cached; // return what we have
            }
        },
        liveCheckHash: async (hash) => false,
        bypassQuotas: true,  // OffCloud has no API rate limits, so bypass quotas
        cleanup: async () => {}
    };

    const cachedTorrents = await processAndFilterTorrents(newExternalTorrents, ocHandler, episodeInfo, {}, false);
    
    const finalExternalResults = cachedTorrents.map(formatExternalResult);

    const allResults = [...markedPersonal, ...finalExternalResults];

    // Persist OffCloud cached items to SQLite
    try {
        if (sqliteCache?.isEnabled()) {
            console.log(`[OC SQLCACHE] Preparing to cache ${allResults.length} results to SQLite`);
            const upserts = [];
            for (const r of allResults) {
                if (r?.hash) {
                    upserts.push({
                        service: 'offcloud',
                        hash: r.hash.toLowerCase(),
                        fileName: r.name || null,
                        size: r.size || null,
                        category: getQualityCategory(r.name || ''),
                        resolution: torrentUtils.getResolutionFromName(r.name || ''),
                        data: { source: r.isPersonal ? 'personal' : 'cached' }
                    });
                }
            }
            console.log(`[OC SQLCACHE] About to defer ${upserts.length} upserts to SQLite`);
            deferSqliteUpserts(uniqueUpserts(upserts));
        }
    } catch (error) {
        console.error(`[OC SQLCACHE] Error persisting to SQLite cache: ${error.message}`);
    }

    return allResults;
}


function cleanFileName(filename) {
    return filename
        .replace(/\.(mkv|mp4|avi|mov|flv|wmv|webm)$/i, '')
        .replace(/[\.\-\_]/g, ' ')
        .replace(/\b(1080p|720p|480p|2160p|4k)\b/gi, '')
        .replace(/\b(bluray|webrip|hdtv|dvdrip|brrip|x264|x265|h264|h265|dts|ac3|aac|ma|hd)\b/gi, '')
        .replace(/\b(yify|rarbg|ettv|nogrp)\b/gi, '')
        .replace(/\b\d{4}\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function formatExternalResult(result) {
    return {
        name: result.Title, 
        info: PTT.parse(result.Title) || { title: result.Title },
        size: result.Size || result.size || result.filesize || 0, 
        seeders: result.Seeders,
        url: `magnet:?xt=urn:btih:${result.InfoHash}`,
        source: 'offcloud', 
        hash: result.InfoHash.toLowerCase(),
        tracker: result.Tracker,
        languages: Array.isArray(result.Langs) ? result.Langs : [],
        isPersonal: false,
        isCached: true
    };
}

// ===================================================================================
// --- 3. STREAM RESOLVER LOGIC (OC-Specific) ---
// ===================================================================================
async function resolveStream(apiKey, urlToResolve, type, id) {
    if (!urlToResolve.startsWith('magnet:')) {
        return urlToResolve;
    }

    const key = getResolveKey(urlToResolve);
    const cacheHit = getCachedResolve(key);
    if (cacheHit !== undefined) {
        if (cacheHit === null) {
            console.log(`[${LOG_PREFIX}] Recent Offcloud resolve failure for ${key}, skipping immediate retry.`);
            return null;
        }
        console.log(`[${LOG_PREFIX}] Resolve cache hit for ${key}`);
        return cacheHit;
    }

    if (resolveInFlight.has(key)) {
        console.log(`[${LOG_PREFIX}] Joining in-flight Offcloud resolve for ${key}`);
        return resolveInFlight.get(key);
    }

    const hash = getHashFromMagnet(urlToResolve);
    if (!hash) {
        console.log(`[${LOG_PREFIX}] Could not extract hash from magnet: ${urlToResolve}`);
        return null;
    }

    const OCClient = createOffcloudClient(apiKey);

    const resolverPromise = (async () => {
        // First, try to find the file in history by hash
        const historyResponse = await OCClient.cloud.history();
        const history = Array.isArray(historyResponse) ? historyResponse : [];
        const hashMatchResult = await findLargestVideoByHash(OCClient, hash, history);
        if (hashMatchResult) {
            console.log(`[${LOG_PREFIX}] Found stream in history by hash: ${hashMatchResult.url}`);
            return hashMatchResult.url || null;
        }

        // If not found by hash, try to find by metadata
        if (id) {
            const [imdbId, season, episode] = id.split(':');
            const cinemetaDetails = await Cinemeta.getMeta(type, imdbId);
            if (cinemetaDetails) {
                const searchKey = type === 'series' && season && episode
                    ? `${cinemetaDetails.name} s${String(season).padStart(2, '0')}e${String(episode).padStart(2, '0')}`
                    : cinemetaDetails.name;
                
                const relevantHistory = filterHistoryByKeywords(history, searchKey);
                const exactMatchResult = await findLargestVideoInArchive(OCClient, searchKey, relevantHistory);
                if (exactMatchResult) {
                    console.log(`[${LOG_PREFIX}] Found stream in history by metadata: ${exactMatchResult.url}`);
                    return exactMatchResult.url;
                }
            }
        }

        // Try /cache/download first - this gives instant streaming for globally cached items
        // without adding to user's cloud (which would start a download)
        let cacheDownloadHadFiles = false;
        try {
            console.log(`[${LOG_PREFIX}] Trying /cache/download for instant streaming...`);
            const cacheDownloadResponse = await OCClient.cache.download(urlToResolve);

            if (Array.isArray(cacheDownloadResponse) && cacheDownloadResponse.length > 0) {
                cacheDownloadHadFiles = true;
                // Find the largest valid video file (filters out .exe, .iso, samples, etc.)
                const videoFiles = cacheDownloadResponse.filter(f =>
                    f.url && isValidVideo(f.filename, f.size || 0, 10 * 1024 * 1024, LOG_PREFIX)
                );

                if (videoFiles.length > 0) {
                    videoFiles.sort((a, b) => (b.size || 0) - (a.size || 0));
                    const bestFile = videoFiles[0];
                    console.log(`[${LOG_PREFIX}] Got instant stream from /cache/download: ${bestFile.filename} (${(bestFile.size / 1024 / 1024).toFixed(1)} MB)`);
                    return createEncodedUrl(bestFile.url);
                } else {
                    // Files exist but none are valid video - this is a fake torrent
                    const fileNames = cacheDownloadResponse.map(f => f.filename).join(', ');
                    console.log(`[${LOG_PREFIX}] Fake torrent detected (no valid video files): ${fileNames}`);
                    storeResolveResult(key, null);
                    return null;
                }
            }
        } catch (cacheDownloadError) {
            // /cache/download failed - item is not globally cached, need to add to cloud
            console.log(`[${LOG_PREFIX}] /cache/download failed (${cacheDownloadError.response?.status || cacheDownloadError.message}), falling back to cloud add`);
        }

        // If cache had files but no valid videos, don't try adding to cloud (it's a fake torrent)
        if (cacheDownloadHadFiles) {
            return null;
        }

        // If /cache/download failed (not found), add to Offcloud (single attempt per key)
        if (pendingAddToOffcloud.has(key)) {
            console.log(`[${LOG_PREFIX}] Joining in-flight Offcloud add for ${key}`);
            return pendingAddToOffcloud.get(key);
        }

        const addPromise = (async () => {
            console.log(`[${LOG_PREFIX}] Adding to Offcloud cloud...`);
            const addedItem = await addToOffcloud(apiKey, urlToResolve);
            if (!addedItem?.requestId) {
                console.log(`[${LOG_PREFIX}] Failed to add magnet to Offcloud.`);
                return null;
            }

            // Wait for the item to appear in history and process it
            const newItemInHistory = await waitForItemInHistory(OCClient, addedItem.requestId);
            if (newItemInHistory) {
                const processedFiles = await processTorrents(OCClient, [newItemInHistory]);
                if (processedFiles.length > 0) {
                    processedFiles.sort((a, b) => (b.size || 0) - (a.size || 0));
                    console.log(`[${LOG_PREFIX}] Found stream after adding to Offcloud: ${processedFiles[0].url}`);
                    return processedFiles[0].url;
                }
            }

            console.log(`[${LOG_PREFIX}] Could not resolve stream after adding to Offcloud.`);
            return null;
        })().finally(() => pendingAddToOffcloud.delete(key));

        pendingAddToOffcloud.set(key, addPromise);
        return addPromise;
    })().catch(error => {
        console.error(`[${LOG_PREFIX}] Error resolving stream: ${error.message}`);
        return null;
    }).finally(() => {
        resolveInFlight.delete(key);
    });

    resolveInFlight.set(key, resolverPromise);

    const resolved = await resolverPromise;
    storeResolveResult(key, resolved);
    return resolved;
}

// ===================================================================================
// --- 4. HELPER FUNCTIONS (OC-Specific) ---
// ===================================================================================
async function findLargestVideoInArchive(OCClient, searchKey, relevantHistory) {
    const MIN_FALLBACK_SIZE = 350 * 1024 * 1024;
    const fuse = new Fuse(relevantHistory, { keys: ['fileName'], threshold: 0.4, includeScore: true });
    const archiveMatches = fuse.search(searchKey);
    if (archiveMatches.length === 0) return null;

    let allLargeVideos = [];
    for (const match of archiveMatches) {
        try {
            const videoFiles = await processHistoryEntry(OCClient, match.item);
            if (!videoFiles || videoFiles.length === 0) continue;
            const largeFiles = (Array.isArray(videoFiles) ? videoFiles : [videoFiles])
                .filter(file => file?.size && file.size > MIN_FALLBACK_SIZE);
            allLargeVideos.push(...largeFiles);
        } catch {}
    }

    if (allLargeVideos.length > 0) {
        allLargeVideos.sort((a, b) => b.size - a.size);
        return allLargeVideos[0];
    }
    return null;
}

async function findLargestVideoByHash(OCClient, targetHash, history) {
    const MIN_FALLBACK_SIZE = 350 * 1024 * 1024;
    const matchingArchives = history.filter(item => getHashFromMagnet(item.originalLink)?.toLowerCase() === targetHash.toLowerCase());
    if (matchingArchives.length === 0) return null;

    let allLargeVideos = [];
    for (const archive of matchingArchives) {
        try {
            const videoFiles = await processHistoryEntry(OCClient, archive);
            if (videoFiles?.length > 0) {
                const largeFiles = (Array.isArray(videoFiles) ? videoFiles : [videoFiles])
                    .filter(file => file?.size && file.size > MIN_FALLBACK_SIZE);
                allLargeVideos.push(...largeFiles);
            }
        } catch {}
    }

    if (allLargeVideos.length > 0) {
        allLargeVideos.sort((a, b) => b.size - a.size);
        return allLargeVideos[0];
    }
    return null;
}

async function addToOffcloud(apiKey, magnetLink) {
    const url = `${OFFCLOUD_API_URL}/cloud`;
    try {
        return (await axiosWithProxy.post(url, { url: magnetLink }, {
            headers: { 'Authorization': `Bearer ${apiKey}` }
        })).data;
    } catch {
        return null;
    }
}

async function waitForItemInHistory(OCClient, requestId, timeout = 90000, interval = 3000) {
    const timeoutMs = parseInt(process.env.OFFCLOUD_HISTORY_TIMEOUT_MS || timeout, 10);
    const pollMs = parseInt(process.env.OFFCLOUD_HISTORY_POLL_MS || interval, 10);
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
        const historyResponse = await OCClient.cloud.history();
        const history = Array.isArray(historyResponse) ? historyResponse : [];
        const newItem = history.find(item => item.requestId === requestId);
        if (newItem?.fileName) return newItem;
        await delay(pollMs);
    }
    return null;
}

async function processTorrents(client, history) {
    const promises = history.map(item => processHistoryEntry(client, item));
    const results = await Promise.all(promises);
    return results.flat().filter(Boolean);
}

async function processHistoryEntry(client, item) {
    if (!item.fileName) {
        return null;
    }

    const hash = getHashFromMagnet(item.originalLink);

    // Always use cloud.explore() to get actual CDN URLs
    // The item.server field is often undefined for single-file torrents,
    // so manually constructing URLs doesn't work reliably
    try {
        const urls = await client.cloud.explore(item.requestId);
        if (!Array.isArray(urls) || urls.length === 0) return null;

        // Process each file URL and get actual sizes via HEAD requests
        const filePromises = urls.map(async (url) => {
            if (!url) return null;
            const fileName = decodeURIComponent(url.split('/').pop());

            // Quick validation before making HEAD request
            if (!isValidVideo(fileName, 0, 50 * 1024 * 1024, LOG_PREFIX)) return null;

            // Get actual file size via HEAD request
            let fileSize = 0;
            try {
                const headResponse = await axiosWithProxy.head(url, { timeout: 5000 });
                fileSize = headResponse.headers['content-length'] ? parseInt(headResponse.headers['content-length'], 10) : 0;
            } catch (err) {
                console.log(`[${LOG_PREFIX}] Could not get file size via HEAD for ${fileName}`);
                fileSize = item.fileSize || 0;
            }

            // Validate again with actual size
            if (!isValidVideo(fileName, fileSize, 50 * 1024 * 1024, LOG_PREFIX)) return null;

            // For single-file torrents, use item.fileName as searchableName
            // For multi-file, combine archive name with file name
            const isSingleFile = urls.length === 1;
            const searchableName = isSingleFile ? item.fileName : `${item.fileName} ${fileName}`;

            return {
                id: item.requestId, name: fileName, searchableName,
                info: PTT.parse(fileName) || { title: fileName }, size: fileSize,
                hash: hash, url: createEncodedUrl(url)
            };
        });

        const files = await Promise.all(filePromises);
        return files.filter(Boolean);
    } catch (err) {
        console.log(`[${LOG_PREFIX}] cloud.explore failed for ${item.requestId}: ${err.message}`);
        return null;
    }
}

function getKeywords(str) {
    const stopWords = new Set(['the', 'a', 'an', 'and', 'of', 'in', 'on', 'for', 'with']);
    const normalized = str.toLowerCase().replace(/[\._-]/g, ' ').replace(/[':()\[\]]/g, '').replace(/\s+/g, ' ').trim();
    return normalized.split(' ').filter(word => word.length > 1 && !stopWords.has(word) && !/^(1080p|720p|bluray|webrip)$/.test(word)).filter(Boolean);
}

function filterHistoryByKeywords(history, searchKey) {
    const searchKeywords = getKeywords(searchKey);
    if (searchKeywords.length === 0) return [];
    const requiredMatches = searchKeywords.length <= 2 ? searchKeywords.length : Math.max(2, Math.ceil(searchKeywords.length * 0.5));

    return history.filter(item => {
        if (!item.fileName) return false;
        const itemNameLower = item.fileName.toLowerCase().replace(/[\._-]/g, ' ');
        const actualMatches = searchKeywords.reduce((count, keyword) => itemNameLower.includes(keyword) ? count + 1 : count, 0);
        return actualMatches >= requiredMatches;
    });
}

// ===================================================================================
// --- CATALOG: LIST ALL PERSONAL DOWNLOADS ---
// ===================================================================================
async function searchDownloads(apiKey, searchKey = '', threshold = 0.3) {
    const OCClient = createOffcloudClient(apiKey);
    try {
        console.log(`[${LOG_PREFIX}] searchDownloads: Fetching history...`);
        const historyResponse = await OCClient.cloud.history();
        const history = Array.isArray(historyResponse) ? historyResponse : [];
        console.log(`[${LOG_PREFIX}] searchDownloads: Got ${history.length} items from history`);

        // Process all history entries to get individual files
        const allFiles = await processTorrents(OCClient, history);
        console.log(`[${LOG_PREFIX}] searchDownloads: Processed into ${allFiles.length} video files`);

        if (allFiles.length === 0) {
            return [];
        }

        // If no search key, return all files
        if (!searchKey || searchKey === '') {
            return allFiles;
        }

        // Search within files using fuzzy matching
        const fuse = new Fuse(allFiles, {
            keys: ['name', 'searchableName', 'info.title'],
            threshold,
            minMatchCharLength: 2
        });

        const results = fuse.search(searchKey).map(r => r.item);
        console.log(`[${LOG_PREFIX}] searchDownloads: Fuzzy search found ${results.length} matches for "${searchKey}"`);
        return results;
    } catch (error) {
        console.error(`[${LOG_PREFIX}] searchDownloads error: ${error.message}`);
        console.error(`[${LOG_PREFIX}] Stack:`, error.stack);
        return [];
    }
}

export default { searchOffcloudTorrents, resolveStream, searchDownloads, searchPersonalFiles };
