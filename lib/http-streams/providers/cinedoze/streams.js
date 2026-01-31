/**
 * CineDoze HTTP Streams
 * Scrapes cinedoze.tv posts -> cinedoze links -> savelinks pages, preferring hubdrive/hubcloud
 * with gdflix as a pixeldrain-only fallback.
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import Cinemeta from '../../../util/cinemeta.js';
import { renderLanguageFlags, detectLanguagesFromTitle } from '../../../util/language-mapping.js';
import { makeRequest } from '../../utils/http.js';
import {
    removeYear,
    generateAlternativeQueries,
    getSortedMatches
} from '../../utils/parsing.js';
import { getResolutionFromName } from '../../utils/parsing.js';
import { extractFileName } from '../../../common/torrent-utils.js';
import { encodeUrlForStreaming } from '../../utils/encoding.js';
import { processExtractorLinkWithAwait } from '../4khdhub/extraction.js';
import { parseSizeFromText, isLazyLoadEnabled } from '../../utils/preview-mode.js';
import * as config from '../../../config.js';

const BASE_URL = (process.env.CINEDOZE_BASE_URL || 'https://cinedoze.tv').replace(/\/+$/, '');
const PROVIDER = 'CineDoze';

// FlareSolverr configuration
const FLARESOLVERR_URL = config.FLARESOLVERR_URL || process.env.FLARESOLVERR_URL || '';
const FLARESOLVERR_V2 = config.FLARESOLVERR_V2 || process.env.FLARESOLVERR_V2 === 'true';
const FLARESOLVERR_PROXY_URL = config.FLARESOLVERR_PROXY_URL || process.env.FLARESOLVERR_PROXY_URL || '';
const FLARESOLVERR_TIMEOUT = parseInt(process.env.CINEDOZE_FLARESOLVERR_TIMEOUT, 10) || 45000;

/**
 * Check if a response body contains a Cloudflare challenge
 */
function isCloudflareChallenge(body = '', statusCode = null) {
    if (statusCode && (statusCode === 403 || statusCode === 503)) {
        const lower = (body || '').toLowerCase();
        if (lower.includes('cloudflare') || lower.includes('cf-') || lower.includes('just a moment')) {
            return true;
        }
    }
    const lower = (body || '').toLowerCase();
    return lower.includes('cf-mitigated') ||
        lower.includes('just a moment') ||
        lower.includes('cf_chl') ||
        (lower.includes('challenge-platform') && lower.includes('cf_chl')) ||
        lower.includes('cf-turnstile') ||
        lower.includes('verify_turnstile') ||
        (lower.includes('security check') && lower.includes('cloudflare'));
}

/**
 * Fetch a URL using FlareSolverr to bypass Cloudflare
 */
async function fetchWithFlareSolverr(url, headers = {}) {
    if (!FLARESOLVERR_URL) {
        return null;
    }

    console.log(`[${PROVIDER}] Using FlareSolverr to bypass Cloudflare for ${url}`);
    const flareTimeout = Math.max(FLARESOLVERR_TIMEOUT, 30000);

    try {
        const requestBody = {
            cmd: 'request.get',
            url,
            maxTimeout: flareTimeout
        };

        if (!FLARESOLVERR_V2) {
            requestBody.headers = headers;
            const userAgent = headers['User-Agent'] || headers['user-agent'];
            if (userAgent) requestBody.userAgent = userAgent;
        }

        if (FLARESOLVERR_PROXY_URL) {
            requestBody.proxy = { url: FLARESOLVERR_PROXY_URL };
        }

        const response = await axios.post(`${FLARESOLVERR_URL}/v1`, requestBody, {
            timeout: flareTimeout + 5000,
            headers: { 'Content-Type': 'application/json' }
        });

        const solution = response?.data?.solution;
        if (!solution?.response) {
            console.log(`[${PROVIDER}] FlareSolverr returned no response for ${url}`);
            return null;
        }

        const body = solution.response;
        const lower = String(body).toLowerCase();

        if (lower.includes('just a moment') || lower.includes('checking your browser') || lower.includes('cf-browser-verification')) {
            console.log(`[${PROVIDER}] FlareSolverr still blocked for ${url}`);
            return null;
        }

        console.log(`[${PROVIDER}] FlareSolverr success for ${url}`);
        return {
            document: cheerio.load(body),
            body,
            url: solution.url || url,
            statusCode: solution.status
        };
    } catch (error) {
        console.log(`[${PROVIDER}] FlareSolverr error for ${url}: ${error.message}`);
        return null;
    }
}

