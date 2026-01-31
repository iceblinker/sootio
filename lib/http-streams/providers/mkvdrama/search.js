/**
 * MKVDrama search helpers
 * Provides search and post parsing utilities for mkvdrama.net
 */

import * as cheerio from 'cheerio';
import axios from 'axios';
import { makeRequest } from '../../utils/http.js';
import { cleanTitle } from '../../utils/parsing.js';
import * as config from '../../../config.js';
import * as SqliteCache from '../../../util/cache-store.js';

const BASE_URL = 'https://mkvdrama.net';
// ouo.io is the primary short link service, oii.la/ouo.press appear on some pages
const OUO_HOSTS = ['ouo.io', 'ouo.press', 'oii.la'];
const MKVDRAMA_COOKIE = config.MKVDRAMA_COOKIE || '';
const FLARESOLVERR_URL = config.FLARESOLVERR_URL || process.env.FLARESOLVERR_URL || '';
const FLARESOLVERR_PROXY_URL = config.FLARESOLVERR_PROXY_URL || process.env.FLARESOLVERR_PROXY_URL || '';
const FLARESOLVERR_V2 = config.FLARESOLVERR_V2 || process.env.FLARESOLVERR_V2 === 'true';
const MKVDRAMA_CACHE_DISABLED = process.env.MKVDRAMA_CACHE_DISABLED === 'true';

// Cache configuration
const CF_COOKIE_CACHE_TTL = parseInt(process.env.MKVDRAMA_CF_COOKIE_TTL, 10) || 0; // 0 = reuse until denied
const SQLITE_SERVICE_KEY = 'mkvdrama';
const SQLITE_CF_COOKIE_PREFIX = 'cf_cookie:';
const CF_COOKIE_CACHE = new Map(); // domain -> { cookies, userAgent } (in-memory fallback)
const FLARESOLVERR_LOCKS = new Map(); // domain -> Promise (prevents thundering herd)


// Helper to get from SQLite/Postgres cache
async function getDbCached(hashKey, ttl) {
    if (MKVDRAMA_CACHE_DISABLED) return null;
    if (!SqliteCache.isEnabled()) return null;
    try {
        const cached = await SqliteCache.getCachedRecord(SQLITE_SERVICE_KEY, hashKey);
        if (!cached?.data) return null;
        const updatedAt = cached.updatedAt || cached.createdAt;
        if (updatedAt && (!ttl || ttl <= 0)) {
            return cached.data;
        }
        if (updatedAt) {
            const age = Date.now() - new Date(updatedAt).getTime();
            if (age <= ttl) return cached.data;
        }
    } catch (error) {
        console.error(`[MKVDrama] Failed to read db cache: ${error.message}`);
    }
    return null;
}

// Helper to write to SQLite/Postgres cache
async function setDbCache(hashKey, data, ttlMs) {
    if (MKVDRAMA_CACHE_DISABLED) return;
    if (!SqliteCache.isEnabled()) return;
    try {
        await SqliteCache.upsertCachedMagnet({
            service: SQLITE_SERVICE_KEY,
            hash: hashKey,
            data,
            releaseKey: 'mkvdrama-http-streams'
        }, { ttlMs });
    } catch (error) {
        console.error(`[MKVDrama] Failed to write db cache: ${error.message}`);
    }
}

// Get CF cookies - check SQLite first (persists across restarts), then in-memory
async function getCachedCfCookies(domain) {
    if (!domain) return null;
    if (MKVDRAMA_CACHE_DISABLED) return null;

    // Check in-memory cache first (fastest)
    const memCached = CF_COOKIE_CACHE.get(domain);
    if (memCached) return memCached;

    // Check SQLite/Postgres cache (survives restarts)
    try {
        const dbCached = await getDbCached(`${SQLITE_CF_COOKIE_PREFIX}${domain}`, CF_COOKIE_CACHE_TTL);
        if (dbCached?.cookies) {
            // Populate in-memory cache for future requests
            CF_COOKIE_CACHE.set(domain, dbCached);
            console.log(`[MKVDrama] Restored CF cookies from DB for ${domain}`);
            return dbCached;
        }
    } catch (error) {
        console.error(`[MKVDrama] Failed to get CF cookie from DB: ${error.message}`);
    }

    return null;
}

