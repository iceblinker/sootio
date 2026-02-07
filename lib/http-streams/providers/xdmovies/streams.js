/**
 * XDMovies Streams
 * Converts XDMovies download links into direct HTTP streams
 */

import Cinemeta from '../../../util/cinemeta.js';
import {
    renderLanguageFlags,
    detectLanguagesFromTitle
} from '../../../util/language-mapping.js';
import {
    getResolutionFromName,
    removeYear,
    generateAlternativeQueries,
    getSortedMatches
} from '../../utils/parsing.js';
import { encodeUrlForStreaming } from '../../utils/encoding.js';
import { searchXDMovies, loadXDMoviesContent } from './search.js';
import { processExtractorLinkWithAwait, extractHubCloudLinks, extractHubDriveLinks } from '../4khdhub/extraction.js';
import { isLazyLoadEnabled, createPreviewStream, formatPreviewStreams } from '../../utils/preview-mode.js';
import { extractFileName } from '../../../common/torrent-utils.js';

const MAX_LINKS = parseInt(process.env.XDMOVIES_MAX_LINKS, 10) || 12;
const MAX_THREAD_COUNT = parseInt(process.env.XDMOVIES_THREAD_COUNT, 10) || 6;

// XDMovies uses link.xdmovies.site as a redirector to HubCloud
const XDMOVIES_LINK_HOST = 'link.xdmovies.site';

// Keywords that indicate a pack rather than individual episode
const PACK_KEYWORDS = [
    '.zip', '.rar', '.7z', 'pack', 'complete', 'all episodes',
    'full series', 'full season', 'season pack'
];

function hasPackKeyword(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    return PACK_KEYWORDS.some(keyword => lower.includes(keyword));
}

function normalizeLabel(label) {
    return label ? label.replace(/\s+/g, ' ').trim() : '';
}

/**
 * Resolve XDMovies link redirects to get HubCloud URL
 * @param {string} url - XDMovies link (link.xdmovies.site)
 * @returns {Promise<string|null>} HubCloud URL or null
 */
async function resolveXDMoviesLink(url) {
    if (!url) return null;

    // If it's already a hubcloud/hubdrive link, return as-is
    if (url.includes('hubcloud') || url.includes('hubdrive') || url.includes('hubcdn')) {
        return url;
    }

    // If it's an xdmovies link, follow the redirect
    if (url.includes(XDMOVIES_LINK_HOST)) {
        try {
            const { makeRequest } = await import('../../utils/http.js');
            const response = await makeRequest(url, {
                allowRedirects: false,
                timeout: 5000
            });

            const redirectUrl = response.headers?.location || response.headers?.['Location'];
            if (redirectUrl) {
                console.log(`[XDMovies] Resolved redirect: ${url} -> ${redirectUrl}`);
                return redirectUrl;
            }
        } catch (error) {
            console.log(`[XDMovies] Failed to resolve redirect for ${url}: ${error.message}`);
        }
    }

    return url;
}

/**
 * Process a single download link and extract streaming URLs
 */
async function processDownloadLink(link, index) {
    try {
        // First resolve any XDMovies redirects
        const resolvedUrl = await resolveXDMoviesLink(link.url);
        if (!resolvedUrl) return [];

        let results = [];

        // Use the appropriate extractor based on URL
        if (resolvedUrl.includes('hubdrive')) {
            results = await extractHubDriveLinks(resolvedUrl, index);
        } else if (resolvedUrl.includes('hubcloud') || resolvedUrl.includes('hubcdn')) {
            results = await extractHubCloudLinks(resolvedUrl, 'XDMovies');
        } else {
            // Generic extraction
            results = await processExtractorLinkWithAwait(resolvedUrl, index + 1);
        }

        if (!results || results.length === 0) {
            return [];
        }

        return results.map(result => ({
            url: result.url,
            name: result.name || 'XDMovies',
            quality: result.quality || getResolutionFromName(link.label),
            size: link.size || result.size,
            sourceLabel: link.label,
            languages: link.languages?.length ? link.languages : detectLanguagesFromTitle(link.label),
            resolverUrl: link.url
        }));
    } catch (error) {
        console.error(`[XDMovies] Failed to process link ${link.url}:`, error.message);
        return [];
    }
}