import * as SqliteCache from '../../../util/cache-store.js';

// Cache configuration
const SEARCH_CACHE_TTL = parseInt(process.env.CINEDOZE_SEARCH_CACHE_TTL, 10) || 30 * 60 * 1000; // 30 minutes
const PAGE_CACHE_TTL = parseInt(process.env.CINEDOZE_PAGE_CACHE_TTL, 10) || 10 * 60 * 1000; // 10 minutes
const SQLITE_SERVICE_KEY = 'cinedoze';
const SQLITE_SEARCH_PREFIX = 'search:';
const SQLITE_PAGE_PREFIX = 'page:';
const SQLITE_EXPAND_PREFIX = 'expand:';

// In-memory hot cache (backed by SQLite/Postgres)
const searchCache = new Map();
const pageCache = new Map();
const expandCache = new Map();

// Helper to get from SQLite/Postgres cache
async function getDbCached(hashKey, ttl) {
    if (!SqliteCache.isEnabled()) return null;
    try {
        const cached = await SqliteCache.getCachedRecord(SQLITE_SERVICE_KEY, hashKey);
        if (!cached?.data) return null;
        const updatedAt = cached.updatedAt || cached.createdAt;
        if (updatedAt) {
            const age = Date.now() - new Date(updatedAt).getTime();
            if (age <= ttl) return cached.data;
        }
    } catch (error) {
        console.error(`[${PROVIDER}] Failed to read db cache: ${error.message}`);
    }
    return null;
}

// Helper to write to SQLite/Postgres cache
async function setDbCache(hashKey, data, ttlMs) {
    if (!SqliteCache.isEnabled()) return;
    try {
        await SqliteCache.upsertCachedMagnet({
            service: SQLITE_SERVICE_KEY,
            hash: hashKey,
            data,
            releaseKey: 'cinedoze-http-streams'
        }, { ttlMs });
    } catch (error) {
        console.error(`[${PROVIDER}] Failed to write db cache: ${error.message}`);
    }
}

function cleanText(text = '') {
    return text.replace(/\s+/g, ' ').replace(/^\W+/, '').trim();
}

function toAbsolute(href, base = BASE_URL) {
    if (!href) return null;
    try {
        return new URL(href, base).toString();
    } catch {
        return null;
    }
}

async function searchCineDoze(query) {
    // CineDoze search breaks when query contains colons - strip them
    const cleanQuery = query.replace(/:/g, '').replace(/\s+/g, ' ').trim();

    // Check in-memory cache first
    const cacheKey = cleanQuery.toLowerCase();
    const dbCacheKey = `${SQLITE_SEARCH_PREFIX}${cacheKey}`;
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < SEARCH_CACHE_TTL) {
        console.log(`[${PROVIDER}] Search cache hit (memory) for "${query}"`);
        return cached.data;
    }

    // Check db cache
    const dbCached = await getDbCached(dbCacheKey, SEARCH_CACHE_TTL);
    if (dbCached) {
        console.log(`[${PROVIDER}] Search cache hit (db) for "${query}"`);
        searchCache.set(cacheKey, { data: dbCached, ts: Date.now() });
        return dbCached;
    }

    const url = `${BASE_URL}/search/${encodeURIComponent(cleanQuery)}/`;
    try {
        const response = await makeRequest(url, { parseHTML: true, timeout: 3000 });
        const $ = response.document;
        const results = [];

        $('article').each((_, article) => {
            const link =
                $(article).find('a[href*="/movies/"], a[href*="/tvshows/"]').first().attr('href');
            const title =
                cleanText(
                    $(article).find('.title').text() ||
                    $(article).find('h3').text() ||
                    $(article).find('h2').text()
                );
            const absolute = toAbsolute(link, url);
            if (absolute && title) {
                results.push({ title, url: absolute });
            }
        });

        // Fallback: regex for movie/tvshow links if DOM parsing failed
        if (results.length === 0) {
            const regex = /https?:\/\/cinedoze\.tv\/(?:movies|tvshows)\/[^\s"'<>]+/gi;
            const matches = [...(response.body || '').matchAll(regex)].map(m => m[0]);
            for (const href of matches) {
                const absolute = toAbsolute(href, url);
                if (!absolute) continue;
                // Derive title from slug
                const slug = absolute.split('/').filter(Boolean).pop() || '';
                const derived = cleanText(slug.replace(/[-_]+/g, ' '));
                if (derived) {
                    results.push({ title: derived, url: absolute });
                }
            }
        }

        // Cache the results (memory + db)
        searchCache.set(cacheKey, { data: results, ts: Date.now() });
        setDbCache(dbCacheKey, results, SEARCH_CACHE_TTL);

        return results;
    } catch (err) {
        console.log(`[${PROVIDER}] Search failed for "${query}": ${err.message}`);
        return [];
    }
}

