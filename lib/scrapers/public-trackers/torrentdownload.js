import axios from 'axios';
import * as cheerio from 'cheerio';
import * as config from '../../config.js';
import { sizeToBytes } from '../../common/torrent-utils.js';
import debridProxyManager from '../../util/debrid-proxy.js';

// Import scraper utilities
import { createTimerLabel } from '../utils/timing.js';
import { detectSimpleLangs } from '../utils/filtering.js';
import { processAndDeduplicate } from '../utils/deduplication.js';
import { handleScraperError } from '../utils/error-handling.js';
import { generateScraperCacheKey } from '../utils/cache.js';
import * as SqliteCache from '../../util/cache-store.js';

// Keep a stable reference to env config for fallbacks when user config is partial
const ENV = config;

// Create axios instance with proxy support
const axiosWithProxy = axios.create(debridProxyManager.getScraperAxiosConfig('torrentdownload'));

const inFlightRequests = new Map();

function isCloudflareChallenge(html = '') {
    if (!html) return false;
    const text = typeof html === 'string' ? html : String(html);
    return text.includes('Just a moment') ||
        text.includes('cf-browser-verification') ||
        text.includes('Attention Required') ||
        text.includes('Cloudflare');
}

async function fetchWithFlareSolverr(url, flareSolverrUrl, timeout, logPrefix, signal) {
    if (!flareSolverrUrl) return null;

    const flareTimeout = Math.max(timeout * 3, 30000);

    try {
        const response = await axios.post(`${flareSolverrUrl}/v1`, {
            cmd: 'request.get',
            url,
            maxTimeout: flareTimeout
        }, {
            timeout: flareTimeout + 5000,
            signal,
            headers: { 'Content-Type': 'application/json' }
        });

        if (response.data?.status === 'ok' && response.data?.solution?.response) {
            console.log(`[${logPrefix} SCRAPER] TorrentDownload FlareSolverr success`);
            return response.data.solution.response;
        }

        console.log(`[${logPrefix} SCRAPER] TorrentDownload FlareSolverr returned status: ${response.data?.status}`);
    } catch (error) {
        console.log(`[${logPrefix} SCRAPER] TorrentDownload FlareSolverr error: ${error.message}`);
    }

    return null;
}

/**
 * Parse torrentdownload.info search results HTML
 * @param {string} html - The HTML content to parse
 * @param {number} limit - Maximum number of results
 * @param {string} logPrefix - Logging prefix
 * @returns {Array} - Array of torrent results
 */
