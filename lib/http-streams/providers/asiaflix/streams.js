/**
 * Asiaflix Streams
 * Extracts video streams from Asiaflix (Asian drama streaming site)
 * Videos are hosted on SharePoint with temporary auth tokens
 */

import Cinemeta from '../../../util/cinemeta.js';
import { scrapeAsiaflixSearch, loadAsiaflixDrama, loadAsiaflixEpisode } from './search.js';
import { renderLanguageFlags } from '../../../util/language-mapping.js';
import { removeYear, generateAlternativeQueries, getSortedMatches } from '../../utils/parsing.js';
import { encodeUrlForStreaming } from '../../utils/encoding.js';

const PROVIDER = 'Asiaflix';
const BASE_URL = 'https://asiaflix.net';
const SUPPORTED_STREAM_SOURCES = new Set(['streamtape']);

function extractQualityFromUrl(url) {
    const text = String(url || '').toLowerCase();
    if (text.includes('2160') || text.includes('4k')) return '4k';
    if (text.includes('1080')) return '1080p';
    if (text.includes('720')) return '720p';
    if (text.includes('480')) return '480p';
    if (text.includes('360')) return '360p';
    return 'HD';
}

function slugifyTitle(title) {
    return (title || '')
        .toLowerCase()
        .replace(/\b(19|20)\d{2}\b/g, '')
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\s/g, '-')
        .replace(/-+/g, '-');
}

function normalizeStreamUrl(url) {
    if (!url) return null;
    if (url.startsWith('//')) return `https:${url}`;
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    return null;
}

function appendRefererHint(url, referer) {
    if (!url || !referer) return url;
    return `${url}#ref=${encodeURIComponent(referer)}`;
}

function isSupportedStreamSource(source) {
    if (!source) return false;
    return SUPPORTED_STREAM_SOURCES.has(source.toLowerCase());
}

async function tryDirectDramaLoad(meta) {
    const candidates = [
        removeYear(meta?.name || ''),
        removeYear(meta?.original_title || '')
    ].filter(Boolean);

    for (const candidate of candidates) {
        const slug = slugifyTitle(candidate);
        if (!slug) continue;
        const url = `${BASE_URL}/drama/${slug}`;
        console.log(`[${PROVIDER}] Trying direct drama URL: ${url}`);
        const drama = await loadAsiaflixDrama(url);
        if (drama?.episodes?.length) {
            return { drama, url };
        }
    }

    return null;
}

/**
 * Get streams from Asiaflix for a given title
 * @param {string} tmdbId - TMDB ID
 * @param {string} type - 'movie' or 'series'
 * @param {number} season - Season number (for series)
 * @param {number} episode - Episode number (for series)
 * @param {Object} config - Configuration options
 * @param {Object} prefetchedMeta - Pre-fetched Cinemeta metadata
 * @returns {Promise<Array>} Array of stream objects
 */
