// lib/util/cinemeta.js
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { getCachedMeta as getCachedMetaFromDb, upsertCachedMeta as upsertCachedMetaInDb } from './cinemeta-sql-cache.js';
import debridProxyManager from './debrid-proxy.js';

// In-memory cache for Cinemeta results (avoids redundant fetches within same request)
const metaCache = new Map();
const metaFetchInFlight = new Map(); // Deduplicates concurrent requests for same IMDB ID
const altTitleFetchInFlight = new Map();
const altTitleLogCache = new Map();
const CINEMETA_CACHE_TTL_MS = parseInt(process.env.CINEMETA_CACHE_TTL_MS || '3600000', 10); // 1 hour (metadata rarely changes)
// Allow a slightly longer default timeout to reduce false timeouts under network jitter
const CINEMETA_TIMEOUT_MS = parseInt(process.env.CINEMETA_TIMEOUT_MS || '8000', 10);
const CINEMETA_SLOW_THRESHOLD_MS = parseInt(process.env.CINEMETA_SLOW_THRESHOLD_MS || '4000', 10);
const CINEMETA_MAX_RETRIES = parseInt(process.env.CINEMETA_MAX_RETRIES || '1', 10);
const CINEMETA_RETRY_DELAY_MS = parseInt(process.env.CINEMETA_RETRY_DELAY_MS || '800', 10);
// Add an extra fallback mirror to smooth over upstream hiccups; order reflects preference.
const CINEMETA_BASE_URLS = (process.env.CINEMETA_BASE_URLS || 'https://v3-cinemeta.strem.io,https://cinemeta.strem.io')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
const CINEMETA_FALLBACK_TO_IMDB = process.env.CINEMETA_FALLBACK_TO_IMDB !== 'false';
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const TMDB_FALLBACK_ENABLED = process.env.TMDB_FALLBACK_ENABLED !== 'false';
const TMDB_TIMEOUT_MS = parseInt(process.env.TMDB_TIMEOUT_MS || '8000', 10);
const TMDB_SLOW_THRESHOLD_MS = parseInt(process.env.TMDB_SLOW_THRESHOLD_MS || '4000', 10);
const IMDB_ALT_TIMEOUT_MS = parseInt(process.env.IMDB_ALT_TIMEOUT_MS || '8000', 10);
const IMDB_ALT_SLOW_THRESHOLD_MS = parseInt(process.env.IMDB_ALT_SLOW_THRESHOLD_MS || '4000', 10);
const CINEMETA_LOG_ALT_TITLES = process.env.CINEMETA_LOG_ALT_TITLES === 'true';
const CINEMETA_ALT_LOG_TTL_MS = parseInt(process.env.CINEMETA_ALT_LOG_TTL_MS || '600000', 10);

function shouldLogAltTitles(imdbId) {
    if (!CINEMETA_LOG_ALT_TITLES) return false;
    const now = Date.now();
    const last = altTitleLogCache.get(imdbId);
    if (last && (now - last) < CINEMETA_ALT_LOG_TTL_MS) {
        return false;
    }
    altTitleLogCache.set(imdbId, now);
    return true;
}

function isRetryableCinemetaError(err) {
    const code = err?.code || err?.cause?.code;
    const message = String(err?.message || '').toLowerCase();
    const retryableCodes = new Set([
        'ECONNRESET',
        'ETIMEDOUT',
        'EAI_AGAIN',
        'ENOTFOUND',
        'ECONNABORTED',
        'EPIPE',
        'UND_ERR_CONNECT_TIMEOUT'
    ]);

    if (code && retryableCodes.has(code)) return true;
    if (message.includes('socket hang up')) return true;
    return false;
}

function isCacheableNullStatus(status) {
    return status === 404 || status === 410;
}

function extractYear(text) {
    if (!text) return null;
    const match = String(text).match(/\b(19\d{2}|20\d{2})\b/);
    return match ? match[1] : null;
}