/**
 * Prioritize and sort download links
 */
function prioritizeLinks(downloadLinks, type, season, episode) {
    const requestedSeason = season ? parseInt(season) : null;
    const requestedEpisode = episode ? parseInt(episode) : null;

    return downloadLinks
        .map(link => {
            let priority = 0;

            // Prefer per-episode links for series
            if (type === 'series') {
                if (requestedSeason && link.season === requestedSeason) {
                    priority += 30;
                }
                if (requestedEpisode && link.episode === requestedEpisode) {
                    priority += 40;
                }
            }

            // Prefer higher resolution
            const resolution = getResolutionFromName(link.label);
            if (resolution === '2160p') priority += 25;
            else if (resolution === '1080p') priority += 20;
            else if (resolution === '720p') priority += 10;

            // Prefer HEVC/265 encodes
            if (/HEVC|H265|x265/i.test(link.label)) priority += 5;

            // Deprioritize packs when looking for specific episodes
            if (link.isPack || hasPackKeyword(link.label)) {
                priority -= 50;
            }

            return { ...link, priority };
        })
        .sort((a, b) => b.priority - a.priority);
}

/**
 * Extract streaming links from download links with concurrency control
 */
async function extractStreamingLinks(downloadLinks, type, season, episode) {
    const prioritized = prioritizeLinks(downloadLinks, type, season, episode);
    const limited = prioritized.slice(0, MAX_LINKS);

    if (limited.length === 0) return [];

    const concurrency = Math.min(MAX_THREAD_COUNT, limited.length);
    console.log(`[XDMovies] Extracting ${limited.length} links with concurrency ${concurrency}`);

    const results = new Array(limited.length);
    let cursor = 0;

    const worker = async () => {
        while (cursor < limited.length) {
            const currentIndex = cursor++;
            const link = limited[currentIndex];
            results[currentIndex] = await processDownloadLink(link, currentIndex);
        }
    };

    await Promise.all(Array.from({ length: concurrency }, worker));
    return results.flat();
}

/**
 * Filter streams to match requested episode
 */
function filterEpisodeStreams(streams, season, episode) {
    if (!season || !episode) return streams;
    const requestedSeason = parseInt(season);
    const requestedEpisode = parseInt(episode);

    return streams.filter(stream => {
        const title = stream.title || stream.sourceLabel || '';

        // Check for SxxExx format
        const sxxexxMatch = title.match(/S0*(\d+)\s*E0*(\d+)/i);
        if (sxxexxMatch) {
            const s = parseInt(sxxexxMatch[1]);
            const e = parseInt(sxxexxMatch[2]);
            return s === requestedSeason && e === requestedEpisode;
        }

        // Check for "Episode X" format
        const episodeMatch = title.match(/Episode\s*0*(\d+)/i);
        if (episodeMatch) {
            return parseInt(episodeMatch[1]) === requestedEpisode;
        }

        // Check for "EP X" format
        const epMatch = title.match(/\bEP\.?\s*0*(\d+)/i);
        if (epMatch) {
            return parseInt(epMatch[1]) === requestedEpisode;
        }

        // No episode marker - could be for any episode
        return true;
    });
}

/**
 * Map extracted links to Stremio stream format
 */
function mapToStreams(links) {
    const trustedDirectHosts = ['hubcloud', 'hubcdn', 'pixeldrain', 'r2.dev', 'workers.dev'];

    return links.map(link => {
        let resolution = getResolutionFromName(link.sourceLabel);
        if (resolution === 'other') {
            resolution = getResolutionFromName(link.name);
        }

        let resolutionLabel = resolution;
        if (resolution === '2160p') resolutionLabel = '4k';

        const languages = link.languages?.length ? link.languages : detectLanguagesFromTitle(link.sourceLabel);
        const languageFlags = renderLanguageFlags(languages);
        const directUrl = encodeUrlForStreaming(link.url);

        const urlLower = (link.url || '').toLowerCase();
        const directIsTrusted = urlLower && trustedDirectHosts.some(host => urlLower.includes(host));

        let needsResolution = Boolean(link.resolverUrl);
        let streamUrl;

        if (directIsTrusted) {
            needsResolution = false;
            streamUrl = encodeUrlForStreaming(link.url);
        } else {
            const resolverSource = needsResolution ? link.resolverUrl : link.url;
            streamUrl = encodeUrlForStreaming(resolverSource || link.url);
        }

        const size = link.size;
        const fileName = extractFileName(link.sourceLabel || link.name || '');
        const behaviorHints = {
            bingeGroup: 'xdmovies-streams',
            xdmoviesDirectUrl: directUrl
        };
        if (fileName) {
            behaviorHints.fileName = fileName;
        }

        return {
            name: `[HS+] Sootio\n${resolutionLabel}`,
            title: `${normalizeLabel(link.sourceLabel || link.name)}${languageFlags}\n💾 ${size || 'N/A'} | XDMovies`,
            url: streamUrl,
            size,
            resolution,
            needsResolution,
            resolverFallbackUrl: directUrl,
            behaviorHints
        };
    });
}