function parseTorrentDownloadResults(html, limit, logPrefix) {
    const $ = cheerio.load(html);
    const results = [];
    const seen = new Set();

    // Results are in table.table2 rows (skip the first table which is "Fast Links" spam)
    // The actual results table has a header with colspan="5" containing the search stats
    const resultTables = $('table.table2');

    // Find the correct table (the one with search results, not the spam table)
    let resultsTable = null;
    resultTables.each((i, table) => {
        const headerText = $(table).find('th').first().text();
        if (headerText.includes('for "') || headerText.includes('Order By')) {
            resultsTable = $(table);
            return false; // break
        }
    });

    if (!resultsTable) {
        console.log(`[${logPrefix} SCRAPER] TorrentDownload could not find results table`);
        return results;
    }

    // Process each row (skip header row)
    resultsTable.find('tr').each((i, row) => {
        if (i === 0) return; // Skip header
        if (results.length >= limit) return false;

        try {
            const $row = $(row);

            // Get the title link which contains the hash in the URL
            const titleCell = $row.find('td.tdleft');
            const titleLink = titleCell.find('div.tt-name a').first();

            if (!titleLink.length) return;

            const href = titleLink.attr('href');
            if (!href) return;

            // Extract hash from URL like /3C89E0316B9FE196BE51FF0756BF9A6DFB6E09EC/Title-Here
            const hashMatch = href.match(/^\/([A-Fa-f0-9]{40})\//);
            if (!hashMatch) return;

            const infoHash = hashMatch[1].toLowerCase();
            if (seen.has(infoHash)) return;
            seen.add(infoHash);

            // Get title (clean up the text, remove category suffix)
            let title = titleLink.text().trim();
            // Remove the » Category suffix if present in the parent
            const categorySpan = titleCell.find('span.smallish');
            if (categorySpan.length) {
                // Title is just the link text, category is separate
            }

            // Get all td cells for other data
            const cells = $row.find('td');

            // Cell order: tdleft (title), tdnormal (date), tdnormal (size), tdseed (seeders), tdleech (leechers)
            let size = 0;
            let seeders = 0;
            let leechers = 0;

            // Find size (in td.tdnormal, but need to identify the right one)
            cells.each((idx, cell) => {
                const $cell = $(cell);
                const text = $cell.text().trim();

                if ($cell.hasClass('tdseed')) {
                    seeders = parseInt(text.replace(/,/g, '')) || 0;
                } else if ($cell.hasClass('tdleech')) {
                    leechers = parseInt(text.replace(/,/g, '')) || 0;
                } else if ($cell.hasClass('tdnormal')) {
                    // Check if this looks like a size
                    const sizeMatch = text.match(/^[\d.,]+\s*(GB|MB|KB|TB|B)$/i);
                    if (sizeMatch && size === 0) {
                        size = sizeToBytes(text);
                    }
                }
            });

            // Construct magnet link
            const magnetLink = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}`;

            results.push({
                Title: title,
                InfoHash: infoHash,
                Size: size,
                Seeders: seeders,
                Leechers: leechers,
                Tracker: 'TorrentDownload',
                Langs: detectSimpleLangs(title),
                Magnet: magnetLink
            });
        } catch (e) {
            // Skip individual parse errors
        }
    });

    return results;
}

/**
 * Search torrentdownload.info for torrents
 * @param {string} query - Search query
 * @param {AbortSignal} signal - Abort signal
 * @param {string} logPrefix - Logging prefix
 * @param {object} config - Configuration object
 * @returns {Promise<Array>} - Array of torrent results
 */
export async function searchTorrentDownload(query, signal, logPrefix, config) {
    const scraperName = 'TorrentDownload';
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
        const limit = config?.TORRENTDOWNLOAD_LIMIT ?? ENV.TORRENTDOWNLOAD_LIMIT ?? 100;
        const maxPages = config?.TORRENTDOWNLOAD_MAX_PAGES ?? ENV.TORRENTDOWNLOAD_MAX_PAGES ?? 2;
        const base = ((config?.TORRENTDOWNLOAD_URL || ENV.TORRENTDOWNLOAD_URL) || 'https://www.torrentdownload.info').replace(/\/$/, '');
        // Use dedicated timeout for TorrentDownload (default 10s) since it can be slow
        const timeout = config?.TORRENTDOWNLOAD_TIMEOUT ?? ENV.TORRENTDOWNLOAD_TIMEOUT ?? 10000;
        const flareSolverrUrl = config?.FLARESOLVERR_URL || ENV.FLARESOLVERR_URL || '';

        // Check for abort signal
        if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }

        const allResults = [];
        const seenHashes = new Set();

        // Fetch multiple pages
        for (let page = 1; page <= maxPages; page++) {
            if (signal?.aborted) break;
            if (allResults.length >= limit) break;

            // Build search URL - torrentdownload.info uses /search?q=query&p=page
            const searchUrl = page === 1
                ? `${base}/search?q=${encodeURIComponent(query)}`
                : `${base}/search?q=${encodeURIComponent(query)}&p=${page}`;

            console.log(`[${logPrefix} SCRAPER] ${scraperName} searching page ${page}: ${searchUrl}`);

            let html = null;
            try {
                const response = await axiosWithProxy.get(searchUrl, {
                    timeout,
                    signal,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.5',
                        'Accept-Encoding': 'gzip, deflate, br',
                        'Connection': 'keep-alive',
                        'Upgrade-Insecure-Requests': '1'
                    }
                });

                html = response.data;

                const cloudflareDetected = response.status === 403 || isCloudflareChallenge(html);
                if (cloudflareDetected && flareSolverrUrl) {
                    console.log(`[${logPrefix} SCRAPER] ${scraperName} received ${response.status} / Cloudflare page, retrying via FlareSolverr`);
                    html = await fetchWithFlareSolverr(searchUrl, flareSolverrUrl, timeout, logPrefix, signal);
                } else if (cloudflareDetected) {
                    console.log(`[${logPrefix} SCRAPER] ${scraperName} blocked by Cloudflare (status ${response.status}) and no FlareSolverr configured`);
                    html = null;
                }

                // Parse results from this page
                if (!html) {
                    throw new Error('Empty response body after Cloudflare handling');
                }
                const pageResults = parseTorrentDownloadResults(html, limit, logPrefix);
                console.log(`[${logPrefix} SCRAPER] ${scraperName} page ${page} returned ${pageResults.length} results`);

                // Add unique results
                for (const result of pageResults) {
                    if (allResults.length >= limit) break;
                    if (!seenHashes.has(result.InfoHash)) {
                        seenHashes.add(result.InfoHash);
                        allResults.push(result);
                    }
                }

                // Stop if page had fewer than expected results (50 per page typically)
                if (pageResults.length < 40) {
                    console.log(`[${logPrefix} SCRAPER] ${scraperName} page ${page} had ${pageResults.length} results (not full), stopping pagination`);
                    break;
                }
            } catch (error) {
                if (error.name === 'AbortError' || axios.isCancel(error)) {
                    throw error;
                }
                let htmlFromFlare = null;
                if (flareSolverrUrl && error?.response?.status === 403) {
                    console.log(`[${logPrefix} SCRAPER] ${scraperName} received 403, attempting FlareSolverr fallback`);
                    htmlFromFlare = await fetchWithFlareSolverr(searchUrl, flareSolverrUrl, timeout, logPrefix, signal);
                }

                if (htmlFromFlare) {
                    const pageResults = parseTorrentDownloadResults(htmlFromFlare, limit, logPrefix);
                    console.log(`[${logPrefix} SCRAPER] ${scraperName} page ${page} returned ${pageResults.length} results via FlareSolverr`);

                    for (const result of pageResults) {
                        if (allResults.length >= limit) break;
                        if (!seenHashes.has(result.InfoHash)) {
                            seenHashes.add(result.InfoHash);
                            allResults.push(result);
                        }
                    }

                    if (pageResults.length < 40) {
                        console.log(`[${logPrefix} SCRAPER] ${scraperName} page ${page} had ${pageResults.length} results (not full), stopping pagination`);
                        break;
                    }
                } else {
                    console.log(`[${logPrefix} SCRAPER] ${scraperName} page ${page} error: ${error.message}`);
                    if (page === 1) {
                        // If first page fails, throw to report the error
                        throw error;
                    }
                    // For subsequent pages, just stop pagination
                    break;
                }
            }
        }

        const results = allResults;

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