// Manual metadata overrides for cases where Cinemeta has incorrect data
const METADATA_OVERRIDES = {
    'tt15416342': {
        name: 'The Bengal Files',
        year: '2025',
        imdb_id: 'tt15416342'
    }
    // Removed Thamma manual override to test automatic IMDB title fetching
    // 'tt28102562': {
    //     name: 'Thamma',
    //     original_title: 'Vampires of Vijay Nagar',
    //     alternativeTitles: ['Thamma', 'Vampires of Vijay Nagar'],
    //     year: '2025',
    //     imdb_id: 'tt28102562'
    // }
};

/**
 * Fetches alternative titles (AKAs) from IMDB
 * @param {string} imdbId - IMDB ID (e.g., 'tt28102562')
 * @returns {Promise<string[]>} Array of alternative titles
 */
async function fetchImdbAlternativeTitles(imdbId) {
    try {
        console.log(`[Cinemeta] Fetching IMDB alternative titles for ${imdbId}`);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), IMDB_ALT_TIMEOUT_MS);
        const startTime = Date.now();

        const response = await fetch(`https://www.imdb.com/title/${imdbId}/`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept-Language': 'en-US,en;q=0.9'
            },
            signal: controller.signal
        }).finally(() => clearTimeout(timeoutId));

        const duration = Date.now() - startTime;
        if (duration >= IMDB_ALT_SLOW_THRESHOLD_MS) {
            console.error(`[Cinemeta] IMDB alternative titles slow (${duration}ms) for ${imdbId}`);
        }

        if (!response.ok) {
            console.log(`[Cinemeta] IMDB fetch failed with status ${response.status}`);
            return [];
        }

        const html = await response.text();
        const $ = cheerio.load(html);

        const titles = new Set();

        // Get the main title
        const mainTitle = $('h1[data-testid="hero__pageTitle"] span').first().text().trim();
        if (mainTitle) titles.add(mainTitle);

        // Get original title if different
        const originalTitle = $('div[data-testid="hero__pageTitle"] ul li:contains("Original title:")').text().replace('Original title:', '').trim();
        if (originalTitle) titles.add(originalTitle);

        // Try to get AKA titles from the page
        const akaSection = $('li[data-testid="title-details-akas"]');
        if (akaSection.length > 0) {
            // The AKAs might be in a link or button
            const akaText = akaSection.find('a, button, span').text();
            if (akaText && !akaText.includes('See more')) {
                // Clean up common prefixes
                const cleanedText = akaText
                    .replace(/Also known as\s*/gi, '')
                    .replace(/AKA\s*/gi, '');
                // Parse individual AKAs if they're listed
                const akas = cleanedText.split(/[,;]/).map(t => t.trim()).filter(t => t.length > 0);
                akas.forEach(aka => titles.add(aka));
            }
        }

        const result = Array.from(titles).filter(t => t.length > 0 && t.length < 100);
        if (shouldLogAltTitles(imdbId)) {
            console.debug(`[Cinemeta] Found ${result.length} alternative titles from IMDB:`, result);
        }
        return result;
    } catch (err) {
        if (err.name === 'AbortError') {
            console.error(`[Cinemeta] IMDB alternative titles timeout after ${IMDB_ALT_TIMEOUT_MS}ms for ${imdbId}`);
        } else {
            console.error(`[Cinemeta] Error fetching IMDB alternative titles:`, err.message);
        }
        return [];
    }
}

