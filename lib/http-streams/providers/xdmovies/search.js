/**
 * XDMovies Search Helpers
 * Handles search API and page parsing for XDMovies.site
 */

import * as cheerio from 'cheerio';
import { makeRequest } from '../../utils/http.js';
import { cleanTitle, getResolutionFromName } from '../../utils/parsing.js';
import { detectLanguagesFromTitle } from '../../../util/language-mapping.js';

const BASE_URL = process.env.XDMOVIES_BASE_URL || 'https://new.xdmovies.wtf';
const SEARCH_CACHE_TTL = parseInt(process.env.XDMOVIES_SEARCH_CACHE_TTL, 10) || 30 * 60 * 1000; // 30 minutes
const PAGE_CACHE_TTL = parseInt(process.env.XDMOVIES_PAGE_CACHE_TTL, 10) || 10 * 60 * 1000; // 10 minutes

// In-memory caches
const searchCache = new Map(); // query -> { fetchedAt, data }
const pageCache = new Map(); // url -> { fetchedAt, data }

// Special headers required by XDMovies search API
// Token decoded from: base64Decode("NzI5N3Nra2loa2Fqd25zZ2FrbGFrc2h1d2Q=")
const SEARCH_HEADERS = {
    'x-auth-token': '7297skkihkajwnsgaklakshuwd',
    'x-requested-with': 'XMLHttpRequest',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
};

/**
 * Search XDMovies using their API
 * @param {string} query - Search query
 * @param {number} limit - Maximum results to return
 * @returns {Promise<Array>} Search results
 */
export async function searchXDMovies(query, limit = 15) {
    if (!query) return [];

    const cacheKey = `search:${query.toLowerCase().trim()}`;
    const now = Date.now();

    // Check in-memory cache
    const cached = searchCache.get(cacheKey);
    if (cached && now - cached.fetchedAt < SEARCH_CACHE_TTL) {
        console.log(`[XDMovies] Using cached search results for "${query}"`);
        return cached.data.slice(0, limit);
    }

    try {
        const searchUrl = `${BASE_URL}/php/search_api.php?query=${encodeURIComponent(query)}&fuzzy=true`;
        console.log(`[XDMovies] Searching: ${searchUrl}`);

        const response = await makeRequest(searchUrl, {
            headers: SEARCH_HEADERS,
            timeout: 10000
        });

        let data = [];
        try {
            data = JSON.parse(response.body);
        } catch (e) {
            console.error('[XDMovies] Failed to parse search response:', e.message);
            return [];
        }

        if (!Array.isArray(data)) {
            console.log('[XDMovies] Search returned non-array response');
            return [];
        }

        const results = data.map(item => ({
            id: item.id,
            tmdbId: item.tmdb_id,
            title: item.title,
            path: item.path,
            url: `${BASE_URL}${item.path}`,
            poster: item.poster ? `https://image.tmdb.org/t/p/original${item.poster}` : null,
            type: item.type?.toLowerCase() === 'tv' || item.type?.toLowerCase() === 'series' ? 'series' : 'movie',
            year: item.release_year ? parseInt(item.release_year) : null,
            qualities: item.qualities || [],
            audioLanguages: item.audio_languages,
            exactMatch: item.exact_match === 1
        }));

        // Cache results in memory
        searchCache.set(cacheKey, { fetchedAt: now, data: results });

        console.log(`[XDMovies] Found ${results.length} results for "${query}"`);
        return results.slice(0, limit);
    } catch (error) {
        console.error(`[XDMovies] Search error for "${query}":`, error.message);
        return [];
    }
}

/**
 * Extract season and episode from text
 */
function extractSeasonEpisode(text) {
    if (!text) return {};

    const seasonMatch = text.match(/S(?:eason)?\s*0*(\d+)/i);
    const episodeMatch = text.match(/E(?:pisode)?\s*0*(\d+)/i) || text.match(/\bEp?\s*0*(\d+)/i);

    return {
        season: seasonMatch ? parseInt(seasonMatch[1]) : null,
        episode: episodeMatch ? parseInt(episodeMatch[1]) : null
    };
}

/**
 * Extract size from text
 */
function extractSize(text) {
    if (!text) return null;
    const match = text.match(/([0-9]+(?:\.[0-9]+)?)\s*(TB|GB|MB)/i);
    return match ? `${match[1]} ${match[2].toUpperCase()}` : null;
}

/**
 * Load content page and extract download links
 * @param {string} url - Page URL
 * @returns {Promise<Object|null>} Parsed content with download links
 */