// Cache CF cookies to both in-memory and SQLite (for persistence)
async function cacheCfCookies(domain, cookies, userAgent) {
    if (!domain || !Array.isArray(cookies) || cookies.length === 0) return;
    if (MKVDRAMA_CACHE_DISABLED) return;

    // Cache ALL cookies from FlareSolverr, not just CF ones
    // This allows reuse of session cookies even when no CF challenge was present
    const cookieString = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
    if (!cookieString) return;

    const cookieData = {
        cookies: cookieString,
        userAgent: userAgent || USER_AGENTS[0]
    };

    // Save to in-memory cache
    CF_COOKIE_CACHE.set(domain, cookieData);

    // Persist to SQLite/Postgres (survives restarts)
    const cookieNames = cookies.map(c => c.name).join(', ');
    try {
        await setDbCache(`${SQLITE_CF_COOKIE_PREFIX}${domain}`, cookieData, CF_COOKIE_CACHE_TTL);
        console.log(`[MKVDrama] Cached cookies for ${domain} (memory + DB): ${cookieNames}`);
    } catch (error) {
        console.error(`[MKVDrama] Failed to persist cookie to DB: ${error.message}`);
        console.log(`[MKVDrama] Cached cookies for ${domain} (memory only): ${cookieNames}`);
    }
}

function clearCachedCfCookies(domain) {
    if (!domain) return;
    if (MKVDRAMA_CACHE_DISABLED) return;
    CF_COOKIE_CACHE.delete(domain);
    // Also clear from DB
    setDbCache(`${SQLITE_CF_COOKIE_PREFIX}${domain}`, null, 0).catch(() => {});
}

/**
 * Fetch a page from mkvdrama.net using direct requests
 * FlareSolverr is only used for ouo.io links in http-resolver.js
 * If MKVDRAMA_COOKIE is set, it will be used for requests (for Cloudflare bypass)
 */
// Common browser User-Agents to try
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0'
];

async function fetchPage(url, signal = null) {
    const domain = (() => {
        try { return new URL(url).hostname; } catch { return null; }
    })();
    try {
        const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
        const headers = {
            'User-Agent': userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1'
        };
        let usedCachedCookie = false;
        if (MKVDRAMA_COOKIE) {
            headers['Cookie'] = MKVDRAMA_COOKIE;
            console.log(`[MKVDrama] Using configured cookie for ${url}`);
        } else {
            const cached = await getCachedCfCookies(domain);
            if (cached?.cookies) {
                headers['Cookie'] = cached.cookies;
                headers['User-Agent'] = cached.userAgent || headers['User-Agent'];
                usedCachedCookie = true;
                console.log(`[MKVDrama] Using cached CF cookies for ${url}`);
            }
        }
        const response = await makeRequest(url, {
            parseHTML: true,
            signal,
            timeout: 15000,
            headers
        });

        const body = response.body || '';
        const lower = body.toLowerCase();
        const isCloudflare =
            lower.includes('just a moment') ||
            lower.includes('checking your browser') ||
            lower.includes('cf-browser-verification');

        // Only treat as Cloudflare blocked if we see actual challenge markers in HTML
        const isCloudflareBlocked = isCloudflare;

        // Clear cached cookies if they didn't work (got 403/429/503 or CF challenge)
        const gotBlocked = isCloudflareBlocked ||
            response.statusCode === 403 ||
            response.statusCode === 429 ||
            response.statusCode === 503;
        if (gotBlocked && usedCachedCookie) {
            console.log(`[MKVDrama] Cached cookies failed (status ${response.statusCode}), clearing for ${domain}`);
            clearCachedCfCookies(domain);
        }

        // Use FlareSolverr if:
        // 1. Actual Cloudflare challenge detected, OR
        // 2. Got 403/429 AND we have no cached cookies (need to bootstrap)
        // Note: If we had cached cookies but they failed, we cleared them above
        // and should NOT immediately retry FlareSolverr to avoid loops
        const needsFlareSolverr = isCloudflareBlocked ||
            ((response.statusCode === 403 || response.statusCode === 429 || response.statusCode === 503) && !usedCachedCookie);

        if (needsFlareSolverr && FLARESOLVERR_URL) {
            const flare = await fetchWithFlareSolverr(url, headers);
            if (flare) return flare;

            // FlareSolverr returned null - maybe we waited for another request that got cookies
            // Check if we now have cached cookies and retry the direct request
            const newCached = await getCachedCfCookies(domain);
            if (newCached?.cookies && newCached.cookies !== headers['Cookie']) {
                console.log(`[MKVDrama] Retrying with fresh CF cookies for ${url}`);
                headers['Cookie'] = newCached.cookies;
                headers['User-Agent'] = newCached.userAgent || headers['User-Agent'];
                try {
                    const retryResponse = await makeRequest(url, {
                        parseHTML: true,
                        signal,
                        timeout: 15000,
                        headers
                    });
                    if (retryResponse.statusCode < 400) {
                        console.log(`[MKVDrama] Retry successful for ${url}`);
                        return retryResponse.document || null;
                    }
                } catch (retryErr) {
                    console.log(`[MKVDrama] Retry failed for ${url}: ${retryErr.message}`);
                }
            }
        }

        if (isCloudflare) {
            console.error(`[MKVDrama] Cloudflare challenge detected for ${url} - set MKVDRAMA_COOKIE with cf_clearance`);
            return null;
        }

        if (response.statusCode >= 400) {
            console.error(`[MKVDrama] Request failed for ${url}: status ${response.statusCode}`);
            return null;
        }

        console.log(`[MKVDrama] Successfully fetched ${url} (status: ${response.statusCode}, body length: ${body.length})`);
        return response.document || null;
    } catch (error) {
        console.error(`[MKVDrama] Request failed for ${url}: ${error.message}`);
        return null;
    }
}