async function fetchImdbFallbackMeta(type, imdbId) {
    try {
        console.warn(`[Cinemeta] Falling back to IMDB metadata for ${imdbId}`);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), IMDB_ALT_TIMEOUT_MS);
        const startTime = Date.now();

        const response = await fetch(`https://www.imdb.com/title/${imdbId}/`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept-Language': 'en-US,en;q=0.9'
            },
            signal: controller.signal
        }).finally(() => clearTimeout(timeoutId));

        const duration = Date.now() - startTime;
        if (duration >= IMDB_ALT_SLOW_THRESHOLD_MS) {
            console.error(`[Cinemeta] IMDB fallback slow (${duration}ms) for ${imdbId}`);
        }

        if (!response.ok) {
            console.error(`[Cinemeta] IMDB fallback failed with status ${response.status} for ${imdbId}`);
            return null;
        }

        const html = await response.text();
        const $ = cheerio.load(html);

        let name = '';
        let year = '';

        const titleTag = $('title').first().text().trim();
        const titleMatch = titleTag.match(/^(.*?)\s*\((\d{4})(?:–\d{4})?\)\s*-\s*IMDb$/i);
        if (titleMatch) {
            name = titleMatch[1].trim();
            year = titleMatch[2];
        }

        if (!name) {
            const mainTitle = $('h1[data-testid="hero__pageTitle"] span').first().text().trim();
            if (mainTitle) name = mainTitle;
        }

        if (!year) {
            const yearCandidates = [
                $('a[href*="releaseinfo"]').first().text().trim(),
                $('span[data-testid="release-year"]').first().text().trim(),
                $('ul[data-testid="hero-title-block__metadata"] li').first().text().trim()
            ];
            for (const candidate of yearCandidates) {
                const parsedYear = extractYear(candidate);
                if (parsedYear) {
                    year = parsedYear;
                    break;
                }
            }
        }

        if (!name) {
            console.error(`[Cinemeta] IMDB fallback could not parse title for ${imdbId}`);
            return null;
        }

        return {
            name,
            year: year || undefined,
            imdb_id: imdbId,
            type
        };
    } catch (err) {
        if (err.name === 'AbortError') {
            console.error(`[Cinemeta] IMDB fallback timeout after ${IMDB_ALT_TIMEOUT_MS}ms for ${imdbId}`);
        } else {
            console.error(`[Cinemeta] IMDB fallback error for ${imdbId}:`, err.message);
        }
        return null;
    }
}

function normalizeType(type = '') {
    if (type === 'tv') return 'series';
    return type;
}

function normalizeTmdbType(type = '') {
    if (type === 'series') return 'tv';
    return type === 'movie' ? 'movie' : type;
}

function parseTmdbId(id) {
    if (!id) return null;
    const str = String(id).trim();
    if (!str) return null;
    if (/^\d{3,}$/.test(str)) return str;
    const match = str.match(/tmdb[^0-9]*([0-9]{3,})/i) || str.match(/\/(movie|tv)\/([0-9]{3,})/i);
    if (match) {
        return match[2] || match[1];
    }
    return null;
}

async function tmdbFetchJson(url, label) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TMDB_TIMEOUT_MS);
    const startTime = Date.now();
    try {
        const response = await fetch(url, { signal: controller.signal });
        const duration = Date.now() - startTime;
        if (duration >= TMDB_SLOW_THRESHOLD_MS) {
            console.error(`[Cinemeta] TMDB slow response (${duration}ms) for ${label}`);
        }
        if (!response.ok) {
            console.warn(`[Cinemeta] TMDB ${label} failed with status ${response.status}`);
            return null;
        }
        return await response.json();
    } catch (err) {
        if (err.name === 'AbortError') {
            console.error(`[Cinemeta] TMDB ${label} timeout after ${TMDB_TIMEOUT_MS}ms`);
        } else {
            console.error(`[Cinemeta] TMDB ${label} error:`, err.message);
        }
        return null;
    } finally {
        clearTimeout(timeoutId);
    }
}

function buildTmdbMetaFromDetails(details, type, imdbId, tmdbId) {
    if (!details) return null;
    const title = details.title || details.name || details.original_title || details.original_name;
    const date = details.release_date || details.first_air_date || '';
    const year = extractYear(date) || undefined;
    if (!title) return null;
    return {
        name: title,
        year,
        imdb_id: imdbId && String(imdbId).startsWith('tt') ? imdbId : undefined,
        type,
        moviedb_id: tmdbId || details.id,
        tmdb_id: tmdbId || details.id
    };
}