/**
 * Main entry point: Get XDMovies streams for a given IMDB ID
 */
export async function getXDMoviesStreams(imdbId, type, season = null, episode = null, config = {}, prefetchedMeta = null) {
    try {
        // Extract just the IMDB ID if full series ID format is passed (tt1234567:2:1 -> tt1234567)
        const cleanImdbId = imdbId.includes(':') ? imdbId.split(':')[0] : imdbId;

        // Use pre-fetched metadata if available
        let cinemetaDetails = prefetchedMeta;
        if (!cinemetaDetails) {
            console.log(`[XDMovies] No pre-fetched metadata, fetching from Cinemeta...`);
            cinemetaDetails = await Cinemeta.getMeta(type, cleanImdbId);
        } else {
            console.log(`[XDMovies] Using pre-fetched Cinemeta metadata: "${cinemetaDetails.name}"`);
        }

        if (!cinemetaDetails) {
            console.log('[XDMovies] Cinemeta lookup failed');
            return [];
        }

        const year = cinemetaDetails.year ? parseInt(String(cinemetaDetails.year).split('-')[0]) : null;

        // Build query list
        let queries = [];
        if (cinemetaDetails.alternativeTitles && cinemetaDetails.alternativeTitles.length > 0) {
            console.log(`[XDMovies] Using ${cinemetaDetails.alternativeTitles.length} alternative titles for search`);
            queries = cinemetaDetails.alternativeTitles;
        } else {
            queries = generateAlternativeQueries(cinemetaDetails.name, cinemetaDetails.original_title);
        }

        // Search for content
        let searchResults = [];
        for (const query of queries) {
            console.log(`[XDMovies] Searching with query: "${query}"`);
            const results = await searchXDMovies(query, 15);
            if (results.length > 0) {
                searchResults = results;
                console.log(`[XDMovies] Query "${query}" found ${results.length} results`);
                break;
            }
        }

        if (searchResults.length === 0) {
            console.log('[XDMovies] No search results found');
            return [];
        }

        // Find best matching result
        let content = null;
        const isSeries = type === 'series' || type === 'tv';
        const sortedMatches = getSortedMatches(searchResults, cinemetaDetails.name);

        if (sortedMatches.length === 0) {
            console.log(`[XDMovies] No suitable match found for: ${cinemetaDetails.name}`);
            return [];
        }

        for (const result of sortedMatches) {
            // Check type match
            if (isSeries && result.type !== 'series') continue;
            if (!isSeries && result.type !== 'movie') continue;

            // Check year match (if available)
            if (year && result.year && Math.abs(result.year - year) > 1) continue;

            // Load content page
            const candidateContent = await loadXDMoviesContent(result.url);
            if (!candidateContent || !candidateContent.downloadLinks?.length) {
                console.log(`[XDMovies] No download links found for ${result.url}`);
                continue;
            }

            // For series, check if the requested season exists
            if (isSeries && season) {
                const requestedSeason = parseInt(season);
                const hasRequestedSeason = candidateContent.downloadLinks.some(link =>
                    link.season === requestedSeason
                );

                if (!hasRequestedSeason && candidateContent.episodeData?.length > 0) {
                    const episodeHasSeason = candidateContent.episodeData.some(ep =>
                        ep.season === requestedSeason
                    );
                    if (!episodeHasSeason) {
                        console.log(`[XDMovies] Season ${requestedSeason} not found in ${result.title}`);
                        continue;
                    }
                }
            }

            content = candidateContent;
            console.log(`[XDMovies] Using match: ${candidateContent.title}`);
            break;
        }

        if (!content) {
            console.log('[XDMovies] No suitable content found');
            return [];
        }

        // LAZY-LOAD MODE: Return preview streams without full extraction
        if (isLazyLoadEnabled()) {
            console.log(`[XDMovies] Lazy-load enabled: returning ${content.downloadLinks.length} preview streams`);

            let linksToProcess = content.downloadLinks;

            // Filter for specific episode if requested
            if (isSeries && season && episode) {
                const requestedSeason = parseInt(season);
                const requestedEpisode = parseInt(episode);

                const episodeLinks = linksToProcess.filter(link => {
                    if (link.season === requestedSeason && link.episode === requestedEpisode) {
                        return true;
                    }

                    // Check label for episode markers
                    const label = link.label || '';
                    const sxxexxMatch = label.match(/S0*(\d+)\s*E0*(\d+)/i);
                    if (sxxexxMatch) {
                        return parseInt(sxxexxMatch[1]) === requestedSeason &&
                               parseInt(sxxexxMatch[2]) === requestedEpisode;
                    }

                    // Check for episode number only (e.g., "Episode 1", "Ep 1")
                    const episodeOnlyMatch = label.match(/(?:Episode|Ep\.?)\s*0*(\d+)/i);
                    if (episodeOnlyMatch) {
                        return parseInt(episodeOnlyMatch[1]) === requestedEpisode;
                    }

                    return false;
                });

                if (episodeLinks.length > 0) {
                    linksToProcess = episodeLinks;
                    console.log(`[XDMovies] Filtered to ${linksToProcess.length} links for S${season}E${episode}`);
                } else {
                    // No specific episode links found - XDMovies often has season-level links
                    // Keep all non-pack links as they may contain the episode
                    console.log(`[XDMovies] No specific episode links found for S${season}E${episode}, keeping all ${linksToProcess.length} links`);
                }
            }

            // Filter out packs for episode requests
            if (isSeries && episode) {
                linksToProcess = linksToProcess.filter(link =>
                    !link.isPack && !hasPackKeyword(link.label)
                );
            }

            // Prioritize and limit
            const prioritized = prioritizeLinks(linksToProcess, type, season, episode);
            const limited = prioritized.slice(0, MAX_LINKS);

            const previewStreams = limited.map(link => createPreviewStream({
                url: link.url,
                label: link.label || 'XDMovies Stream',
                provider: 'XDMovies',
                size: link.size,
                languages: link.languages || []
            }));

            const streams = formatPreviewStreams(previewStreams, encodeUrlForStreaming, renderLanguageFlags);

            console.log(`[XDMovies] Returning ${streams.length} preview streams (lazy-load mode)`);
            return streams;
        }

        // LEGACY MODE: Full extraction and validation
        console.log(`[XDMovies] Lazy-load disabled: extracting streams (legacy mode)`);
        const streamingLinks = await extractStreamingLinks(content.downloadLinks, type, season, episode);

        if (streamingLinks.length === 0) {
            console.log('[XDMovies] No streaming links after extraction');
            return [];
        }

        // Dedupe
        const seen = new Set();
        const unique = streamingLinks.filter(link => {
            if (!link.url || seen.has(link.url)) return false;
            seen.add(link.url);
            return true;
        });

        let streams = mapToStreams(unique);

        // Sort by resolution
        streams.sort((a, b) => {
            const priority = { '2160p': 4, '1080p': 3, '720p': 2, '480p': 1, other: 0 };
            return (priority[b.resolution] || 0) - (priority[a.resolution] || 0);
        });

        // Filter for specific episode
        if (isSeries && season && episode) {
            const episodeStreams = filterEpisodeStreams(streams, season, episode);
            if (episodeStreams.length > 0) {
                streams = episodeStreams;
            }
        }

        console.log(`[XDMovies] Returning ${streams.length} streams`);
        return streams;
    } catch (error) {
        console.error('[XDMovies] Error getting streams:', error.message);
        return [];
    }
}

export { filterEpisodeStreams };
