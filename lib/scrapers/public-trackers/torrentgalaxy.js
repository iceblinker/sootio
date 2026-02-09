import axios from 'axios';
import * as config from '../../config.js';
import * as SqliteCache from '../../util/cache-store.js';
import { exec } from 'child_process';
import { promisify } from 'util';

// Import scraper utilities
import { createTimerLabel } from '../utils/timing.js';
import { handleScraperError } from '../utils/error-handling.js';
import { generateScraperCacheKey } from '../utils/cache.js';

// Keep a stable reference to env config for fallbacks when user config is partial
const ENV = config;

const execPromise = promisify(exec);
const inFlightRequests = new Map();
let curlCheckPromise = null;
let warnedNoCurl = false;

async function hasCurl() {
    if (!curlCheckPromise) {
        curlCheckPromise = execPromise('command -v curl')
            .then(() => true)
            .catch(() => false);
    }
    return curlCheckPromise;
}

function generateRandomUserAgent() {
    const firefoxVersions = ['138.0', '139.0', '140.0', '141.0'];
    const platforms = [
        'Macintosh; Intel Mac OS X 10.15',
        'Windows NT 10.0; Win64; x64',
        'X11; Linux x86_64'
    ];
    const version = firefoxVersions[Math.floor(Math.random() * firefoxVersions.length)];
    const platform = platforms[Math.floor(Math.random() * platforms.length)];
    return `Mozilla/5.0 (${platform}; rv:${version}) Gecko/20100101 Firefox/${version}`;
}

function isCloudflareChallenge(text = '') {
    if (!text) return false;
    return text.includes('Just a moment') ||
        text.includes('cf-browser-verification') ||
        text.includes('Enable JavaScript and cookies');
}

/**
 * Try to fetch the search URL via FlareSolverr when curl gets blocked by Cloudflare
 */
async function fetchViaFlareSolverr(searchUrl, flareSolverrUrl, timeout, logPrefix) {
    if (!flareSolverrUrl) return null;

    const scraperName = 'TorrentGalaxy';
    const flareTimeout = Math.max(timeout * 3, 30000);

    try {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} trying FlareSolverr for ${searchUrl}`);
        const response = await axios.post(`${flareSolverrUrl}/v1`, {
            cmd: 'request.get',
            url: searchUrl,
            maxTimeout: flareTimeout
        }, {
            timeout: flareTimeout + 5000,
            headers: { 'Content-Type': 'application/json' }
        });

        const solution = response?.data?.solution;
        if (!solution?.response) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} FlareSolverr returned no response`);
            return null;
        }

        const body = solution.response;
        if (isCloudflareChallenge(body)) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} FlareSolverr still blocked by Cloudflare`);
            return null;
        }

        console.log(`[${logPrefix} SCRAPER] ${scraperName} FlareSolverr success`);
        return body;
    } catch (error) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} FlareSolverr error: ${error.message}`);
        return null;
    }
}