export async function loadXDMoviesContent(url) {
    if (!url) return null;

    const now = Date.now();

    // Check in-memory cache
    const cached = pageCache.get(url);
    if (cached && now - cached.fetchedAt < PAGE_CACHE_TTL) {
        console.log(`[XDMovies] Using cached content for ${url}`);
        return cached.data;
    }

    try {
        console.log(`[XDMovies] Loading content page: ${url}`);
        const response = await makeRequest(url, {
            parseHTML: true,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 15000
        });

        const $ = response.document;
        if (!$) {
            throw new Error('Failed to parse page HTML');
        }

        // Extract basic info
        const infoDiv = $('div.info').first();
        const title = infoDiv.find('h2').text().trim() || $('h1').first().text().trim();
        const description = $('p.overview').text().trim();

        // Extract year from URL or page
        const urlTmdbId = url.match(/-(\d+)$/)?.[1];
        const firstAirDate = $('p:contains("First Air Date:")').text().replace('First Air Date:', '').trim();
        const year = firstAirDate ? parseInt(firstAirDate.split('-')[0]) : null;

        // Determine content type from URL path
        const pathType = url.split('/')[3]; // e.g., 'movie', 'tv', 'anime'
        const type = ['tv', 'series', 'anime'].includes(pathType?.toLowerCase()) ? 'series' : 'movie';

        // Extract download links - movies have them in div.download-item a
        const downloadLinks = [];

        // For movies - simple download links
        $('div.download-item a').each((_, el) => {
            const href = $(el).attr('href')?.trim();
            if (!href) return;

            const label = $(el).text().trim() || $(el).attr('title') || '';
            const parentText = $(el).parent().text().trim();

            // Build descriptive label
            let fullLabel = label;
            if (parentText && parentText !== label) {
                fullLabel = `${parentText} ${label}`.trim();
            }

            downloadLinks.push({
                url: href,
                label: fullLabel,
                quality: getResolutionFromName(fullLabel),
                size: extractSize(fullLabel),
                languages: detectLanguagesFromTitle(fullLabel),
                ...extractSeasonEpisode(fullLabel)
            });
        });

        // For series - episode cards
        const episodeData = [];
        $('div.season-section').each((_, section) => {
            const sectionHtml = $(section).html() || '';

            // Extract season number
            const seasonMatch = sectionHtml.match(/season-(?:packs|episodes)-(\d+)/i) ||
                $(section).find('button.toggle-season-btn').text().match(/Season\s*(\d+)/i);
            const seasonNum = seasonMatch ? parseInt(seasonMatch[1]) : 1;

            // Episode cards
            $(section).find('.episode-card').each((idx, card) => {
                const cardTitle = $(card).find('.episode-title').text().trim();
                const epMatch = cardTitle.match(/S(\d+)E(\d+)/i) || cardTitle.match(/Episode\s*(\d+)/i);
                const epNum = epMatch ? parseInt(epMatch[2] || epMatch[1]) : (idx + 1);

                const links = [];
                $(card).find('a.movie-download-btn, a.download-button, a[href*="xdmovies"]').each((_, a) => {
                    const href = $(a).attr('href')?.trim();
                    if (href) {
                        const linkText = $(a).text().trim();
                        // Use card title (filename) as label, falling back to link text
                        // Card title has the full filename like "Squid.Game.S01E01.1080p.NF.WEB-DL.mkv"
                        const label = cardTitle || linkText || `S${seasonNum}E${epNum}`;
                        const size = extractSize(linkText) || extractSize(cardTitle);
                        links.push({
                            url: href,
                            label,
                            quality: getResolutionFromName(cardTitle) || getResolutionFromName(linkText),
                            size,
                            languages: detectLanguagesFromTitle(cardTitle),
                            season: seasonNum,
                            episode: epNum
                        });
                    }
                });

                if (links.length > 0) {
                    episodeData.push({
                        season: seasonNum,
                        episode: epNum,
                        title: cardTitle,
                        links
                    });
                }
            });

            // Pack cards (full season downloads)
            $(section).find('.packs-grid .pack-card').each((idx, pack) => {
                const href = $(pack).find('a.download-button').attr('href')?.trim();
                if (href) {
                    const packLabel = $(pack).text().trim() || `Season ${seasonNum} Pack`;
                    downloadLinks.push({
                        url: href,
                        label: packLabel,
                        quality: getResolutionFromName(packLabel),
                        size: extractSize(packLabel),
                        languages: detectLanguagesFromTitle(packLabel),
                        season: seasonNum,
                        episode: null,
                        isPack: true
                    });
                }
            });
        });

        // If we found episode data, flatten to download links
        if (episodeData.length > 0) {
            episodeData.forEach(ep => {
                downloadLinks.push(...ep.links);
            });
        }

        // Detect languages from page title
        const titleLanguages = detectLanguagesFromTitle(title);

        const data = {
            url,
            title,
            year,
            type,
            tmdbId: urlTmdbId ? parseInt(urlTmdbId) : null,
            description,
            titleLanguages,
            downloadLinks,
            episodeData
        };

        // Cache the result in memory
        pageCache.set(url, { fetchedAt: now, data });

        console.log(`[XDMovies] Loaded content: "${title}" with ${downloadLinks.length} download links`);
        return data;
    } catch (error) {
        console.error(`[XDMovies] Failed to load content ${url}:`, error.message);
        return null;
    }
}

export { BASE_URL };