async function loadCineDozePage(detailUrl) {
    // Check in-memory cache first
    const dbCacheKey = `${SQLITE_PAGE_PREFIX}${detailUrl}`;
    const cached = pageCache.get(detailUrl);
    if (cached && Date.now() - cached.ts < PAGE_CACHE_TTL) {
        console.log(`[${PROVIDER}] Page cache hit (memory) for ${detailUrl}`);
        return cached.data;
    }

    // Check db cache
    const dbCached = await getDbCached(dbCacheKey, PAGE_CACHE_TTL);
    if (dbCached) {
        console.log(`[${PROVIDER}] Page cache hit (db) for ${detailUrl}`);
        pageCache.set(detailUrl, { data: dbCached, ts: Date.now() });
        return dbCached;
    }

    try {
        const response = await makeRequest(detailUrl, { parseHTML: true, timeout: 3000 });
        const $ = response.document;
        const rows = $('#download table tbody tr');
        const entries = [];

        rows.each((_, row) => {
            const link = $(row).find('a[href]').attr('href');
            const quality = cleanText($(row).find('.quality').text() || $(row).find('td').eq(1).text());
            const languageText = cleanText($(row).find('td').eq(2).text());
            const sizeText = cleanText($(row).find('td').eq(3).text());

            const absolute = toAbsolute(link, detailUrl);
            if (!absolute) return;

            entries.push({
                url: absolute,
                quality: quality || 'Download',
                languages: detectLanguagesFromTitle(languageText),
                size: sizeText || parseSizeFromText(quality)
            });
        });

        // Cache the result (memory + db)
        pageCache.set(detailUrl, { data: entries, ts: Date.now() });
        setDbCache(dbCacheKey, entries, PAGE_CACHE_TTL);

        return entries;
    } catch (err) {
        console.log(`[${PROVIDER}] Failed to load detail page ${detailUrl}: ${err.message}`);
        return [];
    }
}