// Internal function that actually calls FlareSolverr
async function _doFlareSolverrRequest(url, headers = {}) {
    const flareTimeout = Math.max(30000, 15000 * 3);
    const domain = (() => {
        try { return new URL(url).hostname; } catch { return null; }
    })();
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
            timeout: flareTimeout + 5000
        });
        const solution = response?.data?.solution;
        if (!solution?.response) {
            console.log(`[MKVDrama] FlareSolverr returned no response for ${url}`);
            return { success: false, body: null };
        }
        const body = solution.response;
        const lower = String(body).toLowerCase();
        if (lower.includes('just a moment') || lower.includes('checking your browser') || lower.includes('cf-browser-verification')) {
            console.log(`[MKVDrama] FlareSolverr still blocked for ${url}`);
            return { success: false, body: null };
        }
        if (domain && solution.cookies) {
            await cacheCfCookies(domain, solution.cookies, solution.userAgent || headers['User-Agent']);
        }
        console.log(`[MKVDrama] FlareSolverr success for ${url} (status: ${solution.status || 'n/a'})`);
        return { success: true, body };
    } catch (error) {
        console.log(`[MKVDrama] FlareSolverr error for ${url}: ${error.message}`);
        return { success: false, body: null };
    }
}

// Wrapper that prevents thundering herd - only one FlareSolverr call per domain at a time
async function fetchWithFlareSolverr(url, headers = {}) {
    if (!FLARESOLVERR_URL) return null;

    const domain = (() => {
        try { return new URL(url).hostname; } catch { return null; }
    })();

    // If there's already a FlareSolverr request in progress for this domain, wait for it
    const existingLock = domain ? FLARESOLVERR_LOCKS.get(domain) : null;
    if (existingLock) {
        console.log(`[MKVDrama] Waiting for existing FlareSolverr request for ${domain}...`);
        try {
            await existingLock;
            // After waiting, check if we now have cached cookies
            const cached = await getCachedCfCookies(domain);
            if (cached?.cookies) {
                console.log(`[MKVDrama] Using cookies from completed FlareSolverr request for ${domain}`);
                return null; // Return null to signal caller should retry with cached cookies
            }
        } catch {
            // Lock failed, continue to make our own request
        }
    }

    // Create a lock for this domain
    let resolveLock;
    const lockPromise = new Promise(resolve => { resolveLock = resolve; });
    if (domain) {
        FLARESOLVERR_LOCKS.set(domain, lockPromise);
    }

    try {
        const result = await _doFlareSolverrRequest(url, headers);
        if (result.success && result.body) {
            return cheerio.load(result.body);
        }
        return null;
    } finally {
        // Release the lock
        if (domain) {
            FLARESOLVERR_LOCKS.delete(domain);
        }
        resolveLock?.();
    }
}

