import axios from 'axios';
import * as cheerio from 'cheerio';
import crypto from 'crypto';
import * as config from '../../config.js';
import { getHashFromMagnet, sizeToBytes } from '../../common/torrent-utils.js';
import { exec } from 'child_process';
import { promisify } from 'util';

// Import scraper utilities
import { createTimerLabel } from '../utils/timing.js';
import { detectSimpleLangs } from '../utils/filtering.js';
import { processAndDeduplicate } from '../utils/deduplication.js';
import { handleScraperError } from '../utils/error-handling.js';
import { generateScraperCacheKey } from '../utils/cache.js';
import * as SqliteCache from '../../util/cache-store.js';

// Keep a stable reference to env config for fallbacks when user config is partial
const ENV = config;

const execPromise = promisify(exec);
const inFlightRequests = new Map();

// Session cache for FlareSolverr - reuses browser sessions to avoid TLS fingerprint issues
const sessionCache = new Map();
const SESSION_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// Simple limiter to reduce FlareSolverr overload when too many requests stack up
const flareSolverrLimiter = {
    active: 0,
    queue: []
};

async function acquireFlareSolverrSlot({ maxConcurrent = 5, timeoutMs = 60000, logPrefix = 'ExtTo', signal = null } = {}) {
    if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
    }

    return new Promise((resolve, reject) => {
        let timeoutId = null;
        let abortHandler = null;

        const grant = () => {
            if (timeoutId) clearTimeout(timeoutId);
            if (abortHandler) signal?.removeEventListener?.('abort', abortHandler);
            flareSolverrLimiter.active += 1;
            resolve(() => {
                flareSolverrLimiter.active = Math.max(0, flareSolverrLimiter.active - 1);
                const next = flareSolverrLimiter.queue.shift();
                if (next) next();
            });
        };

        if (flareSolverrLimiter.active < maxConcurrent) {
            grant();
            return;
        }

        const waiter = () => {
            if (signal?.aborted) {
                reject(new DOMException('Aborted', 'AbortError'));
                return;
            }
            grant();
        };

        flareSolverrLimiter.queue.push(waiter);
        console.log(`[${logPrefix} SCRAPER] ExtTo waiting for FlareSolverr slot (active=${flareSolverrLimiter.active}, max=${maxConcurrent})`);

        if (signal?.addEventListener) {
            abortHandler = () => {
                const idx = flareSolverrLimiter.queue.indexOf(waiter);
                if (idx !== -1) {
                    flareSolverrLimiter.queue.splice(idx, 1);
                }
                if (timeoutId) clearTimeout(timeoutId);
                reject(new DOMException('Aborted', 'AbortError'));
            };
            signal.addEventListener('abort', abortHandler, { once: true });
        }

        if (timeoutMs && timeoutMs > 0) {
            timeoutId = setTimeout(() => {
                const idx = flareSolverrLimiter.queue.indexOf(waiter);
                if (idx !== -1) {
                    flareSolverrLimiter.queue.splice(idx, 1);
                }
                if (abortHandler) signal?.removeEventListener?.('abort', abortHandler);
                reject(new Error('FlareSolverr queue wait timeout'));
            }, timeoutMs);
        }
    });
}

async function postFlareSolverr(flareSolverrUrl, body, { timeout = 30000, logPrefix = 'ExtTo', signal = null, limiter = {} } = {}) {
    const release = await acquireFlareSolverrSlot({
        maxConcurrent: limiter.maxConcurrent,
        timeoutMs: limiter.queueTimeoutMs,
        logPrefix,
        signal
    });

    try {
        return await axios.post(`${flareSolverrUrl}/v1`, body, {
            timeout,
            headers: { 'Content-Type': 'application/json' }
        });
    } finally {
        release();
    }
}

// Cookie cache - persists Cloudflare cookies to avoid FlareSolverr on every request
const COOKIE_CACHE_SERVICE = 'cf_cookie';
const COOKIE_CACHE_TTL = 0; // 0 = reuse until denied
const cookieMemCache = new Map(); // domain -> { cookieHeader, userAgent, timestamp }

/**
 * Get or create a FlareSolverr session for a domain
 * @param {string} flareSolverrUrl - FlareSolverr URL
 * @param {string} domain - Domain to get session for
 * @param {string} logPrefix - Log prefix
 * @returns {Promise<string|null>} - Session ID or null
 */
