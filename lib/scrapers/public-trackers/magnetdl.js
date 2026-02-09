import axios from 'axios';
import * as config from '../../config.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as SqliteCache from '../../util/cache-store.js';

// Import scraper utilities
import { createTimerLabel } from '../utils/timing.js';
import { detectSimpleLangs } from '../utils/filtering.js';
import { processAndDeduplicate } from '../utils/deduplication.js';
import { handleScraperError } from '../utils/error-handling.js';
import { generateScraperCacheKey } from '../utils/cache.js';

function isCloudflareChallenge(text = '') {
    if (!text) return false;
    return text.includes('Just a moment') ||
        text.includes('cf-browser-verification') ||
        text.includes('Enable JavaScript and cookies');
}

async function fetchViaFlareSolverr(url, flareSolverrUrl, timeout, scraperName, logPrefix) {
    if (!flareSolverrUrl) return null;
    const flareTimeout = Math.max(timeout * 3, 30000);
    try {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} trying FlareSolverr for ${url}`);
        const response = await axios.post(`${flareSolverrUrl}/v1`, {
            cmd: 'request.get',
            url,
            maxTimeout: flareTimeout
        }, {
            timeout: flareTimeout + 5000,
            headers: { 'Content-Type': 'application/json' }
        });
        const solution = response?.data?.solution;
        if (!solution?.response) return null;
        if (isCloudflareChallenge(solution.response)) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} FlareSolverr still blocked`);
            return null;
        }
        console.log(`[${logPrefix} SCRAPER] ${scraperName} FlareSolverr success`);
        return solution.response;
    } catch (error) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} FlareSolverr error: ${error.message}`);
        return null;
    }
}

// Keep a stable reference to env config for fallbacks when user config is partial
const ENV = config;

const execPromise = promisify(exec);
const inFlightRequests = new Map();
let curlCheckPromise = null;
let warnedNoCurl = false;

function normalizeBase(url) {
    return (url || '').replace(/\/$/, '');
}

function buildProxyArg(proxy) {
    if (!proxy) return '';
    const escaped = proxy.replace(/'/g, "'\\''");
    if (proxy.startsWith('socks')) {
        return `--socks5-hostname '${escaped.replace(/^socks5?:\/\//, '')}'`;
    }
    return `-x '${escaped}'`;
}

function buildCurlCommand(apiUrl, base, proxyArg) {
    const escapedApiUrl = apiUrl.replace(/'/g, "'\\''");
    const escapedBase = base.replace(/'/g, "'\\''");
    return `curl -s --compressed ${proxyArg} -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0' -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' -H 'Accept-Language: en-US,en;q=0.5' -H 'Accept-Encoding: gzip, deflate, br, zstd' -H 'Referer: ${escapedBase}/' -H 'DNT: 1' -H 'Connection: keep-alive' -H 'Upgrade-Insecure-Requests: 1' -H 'Sec-Fetch-Dest: document' -H 'Sec-Fetch-Mode: navigate' -H 'Sec-Fetch-Site: same-origin' -H 'Sec-Fetch-User: ?1' -H 'Priority: u=0, i' -H 'TE: trailers' '${escapedApiUrl}'`;
}

function formatResults(resultsData, limit, scraperName, config) {
    const resultArray = Array.isArray(resultsData) ? resultsData : Object.values(resultsData);
    return resultArray.slice(0, limit).map(item => {
        if (!item?.info_hash || !item?.name) return null;

        return {
            Title: item.name,
            InfoHash: item.info_hash.toLowerCase(), // Normalize to lowercase to match cache expectations
            Size: parseInt(item.size) || 0,
            Seeders: parseInt(item.seeders) || 0,
            Leechers: parseInt(item.leechers) || 0,
            Tracker: `${scraperName} | ${item.category ? `Cat:${item.category}` : 'Public'}`,
            Langs: detectSimpleLangs(item.name),
            Username: item.username,
            Added: item.added ? new Date(parseInt(item.added) * 1000).toISOString() : null
        };
    }).filter(Boolean);
}

async function hasCurl() {
    if (!curlCheckPromise) {
        curlCheckPromise = execPromise('command -v curl')
            .then(() => true)
            .catch(() => false);
    }
    return curlCheckPromise;
}

function tryParseResponse(raw, base, scraperName, logPrefix) {
    if (!raw) return null;
    const toText = (val) => typeof val === 'string' ? val : JSON.stringify(val);
    const text = toText(raw).trim();
    if (!text) return null;
    if (text.startsWith('<')) return null; // likely HTML/CF challenge

    // Attempt direct parse
    try {
        return JSON.parse(text);
    } catch (_) {
        // Try to recover if there's junk before the JSON
        const idx = Math.min(
            ...['[', '{'].map(ch => {
                const i = text.indexOf(ch);
                return i === -1 ? Number.POSITIVE_INFINITY : i;
            })
        );
        if (idx !== Number.POSITIVE_INFINITY) {
            const candidate = text.slice(idx);
            try {
                return JSON.parse(candidate);
            } catch (err) {
                console.log(`[${logPrefix} SCRAPER] ${scraperName} parse retry failed for ${base}: ${err.message}`);
            }
        }
        return null;
    }
}

async function runMagnetDLSearch(scraperName, query, category, signal, logPrefix, config) {
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    const timerLabel = createTimerLabel(logPrefix, scraperName, sfx);
    console.time(timerLabel);

    const cacheKey = generateScraperCacheKey(scraperName, category ? `${query}|cat${category}` : query, config);
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

    const searchPromise = (async () => {
        const limit = config?.MAGNETDL_LIMIT ?? ENV.MAGNETDL_LIMIT ?? 200;
        const timeout = config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT;
        const proxy = config?.MAGNETDL_PROXY || ENV.MAGNETDL_PROXY || '';
        const proxyArg = buildProxyArg(proxy);
        const encodedQuery = encodeURIComponent(query).replace(/\%20/g, '+');
        const curlAvailable = await hasCurl();
        if (!curlAvailable && !warnedNoCurl) {
            console.warn(`[${logPrefix} SCRAPER] ${scraperName} falling back to axios because curl is not installed.`);
            warnedNoCurl = true;
        }
        const baseCandidates = Array.from(new Set([
            normalizeBase(config?.MAGNETDL_URL || ENV.MAGNETDL_URL || 'https://magnetdl.homes'),
            normalizeBase(ENV.MAGNETDL_URL || 'https://magnetdl.homes'),
            'https://magnetdl.homes'
        ])).filter(Boolean);

        let resultsData = null;
        let fetchedFrom = null;
        let lastError = null;
        const effectiveTimeout = Math.max(timeout ?? 0, 15000);

        for (const base of baseCandidates) {
            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            const apiUrl = `${base}/api.php?url=/q.php?q=${encodedQuery}${category ? `&cat=${category}` : ''}`;
            console.log(`[${logPrefix} SCRAPER] ${scraperName} fetching ${apiUrl}`);

            let raw = null;
            try {
                if (curlAvailable) {
                    const curlCmd = buildCurlCommand(apiUrl, base, proxyArg);
                    const { stdout } = await execPromise(curlCmd, { timeout: effectiveTimeout });
                    raw = stdout;
                } else {
                    const { data } = await axios.get(apiUrl, {
                        timeout: effectiveTimeout,
                        signal,
                        responseType: 'text',
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0',
                            'Accept': 'application/json,text/plain,*/*',
                            'Accept-Language': 'en-US,en;q=0.5',
                            'Accept-Encoding': 'gzip, deflate, br',
                            'Referer': `${base}/`
                        }
                    });
                    raw = data;
                }
            } catch (error) {
                lastError = error;
                console.log(`[${logPrefix} SCRAPER] ${scraperName} request failed from ${base}: ${error.message}`);
                continue;
            }

            resultsData = tryParseResponse(raw, base, scraperName, logPrefix);
            if (resultsData) {
                fetchedFrom = base;
                break;
            }

            // If curl got a Cloudflare challenge, try FlareSolverr before moving to next base
            const rawText = typeof raw === 'string' ? raw : '';
            const flareSolverrUrl = config?.FLARESOLVERR_URL || ENV.FLARESOLVERR_URL || '';
            if (rawText.startsWith('<') && isCloudflareChallenge(rawText) && flareSolverrUrl) {
                console.log(`[${logPrefix} SCRAPER] ${scraperName} Cloudflare detected on ${base}, trying FlareSolverr`);
                const flareBody = await fetchViaFlareSolverr(apiUrl, flareSolverrUrl, effectiveTimeout, scraperName, logPrefix);
                if (flareBody) {
                    resultsData = tryParseResponse(flareBody, base, scraperName, logPrefix);
                    if (resultsData) {
                        fetchedFrom = base;
                        break;
                    }
                }
            }

            lastError = new Error('Invalid JSON payload');
            console.log(`[${logPrefix} SCRAPER] ${scraperName} received non-JSON response from ${base}, trying next base`);
        }

        if (!resultsData) {
            if (lastError) {
                console.warn(`[${logPrefix} SCRAPER] ${scraperName} exhausted all MagnetDL bases: ${lastError.message}`);
            } else {
                console.warn(`[${logPrefix} SCRAPER] ${scraperName} exhausted all MagnetDL bases with empty responses`);
            }
            return [];
        }

        const results = formatResults(resultsData, limit, scraperName, config);
        const processedResults = processAndDeduplicate(results, config);

        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${processedResults.length} results after processing${fetchedFrom ? ` (source: ${fetchedFrom})` : ''}.`);
        return processedResults;
    })();

    inFlightRequests.set(cacheKey, searchPromise);

    try {
        const processedResults = await searchPromise;

        if (processedResults.length > 0) {
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
        inFlightRequests.delete(cacheKey);
        console.timeEnd(timerLabel);
    }
}

export async function searchMagnetDL(query, signal, logPrefix, config) {
    return runMagnetDLSearch('MagnetDL', query, null, signal, logPrefix, config);
}

export async function searchMagnetDLMovie(query, signal, logPrefix, config) {
    return runMagnetDLSearch('MagnetDL-Movie', query, '201', signal, logPrefix, config);
}

export async function searchMagnetDLTV(query, signal, logPrefix, config) {
    return runMagnetDLSearch('MagnetDL-TV', query, '205', signal, logPrefix, config);
}