function normalizeUrl(href, base = BASE_URL) {
    if (!href) return null;
    try {
        return new URL(href, base).toString();
    } catch {
        return null;
    }
}

function cleanText(text = '') {
    return text.replace(/\s+/g, ' ').trim();
}

function decodeMkvDramaToken(token = '') {
    if (!token) return null;
    try {
        const decoded = Buffer.from(String(token), 'base64').toString('utf8').trim();
        return decoded || null;
    } catch {
        return null;
    }
}

function buildMkvDramaTokenUrl(token = '') {
    if (!token) return null;
    return `${BASE_URL}/?mkv_token=${encodeURIComponent(token)}`;
}

function normalizeHostName(text = '') {
    const normalized = cleanText(text).toLowerCase();
    if (!normalized) return null;
    if (normalized.includes('pixeldrain')) return 'pixeldrain.com';
    if (normalized.includes('gofile')) return 'gofile.io';
    if (normalized.includes('mega')) return 'mega.nz';
    if (normalized.includes('send.now')) return 'send.now';
    if (normalized.includes('send.cm')) return 'send.cm';
    return normalized.includes('.') ? normalized : null;
}

function getHostFromElement($, element) {
    if (!element) return null;
    const hostAttr = $(element)
        .closest('[data-oc2le],[data-07cgr]')
        .attr('data-oc2le') || $(element).closest('[data-07cgr]').attr('data-07cgr');
    return normalizeHostName(hostAttr || '');
}

function collectEncodedLinks($, scope, fallbackLabel = '') {
    const downloadLinks = [];
    const seen = new Set();

    scope.find('[data-riwjd]').each((_, el) => {
        const tokenRaw = $(el).attr('data-riwjd');
        const decoded = decodeMkvDramaToken(tokenRaw);
        const url = buildMkvDramaTokenUrl(decoded);
        if (!url || seen.has(url)) return;
        seen.add(url);

        const container = $(el).closest('div');
        const episodeContainer = $(el).closest('[data-4xptf]');
        const episodeLabel = cleanText(
            episodeContainer.attr('data-4xptf') ||
            episodeContainer.find('h2').first().text() ||
            fallbackLabel
        );
        const label = cleanText(container.find('span').first().text()) || episodeLabel || fallbackLabel;
        const quality = label;
        const host = getHostFromElement($, el) || normalizeHostName(container.find('span').eq(1).text());
        const episodeRange = parseEpisodeRange(episodeLabel);
        const season = parseSeasonNumber(episodeLabel);

        downloadLinks.push({
            url,
            label: episodeLabel || label,
            quality,
            linkText: label,
            host,
            episodeStart: episodeRange?.start ?? null,
            episodeEnd: episodeRange?.end ?? null,
            season
        });
    });

    return downloadLinks;
}

function parseEpisodeRange(label = '') {
    const normalized = label || '';
    const match = normalized.match(/(?:episode|episodes|ep|eps)\.?\s*(\d{1,3})(?:\s*(?:-|to|–|—|&|and)\s*(\d{1,3}))?/i);
    if (match) {
        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : start;
        if (Number.isNaN(start)) return null;
        return { start, end };
    }

    const seMatch = normalized.match(/\bS(\d{1,2})E(\d{1,3})\b/i);
    if (seMatch) {
        const episode = parseInt(seMatch[2], 10);
        if (!Number.isNaN(episode)) return { start: episode, end: episode };
    }

    const eMatch = normalized.match(/\bE(\d{1,3})\b/i);
    if (eMatch) {
        const episode = parseInt(eMatch[1], 10);
        if (!Number.isNaN(episode)) return { start: episode, end: episode };
    }

    return null;
}