async function getOrCreateSession(flareSolverrUrl, domain, logPrefix, limiter = {}, signal = null) {
    // Use a deterministic session ID so all workers share the same FlareSolverr browser
    const sessionId = `sootio_extto_${domain.replace(/\./g, '_')}`;

    const cached = sessionCache.get(domain);
    if (cached && (Date.now() - cached.timestamp) < SESSION_CACHE_TTL) {
        return cached.sessionId;
    }

    // Check if session already exists on FlareSolverr (created by another worker)
    try {
        const listResponse = await postFlareSolverr(flareSolverrUrl, {
            cmd: 'sessions.list'
        }, {
            timeout: 10000,
            logPrefix,
            signal,
            limiter
        });

        if (listResponse.data?.sessions?.includes(sessionId)) {
            // Session exists, cache it locally and reuse
            sessionCache.set(domain, { sessionId, timestamp: Date.now() });
            console.log(`[${logPrefix} SCRAPER] ExtTo reusing existing FlareSolverr session: ${sessionId}`);
            return sessionId;
        }
    } catch (error) {
        // Ignore list errors, try to create
    }

    // Create new session
    try {
        const response = await postFlareSolverr(flareSolverrUrl, {
            cmd: 'sessions.create',
            session: sessionId
        }, {
            timeout: 30000,
            logPrefix,
            signal,
            limiter
        });

        if (response.data?.status === 'ok') {
            sessionCache.set(domain, { sessionId, timestamp: Date.now() });
            console.log(`[${logPrefix} SCRAPER] ExtTo created FlareSolverr session: ${sessionId}`);
            return sessionId;
        }
    } catch (error) {
        // Session might already exist (race with another worker), check if we can use it
        if (error.response?.data?.message?.includes('already exists')) {
            sessionCache.set(domain, { sessionId, timestamp: Date.now() });
            console.log(`[${logPrefix} SCRAPER] ExtTo using existing FlareSolverr session: ${sessionId}`);
            return sessionId;
        }
        console.log(`[${logPrefix} SCRAPER] ExtTo failed to create session: ${error.message}`);
    }
    return null;
}

/**
 * Destroy a FlareSolverr session
 * @param {string} flareSolverrUrl - FlareSolverr URL
 * @param {string} sessionId - Session ID to destroy
 */