export async function searchTorrentGalaxy(searchKey, signal, logPrefix, config) {
    const scraperName = 'TorrentGalaxy';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    const timerLabel = createTimerLabel(logPrefix, scraperName, sfx);
    console.time(timerLabel);

    const cacheKey = generateScraperCacheKey(scraperName, searchKey, config);
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

    let cookieFile = null;
    let isOwner = false;

    const scrapePromise = (async () => {
        const limit = ENV.TORRENTGALAXY_LIMIT || 200;
        const maxPages = ENV.TORRENTGALAXY_MAX_PAGES || 10;
        const base = (ENV.TORRENTGALAXY_URL || 'https://torrentgalaxy.space').replace(/\/$/, '');
        const timeout = config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT ?? 15000;
        const flareSolverrUrl = config?.FLARESOLVERR_URL || ENV.FLARESOLVERR_URL || '';

        const curlAvailable = await hasCurl();
        if (!curlAvailable) {
            if (!warnedNoCurl) {
                console.warn(`[${logPrefix} SCRAPER] ${scraperName} requires curl; it is not installed. Skipping.`);
                warnedNoCurl = true;
            }
            return [];
        }

        if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }

        cookieFile = `/tmp/tgx-cookies-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`;

        let page = 1;
        let accumulated = [];
        const seen = new Set();
        let pageSize = 50;

        while (accumulated.length < limit && page <= maxPages) {
            if (signal?.aborted) break;

            const url = `${base}/get-posts/keywords:${encodeURIComponent(searchKey)}:format:json/?page=${page}`;
            const userAgent = generateRandomUserAgent();
            const escapedUrl = url.replace(/'/g, "'\\''");
            const escapedUserAgent = userAgent.replace(/'/g, "'\\''");
            const escapedCookieFile = cookieFile.replace(/'/g, "'\\''");
            const escapedBase = base.replace(/'/g, "'\\''");

            const curlCmd = page === 1
                ? `curl -s -L -c '${escapedCookieFile}' -H 'User-Agent: ${escapedUserAgent}' -H 'Accept: application/json, text/plain, */*' -H 'Accept-Language: en-US,en;q=0.5' -H 'Accept-Encoding: gzip, deflate, br, zstd' -H 'DNT: 1' -H 'Connection: keep-alive' -H 'Sec-Fetch-Dest: document' -H 'Sec-Fetch-Mode: navigate' -H 'Sec-Fetch-Site: none' -H 'Sec-Fetch-User: ?1' -H 'Priority: u=0, i' -H 'TE: trailers' --compressed '${escapedUrl}'`
                : `curl -s -L -b '${escapedCookieFile}' -c '${escapedCookieFile}' -H 'User-Agent: ${escapedUserAgent}' -H 'Accept: application/json, text/plain, */*' -H 'Accept-Language: en-US,en;q=0.5' -H 'Accept-Encoding: gzip, deflate, br, zstd' -H 'DNT: 1' -H 'Connection: keep-alive' -H 'Referer: ${escapedBase}/' -H 'Sec-Fetch-Dest: document' -H 'Sec-Fetch-Mode: navigate' -H 'Sec-Fetch-Site: same-origin' -H 'Sec-Fetch-User: ?1' -H 'Priority: u=0, i' -H 'TE: trailers' --compressed '${escapedUrl}'`;

            let stdout;
            try {
                const result = await execPromise(curlCmd, { timeout: Math.max(timeout, 20000) });
                stdout = result.stdout;
            } catch (curlError) {
                console.log(`[${logPrefix} SCRAPER] ${scraperName} page ${page} curl error: ${curlError.message}`);
                break;
            }

            // Detect Cloudflare challenge
            if (!stdout || stdout.startsWith('<') || isCloudflareChallenge(stdout)) {
                if (page === 1) {
                    console.log(`[${logPrefix} SCRAPER] ${scraperName} blocked by Cloudflare, trying FlareSolverr`);
                    const flareBody = await fetchViaFlareSolverr(url, flareSolverrUrl, timeout, logPrefix);
                    if (flareBody) {
                        stdout = flareBody;
                    } else {
                        if (!flareSolverrUrl) {
                            console.log(`[${logPrefix} SCRAPER] ${scraperName} Cloudflare blocked and no FLARESOLVERR_URL configured`);
                        }
                        return [];
                    }
                } else {
                    console.log(`[${logPrefix} SCRAPER] ${scraperName} Cloudflare on page ${page}, stopping`);
                    break;
                }
            }

            let payload;
            try {
                payload = JSON.parse(stdout);
            } catch {
                console.log(`[${logPrefix} SCRAPER] ${scraperName} page ${page} invalid JSON (length: ${stdout?.length || 0})`);
                break;
            }

            const results = Array.isArray(payload.results) ? payload.results : [];

            if (payload.page_size && Number.isFinite(Number(payload.page_size))) {
                pageSize = parseInt(payload.page_size, 10);
            }

            if (results.length === 0) break;

            for (const r of results) {
                if (accumulated.length >= limit) break;

                const rawHash = r.h || r.pk || null;
                if (!rawHash) continue;

                const cleaned = String(rawHash).replace(/[^A-Za-z0-9]/g, '');
                if (!cleaned) continue;
                if (seen.has(cleaned)) continue;
                seen.add(cleaned);

                accumulated.push({
                    Title: r.n || 'Unknown Title',
                    InfoHash: cleaned,
                    Size: Number.isFinite(Number(r.s)) ? parseInt(r.s, 10) : 0,
                    Seeders: (r.se === null || typeof r.se === 'undefined') ? 0 : (Number.isFinite(Number(r.se)) ? parseInt(r.se, 10) : 0),
                    Tracker: `${scraperName} | ${r.u || 'Public'}`
                });
            }

            if (results.length < pageSize) break;
            page += 1;
        }

        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${accumulated.length} results`);
        return accumulated.slice(0, limit);
    })();

    inFlightRequests.set(cacheKey, scrapePromise);
    isOwner = true;

    try {
        const results = await scrapePromise;

        if (isOwner && results.length > 0) {
            try {
                const saved = await SqliteCache.upsertCachedMagnet({
                    service: 'scraper',
                    hash: cacheKey,
                    data: results
                });
                if (saved) {
                    console.log(`[${logPrefix} SCRAPER] ${scraperName} saved ${results.length} results to cache`);
                }
            } catch (cacheError) {
                console.warn(`[${logPrefix} SCRAPER] ${scraperName} failed to save to cache: ${cacheError.message}`);
            }
        }

        return results;
    } catch (error) {
        handleScraperError(error, scraperName, logPrefix);
        return [];
    } finally {
        if (isOwner) {
            inFlightRequests.delete(cacheKey);
            if (cookieFile) {
                try { await execPromise(`rm -f "${cookieFile}"`); } catch (e) { /* ignore */ }
            }
        }
        console.timeEnd(timerLabel);
    }
}