function parseSeasonNumber(label = '') {
    const normalized = label || '';
    const match = normalized.match(/season\s*(\d{1,2})/i) ||
        normalized.match(/\bS(\d{1,2})E\d{1,3}\b/i) ||
        normalized.match(/\bS(\d{1,2})\b/i);
    if (!match) return null;
    const season = parseInt(match[1], 10);
    return Number.isNaN(season) ? null : season;
}

function isOuoLink(url) {
    if (!url) return false;
    return OUO_HOSTS.some(host => url.toLowerCase().includes(host));
}

function collectDownloadLinks($, scope) {
    const downloadLinks = [];
    const seen = new Set();

    const addLink = (entry) => {
        if (!entry?.url || seen.has(entry.url)) return;
        seen.add(entry.url);
        downloadLinks.push(entry);
    };

    scope.each((_, el) => {
        const block = $(el);
        const episodeLabel = cleanText(block.find('.sorattlx, .sorattl, .soratt, h3, h4').first().text());
        const season = parseSeasonNumber(episodeLabel);
        const episodeRange = parseEpisodeRange(episodeLabel);

        block.find('.soraurlx, .soraurl').each((__, linkBox) => {
            const $box = $(linkBox);
            const quality = cleanText($box.find('strong, b').first().text());

            $box.find('a[href]').each((___, link) => {
                const href = $(link).attr('href');
                const absolute = normalizeUrl(href, BASE_URL);
                if (!absolute || !isOuoLink(absolute)) return;

                const host = getHostFromElement($, link) || normalizeHostName($(link).text());

                addLink({
                    url: absolute,
                    label: episodeLabel,
                    quality,
                    linkText: cleanText($(link).text()),
                    host,
                    episodeStart: episodeRange?.start ?? null,
                    episodeEnd: episodeRange?.end ?? null,
                    season
                });
            });
        });
    });

    return downloadLinks;
}

function collectLooseOuoLinks($, scope, fallbackLabel = '') {
    const downloadLinks = [];
    const seen = new Set();

    scope.find('a[href]').each((_, link) => {
        const href = $(link).attr('href');
        const absolute = normalizeUrl(href, BASE_URL);
        if (!absolute || !isOuoLink(absolute) || seen.has(absolute)) return;
        seen.add(absolute);

        const container = $(link).closest('li, p, div').first();
        const label = cleanText(
            container.find('h1, h2, h3, h4, h5, strong, b').first().text()
        ) || fallbackLabel;
        const quality = cleanText(container.find('strong, b').first().text());
        const episodeRange = parseEpisodeRange(label);
        const season = parseSeasonNumber(label);
        const host = getHostFromElement($, link) || normalizeHostName($(link).text());

        downloadLinks.push({
            url: absolute,
            label,
            quality,
            linkText: cleanText($(link).text()),
            host,
            episodeStart: episodeRange?.start ?? null,
            episodeEnd: episodeRange?.end ?? null,
            season
        });
    });

    return downloadLinks;
}

function collectEpisodePostLinks($) {
    const candidates = [];
    const seen = new Set();

    const addCandidate = (title, url) => {
        if (!title || !url || seen.has(url)) return;
        seen.add(url);
        const episodeRange = parseEpisodeRange(title);
        const season = parseSeasonNumber(title);
        candidates.push({
            title,
            url,
            episodeStart: episodeRange?.start ?? null,
            episodeEnd: episodeRange?.end ?? null,
            season
        });
    };

    const selectors = [
        'h2[itemprop="headline"] a[href]',
        'h2.entry-title a[href]',
        'article h2 a[href]',
        'a[rel="bookmark"]'
    ];

    selectors.forEach((selector) => {
        $(selector).each((_, el) => {
            const anchor = $(el);
            const title = cleanText(anchor.text() || anchor.attr('title'));
            const url = normalizeUrl(anchor.attr('href'));
            addCandidate(title, url);
        });
    });

    $('.tt').each((_, el) => {
        const block = $(el);
        const title = cleanText(block.find('h2, b').first().text());
        let anchor = block.find('a[href]').first();
        if (!anchor.length) anchor = block.closest('a[href]');
        if (!anchor.length) anchor = block.parent().find('a[href]').first();
        const url = normalizeUrl(anchor.attr('href'));
        addCandidate(title, url);
    });

    return candidates;
}