async function destroySession(flareSolverrUrl, sessionId) {
    try {
        await axios.post(`${flareSolverrUrl}/v1`, {
            cmd: 'sessions.destroy',
            session: sessionId
        }, {
            timeout: 10000,
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        // Ignore destroy errors
    }
}

/**
 * Get cached Cloudflare cookie from SQLite
 * @param {string} domain - Domain to get cookie for
 * @returns {Promise<{cookieHeader: string, userAgent: string}|null>}
 */
async function getCachedCookie(domain) {
    try {
        const cacheKey = `${domain}_cf_cookie`;
        const memCached = cookieMemCache.get(domain);
        if (memCached?.cookieHeader && memCached?.userAgent) {
            return memCached;
        }
        const result = await SqliteCache.getCachedRecord(COOKIE_CACHE_SERVICE, cacheKey);
        if (result?.data && (result.data.cookieHeader || result.data.cfClearance) && result.data.userAgent) {
            // Check if cookie is still valid (within TTL)
            const age = Date.now() - (result.data.timestamp || 0);
            if (!COOKIE_CACHE_TTL || COOKIE_CACHE_TTL <= 0 || age < COOKIE_CACHE_TTL) {
                const cookieHeader = result.data.cookieHeader || `cf_clearance=${result.data.cfClearance}`;
                const hydrated = {
                    cookieHeader,
                    userAgent: result.data.userAgent,
                    timestamp: result.data.timestamp
                };
                cookieMemCache.set(domain, hydrated);
                return hydrated;
            }
        }
    } catch (error) {
        // Ignore cache errors
    }
    return null;
}

/**
 * Save Cloudflare cookie to SQLite for reuse
 * @param {string} domain - Domain the cookie is for
 * @param {string} cookieHeader - Full Cookie header value
 * @param {string} userAgent - The user agent used (must match for cookie to work)
 * @param {string|null} cfClearance - Optional cf_clearance value
 */
async function saveCookie(domain, cookieHeader, userAgent, cfClearance = null) {
    try {
        const cacheKey = `${domain}_cf_cookie`;
        const normalizedHeader = cookieHeader?.trim() || '';
        const clearanceValue = cfClearance || (normalizedHeader.match(/(?:^|;\s*)cf_clearance=([^;]+)/)?.[1] || null);
        const cookieData = {
            cfClearance: clearanceValue,
            cookieHeader: normalizedHeader || (clearanceValue ? `cf_clearance=${clearanceValue}` : ''),
            userAgent,
            timestamp: Date.now()
        };
        cookieMemCache.set(domain, cookieData);
        return await SqliteCache.upsertCachedMagnet({
            service: COOKIE_CACHE_SERVICE,
            hash: cacheKey,
            data: cookieData
        }, { ttlMs: COOKIE_CACHE_TTL });
    } catch (error) {
        // Ignore cache errors
        return false;
    }
    return false;
}

/**
 * Extract cf_clearance cookie from FlareSolverr response cookies
 * @param {Array} cookies - Array of cookie objects from FlareSolverr
 * @returns {string|null} - cf_clearance value or null
 */
function extractCfClearance(cookies) {
    if (!Array.isArray(cookies)) return null;
    const cfCookie = cookies.find(c => c.name === 'cf_clearance');
    return cfCookie?.value || null;
}

/**
 * Extract full Cookie header from FlareSolverr response cookies
 * @param {Array} cookies - Array of cookie objects from FlareSolverr
 * @returns {string|null} - Cookie header string
 */
function extractCookieHeader(cookies) {
    if (!Array.isArray(cookies) || cookies.length === 0) return null;
    return cookies
        .map(c => `${c.name}=${c.value}`)
        .join('; ');
}

async function clearCachedCookie(domain) {
    if (!domain) return;
    cookieMemCache.delete(domain);
    try {
        await SqliteCache.deleteCachedHash(COOKIE_CACHE_SERVICE, `${domain}_cf_cookie`);
    } catch (error) {
        // Ignore cache errors
    }
}

/**
 * Verify that a cf_clearance cookie actually works by making a test request
 * @param {string} baseUrl - Base URL to test
 * @param {string} cfClearance - The cf_clearance cookie value
 * @param {string} userAgent - The user agent to use
 * @param {number} timeout - Request timeout
 * @param {string} logPrefix - Log prefix
 * @returns {Promise<boolean>} - True if cookie works
 */
async function verifyCookie(baseUrl, cfClearance, userAgent, timeout, logPrefix) {
    try {
        const testUrl = baseUrl; // Just test the base URL
        const escapedUrl = testUrl.replace(/'/g, "'\\''");

        const curlCmd = `curl -s -L --compressed \
            -H 'User-Agent: ${userAgent}' \
            -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' \
            -H 'Cookie: cf_clearance=${cfClearance}' \
            '${escapedUrl}'`;

        const { stdout } = await execPromise(curlCmd, { timeout: Math.min(timeout, 15000) });

        // Check if we're still getting Cloudflare challenge
        if (stdout.includes('Just a moment...') || stdout.includes('Checking your browser') || stdout.includes('cf-browser-verification')) {
            console.log(`[${logPrefix} SCRAPER] ExtTo cookie verification FAILED - still blocked`);
            return false;
        }

        // Check if we got actual HTML content (not an error page)
        if (stdout.length > 1000 && (stdout.includes('</html>') || stdout.includes('</HTML>'))) {
            console.log(`[${logPrefix} SCRAPER] ExtTo cookie verification SUCCESS`);
            return true;
        }

        console.log(`[${logPrefix} SCRAPER] ExtTo cookie verification UNCLEAR - response length: ${stdout.length}`);
        return stdout.length > 500; // Assume it works if we got substantial content
    } catch (error) {
        console.log(`[${logPrefix} SCRAPER] ExtTo cookie verification error: ${error.message}`);
        return false;
    }
}

/**
 * Fetch a page using FlareSolverr with session reuse
 * First request solves the challenge, subsequent requests reuse the session (fast)
 * Also extracts and saves cf_clearance cookie for future curl requests
 * @param {string} url - The URL to fetch
 * @param {string} flareSolverrUrl - The FlareSolverr service URL
 * @param {number} timeout - Request timeout in ms
 * @param {string} logPrefix - Logging prefix
 * @param {string|null} sessionId - Optional session ID to reuse
 * @returns {Promise<{html: string|null, sessionId: string|null}>}
 */
async function fetchWithFlareSolverr(url, flareSolverrUrl, timeout, logPrefix, sessionId = null, limiter = {}, signal = null) {
    try {
        // For session reuse, we need less time since challenge is already solved
        const flareSolverrTimeout = sessionId
            ? Math.max(timeout, 30000)  // 30s for session reuse
            : Math.max(timeout * 4, 60000); // 60s+ for fresh solve

        const requestBody = {
            cmd: 'request.get',
            url: url,
            maxTimeout: flareSolverrTimeout
        };

        // Add session if provided
        if (sessionId) {
            requestBody.session = sessionId;
        }

        const response = await postFlareSolverr(flareSolverrUrl, requestBody, {
            timeout: flareSolverrTimeout + 5000,
            logPrefix,
            signal,
            limiter
        });

        if (response.data?.status === 'ok' && response.data?.solution?.response) {
            const isSessionReuse = sessionId ? ' (session reuse)' : '';
            console.log(`[${logPrefix} SCRAPER] ExtTo FlareSolverr success${isSessionReuse}`);

            // Extract cf_clearance cookie for future curl requests
            const domain = new URL(url).hostname;
            const baseUrl = new URL(url).origin;
            const cfClearance = extractCfClearance(response.data.solution.cookies);
            const cookieHeader = extractCookieHeader(response.data.solution.cookies);
            const userAgent = response.data.solution.userAgent;

            if ((cfClearance || cookieHeader) && userAgent) {
                const saved = await saveCookie(domain, cookieHeader || `cf_clearance=${cfClearance}`, userAgent, cfClearance);
                if (saved) {
                    console.log(`[${logPrefix} SCRAPER] ExtTo saved cf cookie for ${domain}`);
                } else {
                    console.log(`[${logPrefix} SCRAPER] ExtTo cf cookie cache backend rejected save`);
                }
            } else {
                console.log(`[${logPrefix} SCRAPER] ExtTo FlareSolverr response did not include cf_clearance cookie, skipping cache`);
            }

            return {
                html: response.data.solution.response,
                sessionId: sessionId, // Return the session ID for reuse
                cookieHeader: cookieHeader,
                userAgent: userAgent
            };
        }

        console.log(`[${logPrefix} SCRAPER] ExtTo FlareSolverr returned status: ${response.data?.status}`);

        // If session failed, it might be expired - clear it
        if (sessionId && response.data?.status !== 'ok') {
            const domain = new URL(url).hostname;
            sessionCache.delete(domain);
        }

        return { html: null, sessionId: null, cookieHeader: null, userAgent: null };
    } catch (error) {
        console.log(`[${logPrefix} SCRAPER] ExtTo FlareSolverr error: ${error.message}`);

        // Clear session on error
        if (sessionId) {
            const domain = new URL(url).hostname;
            sessionCache.delete(domain);
        }

        return { html: null, sessionId: null, cookieHeader: null, userAgent: null };
    }
}

/**
 * Fetch a page using curl with browser-like headers
 * Can use saved cf_clearance cookie to bypass Cloudflare without FlareSolverr
 * @param {string} url - The URL to fetch
 * @param {number} timeout - Request timeout in ms
 * @param {string} logPrefix - Logging prefix
 * @param {object|null} cookieData - Optional cookie data {cfClearance, userAgent}
 * @returns {Promise<{html: string|null, isChallenge: boolean, error: Error|null}>}
 */
async function fetchWithCurl(url, timeout, logPrefix, cookieData = null) {
    try {
        // Use saved user agent if we have a cookie, otherwise use default
        const userAgent = cookieData?.userAgent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0';
        const escapedUrl = url.replace(/'/g, "'\\''");

        // Build cookie header if we have cookies
        const cookieHeader = cookieData?.cookieHeader
            ? `-H 'Cookie: ${cookieData.cookieHeader}' `
            : '';

        const curlCmd = `curl -s -L --compressed \
            -H 'User-Agent: ${userAgent}' \
            -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' \
            -H 'Accept-Language: en-US,en;q=0.5' \
            -H 'Accept-Encoding: gzip, deflate, br' \
            -H 'Connection: keep-alive' \
            -H 'Upgrade-Insecure-Requests: 1' \
            -H 'Sec-Fetch-Dest: document' \
            -H 'Sec-Fetch-Mode: navigate' \
            -H 'Sec-Fetch-Site: none' \
            ${cookieHeader}'${escapedUrl}'`;

        const { stdout } = await execPromise(curlCmd, { timeout });

        // Check if we got a Cloudflare challenge page
        // Only check for actual challenge indicators, not cookie names
        if (stdout.includes('Just a moment...') || stdout.includes('Checking your browser') || stdout.includes('cf-browser-verification')) {
            const withCookie = cookieData ? ' (cookie expired)' : '';
            console.log(`[${logPrefix} SCRAPER] ExtTo curl blocked by Cloudflare challenge${withCookie}`);
            return { html: null, isChallenge: true, error: null };
        }

        return { html: stdout, isChallenge: false, error: null };
    } catch (error) {
        console.log(`[${logPrefix} SCRAPER] ExtTo curl error: ${error.message}`);
        return { html: null, isChallenge: false, error };
    }
}

/**
 * Compute HMAC for ExtTo API
 * Formula: SHA256(torrentId + '|' + timestamp + '|' + pageToken)
 */
function computeExtToHmac(torrentId, timestamp, pageToken) {
    const data = `${torrentId}|${timestamp}|${pageToken}`;
    return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Extract tokens from ExtTo page HTML
 * Note: Search pages have 'searchPageToken', detail pages have 'pageToken'
 * The API uses the token as 'pageToken' regardless of source
 * @param {string} html - The HTML content
 * @returns {{pageToken: string|null, csrfToken: string|null}}
 */
function extractExtToTokens(html) {
    // Try pageToken first (detail pages), then searchPageToken (search results)
    const pageTokenMatch = html.match(/window\.pageToken\s*=\s*['"]([a-f0-9]+)['"]/);
    const searchPageTokenMatch = html.match(/window\.searchPageToken\s*=\s*['"]([a-f0-9]+)['"]/);
    const csrfTokenMatch = html.match(/window\.csrfToken\s*=\s*['"]([a-f0-9]+)['"]/);
    return {
        pageToken: pageTokenMatch?.[1] || searchPageTokenMatch?.[1] || null,
        csrfToken: csrfTokenMatch?.[1] || null
    };
}

/**
 * Fetch magnet hash from ExtTo via API
 * 1. Visit detail page to get tokens (pageToken, csrfToken)
 * 2. Call the API with those tokens to get the magnet link
 * @param {string} detailUrl - The detail page URL
 * @param {string} torrentId - The torrent ID
 * @param {string} flareSolverrUrl - FlareSolverr URL
 * @param {string} sessionId - FlareSolverr session ID
 * @param {string} logPrefix - Logging prefix
 * @param {object} limiter - FlareSolverr limiter config
 * @param {AbortSignal} signal - Abort signal
 * @returns {Promise<string|null>} - The info hash or null
 */
async function fetchMagnetHashViaApi(detailUrl, torrentId, flareSolverrUrl, sessionId, logPrefix, limiter = {}, signal = null, debug = false) {
    try {
        // Step 1: Visit detail page to get tokens
        const pageResponse = await postFlareSolverr(flareSolverrUrl, {
            cmd: 'request.get',
            url: detailUrl,
            session: sessionId,
            maxTimeout: 25000
        }, {
            timeout: 30000,
            logPrefix,
            signal,
            limiter
        });

        if (pageResponse.data?.status !== 'ok' || !pageResponse.data?.solution?.response) {
            if (debug) console.log(`[${logPrefix} SCRAPER] ExtTo API: ${torrentId} - detail page fetch failed`);
            return null;
        }

        const html = pageResponse.data.solution.response;

        // Check if it's an actual 404 error page (not just any page with "404" text)
        if (html.includes('Page not found') && html.includes('<title>Page not found')) {
            if (debug) console.log(`[${logPrefix} SCRAPER] ExtTo API: ${torrentId} - detail page 404`);
            return null;
        }

        // Extract tokens
        const pageToken = html.match(/window\.pageToken\s*=\s*['"]([a-f0-9]+)['"]/i)?.[1];
        const csrfToken = html.match(/window\.csrfToken\s*=\s*['"]([a-f0-9]+)['"]/i)?.[1];

        if (!pageToken || !csrfToken) {
            if (debug) console.log(`[${logPrefix} SCRAPER] ExtTo API: ${torrentId} - missing tokens (pageToken: ${!!pageToken}, csrfToken: ${!!csrfToken})`);
            return null;
        }

        // Step 2: Call API with tokens
        const timestamp = Math.floor(Date.now() / 1000);
        const hmac = crypto.createHash('sha256').update(`${torrentId}|${timestamp}|${pageToken}`).digest('hex');

        const apiResponse = await postFlareSolverr(flareSolverrUrl, {
            cmd: 'request.post',
            url: 'https://ext.to/ajax/getTorrentMagnet.php',
            session: sessionId,
            postData: `torrent_id=${torrentId}&download_type=magnet&timestamp=${timestamp}&hmac=${hmac}&sessid=${csrfToken}`,
            maxTimeout: 20000
        }, {
            timeout: 25000,
            logPrefix,
            signal,
            limiter
        });

        if (apiResponse.data?.status === 'ok' && apiResponse.data?.solution?.response) {
            const responseText = apiResponse.data.solution.response;

            // Parse JSON from the response (it's wrapped in HTML)
            const jsonMatch = responseText.match(/\{[^}]+\}/);
            if (jsonMatch) {
                try {
                    const data = JSON.parse(jsonMatch[0]);
                    if (data.success && data.url) {
                        // Extract hash from magnet URL
                        const hashMatch = data.url.match(/btih:([a-fA-F0-9]{40})/i);
                        if (hashMatch) {
                            return hashMatch[1].toLowerCase();
                        }
                        if (debug) console.log(`[${logPrefix} SCRAPER] ExtTo API: ${torrentId} - no hash in magnet URL`);
                    } else {
                        if (debug) console.log(`[${logPrefix} SCRAPER] ExtTo API: ${torrentId} - API error: ${data.error || 'unknown'}`);
                    }
                } catch (e) {
                    if (debug) console.log(`[${logPrefix} SCRAPER] ExtTo API: ${torrentId} - JSON parse error`);
                }
            } else {
                if (debug) console.log(`[${logPrefix} SCRAPER] ExtTo API: ${torrentId} - no JSON in response`);
            }
        } else {
            if (debug) console.log(`[${logPrefix} SCRAPER] ExtTo API: ${torrentId} - API call failed`);
        }
    } catch (error) {
        if (debug) console.log(`[${logPrefix} SCRAPER] ExtTo API: ${torrentId} - exception: ${error.message}`);
    }
    return null;
}

/**
 * Parse ext.to search results HTML
 * New format: Extract torrent IDs and metadata, then fetch hashes via API
 * @param {string} html - The HTML content to parse
 * @param {number} limit - Maximum number of results
 * @param {string} logPrefix - Logging prefix
 * @returns {{torrents: Array, tokens: {pageToken: string|null, csrfToken: string|null}}}
 */
function parseExtToResults(html, limit, logPrefix) {
    const $ = cheerio.load(html);
    const torrents = [];
    const seen = new Set();

    // Extract tokens for API calls
    const tokens = extractExtToTokens(html);

    // Find all magnet buttons with data-id
    const magnetButtons = $('a.search-magnet-btn[data-id]');

    console.log(`[${logPrefix} SCRAPER] ExtTo found ${magnetButtons.length} magnet buttons`);

    magnetButtons.each((i, el) => {
        if (torrents.length >= limit) return false;

        try {
            const btn = $(el);
            const torrentId = btn.attr('data-id');

            if (!torrentId || seen.has(torrentId)) return;
            seen.add(torrentId);

            // Find the parent row to extract metadata
            const row = btn.closest('tr');

            // Get title and detail URL from torrent-title-link
            const titleLink = row.find('.torrent-title-link');
            let title = titleLink.attr('data-tooltip') || titleLink.text().trim() || 'Unknown Title';
            // Clean up HTML entities in title
            title = title.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
            // Remove any remaining HTML tags
            title = title.replace(/<[^>]+>/g, '');

            // Get detail page URL
            let detailUrl = titleLink.attr('href');
            if (detailUrl && !detailUrl.startsWith('http')) {
                detailUrl = 'https://ext.to' + detailUrl;
            }

            // Extract size - look for size pattern in td elements
            let size = 0;
            row.find('td').each((idx, td) => {
                const text = $(td).text().trim();
                const sizeMatch = text.match(/^(\d+(?:\.\d+)?)\s*(GB|MB|KB|TB|B)$/i);
                if (sizeMatch && size === 0) {
                    size = sizeToBytes(text);
                }
            });

            // Extract seeders from .text-success
            const seedersText = row.find('.text-success').first().text().trim();
            const seeders = parseInt(seedersText) || 0;

            // Extract leechers from .text-danger
            const leechersText = row.find('.text-danger').first().text().trim();
            const leechers = parseInt(leechersText) || 0;

            torrents.push({
                torrentId,
                detailUrl,
                Title: title,
                Size: size,
                Seeders: seeders,
                Leechers: leechers,
                Tracker: 'ExtTo',
                Langs: detectSimpleLangs(title)
            });
        } catch (e) {
            // Skip individual parse errors
        }
    });

    return { torrents, tokens };
}

/**
 * Search ext.to for torrents
 * @param {string} query - Search query
 * @param {AbortSignal} signal - Abort signal
 * @param {string} logPrefix - Logging prefix
 * @param {object} config - Configuration object
 * @returns {Promise<Array>} - Array of torrent results
 */
export async function searchExtTo(query, signal, logPrefix, config) {
    const scraperName = 'ExtTo';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    const timerLabel = createTimerLabel(logPrefix, scraperName, sfx);
    console.time(timerLabel);

    const cacheKey = generateScraperCacheKey(scraperName, query, config);
    const cachedResult = await SqliteCache.getCachedRecord('scraper', cacheKey);
    const cached = cachedResult?.data || null;

    if (cached && Array.isArray(cached)) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${cached.length} results from cache.`);
        console.timeEnd(timerLabel);
        return cached;
    }

    const existingPromise = inFlightRequests.get(cacheKey);
    if (existingPromise) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} awaiting in-flight request for ${cacheKey}`);
        try {
            return await existingPromise;
        } finally {
            console.timeEnd(timerLabel);
        }
    }

    let isOwner = false;

    const scrapePromise = (async () => {
        const limit = config?.EXTTO_LIMIT ?? ENV.EXTTO_LIMIT ?? 100;
        const maxPages = config?.EXTTO_MAX_PAGES ?? ENV.EXTTO_MAX_PAGES ?? 2;
        const base = ((config?.EXTTO_URL || ENV.EXTTO_URL) || 'https://ext.to').replace(/\/$/, '');
        // Use EXTTO_TIMEOUT which defaults to 65s for FlareSolverr compatibility
        const timeout = config?.EXTTO_TIMEOUT ?? ENV.EXTTO_TIMEOUT ?? 65000;
        const flareMaxConcurrent = config?.EXTTO_FLARESOLVERR_MAX_CONCURRENT ?? ENV.EXTTO_FLARESOLVERR_MAX_CONCURRENT ?? 5;
        const flareQueueTimeoutMs = config?.EXTTO_FLARESOLVERR_QUEUE_TIMEOUT_MS ?? ENV.EXTTO_FLARESOLVERR_QUEUE_TIMEOUT_MS ?? 60000;
        const flareSolverrUrl = config?.FLARESOLVERR_URL || ENV.FLARESOLVERR_URL || '';
        const flareLimiter = {
            maxConcurrent: Math.max(1, parseInt(flareMaxConcurrent, 10) || 1),
            queueTimeoutMs: Math.max(0, parseInt(flareQueueTimeoutMs, 10) || 0)
        };

        // Check for abort signal
        if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }

        const allTorrents = [];
        const seenIds = new Set();
        const seenHashes = new Set();
        let pageToken = null;
        let csrfToken = null;
        let apiCookieHeader = null;  // Cookies for API calls
        let apiUserAgent = null;     // User agent for API calls

        // Extract domain for session caching
        const domain = new URL(base).hostname;

        // Check for cached cf_clearance cookie first (avoids FlareSolverr entirely)
        let cachedCookie = await getCachedCookie(domain);
        let sessionId = null;

        // Fetch multiple pages
        for (let page = 1; page <= maxPages; page++) {
            if (signal?.aborted) break;
            if (allTorrents.length >= limit) break;

            // Build search URL - ext.to uses /browse/ for search
            // Include page_size=100 for maximum results per page and with_adult=1 to include all content
            const searchUrl = `${base}/browse/?page_size=100&q=${encodeURIComponent(query)}&with_adult=1&page=${page}`;
            console.log(`[${logPrefix} SCRAPER] ${scraperName} searching page ${page}: ${searchUrl}`);

            let html = null;
            let challengeDetected = false;

            // Strategy: Try curl first (with or without cookie), only use FlareSolverr if Cloudflare blocks us

            // 1. Try curl with cached cf_clearance cookie (fastest - no FlareSolverr needed)
            if (cachedCookie) {
                if (page === 1) {
                    console.log(`[${logPrefix} SCRAPER] ${scraperName} trying cached cf_clearance cookie with curl`);
                }
                const curlResult = await fetchWithCurl(searchUrl, timeout, logPrefix, cachedCookie);
                html = curlResult.html;
                if (curlResult.isChallenge) {
                    challengeDetected = true;
                }

                // If curl worked, capture cookies for API calls
                if (html && !apiCookieHeader && cachedCookie.cookieHeader) {
                    apiCookieHeader = cachedCookie.cookieHeader;
                    apiUserAgent = cachedCookie.userAgent;
                    console.log(`[${logPrefix} SCRAPER] ${scraperName} using cached cookies for API calls`);
                }

                // If cookie failed, clear it and try plain curl
                if (!html) {
                    cachedCookie = null;
                    if (curlResult.isChallenge) {
                        await clearCachedCookie(domain);
                    }
                }
            }

            // 2. Try plain curl without cookie (check if Cloudflare is even active)
            if (!html) {
                if (page === 1) {
                    console.log(`[${logPrefix} SCRAPER] ${scraperName} trying direct curl`);
                }
                const curlResult = await fetchWithCurl(searchUrl, timeout, logPrefix);
                html = curlResult.html;
                if (curlResult.isChallenge) {
                    challengeDetected = true;
                }
            }

            // 3. Use FlareSolverr if curl failed for ANY reason (not just challenge detection)
            // This handles network errors, timeouts, and Cloudflare blocks
            if (!html && flareSolverrUrl) {
                if (page === 1 || !sessionId) {
                    // Get or create session on first FlareSolverr use
                    sessionId = await getOrCreateSession(flareSolverrUrl, domain, logPrefix, flareLimiter, signal);
                    const reason = challengeDetected ? 'Cloudflare challenge' : 'curl failed';
                    console.log(`[${logPrefix} SCRAPER] ${scraperName} ${reason}, using FlareSolverr at ${flareSolverrUrl}${sessionId ? ' (with session)' : ''}`);
                }
                let result = await fetchWithFlareSolverr(searchUrl, flareSolverrUrl, timeout, logPrefix, sessionId, flareLimiter, signal);
                html = result.html;

                // If FlareSolverr with session failed, try again WITHOUT session (session might be stale)
                if (!html && sessionId) {
                    console.log(`[${logPrefix} SCRAPER] ${scraperName} FlareSolverr with session failed, retrying without session`);
                    sessionCache.delete(domain);
                    sessionId = null;
                    result = await fetchWithFlareSolverr(searchUrl, flareSolverrUrl, timeout, logPrefix, null, flareLimiter, signal);
                    html = result.html;
                }

                // If FlareSolverr succeeded, capture cookies for API calls
                if (html) {
                    cachedCookie = await getCachedCookie(domain);
                    // Store cookies and userAgent for API calls (from first successful FlareSolverr response)
                    if (!apiCookieHeader && result.cookieHeader) {
                        apiCookieHeader = result.cookieHeader;
                        apiUserAgent = result.userAgent;
                        console.log(`[${logPrefix} SCRAPER] ${scraperName} captured cookies for API calls`);
                    }
                }

                // If we got a session back, use it for subsequent pages
                if (result.sessionId && !sessionId) {
                    sessionId = result.sessionId;
                }
            }

            if (!html) {
                if (page === 1) {
                    // First page failed - this is a captcha/cloudflare block
                    // Throw a specific error so performance tracker can count consecutive failures
                    const captchaError = new Error('Cloudflare challenge failed - captcha or cookie invalid');
                    captchaError.isCaptcha = true;
                    throw captchaError;
                }
                break;
            }

            // Parse results from this page
            const { torrents: pageTorrents, tokens: pageTokens } = parseExtToResults(html, limit, logPrefix);
            console.log(`[${logPrefix} SCRAPER] ${scraperName} page ${page} found ${pageTorrents.length} torrents`);

            // Store tokens for hash fetching (use first page's tokens)
            if (page === 1 && pageTokens.pageToken && pageTokens.csrfToken) {
                pageToken = pageTokens.pageToken;
                csrfToken = pageTokens.csrfToken;
                console.log(`[${logPrefix} SCRAPER] ${scraperName} extracted tokens for hash fetching`);
            }

            // Add unique torrents (will fetch hashes later)
            for (const torrent of pageTorrents) {
                if (allTorrents.length >= limit) break;
                if (!seenIds.has(torrent.torrentId)) {
                    seenIds.add(torrent.torrentId);
                    allTorrents.push(torrent);
                }
            }

            // Only continue to next page if current page was full (100 results = likely more available)
            if (pageTorrents.length < 100) {
                console.log(`[${logPrefix} SCRAPER] ${scraperName} page ${page} had ${pageTorrents.length} torrents (not full), stopping pagination`);
                break;
            }
        }

        // Now fetch hashes for all torrents from detail pages
        if (allTorrents.length === 0) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} no torrents found`);
            return [];
        }

        // Filter torrents that have detail URLs
        const torrentsWithUrls = allTorrents.filter(t => t.detailUrl);
        if (torrentsWithUrls.length === 0) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} no torrents have detail URLs`);
            return [];
        }

        // Need FlareSolverr and session for fetching detail pages
        if (!flareSolverrUrl) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} no FlareSolverr URL configured, cannot fetch hashes from detail pages`);
            return [];
        }

        // Get or create session if we don't have one yet
        if (!sessionId) {
            sessionId = await getOrCreateSession(flareSolverrUrl, domain, logPrefix, flareLimiter, signal);
            if (!sessionId) {
                console.log(`[${logPrefix} SCRAPER] ${scraperName} failed to create FlareSolverr session for hash fetching`);
                return [];
            }
        }

        console.log(`[${logPrefix} SCRAPER] ${scraperName} fetching hashes via API for ${torrentsWithUrls.length} torrents...`);

        // Batch fetch hashes with concurrency limit
        // Using batch size of 1 (sequential) to avoid session conflicts when parallel requests
        // hit different detail pages and get different CSRF tokens
        const HASH_BATCH_SIZE = 1;
        const results = [];

        for (let i = 0; i < torrentsWithUrls.length; i += HASH_BATCH_SIZE) {
            if (signal?.aborted) break;

            const batch = torrentsWithUrls.slice(i, i + HASH_BATCH_SIZE);
            const hashPromises = batch.map(torrent =>
                fetchMagnetHashViaApi(torrent.detailUrl, torrent.torrentId, flareSolverrUrl, sessionId, logPrefix, flareLimiter, signal)
                    .then(hash => ({ torrent, hash }))
                    .catch(() => ({ torrent, hash: null }))
            );

            const batchResults = await Promise.all(hashPromises);

            for (const { torrent, hash } of batchResults) {
                if (hash && !seenHashes.has(hash)) {
                    seenHashes.add(hash);
                    results.push({
                        Title: torrent.Title,
                        InfoHash: hash,
                        Size: torrent.Size,
                        Seeders: torrent.Seeders,
                        Leechers: torrent.Leechers || 0,
                        Tracker: torrent.Tracker,
                        Langs: torrent.Langs,
                        Magnet: `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(torrent.Title)}`
                    });
                }
            }

            // Log progress
            if ((i + HASH_BATCH_SIZE) % 15 === 0 || i + HASH_BATCH_SIZE >= torrentsWithUrls.length) {
                console.log(`[${logPrefix} SCRAPER] ${scraperName} processed ${Math.min(i + HASH_BATCH_SIZE, torrentsWithUrls.length)}/${torrentsWithUrls.length} torrents, got ${results.length} valid hashes`);
            }
        }

        console.log(`[${logPrefix} SCRAPER] ${scraperName} raw results before processing: ${results.length}`);
        if (results.length > 0) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} Sample raw results:`);
            results.slice(0, 3).forEach((r, i) => {
                console.log(`  ${i+1}. ${r.Title}`);
                console.log(`     Hash: ${r.InfoHash}, Size: ${(r.Size / (1024**3)).toFixed(2)} GB, Seeders: ${r.Seeders}, Langs: [${r.Langs.join(', ')}]`);
            });
        }

        const processedResults = processAndDeduplicate(results, config);

        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${processedResults.length} results after processing (filtered from ${results.length}).`);
        if (processedResults.length > 0) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} Sample processed results:`);
            processedResults.slice(0, 3).forEach((r, i) => {
                console.log(`  ${i+1}. ${r.Title}`);
                console.log(`     Hash: ${r.InfoHash}, Size: ${(r.Size / (1024**3)).toFixed(2)} GB, Seeders: ${r.Seeders}, Langs: [${r.Langs.join(', ')}]`);
            });
        }

        return processedResults;
    })();

    inFlightRequests.set(cacheKey, scrapePromise);
    isOwner = true;

    try {
        const processedResults = await scrapePromise;

        if (isOwner && processedResults.length > 0) {
            try {
                const saved = await SqliteCache.upsertCachedMagnet({
                    service: 'scraper',
                    hash: cacheKey,
                    data: processedResults
                });
                if (saved) {
                    console.log(`[${logPrefix} SCRAPER] ${scraperName} saved ${processedResults.length} results to cache`);
                }
            } catch (cacheError) {
                console.warn(`[${logPrefix} SCRAPER] ${scraperName} failed to save to cache: ${cacheError.message}`);
            }
        }

        return processedResults;
    } catch (error) {
        handleScraperError(error, scraperName, logPrefix);
        return [];
    } finally {
        if (isOwner) {
            inFlightRequests.delete(cacheKey);
        }
        console.timeEnd(timerLabel);
    }
}