export async function getAsiaflixStreams(tmdbId, type, season = null, episode = null, config = {}, prefetchedMeta = null) {
    try {
        console.log(`[${PROVIDER}] Starting search for ${tmdbId} (${type}${season ? ` S${season}` : ''}${episode ? `E${episode}` : ''})`);

        // Get metadata
        let meta = prefetchedMeta;
        if (!meta) {
            console.log(`[${PROVIDER}] Fetching metadata from Cinemeta...`);
            meta = await Cinemeta.getMeta(type, tmdbId);
        } else {
            console.log(`[${PROVIDER}] Using pre-fetched metadata: "${meta.name}"`);
        }

        if (!meta?.name) {
            console.log(`[${PROVIDER}] Missing metadata for ${tmdbId}`);
            return [];
        }

        const languageFlags = renderLanguageFlags(['ko', 'en']); // Korean audio, English subs
        const buildStreamsFromUrls = (items, titleBase, episodeLabel, referer) => {
            if (!Array.isArray(items) || items.length === 0) return [];
            return items
                .filter(item => item && item.url && isSupportedStreamSource(item.source || ''))
                .map(item => {
                    const normalizedUrl = normalizeStreamUrl(item.url.trim());
                    if (!normalizedUrl) return null;
                    const source = (item.source || 'Server').trim();
                    const hintedUrl = appendRefererHint(normalizedUrl, referer);
                    const quality = extractQualityFromUrl(normalizedUrl);
                    return {
                        name: `[HS+] Sootio\n${quality}`,
                        title: `${titleBase} E${episodeLabel}${languageFlags}\n${PROVIDER} (${source})`,
                        url: encodeUrlForStreaming(hintedUrl),
                        resolution: quality,
                        needsResolution: true,
                        behaviorHints: {
                            bingeGroup: 'asiaflix-streams',
                            notWebReady: true,
                            proxyHeaders: {
                                request: {
                                    Referer: referer || normalizedUrl
                                }
                            },
                            filename: `${titleBase} E${episodeLabel}.mp4`
                        }
                    };
                })
                .filter(Boolean);
        };

        if (type === 'series' || type === 'tv') {
            const episodeLabel = parseInt(episode, 10);
            const directCandidates = [
                meta.name,
                meta.original_title
            ].filter(Boolean);

            for (const candidate of directCandidates) {
                const slug = slugifyTitle(candidate);
                if (!slug) continue;
                const episodeUrl = `${BASE_URL}/drama/${slug}/episode-${episodeLabel}`;
                console.log(`[${PROVIDER}] Trying direct episode URL: ${episodeUrl}`);
                const episodeData = await loadAsiaflixEpisode(episodeUrl);
                if (Array.isArray(episodeData.streamUrls) && episodeData.streamUrls.length > 0) {
                    const streams = buildStreamsFromUrls(episodeData.streamUrls, meta.name, episodeLabel, episodeUrl);
                    console.log(`[${PROVIDER}] Returning ${streams.length} stream(s) from direct episode URL`);
                    return streams;
                }
                if (episodeData.videoUrl) {
                    const quality = episodeData.quality || 'HD';
                    const stream = {
                        name: `[HS+] Sootio\n${quality}`,
                        title: `${meta.name} E${episodeLabel}${languageFlags}\n${PROVIDER} (SharePoint)`,
                        url: encodeUrlForStreaming(appendRefererHint(episodeData.videoUrl, episodeUrl)),
                        resolution: quality,
                        behaviorHints: {
                            bingeGroup: 'asiaflix-streams',
                            filename: episodeData.filename || `${meta.name} E${episodeLabel}.mp4`
                        }
                    };
                    console.log(`[${PROVIDER}] Returning 1 stream (${quality}) from direct episode URL`);
                    return [stream];
                }
            }
        }

        // Try direct drama URL first to avoid slow search
        let dramaResult = await tryDirectDramaLoad(meta);
        let drama = dramaResult?.drama || null;
        let bestMatch = dramaResult
            ? { title: drama.title || meta.name, url: dramaResult.url, score: 100 }
            : null;

        if (!drama) {
            // Build search queries
            const queries = Array.from(new Set([
                meta.name,
                removeYear(meta.name),
                ...(meta.alternativeTitles || []),
                ...generateAlternativeQueries(meta.name, meta.original_title)
            ].filter(Boolean)));

            // Search for the drama
            let searchResults = [];
            for (const query of queries.slice(0, 3)) { // Limit to first 3 queries
                console.log(`[${PROVIDER}] Searching for: "${query}"`);
                const results = await scrapeAsiaflixSearch(query);
                searchResults.push(...results);

                // Early exit on good match
                if (results.length > 0) {
                    const matches = getSortedMatches(results, meta.name);
                    if (matches.length > 0 && matches[0].score >= 60) {
                        console.log(`[${PROVIDER}] Found good match early, skipping remaining queries`);
                        break;
                    }
                }
            }

            if (searchResults.length === 0) {
                console.log(`[${PROVIDER}] No search results found`);
                return [];
            }

            // Deduplicate results
            const seenUrls = new Set();
            const uniqueResults = searchResults.filter(result => {
                if (!result?.url || seenUrls.has(result.url)) return false;
                seenUrls.add(result.url);
                return true;
            });

            // Find best match
            const sortedMatches = getSortedMatches(uniqueResults, meta.name);
            bestMatch = sortedMatches[0];
            if (!bestMatch?.url) {
                console.log(`[${PROVIDER}] No suitable match found for ${meta.name}`);
                return [];
            }

            console.log(`[${PROVIDER}] Best match: "${bestMatch.title}" (score: ${bestMatch.score})`);

            // Load drama page to get episodes
            drama = await loadAsiaflixDrama(bestMatch.url);
            if (!drama.episodes || drama.episodes.length === 0) {
                console.log(`[${PROVIDER}] No episodes found for ${bestMatch.title}`);
                return [];
            }
        }

        // For series, find the specific episode
        let targetEpisode;
        if (type === 'series' || type === 'tv') {
            const epNum = parseInt(episode, 10);
            targetEpisode = drama.episodes.find(ep => ep.episode === epNum);

            if (!targetEpisode) {
                console.log(`[${PROVIDER}] Episode ${episode} not found (available: ${drama.episodes.map(e => e.episode).join(', ')})`);
                return [];
            }
        } else {
            // For movies, use first episode (some sites list movies as single-episode dramas)
            targetEpisode = drama.episodes[0];
        }

        console.log(`[${PROVIDER}] Loading episode ${targetEpisode.episode}: ${targetEpisode.url}`);

        // Load episode page and extract video URL
        const episodeData = await loadAsiaflixEpisode(targetEpisode.url);
        if (Array.isArray(episodeData.streamUrls) && episodeData.streamUrls.length > 0) {
            const baseTitle = drama.title || bestMatch.title;
            const episodeLabel = targetEpisode.episode || episode;
            const streams = buildStreamsFromUrls(episodeData.streamUrls, baseTitle, episodeLabel, targetEpisode.url);
            console.log(`[${PROVIDER}] Returning ${streams.length} stream(s) from ng-state`);
            return streams;
        }

        if (!episodeData.videoUrl) {
            console.log(`[${PROVIDER}] No video URL found for episode ${targetEpisode.episode}`);
            return [];
        }

        // Build stream object
        const quality = episodeData.quality || 'HD';
        const stream = {
            name: `[HS+] Sootio\n${quality}`,
            title: `${drama.title || bestMatch.title} E${targetEpisode.episode}${languageFlags}\n${PROVIDER} (SharePoint)`,
            url: encodeUrlForStreaming(appendRefererHint(episodeData.videoUrl, targetEpisode.url)),
            resolution: quality,
            behaviorHints: {
                bingeGroup: 'asiaflix-streams',
                filename: episodeData.filename || `${bestMatch.title} E${targetEpisode.episode}.mp4`
            }
        };

        console.log(`[${PROVIDER}] Returning 1 stream (${quality})`);
        return [stream];

    } catch (error) {
        console.error(`[${PROVIDER}] Error fetching streams: ${error.message}`);
        return [];
    }
}