function matchesEpisodeEntry(entry, season, episode) {
    if (!episode) return true;
    const seasonNumber = season ? parseInt(season, 10) : null;
    const episodeNumber = parseInt(episode, 10);
    if (Number.isNaN(episodeNumber)) return true;
    if (entry.season && seasonNumber && entry.season !== seasonNumber) return false;
    if (entry.episodeStart && entry.episodeEnd) {
        return episodeNumber >= entry.episodeStart && episodeNumber <= entry.episodeEnd;
    }
    return false;
}

function findEpisodePost($, season, episode) {
    if (!episode) return null;
    const candidates = collectEpisodePostLinks($);
    const match = candidates.find((entry) => matchesEpisodeEntry(entry, season, episode));
    if (match) return match;

    const episodeNumber = parseInt(episode, 10);
    if (Number.isNaN(episodeNumber)) return null;
    const episodeRegex = new RegExp(`\\b(ep(?:isode)?\\s*0*${episodeNumber}\\b|e0*${episodeNumber}\\b|s\\d{1,2}e0*${episodeNumber}\\b)`, 'i');
    return candidates.find((entry) => episodeRegex.test(entry.title)) || null;
}

function hasExactEpisodeMatch(downloadLinks, season, episode) {
    if (!episode) return false;
    const episodeNumber = parseInt(episode, 10);
    if (Number.isNaN(episodeNumber)) return false;
    const seasonNumber = season ? parseInt(season, 10) : null;
    return downloadLinks.some((entry) => {
        if (entry.episodeStart === null || entry.episodeEnd === null) return false;
        if (entry.episodeStart !== episodeNumber || entry.episodeEnd !== episodeNumber) return false;
        if (entry.season && seasonNumber && entry.season !== seasonNumber) return false;
        return true;
    });
}

/**
 * Convert a query string to a URL slug
 * "Burnout Syndrome" -> "burnout-syndrome"
 */
function toSlug(query) {
    return query
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '') // Remove special characters
        .replace(/\s+/g, '-')          // Replace spaces with hyphens
        .replace(/-+/g, '-')           // Collapse multiple hyphens
        .replace(/^-|-$/g, '');        // Trim leading/trailing hyphens
}

/**
 * Generate multiple URL patterns to try for a given slug
 * The mkvdrama site uses various URL formats:
 * - /{slug}/
 * - /series/{slug}/
 * - /download-{slug}/
 * - /download-drama-korea-{slug}/
 * - /download-korean-drama-{slug}/
 * - /download-kdrama-{slug}/
 * - /{slug}-korean-drama/
 * - /{slug}-kdrama/
 */
function generateSlugUrls(slug) {
    if (!slug) return [];
    return [
        `${BASE_URL}/${slug}/`,
        `${BASE_URL}/series/${slug}/`,
        `${BASE_URL}/download-${slug}/`,
        `${BASE_URL}/download-drama-korea-${slug}/`,
        `${BASE_URL}/download-korean-drama-${slug}/`,
        `${BASE_URL}/download-kdrama-${slug}/`,
        `${BASE_URL}/${slug}-korean-drama/`,
        `${BASE_URL}/${slug}-kdrama/`
    ];
}

/**
 * Try to fetch a single URL and validate it has content
 * Returns page info if valid, null otherwise
 */