async function fetchTmdbFallbackMeta(type, imdbId) {
    if (!TMDB_API_KEY || !TMDB_FALLBACK_ENABLED) return null;
    const normalizedType = normalizeTmdbType(type);
    const tmdbId = parseTmdbId(imdbId);

    try {
        if (tmdbId) {
            console.warn(`[Cinemeta] Falling back to TMDB metadata for TMDB ID ${tmdbId}`);
            const details = await tmdbFetchJson(
                `https://api.themoviedb.org/3/${normalizedType}/${tmdbId}?api_key=${TMDB_API_KEY}&language=en-US`,
                `${normalizedType}:${tmdbId}`
            );
            return buildTmdbMetaFromDetails(details, type, null, tmdbId);
        }

        if (imdbId && String(imdbId).startsWith('tt')) {
            console.warn(`[Cinemeta] Falling back to TMDB metadata for IMDB ID ${imdbId}`);
            const find = await tmdbFetchJson(
                `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`,
                `find:${imdbId}`
            );
            if (!find) return null;
            const candidates = normalizedType === 'tv' ? (find.tv_results || []) : (find.movie_results || []);
            const first = candidates[0] || (find.movie_results || [])[0] || (find.tv_results || [])[0];
            if (!first?.id) return null;
            const details = await tmdbFetchJson(
                `https://api.themoviedb.org/3/${normalizedType}/${first.id}?api_key=${TMDB_API_KEY}&language=en-US`,
                `${normalizedType}:${first.id}`
            );
            return buildTmdbMetaFromDetails(details, type, imdbId, first.id);
        }
    } catch (err) {
        console.error('[Cinemeta] TMDB fallback error:', err.message);
    }
    return null;
}

async function getMeta(type, imdbId) {
    const normalizedType = normalizeType(type);
    // Check for manual override first
    if (METADATA_OVERRIDES[imdbId]) {
        console.log(`[Cinemeta] Using manual override for ${imdbId}: ${METADATA_OVERRIDES[imdbId].name} (${METADATA_OVERRIDES[imdbId].year})`);
        return METADATA_OVERRIDES[imdbId];
    }

    // Check in-memory cache first (avoids redundant fetches for same request)
    const cacheKey = `${normalizedType}:${imdbId}`;
    const cached = metaCache.get(cacheKey);
    const cacheAgeMs = cached ? (Date.now() - cached.timestamp) : null;
    if (cached && cacheAgeMs < CINEMETA_CACHE_TTL_MS) {
        console.log(`[Cinemeta] Cache HIT for ${imdbId}: ${cached.data?.name || 'null'}`);
        return cached.data;
    }

    const shouldCheckDb = !cached || cacheAgeMs >= CINEMETA_CACHE_TTL_MS;
    if (shouldCheckDb) {
        const dbCached = await getCachedMetaFromDb(normalizedType, imdbId);
        if (dbCached.hit) {
            metaCache.set(cacheKey, { data: dbCached.meta, timestamp: Date.now() });
            console.log(`[Cinemeta] DB cache HIT for ${imdbId}: ${dbCached.meta?.name || 'null'}`);
            return dbCached.meta;
        }
    }

    if (cached && cacheAgeMs != null) {
        console.warn(`[Cinemeta] Using stale cache for ${imdbId} (age: ${Math.floor(cacheAgeMs / 1000)}s), refreshing in background`);
        if (!metaFetchInFlight.has(cacheKey)) {
            const refreshPromise = (async () => {
                return await fetchMeta(normalizedType, imdbId, cacheKey);
            })();
            metaFetchInFlight.set(cacheKey, refreshPromise);
            refreshPromise.finally(() => metaFetchInFlight.delete(cacheKey));
        }
        return cached.data;
    }

    // Check if there's already an in-flight request for this IMDB ID (request coalescing)
    // This prevents multiple concurrent requests from hitting Cinemeta simultaneously
    if (metaFetchInFlight.has(cacheKey)) {
        console.log(`[Cinemeta] Coalescing request for ${imdbId} (already in-flight)`);
        return metaFetchInFlight.get(cacheKey);
    }

    // Create the fetch promise and store it for coalescing
    const fetchPromise = fetchMeta(normalizedType, imdbId, cacheKey);

    // Store the in-flight promise for coalescing
    metaFetchInFlight.set(cacheKey, fetchPromise);

    // Clean up in-flight tracker when done
    fetchPromise.finally(() => {
        metaFetchInFlight.delete(cacheKey);
    });

    return fetchPromise;
}

