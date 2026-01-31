/**
 * Asiaflix search and content loading
 * Handles searching for Asian dramas and extracting SharePoint video URLs
 */

import * as cheerio from 'cheerio';
import axios from 'axios';
import * as config from '../../../config.js';
import { cleanTitle } from '../../utils/parsing.js';

const BASE_URL = 'https://asiaflix.net';
const FLARESOLVERR_URL = config.FLARESOLVERR_URL || process.env.FLARESOLVERR_URL || '';
const FLARESOLVERR_TIMEOUT = parseInt(process.env.HTTP_FLARESOLVERR_TIMEOUT, 10) || 90000;
const DIRECT_FETCH_TIMEOUT = parseInt(process.env.HTTP_DIRECT_FETCH_TIMEOUT, 10) || 5000;

async function fetchDirect(url, signal = null) {
    try {
        const response = await axios.get(url, {
            timeout: DIRECT_FETCH_TIMEOUT,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9'
            },
            signal
        });

        if (response.status >= 200 && response.status < 300 && response.data) {
            return {
                body: response.data,
                url: response.request?.res?.responseUrl || url,
                $: cheerio.load(response.data)
            };
        }
    } catch (error) {
        console.log(`[Asiaflix] Direct fetch failed (${error.message})`);
    }

    return null;
}

/**
 * Fetch a page using FlareSolverr (required for Angular SPA)
 */
async function fetchWithFlare(url, signal = null) {
    if (!FLARESOLVERR_URL) {
        console.log('[Asiaflix] FlareSolverr not configured');
        return null;
    }

    try {
        const response = await axios.post(`${FLARESOLVERR_URL}/v1`, {
            cmd: 'request.get',
            url,
            maxTimeout: FLARESOLVERR_TIMEOUT
        }, {
            timeout: FLARESOLVERR_TIMEOUT + 5000,
            headers: { 'Content-Type': 'application/json' },
            signal
        });

        if (response.data?.status === 'ok' && response.data?.solution?.response) {
            return {
                body: response.data.solution.response,
                url: response.data.solution.url,
                $: cheerio.load(response.data.solution.response)
            };
        }
        return null;
    } catch (error) {
        console.error(`[Asiaflix] FlareSolverr error: ${error.message}`);
        return null;
    }
}

async function fetchPage(url, signal = null) {
    const direct = await fetchDirect(url, signal);
    if (direct) {
        return direct;
    }
    return fetchWithFlare(url, signal);
}

/**
 * Extract SharePoint video URL from page HTML
 */
function extractSharePointUrl(html) {
    if (!html) return null;

    // Look for SharePoint download URLs with tempauth
    const match = html.match(/https:\/\/[a-z0-9]+\.sharepoint\.com\/_layouts\/15\/download\.aspx\?[^"'\s<>]+tempauth=[^"'\s<>&]+[^"'\s<>]*/i);
    if (match) {
        // Decode HTML entities
        return match[0]
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"');
    }
    return null;
}

function extractNgStateJson(html) {
    if (!html) return null;
    const marker = '<script id="ng-state" type="application/json">';
    const start = html.indexOf(marker);
    if (start === -1) return null;
    const jsonStart = html.indexOf('>', start) + 1;
    const jsonEnd = html.indexOf('</script>', jsonStart);
    if (jsonEnd === -1) return null;

    const jsonText = html.slice(jsonStart, jsonEnd);
    try {
        return JSON.parse(jsonText);
    } catch (error) {
        console.log(`[Asiaflix] Failed to parse ng-state JSON: ${error.message}`);
        return null;
    }
}

function extractEpisodeStreamUrlsFromNgState(html, episodeNumber = null, episodeUrl = null) {
    const state = extractNgStateJson(html);
    if (!state || typeof state !== 'object') return [];

    let drama = null;
    for (const value of Object.values(state)) {
        if (value && value.b && Array.isArray(value.b.episodes)) {
            drama = value.b;
            break;
        }
    }

    if (!drama || !Array.isArray(drama.episodes)) return [];

    let episode = null;
    if (episodeNumber != null) {
        episode = drama.episodes.find(ep => ep?.number === Number(episodeNumber));
    }

    if (!episode && episodeUrl) {
        episode = drama.episodes.find(ep => typeof ep?.epUrl === 'string' && episodeUrl.includes(ep.epUrl.split('/').pop()));
    }

    if (!episode) {
        episode = drama.episodes[0] || null;
    }

    return Array.isArray(episode?.streamUrls) ? episode.streamUrls : [];
}