async function tryFetchSlugUrl(url, signal = null) {
    try {
        const $ = await fetchPage(url, signal);
        if (!$) return null;

        // Check if this is a valid content page (has a title and content)
        let title = cleanText($('h1.entry-title').text()) || cleanText($('title').text()) || '';
        title = title.replace(/\s*\|\s*MkvDrama.*$/i, '').trim();

        if (!title) return null;

        // Check for download links or content indicators
        const hasContent = $('.soraddlx, .soraddl, .soradd, .entry-content').length > 0;
        if (!hasContent) return null;

        const yearMatch = title.match(/\b(19|20)\d{2}\b/);
        const poster = $('img.wp-post-image').attr('data-lazy-src') ||
                       $('img.wp-post-image').attr('src') ||
                       $('.thumb img').attr('data-lazy-src') ||
                       $('.thumb img').attr('src') || null;

        return {
            title,
            url,
            year: yearMatch ? parseInt(yearMatch[0], 10) : null,
            poster,
            normalizedTitle: cleanTitle(title)
        };
    } catch (error) {
        return null;
    }
}

/**
 * Try to fetch a direct slug URL and extract page info
 * Tries multiple URL patterns that mkvdrama uses
 */
async function tryDirectSlugUrl(query, signal = null) {
    const slug = toSlug(query);
    if (!slug) return null;

    const urls = generateSlugUrls(slug);
    console.log(`[MKVDrama] Trying ${urls.length} direct slug URL patterns for "${query}"`);

    for (const url of urls) {
        console.log(`[MKVDrama] Trying: ${url}`);
        const result = await tryFetchSlugUrl(url, signal);
        if (result) {
            console.log(`[MKVDrama] Found content via direct slug: "${result.title}" at ${url}`);
            return result;
        }
    }

    console.log(`[MKVDrama] No content found via direct slug patterns`);
    return null;
}

