import axios from 'axios';
import * as config from '../../config.js';
import proxyManager from '../../util/proxy-manager.js';
import * as SqliteCache from '../../util/cache-store.js';
import { exec } from 'child_process';
import { promisify } from 'util';

// Import scraper utilities
import { createTimerLabel } from '../utils/timing.js';
import { detectSimpleLangs } from '../utils/filtering.js';
import { processAndDeduplicate } from '../utils/deduplication.js';
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

// Standard trackers for magnet links
const TRACKERS = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://open.stealth.si:80/announce',
    'udp://tracker.torrent.eu.org:451/announce',
    'udp://tracker.bittor.pw:1337/announce',
    'udp://public.popcorn-tracker.org:6969/announce',
    'udp://tracker.dler.org:6969/announce',
    'udp://exodus.desync.com:6969',
    'udp://open.demonii.com:1337/announce'
];

/**
 * Build a magnet link from info hash and name
 */
function buildMagnetLink(infoHash, name) {
    const encodedName = encodeURIComponent(name);
    const trackerParams = TRACKERS.map(t => `&tr=${encodeURIComponent(t)}`).join('');
    return `magnet:?xt=urn:btih:${infoHash}&dn=${encodedName}${trackerParams}`;
}

// Generate random realistic Firefox User-Agent matching TPB frontend
function generateRandomUserAgent() {
    const firefoxVersions = ['138.0', '139.0', '140.0', '141.0'];
    const platforms = [
        'Macintosh; Intel Mac OS X 10.15',
        'Macintosh; Intel Mac OS X 14.1',
        'Windows NT 10.0; Win64; x64',
        'X11; Linux x86_64',
        'X11; Ubuntu; Linux x86_64'
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
 * Try to fetch the apibay search URL via FlareSolverr when curl gets blocked by Cloudflare
 */
async function fetchViaFlareSolverr(searchUrl, flareSolverrUrl, timeout, logPrefix) {
    if (!flareSolverrUrl) return null;

    const scraperName = 'ThePirateBay';
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

        // Check if FlareSolverr still got a Cloudflare challenge
        if (isCloudflareChallenge(body)) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} FlareSolverr still blocked by Cloudflare`);
            return null;
        }

        console.log(`[${logPrefix} SCRAPER] ${scraperName} FlareSolverr success (status: ${solution.status || 'n/a'})`);
        return body;
    } catch (error) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} FlareSolverr error: ${error.message}`);
        return null;
    }
}

/**
 * Search The Pirate Bay using the apibay.org API via curl
 * Uses browser-like headers matching how the real TPB frontend calls apibay
 * Falls back to FlareSolverr when Cloudflare blocks the request
 * @param {string} query - Search query
 * @param {AbortSignal} signal - Abort signal
 * @param {string} logPrefix - Logging prefix
 * @param {object} config - Configuration object
 * @returns {Promise<Array>} - Array of torrent results
 */