function normalizeHtmlForUrlSearch(html) {
    return html
        .replace(/\\u002F/g, '/')
        .replace(/\\\//g, '/')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"');
}

function extractGenericVideoUrl(html) {
    if (!html) return null;

    const normalized = normalizeHtmlForUrlSearch(html);

    const patterns = [
        // Any SharePoint link (download, stream, or share links)
        /https:\/\/[a-z0-9.-]+\.sharepoint\.com\/[^"'\s<>]+/i,
        // HLS streams
        /https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/i,
        // Direct MP4
        /https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*/i,
        // player config fields
        /(?:file|src|source|video|url)\s*:\s*["'](https?:\/\/[^"'\s<>]+)["']/i
    ];

    for (const pattern of patterns) {
        const match = normalized.match(pattern);
        if (match) {
            return match[1] || match[0];
        }
    }

    return null;
}

/**
 * Extract video quality from filename or URL
 */
function extractQuality(url, filename = '') {
    const text = (url + ' ' + filename).toLowerCase();
    if (text.includes('2160') || text.includes('4k')) return '4k';
    if (text.includes('1080')) return '1080p';
    if (text.includes('720')) return '720p';
    if (text.includes('480')) return '480p';
    if (text.includes('360')) return '360p';
    return 'HD';
}

/**
 * Search Asiaflix for dramas
 * @param {string} query - Search query
 * @param {AbortSignal} signal - Optional abort signal
 * @returns {Promise<Array>} Search results
 */
export async function scrapeAsiaflixSearch(query, signal = null) {
    if (!query) return [];

    const searchUrl = `${BASE_URL}/search?q=${encodeURIComponent(query)}`;
    console.log(`[Asiaflix] Searching: ${searchUrl}`);

    const result = await fetchPage(searchUrl, signal);
    if (!result) {
        console.log('[Asiaflix] Search fetch failed');
        return [];
    }

    const $ = result.$;
    const results = [];

    // Parse search results - look for drama links
    $('a[href^="/drama/"]').each((_, el) => {
        const $el = $(el);
        const href = $el.attr('href');
        if (!href || href.includes('/episode-')) return; // Skip episode links

        const title = $el.find('h3').text().trim() ||
                     $el.attr('title')?.trim() ||
                     $el.text().trim();

        if (!title || results.some(r => r.url === href)) return;

        // Try to extract year
        const yearText = $el.closest('div').find('p:contains("Year")').text();
        const yearMatch = yearText.match(/\b(19|20)\d{2}\b/);

        // Try to extract poster
        const poster = $el.find('img').attr('src') ||
                      $el.closest('div').find('img').attr('src');

        results.push({
            title: title.replace(/\s+/g, ' '),
            url: `${BASE_URL}${href}`,
            year: yearMatch ? parseInt(yearMatch[0], 10) : null,
            poster,
            normalizedTitle: cleanTitle(title)
        });
    });

    console.log(`[Asiaflix] Found ${results.length} search results`);
    return results;
}

/**
 * Load drama page to get episode list
 * @param {string} dramaUrl - Drama page URL
 * @param {AbortSignal} signal - Optional abort signal
 * @returns {Promise<Object>} Drama info with episodes
 */
export async function loadAsiaflixDrama(dramaUrl, signal = null) {
    console.log(`[Asiaflix] Loading drama: ${dramaUrl}`);

    const result = await fetchPage(dramaUrl, signal);
    if (!result) {
        console.log('[Asiaflix] Drama fetch failed');
        return { title: '', episodes: [] };
    }

    const $ = result.$;

    // Extract title
    const title = $('h1').first().text().trim();

    // Extract metadata
    const year = $('a[href*="year="]').first().text().trim();
    const country = $('a[href*="country="]').first().text().trim();
    const status = $('a[href*="status="]').first().text().trim();

    // Extract episode count
    const episodeCountText = $('p:contains("Episodes")').text();
    const episodeCountMatch = episodeCountText.match(/(\d+)\s*Episodes/i);
    const episodeCount = episodeCountMatch ? parseInt(episodeCountMatch[1], 10) : 0;

    // Extract episode links
    const episodes = [];
    $('a[href*="/episode-"]').each((_, el) => {
        const href = $(el).attr('href');
        const titleAttr = $(el).attr('title') || '';
        const epMatch = href.match(/episode-(\d+)/i);

        if (epMatch) {
            const epNum = parseInt(epMatch[1], 10);
            const hasSub = $(el).find('.accent, :contains("SUB")').length > 0 ||
                          titleAttr.toLowerCase().includes('sub');

            if (!episodes.some(e => e.episode === epNum)) {
                episodes.push({
                    episode: epNum,
                    url: href.startsWith('http') ? href : `${BASE_URL}${href}`,
                    hasSub
                });
            }
        }
    });

    // Sort episodes
    episodes.sort((a, b) => a.episode - b.episode);

    console.log(`[Asiaflix] Found ${episodes.length} episodes for "${title}"`);

    return {
        title,
        year: year ? parseInt(year, 10) : null,
        country,
        status,
        episodeCount,
        episodes
    };
}

/**
 * Load episode page and extract video URL
 * @param {string} episodeUrl - Episode page URL
 * @param {AbortSignal} signal - Optional abort signal
 * @returns {Promise<Object>} Episode info with video URL
 */
export async function loadAsiaflixEpisode(episodeUrl, signal = null) {
    console.log(`[Asiaflix] Loading episode: ${episodeUrl}`);

    const episodeNumberMatch = episodeUrl.match(/episode-(\d+)/i);
    const episodeNumber = episodeNumberMatch ? parseInt(episodeNumberMatch[1], 10) : null;

    const extractFromBody = body => {
        let found = extractSharePointUrl(body);
        if (!found) {
            found = extractGenericVideoUrl(body);
            if (found) {
                console.log(`[Asiaflix] Found video URL (non-SharePoint): ${found.substring(0, 80)}...`);
            }
        }
        if (!found) return null;

        const filenameMatch = body.match(/filename[*]?=["']?(?:utf-8'')?([^"'&\s;]+)/i);
        const filename = filenameMatch ? decodeURIComponent(filenameMatch[1]) : '';
        const quality = extractQuality(found, filename);

        return { videoUrl: found, filename, quality, provider: 'SharePoint' };
    };

    const extractFromResult = result => {
        if (!result?.body) return null;
        const streamUrls = extractEpisodeStreamUrlsFromNgState(result.body, episodeNumber, episodeUrl);
        if (streamUrls.length > 0) {
            console.log(`[Asiaflix] Found ${streamUrls.length} stream URL(s) in ng-state`);
            return { streamUrls };
        }
        const videoPayload = extractFromBody(result.body);
        return videoPayload;
    };

    const directPromise = fetchDirect(episodeUrl, signal).then(extractFromResult);
    let flarePromise = null;
    if (FLARESOLVERR_URL) {
        flarePromise = fetchWithFlare(episodeUrl, signal).then(extractFromResult);
    }

    let resolved = null;
    if (flarePromise) {
        try {
            resolved = await Promise.any([
                directPromise.then(result => result || Promise.reject(new Error('direct-empty'))),
                flarePromise.then(result => result || Promise.reject(new Error('flare-empty')))
            ]);
        } catch {
            resolved = await directPromise;
        }
    } else {
        resolved = await directPromise;
    }

    if (!resolved) {
        console.log('[Asiaflix] Episode fetch failed');
        return { videoUrl: null };
    }

    if (resolved.videoUrl) {
        console.log(`[Asiaflix] Found SharePoint URL: ${resolved.videoUrl.substring(0, 80)}...`);
    } else if (resolved.streamUrls) {
        console.log(`[Asiaflix] Using stream URL list from ng-state`);
    }

    return resolved;
}