function extractHostLinks(html, baseUrl) {
    const hostLinks = [];
    const regex = /https?:\/\/[^\s"'<>]+/gi;
    const matches = [...(html || '').matchAll(regex)];
    const seen = new Set();

    for (const m of matches) {
        const href = toAbsolute(m[0], baseUrl);
        if (!href || seen.has(href)) continue;
        const lower = href.toLowerCase();
        if (
            lower.includes('hubdrive') ||
            lower.includes('hubcloud') ||
            lower.includes('hubcdn') ||
            lower.includes('gdflix') ||
            lower.includes('filepress') ||
            lower.includes('pixeldrain') ||
            lower.includes('filesdl')
        ) {
            hostLinks.push(href);
            seen.add(href);
        }
    }

    return hostLinks;
}

async function expandCineDozeLink(linkUrl) {
    // Check in-memory cache first
    const dbCacheKey = `${SQLITE_EXPAND_PREFIX}${linkUrl}`;
    const cached = expandCache.get(linkUrl);
    if (cached && Date.now() - cached.ts < PAGE_CACHE_TTL) {
        return cached.data;
    }

    // Check db cache
    const dbCached = await getDbCached(dbCacheKey, PAGE_CACHE_TTL);
    if (dbCached) {
        expandCache.set(linkUrl, { data: dbCached, ts: Date.now() });
        return dbCached;
    }

    try {
        const response = await makeRequest(linkUrl, { parseHTML: false, timeout: 2000 });
        const finalUrl = response.url || linkUrl;
        const result = extractHostLinks(response.body, finalUrl);
        // Cache the result (memory + db)
        expandCache.set(linkUrl, { data: result, ts: Date.now() });
        setDbCache(dbCacheKey, result, PAGE_CACHE_TTL);
        return result;
    } catch (err) {
        console.log(`[${PROVIDER}] Failed to expand cinedoze link ${linkUrl}: ${err.message}`);
        return [];
    }
}

/**
 * Quick metadata fetch from HubCloud page - extracts filename from page title
 * The HubCloud page title contains the full filename like:
 * "CineDoze.TV-Wicked For Good (2025) MLSBD.Co-Dual Audio [Hindi ORG-English] Amazon 4K.mkv"
 * Used in lazy-load mode to get proper filenames for preview streams
 */
async function fetchHubCloudMetadata(hubcloudUrl) {
    try {
        let response = await makeRequest(hubcloudUrl, { parseHTML: true, timeout: 2000 });
        let $ = response.document;
        let body = response.body || '';

        // Check if we're blocked by Cloudflare
        if (!$ || isCloudflareChallenge(body, response.statusCode)) {
            console.log(`[${PROVIDER}] Cloudflare detected for ${hubcloudUrl}, trying FlareSolverr...`);
            const flareResponse = await fetchWithFlareSolverr(hubcloudUrl, {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            });

            if (flareResponse && flareResponse.document) {
                $ = flareResponse.document;
                body = flareResponse.body || '';
                console.log(`[${PROVIDER}] FlareSolverr bypass successful for ${hubcloudUrl}`);
            } else {
                console.log(`[${PROVIDER}] FlareSolverr bypass failed for ${hubcloudUrl}`);
                return null;
            }
        }

        if (!$) return null;

        // The filename is in the page title on HubCloud pages
        const pageTitle = $('title').text().trim();

        // Check if we still got a Cloudflare page
        if (pageTitle.toLowerCase().includes('just a moment')) {
            console.log(`[${PROVIDER}] Page still shows Cloudflare challenge for ${hubcloudUrl}`);
            return null;
        }

        // Check if it looks like a video filename (ends with .mkv, .mp4, etc.)
        let filename = null;
        if (pageTitle && /\.(mkv|mp4|avi|webm|mov|m4v)$/i.test(pageTitle)) {
            filename = pageTitle;
            console.log(`[${PROVIDER}] Extracted filename from HubCloud title: ${filename}`);
        } else {
            // Fallback: look in body for filename patterns
            const fnMatch = body.match(/([A-Za-z0-9._\-\[\]()@ ]+\.(?:mkv|mp4|avi|webm))/i);
            if (fnMatch) {
                filename = fnMatch[1];
                console.log(`[${PROVIDER}] Extracted filename from body: ${filename}`);
            }
        }

        // Extract quality from filename
        const quality = (filename || '').match(/(2160p|1080p|720p|480p|4K)/i)?.[1] || null;

        return { filename, quality };
    } catch (err) {
        console.log(`[${PROVIDER}] Failed to fetch HubCloud metadata from ${hubcloudUrl}: ${err.message}`);
        return null;
    }
}

function buildStream(result, context) {
    if (!result?.url) return null;

    const labelBase = cleanText(result.title || result.name || context.quality || '');
    const size = result.size || context.size || parseSizeFromText(labelBase) || parseSizeFromText(context.quality) || null;
    const qualityLabel = getResolutionFromName(labelBase || result.name || context.quality || '') || 'HTTP';
    const resLabel = qualityLabel === '2160p' ? '4k' : qualityLabel;
    const languages = Array.from(
        new Set([
            ...(context.languages || []),
            ...detectLanguagesFromTitle(labelBase),
            ...detectLanguagesFromTitle(context.quality || ''),
            ...detectLanguagesFromTitle(result.title || '')
        ].filter(Boolean))
    );
    const languageFlags = renderLanguageFlags(languages);
    const sizeInfo = size ? `\n💾 ${size} | ${PROVIDER}` : `\n${PROVIDER}`;
    const title = `${labelBase || context.quality || 'Download'}${languageFlags}${sizeInfo}`;
    const fileName = extractFileName(result.title || result.name || '');
    const behaviorHints = {
        bingeGroup: 'cinedoze-http'
    };
    if (fileName) {
        behaviorHints.fileName = fileName;
    }

    return {
        name: `[HS+] Sootio\n${resLabel}`,
        title,
        url: encodeUrlForStreaming(result.url),
        size,
        resolution: resLabel,
        languages,
        behaviorHints,
        httpProvider: PROVIDER
    };
}

function filterPixeldrainOnly(results) {
    return (results || []).filter(r => r.url && r.url.toLowerCase().includes('pixel'));
}

async function resolveHostLinks(hostLinks, context) {
    const hubLinks = hostLinks.filter(h => /hubdrive|hubcloud|hubcdn/.test(h));
    const gdflixLinks = hostLinks.filter(h => /gdflix/.test(h));

    // 1) Try hubdrive/hubcloud first
    for (const link of hubLinks) {
        try {
            const extracted = await processExtractorLinkWithAwait(link, 1);
            if (extracted && extracted.length > 0) {
                const streams = extracted.map(r => buildStream(r, context)).filter(Boolean);
                if (streams.length > 0) return streams;
            }
        } catch (err) {
            console.log(`[${PROVIDER}] Hub link failed ${link}: ${err.message}`);
        }
    }

    // 2) Fallback to gdflix -> only pixeldrain results
    for (const link of gdflixLinks) {
        try {
            const extracted = await processExtractorLinkWithAwait(link, 2);
            const pixelOnly = filterPixeldrainOnly(extracted);
            if (pixelOnly && pixelOnly.length > 0) {
                const streams = pixelOnly.map(r => buildStream(r, context)).filter(Boolean);
                if (streams.length > 0) return streams;
            }
        } catch (err) {
            console.log(`[${PROVIDER}] GDFlix fallback failed ${link}: ${err.message}`);
        }
    }

    return [];
}

export async function getCineDozeStreams(tmdbId, type, season = null, episode = null, config = {}, prefetchedMeta = null) {
    try {
        console.log(`[${PROVIDER}] Starting search for ${tmdbId} (${type}${season ? ` S${season}` : ''}${episode ? `E${episode}` : ''})`);

        // Use pre-fetched metadata if available, otherwise fetch it (fallback for direct calls)
        let meta = prefetchedMeta;
        if (!meta) {
            console.log(`[${PROVIDER}] No pre-fetched metadata, fetching from Cinemeta...`);
            meta = await Cinemeta.getMeta(type, tmdbId);
        } else {
            console.log(`[${PROVIDER}] Using pre-fetched Cinemeta metadata: "${meta.name}"`);
        }

        if (!meta?.name) {
            console.log(`[${PROVIDER}] Missing metadata for ${tmdbId}`);
            return [];
        }

        const queries = Array.from(new Set([
            meta.name,
            removeYear(meta.name),
            ...(meta.alternativeTitles || []),
            ...generateAlternativeQueries(meta.name, meta.original_title)
        ].filter(Boolean)));

        // Run searches in parallel for speed
        console.log(`[${PROVIDER}] Searching with ${queries.length} queries in parallel:`, queries);
        const searchPromises = queries.map(query => searchCineDoze(query).then(results => ({ query, results })));
        const searchResponses = await Promise.all(searchPromises);

        const searchResults = [];
        for (const { query, results } of searchResponses) {
            console.log(`[${PROVIDER}] Query "${query}" returned ${results.length} results`);
            searchResults.push(...results);
        }

        if (searchResults.length === 0) {
            console.log(`[${PROVIDER}] No search results for ${meta.name}`);
            return [];
        }

        console.log(`[${PROVIDER}] Total ${searchResults.length} results before dedup/scoring`);
        const best = getSortedMatches(searchResults, meta.name)[0];
        if (!best?.url) {
            console.log(`[${PROVIDER}] No suitable match for ${meta.name}`);
            return [];
        }

        console.log(`[${PROVIDER}] Selected match: ${best.title} -> ${best.url}`);
        const downloadEntries = await loadCineDozePage(best.url);
        if (downloadEntries.length === 0) {
            console.log(`[${PROVIDER}] No download entries found`);
            return [];
        }

        // Check if lazy-load mode is enabled (default: true for faster initial response)
        const useLazyLoad = isLazyLoadEnabled();

        if (useLazyLoad) {
            // Lazy-load mode: expand links and extract final video URLs in parallel
            console.log(`[${PROVIDER}] Lazy-load: extracting ${downloadEntries.length} streams in parallel...`);

            const movieName = meta.name || 'Unknown';
            const movieYear = meta.year || '';

            const previewPromises = downloadEntries.map(async (entry) => {
                const qualityLabel = getResolutionFromName(entry.quality) || 'HTTP';
                const resLabel = qualityLabel === '2160p' ? '4k' : qualityLabel;
                const fallbackTitle = `${movieName}${movieYear ? ` (${movieYear})` : ''} - ${resLabel.toUpperCase()}`;

                try {
                    // Step 1: Expand CineDoze link to get HubCloud URL
                    const hostLinks = await expandCineDozeLink(entry.url);
                    const hubLink = hostLinks.find(h => /hubcloud|hubdrive|hubcdn/.test(h));

                    if (hubLink) {
                        // Step 2: Extract final video URL from HubCloud
                        const extracted = await processExtractorLinkWithAwait(hubLink, 1);

                        if (extracted && extracted.length > 0 && extracted[0].url) {
                            const result = extracted[0];
                            const filename = result.title || result.name || '';

                            // Build display title from filename or fallback
                            let displayName;
                            if (filename) {
                                displayName = filename
                                    .replace(/\.(mkv|mp4|avi|webm)$/i, '')
                                    .replace(/\./g, ' ')
                                    .replace(/_/g, ' ')
                                    .trim();
                            } else {
                                displayName = fallbackTitle;
                            }

                            const languages = entry.languages || detectLanguagesFromTitle(filename || '');
                            const languageFlags = renderLanguageFlags(languages);
                            const size = result.size || entry.size;

                            const sizeInfo = size ? `\n💾 ${size} | ${PROVIDER}` : `\n${PROVIDER}`;
                            const behaviorHints = { bingeGroup: 'cinedoze-http' };
                            const extractedFileName = extractFileName(filename);
                            if (extractedFileName) {
                                behaviorHints.fileName = extractedFileName;
                            }

                            return {
                                name: `[HS+] Sootio\n${resLabel}`,
                                title: `${displayName}${languageFlags}${sizeInfo}`,
                                url: encodeUrlForStreaming(result.url),
                                size,
                                resolution: resLabel,
                                languages,
                                behaviorHints,
                                httpProvider: PROVIDER
                            };
                        }
                    }
                } catch (err) {
                    console.log(`[${PROVIDER}] Failed to extract stream: ${err.message}`);
                }

                // Fallback: return null if extraction failed (skip this entry)
                return null;
            });

            const results = await Promise.all(previewPromises);
            const previewStreams = results.filter(Boolean);

            // Deduplicate by URL (same logic as full extraction mode)
            const seen = new Set();
            const dedupedStreams = [];
            for (const stream of previewStreams) {
                if (!stream.url || seen.has(stream.url)) continue;
                seen.add(stream.url);
                dedupedStreams.push(stream);
            }

            console.log(`[${PROVIDER}] Lazy-load: returning ${dedupedStreams.length} streams (${previewStreams.length - dedupedStreams.length} duplicates removed)`);
            return dedupedStreams;
        }

        // Full extraction mode (when lazy-load is disabled)
        const streamPromises = downloadEntries.map(async (entry) => {
            const hostLinks = await expandCineDozeLink(entry.url);
            if (!hostLinks.length) return [];
            return resolveHostLinks(hostLinks, entry);
        });

        const resolved = (await Promise.all(streamPromises)).flat().filter(Boolean);

        // Deduplicate by URL
        const seen = new Set();
        const streams = [];
        for (const stream of resolved) {
            if (!stream.url || seen.has(stream.url)) continue;
            seen.add(stream.url);
            streams.push(stream);
        }

        console.log(`[${PROVIDER}] Returning ${streams.length} streams`);
        return streams;
    } catch (err) {
        console.error(`[${PROVIDER}] Unexpected error: ${err.message}`);
        return [];
    }
}