export async function searchThePirateBay(query, signal, logPrefix, config) {
    const scraperName = 'ThePirateBay';
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

    let cookieFile = null;
    let isOwner = false;

    const scrapePromise = (async () => {
        const limit = config?.THEPIRATEBAY_LIMIT ?? ENV.THEPIRATEBAY_LIMIT ?? 100;
        const base = ((config?.THEPIRATEBAY_URL || ENV.THEPIRATEBAY_URL) || 'https://apibay.org').replace(/\/$/, '');
        const timeout = config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT;
        const flareSolverrUrl = config?.FLARESOLVERR_URL || ENV.FLARESOLVERR_URL || '';

        const curlAvailable = await hasCurl();
        if (!curlAvailable) {
            if (!warnedNoCurl) {
                console.warn(`[${logPrefix} SCRAPER] ${scraperName} requires curl; it is not installed. Skipping scraper.`);
                warnedNoCurl = true;
            }
            return [];
        }

        // Check for abort signal
        if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }

        // Build search URL - cat=0 means all categories
        const searchUrl = `${base}/q.php?q=${encodeURIComponent(query)}&cat=0`;

        console.log(`[${logPrefix} SCRAPER] ${scraperName} searching: ${searchUrl}`);

        // Cookie file for persistence across requests
        cookieFile = `/tmp/tpb-cookies-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`;

        const userAgent = generateRandomUserAgent();
        const perRequestTimeout = Math.max(timeout || 15000, 20000);

        // Escape single quotes in dynamic values
        const escapedUrl = searchUrl.replace(/'/g, "'\\''");
        const escapedUserAgent = userAgent.replace(/'/g, "'\\''");
        const escapedCookieFile = cookieFile.replace(/'/g, "'\\''");

        // Build proxy argument
        let proxyArg = '';
        const useProxies = config?.THEPIRATEBAY_USE_PROXIES ?? ENV.THEPIRATEBAY_USE_PROXIES ?? false;
        let proxy = null;
        if (useProxies) {
            proxy = await proxyManager.getNextProxy();
            if (proxy) {
                const escapedProxy = proxy.replace(/'/g, "'\\''");
                if (proxy.startsWith('socks')) {
                    proxyArg = `--socks5 '${escapedProxy.replace('socks5://', '')}'`;
                } else {
                    proxyArg = `-x '${escapedProxy}'`;
                }
            }
        }

        // Use curl with headers matching how TPB frontend calls apibay.org
        // Key: Origin + Referer from thepiratebay.org, Sec-Fetch-Site: cross-site
        const curlCmd = `curl -s -L ${proxyArg} -c '${escapedCookieFile}' -b '${escapedCookieFile}' -H 'User-Agent: ${escapedUserAgent}' -H 'Accept: application/json, text/plain, */*' -H 'Accept-Language: en-US,en;q=0.5' -H 'Accept-Encoding: gzip, deflate, br, zstd' -H 'Origin: https://thepiratebay.org' -H 'Referer: https://thepiratebay.org/' -H 'DNT: 1' -H 'Connection: keep-alive' -H 'Sec-Fetch-Dest: empty' -H 'Sec-Fetch-Mode: cors' -H 'Sec-Fetch-Site: cross-site' -H 'Priority: u=0' -H 'TE: trailers' --compressed '${escapedUrl}'`;

        const execOptions = { timeout: perRequestTimeout };

        let stdout;
        try {
            const result = await execPromise(curlCmd, execOptions);
            stdout = result.stdout;
            // Mark proxy as successful if used
            if (proxy) proxyManager.markSuccess(proxy);
        } catch (curlError) {
            if (proxy) proxyManager.markFailure(proxy);
            throw curlError;
        }

        // Detect Cloudflare challenge and fall back to FlareSolverr
        if (!stdout || stdout.startsWith('<') || isCloudflareChallenge(stdout)) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} blocked by Cloudflare, trying FlareSolverr fallback`);

            const flareBody = await fetchViaFlareSolverr(searchUrl, flareSolverrUrl, perRequestTimeout, logPrefix);
            if (flareBody) {
                stdout = flareBody;
            } else {
                if (!flareSolverrUrl) {
                    console.log(`[${logPrefix} SCRAPER] ${scraperName} Cloudflare blocked and no FLARESOLVERR_URL configured`);
                } else {
                    console.log(`[${logPrefix} SCRAPER] ${scraperName} FlareSolverr could not bypass Cloudflare`);
                }
                return [];
            }
        }

        let data;
        try {
            data = JSON.parse(stdout);
        } catch {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} invalid JSON response (length: ${stdout?.length || 0})`);
            return [];
        }

        // Check if response is valid
        if (!Array.isArray(data)) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} invalid response format`);
            return [];
        }

        // Filter out invalid entries (info_hash of all zeros means no results)
        const INVALID_HASH = '0000000000000000000000000000000000000000';
        const validResults = data.filter(item => item.info_hash && item.info_hash !== INVALID_HASH);

        if (validResults.length === 0) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} no valid results found`);
            return [];
        }

        const results = [];
        const seen = new Set();

        for (const item of validResults) {
            if (results.length >= limit) break;

            const infoHash = item.info_hash.toLowerCase();

            // Skip duplicates
            if (seen.has(infoHash)) continue;
            seen.add(infoHash);

            const title = item.name || 'Unknown Title';
            const seeders = parseInt(item.seeders) || 0;
            const leechers = parseInt(item.leechers) || 0;
            const size = parseInt(item.size) || 0;

            results.push({
                Title: title,
                InfoHash: infoHash,
                Size: size,
                Seeders: seeders,
                Leechers: leechers,
                Tracker: scraperName,
                Langs: detectSimpleLangs(title),
                Magnet: buildMagnetLink(infoHash, title)
            });
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
            // Clean up cookie file
            if (cookieFile) {
                try {
                    await execPromise(`rm -f "${cookieFile}"`);
                } catch (e) {
                    // Ignore cleanup errors
                }
            }
        }
        console.timeEnd(timerLabel);
    }
}