export async function scrapeMkvDramaSearch(query, signal = null) {
    if (!query) return [];

    const cleanQuery = query.replace(/:/g, '').replace(/\s+/g, ' ').trim();

    const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(cleanQuery)}`;

    console.log(`[MKVDrama] Search query: "${cleanQuery}", URL: ${searchUrl}`);

    try {
        const $ = await fetchPage(searchUrl, signal);
        if (!$) {
            console.log(`[MKVDrama] fetchPage returned null for search, trying direct slug...`);
            // Search page failed, try direct slug as fallback
            const directResult = await tryDirectSlugUrl(cleanQuery, signal);
            console.log(`[MKVDrama] Direct slug result: ${directResult ? directResult.title : 'null'}`);
            return directResult ? [directResult] : [];
        }
        const results = [];
        const seen = new Set();

        const addResult = (title, url, poster = null) => {
            if (!title || !url || seen.has(url)) return;
            seen.add(url);
            const yearMatch = title.match(/\b(19|20)\d{2}\b/);
            results.push({
                title,
                url,
                year: yearMatch ? parseInt(yearMatch[0], 10) : null,
                poster,
                normalizedTitle: cleanTitle(title)
            });
        };

        const articles = $('article');
        console.log(`[MKVDrama] Found ${articles.length} article elements in search results`);

        articles.each((_, el) => {
            const anchor = $(el).find('.bsx a').first();
            const title = cleanText(anchor.attr('title') || anchor.text());
            const url = normalizeUrl(anchor.attr('href'));
            const poster = $(el).find('img').attr('data-lazy-src') || $(el).find('img').attr('src') || null;
            addResult(title, url, poster);
        });

        if (results.length === 0) {
            const selectors = [
                'h2.entry-title a',
                'h2.post-title a',
                'h2.title a',
                'a[rel="bookmark"]'
            ];
            selectors.forEach((selector) => {
                $(selector).each((_, el) => {
                    const anchor = $(el);
                    const title = cleanText(anchor.attr('title') || anchor.text());
                    const url = normalizeUrl(anchor.attr('href'));
                    const article = anchor.closest('article');
                    const poster = article.find('img').attr('data-lazy-src') || article.find('img').attr('src') || null;
                    addResult(title, url, poster);
                });
            });
        }

        console.log(`[MKVDrama] Parsed ${results.length} results from search page`);

        // If search returned no results, try direct slug URL as fallback
        if (results.length === 0) {
            console.log(`[MKVDrama] Search returned no results, trying direct slug URL...`);
            const directResult = await tryDirectSlugUrl(cleanQuery, signal);
            if (directResult) {
                console.log(`[MKVDrama] Direct slug found: "${directResult.title}" at ${directResult.url}`);
                results.push(directResult);
            } else {
                console.log(`[MKVDrama] Direct slug also returned no results`);
            }
        }

        return results;
    } catch (error) {
        console.error(`[MKVDrama] Search failed for "${query}": ${error.message}`);
        // Try direct slug as last resort
        const directResult = await tryDirectSlugUrl(cleanQuery, signal);
        return directResult ? [directResult] : [];
    }
}

export async function loadMkvDramaContent(postUrl, signal = null, options = {}) {
    if (!postUrl) return { title: '', downloadLinks: [] };
    const depth = options?.depth ?? 0;

    try {
        const $ = await fetchPage(postUrl, signal);
        if (!$) {
            return { title: '', downloadLinks: [] };
        }
        let title = cleanText($('h1.entry-title').text()) || cleanText($('title').text()) || '';
        title = title.replace(/\s*\|\s*MkvDrama.*$/i, '').trim();

        let downloadLinks = collectDownloadLinks($, $('.soraddlx, .soraddl, .soradd'));

        if (downloadLinks.length === 0) {
            $('.sorattlx, .sorattl, .soratt').each((_, el) => {
                const episodeLabel = cleanText($(el).text());
                const season = parseSeasonNumber(episodeLabel);
                const episodeRange = parseEpisodeRange(episodeLabel);
                const linkBox = $(el).nextAll('.soraurlx, .soraurl').first();
                if (!linkBox.length) return;

                const quality = cleanText(linkBox.find('strong, b').first().text());
                linkBox.find('a[href]').each((__, link) => {
                    const href = $(link).attr('href');
                    const absolute = normalizeUrl(href, BASE_URL);
                    if (!absolute || !isOuoLink(absolute)) return;

                    downloadLinks.push({
                        url: absolute,
                        label: episodeLabel,
                        quality,
                        linkText: cleanText($(link).text()),
                        episodeStart: episodeRange?.start ?? null,
                        episodeEnd: episodeRange?.end ?? null,
                        season
                    });
                });
            });
        }

        if (downloadLinks.length > 0) {
            const titleEpisodeRange = parseEpisodeRange(title);
            const titleSeason = parseSeasonNumber(title);
            if (titleEpisodeRange || titleSeason) {
                downloadLinks = downloadLinks.map((entry) => {
                    if (entry.episodeStart || entry.episodeEnd || entry.season) return entry;
                    return {
                        ...entry,
                        episodeStart: titleEpisodeRange?.start ?? null,
                        episodeEnd: titleEpisodeRange?.end ?? null,
                        season: titleSeason ?? null
                    };
                });
            }
        }

        if (options?.episode && depth < 1) {
            const hasExact = hasExactEpisodeMatch(downloadLinks, options?.season, options?.episode);
            if (!hasExact) {
                const episodePost = findEpisodePost($, options?.season, options?.episode);
                if (episodePost?.url && episodePost.url !== postUrl) {
                    const nested = await loadMkvDramaContent(episodePost.url, signal, {
                        ...options,
                        depth: depth + 1
                    });
                    const nestedHasExact = hasExactEpisodeMatch(nested.downloadLinks || [], options?.season, options?.episode);
                    if (nested.downloadLinks.length && (nestedHasExact || downloadLinks.length === 0)) {
                        return nested;
                    }
                    if (nested.title && !title) {
                        title = nested.title;
                    }
                    if (downloadLinks.length === 0) {
                        downloadLinks = nested.downloadLinks;
                    }
                }
            }
        }

        if (downloadLinks.length === 0) {
            downloadLinks = collectLooseOuoLinks($, $('article, .entry-content, .post-content, body'), title);
        }

        if (downloadLinks.length === 0) {
            downloadLinks = collectEncodedLinks($, $('body'), title);
        }

        const result = { title, downloadLinks };

        return result;
    } catch (error) {
        console.error(`[MKVDrama] Failed to load post ${postUrl}: ${error.message}`);
        return { title: '', downloadLinks: [] };
    }
}