async function fetchMeta(type, imdbId, cacheKey) {
    let lastError = null;
    let lastStatus = null;
    let hadNetworkError = false; // Track if we had any retryable network error
    const baseUrls = CINEMETA_BASE_URLS.length ? CINEMETA_BASE_URLS : ['https://v3-cinemeta.strem.io'];

    for (const baseUrl of baseUrls) {
        for (let attempt = 0; attempt <= CINEMETA_MAX_RETRIES; attempt++) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), CINEMETA_TIMEOUT_MS);
                const startTime = Date.now();

                const safeBase = baseUrl.replace(/\/+$/, '');
                const response = await fetch(`${safeBase}/meta/${type}/${imdbId}.json`, {
                    signal: controller.signal
                }).finally(() => clearTimeout(timeoutId));

                const duration = Date.now() - startTime;
                if (duration >= CINEMETA_SLOW_THRESHOLD_MS) {
                    console.error(`[Cinemeta] Slow metadata response (${duration}ms) for ${type}:${imdbId} via ${safeBase}`);
                }

                if (!response.ok) {
                    lastStatus = response.status;
                    if (response.status >= 500 && attempt < CINEMETA_MAX_RETRIES) {
                        console.warn(`[Cinemeta] ${response.status} from Cinemeta (${safeBase}), retrying (${attempt + 1}/${CINEMETA_MAX_RETRIES})`);
                        await new Promise(resolve => setTimeout(resolve, CINEMETA_RETRY_DELAY_MS));
                        continue;
                    }
                    if (isCacheableNullStatus(response.status)) {
                        metaCache.set(cacheKey, { data: null, timestamp: Date.now() });
                        await upsertCachedMetaInDb(type, imdbId, null, CINEMETA_CACHE_TTL_MS);
                    }
                    console.error(`[Cinemeta] Received a ${response.status} response for ${type}:${imdbId} via ${safeBase}`);
                    break;
                }

                const body = await response.json();
                const meta = body && body.meta;

                metaCache.set(cacheKey, { data: meta, timestamp: Date.now() });
                await upsertCachedMetaInDb(type, imdbId, meta, CINEMETA_CACHE_TTL_MS);

                if (meta && process.env.ENABLE_IMDB_ALTERNATIVE_TITLES !== 'false') {
                    if (!altTitleFetchInFlight.has(imdbId)) {
                        const altFetchPromise = fetchImdbAlternativeTitles(imdbId)
                            .then(async altTitles => {
                                if (altTitles.length > 0) {
                                    meta.alternativeTitles = altTitles;
                                    metaCache.set(cacheKey, { data: meta, timestamp: Date.now() });
                                    await upsertCachedMetaInDb(type, imdbId, meta, CINEMETA_CACHE_TTL_MS);
                                    if (shouldLogAltTitles(imdbId)) {
                                        console.debug(`[Cinemeta] Background: added ${altTitles.length} alternative titles to cache for ${imdbId}`);
                                    }
                                }
                            })
                            .catch(() => {
                                if (shouldLogAltTitles(imdbId)) {
                                    console.debug(`[Cinemeta] Background: failed to fetch alternative titles for ${imdbId}`);
                                }
                            })
                            .finally(() => {
                                altTitleFetchInFlight.delete(imdbId);
                            });

                        altTitleFetchInFlight.set(imdbId, altFetchPromise);
                    }
                }

                return meta;
            } catch (err) {
                lastError = err;
                // Treat network errors, timeouts, and truncated JSON responses as network issues
                if (isRetryableCinemetaError(err) || err.name === 'AbortError' || err.name === 'SyntaxError') {
                    hadNetworkError = true;
                }
                if (err.name === 'AbortError') {
                    console.error(`[Cinemeta] Metadata timeout after ${CINEMETA_TIMEOUT_MS}ms for ${type}:${imdbId} via ${baseUrl}`);
                } else {
                    console.error(`[Cinemeta] A network or parsing error occurred:`, err);
                }
                if (attempt < CINEMETA_MAX_RETRIES && isRetryableCinemetaError(err)) {
                    await new Promise(resolve => setTimeout(resolve, CINEMETA_RETRY_DELAY_MS));
                    continue;
                }
                break;
            }
        }
    }

    // If we had a network error and proxy is available, retry with proxy
    const proxyAgent = debridProxyManager.getProxyAgent('cinemeta');
    if (hadNetworkError && proxyAgent) {
        console.log(`[Cinemeta] Retrying with SOCKS5 proxy after network error for ${type}:${imdbId}`);
        const primaryUrl = baseUrls[0].replace(/\/+$/, '');
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), CINEMETA_TIMEOUT_MS);
            const startTime = Date.now();

            const response = await fetch(`${primaryUrl}/meta/${type}/${imdbId}.json`, {
                signal: controller.signal,
                agent: proxyAgent
            }).finally(() => clearTimeout(timeoutId));

            const duration = Date.now() - startTime;
            if (duration >= CINEMETA_SLOW_THRESHOLD_MS) {
                console.error(`[Cinemeta] Slow proxy response (${duration}ms) for ${type}:${imdbId}`);
            }

            if (response.ok) {
                const body = await response.json();
                const meta = body && body.meta;
                metaCache.set(cacheKey, { data: meta, timestamp: Date.now() });
                await upsertCachedMetaInDb(type, imdbId, meta, CINEMETA_CACHE_TTL_MS);
                console.log(`[Cinemeta] Proxy retry successful for ${type}:${imdbId}`);
                return meta;
            } else {
                console.warn(`[Cinemeta] Proxy retry failed with status ${response.status} for ${type}:${imdbId}`);
                lastStatus = response.status;
            }
        } catch (proxyErr) {
            if (proxyErr.name === 'AbortError') {
                console.error(`[Cinemeta] Proxy retry timeout after ${CINEMETA_TIMEOUT_MS}ms for ${type}:${imdbId}`);
            } else {
                console.error(`[Cinemeta] Proxy retry error for ${type}:${imdbId}:`, proxyErr.message);
            }
        }
    }

    const tmdbIdCandidate = parseTmdbId(imdbId);
    const shouldFallbackToTmdb = TMDB_FALLBACK_ENABLED && TMDB_API_KEY && (
        hadNetworkError || (lastStatus && lastStatus >= 500) || tmdbIdCandidate
    );
    if (shouldFallbackToTmdb) {
        const tmdbMeta = await fetchTmdbFallbackMeta(type, imdbId);
        if (tmdbMeta) {
            metaCache.set(cacheKey, { data: tmdbMeta, timestamp: Date.now() });
            await upsertCachedMetaInDb(type, imdbId, tmdbMeta, CINEMETA_CACHE_TTL_MS);
            return tmdbMeta;
        }
    }

    const shouldFallbackToImdb = CINEMETA_FALLBACK_TO_IMDB && (
        hadNetworkError || (lastStatus && lastStatus >= 500)
    );
    if (shouldFallbackToImdb) {
        const fallbackMeta = await fetchImdbFallbackMeta(type, imdbId);
        if (fallbackMeta) {
            metaCache.set(cacheKey, { data: fallbackMeta, timestamp: Date.now() });
            await upsertCachedMetaInDb(type, imdbId, fallbackMeta, CINEMETA_CACHE_TTL_MS);
            return fallbackMeta;
        }
    }
    if (hadNetworkError) {
        const cached = metaCache.get(cacheKey);
        if (cached?.data) {
            console.warn(`[Cinemeta] Returning stale cache for ${imdbId} after retries exhausted`);
            return cached.data;
        }
    }
    return null;
}

export default { getMeta };
