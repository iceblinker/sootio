/**
 * MKVDrama Streams
 * Builds HTTP streams from mkvdrama.net download pages (Ouo short links).
 *
 * Search phase: Find page, extract OUO links with resolutions
 * Resolution phase (user clicks): Resolve OUO → viewcrate → pixeldrain
 */

import Cinemeta from '../../../util/cinemeta.js';
import { scrapeMkvDramaSearch, loadMkvDramaContent } from './search.js';
import { renderLanguageFlags, detectLanguagesFromTitle } from '../../../util/language-mapping.js';
import { removeYear, generateAlternativeQueries, getSortedMatches, getResolutionFromName } from '../../utils/parsing.js';
import { encodeUrlForStreaming } from '../../utils/encoding.js';
import { isLazyLoadEnabled, createPreviewStream, formatPreviewStreams } from '../../utils/preview-mode.js';
import flaresolverrManager from '../../../util/flaresolverr-manager.js';

const PROVIDER = 'MkvDrama';

/**
 * Creates a user-visible error stream when FlareSolverr is unavailable
 * @param {string} reason - Reason for unavailability ('overloaded' or 'rate_limited')
 * @param {Object} options - Additional options
 * @returns {Object} A Stremio-formatted error stream
 */
function createFlareSolverrErrorStream(reason = 'overloaded', options = {}) {
    const { remaining = 0 } = options;
    let title, description;

    if (reason === 'rate_limited') {
        title = '⏳ Rate Limit Reached';
        description = `You've used your FlareSolverr quota for this hour.\n${remaining > 0 ? `${remaining} requests remaining.` : 'Please try again later.'}\n\nMkvDrama | Debrid streams unaffected`;
    } else {
        title = '⚠️ Server Busy';
        description = 'FlareSolverr is processing many requests.\nPlease try again in a moment.\n\nMkvDrama | Debrid streams unaffected';
    }

    return {
        name: `[HS+] Sootio\nBusy`,
        title: `${title}\n${description}`,
        externalUrl: 'https://github.com/sootio/stremio-addon',
        behaviorHints: { notWebReady: true }
    };
}

// Supported download hosts - each link generates streams for all hosts
const DOWNLOAD_HOSTS = [
    { id: 'pixeldrain.com', label: 'Pixeldrain' }
];

/**
 * Check if an entry could be a pixeldrain link.
 * Returns true if:
 * - Host is explicitly pixeldrain.com, OR
 * - Host is not set (will be resolved via OUO -> viewcrate chain)
 * Returns false if host is explicitly set to a different provider.
 */
function isPixeldrainLink(entry) {
    if (!entry) return false;
    if (entry.host) {
        const host = entry.host.toLowerCase();
        // Explicitly pixeldrain
        if (host === 'pixeldrain.com' || host.includes('pixeldrain')) return true;
        // Explicitly a different host - exclude it
        return false;
    }
    // No host info - assume it could be pixeldrain (most mkvdrama OUO links resolve to pixeldrain)
    return true;
}

function normalizeResolution(label = '') {
    const resolution = getResolutionFromName(label);
    if (resolution === '2160p') return '4k';
    if (['1080p', '720p', '540p', '480p'].includes(resolution)) return resolution;
    return 'HTTP';
}

function buildHintedUrl(url, hints = {}) {
    const params = new URLSearchParams();
    if (hints.episode) params.set('ep', hints.episode);
    if (hints.resolution) params.set('res', hints.resolution);
    if (hints.host) params.set('host', hints.host);
    const hash = params.toString();
    return hash ? `${url}#${hash}` : url;
}

function formatEpisodeKey(season, episode) {
    if (!season || !episode) return null;
    const s = String(season).padStart(2, '0');
    const e = String(episode).padStart(2, '0');
    return `S${s}E${e}`;
}

function formatEpisodeKeyFromEntry(entry) {
    if (!entry) return null;
    if (entry.episodeStart && entry.episodeEnd && entry.episodeStart === entry.episodeEnd) {
        const e = String(entry.episodeStart).padStart(2, '0');
        if (entry.season) {
            const s = String(entry.season).padStart(2, '0');
            return `S${s}E${e}`;
        }
        return `E${e}`;
    }
    return null;
}

function extractEpisodeKeyFromText(text = '') {
    const match = text.match(/\bS(\d{1,2})E(\d{1,3})\b/i);
    if (!match) return null;
    const s = String(match[1]).padStart(2, '0');
    const e = String(match[2]).padStart(2, '0');
    return `S${s}E${e}`;
}

function buildDedupKey(entry, episodeKey, hostId) {
    const text = `${entry?.linkText || ''} ${entry?.label || ''} ${entry?.quality || ''}`.trim();
    const resolution = getResolutionFromName(text);
    const entryEpisodeKey = episodeKey ||
        formatEpisodeKeyFromEntry(entry) ||
        extractEpisodeKeyFromText(text);
    return `${entryEpisodeKey || 'unknown'}|${resolution || 'other'}|${hostId || 'host'}`;
}

function buildDisplayLabel(entry, episodeKey = null) {
    const label = episodeKey || entry.label;
    const parts = [label, entry.quality].filter(Boolean);
    return parts.join(' ').trim() || 'Download';
}

function matchesEpisode(entry, season, episode) {
    if (!episode) return true;
    const episodeNumber = parseInt(episode, 10);
    if (Number.isNaN(episodeNumber)) return true;
    if (entry.season && season && entry.season !== parseInt(season, 10)) return false;
    if (entry.episodeStart !== null && entry.episodeEnd !== null) {
        return episodeNumber >= entry.episodeStart && episodeNumber <= entry.episodeEnd;
    }
    // Entry has no episode info — when a specific episode is requested, reject it
    // to avoid returning season packs or unrelated episodes
    return false;
}

function selectEpisodeLinks(links, season, episode) {
    if (!episode) return links;
    const episodeNumber = parseInt(episode, 10);
    if (Number.isNaN(episodeNumber)) return links;
    const seasonNumber = season ? parseInt(season, 10) : null;

    const seasonFiltered = links.filter((entry) => {
        if (entry.season && seasonNumber && entry.season !== seasonNumber) return false;
        return true;
    });

    const withEpisodeInfo = seasonFiltered.filter((entry) =>
        entry.episodeStart !== null || entry.episodeEnd !== null
    );

    const exactMatches = withEpisodeInfo.filter((entry) =>
        entry.episodeStart === episodeNumber && entry.episodeEnd === episodeNumber
    );
    if (exactMatches.length) return exactMatches;

    const rangedMatches = withEpisodeInfo.filter((entry) => {
        if (entry.episodeStart === null && entry.episodeEnd === null) return false;
        const start = entry.episodeStart ?? entry.episodeEnd;
        const end = entry.episodeEnd ?? entry.episodeStart;
        if (start === null || end === null) return false;
        return episodeNumber >= start && episodeNumber <= end;
    });
    if (rangedMatches.length) return rangedMatches;

    // No exact or ranged matches found — return empty instead of falling back
    // to all links without episode info (which would yield season packs or wrong episodes)
    return [];
}

function normalizeLinkUrl(url = '') {
    if (!url) return '';
    try {
        const parsed = new URL(url);
        parsed.hash = '';
        return parsed.toString();
    } catch {
        return url;
    }
}

function dedupeLinks(links) {
    const seen = new Set();
    return links.filter((entry) => {
        const key = normalizeLinkUrl(entry.url);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

// Exported for unit testing
export { matchesEpisode, selectEpisodeLinks };

export async function getMkvDramaStreams(tmdbId, type, season = null, episode = null, config = {}, prefetchedMeta = null) {
    try {
        console.log(`[${PROVIDER}] Starting search for ${tmdbId} (${type}${season ? ` S${season}` : ''}${episode ? `E${episode}` : ''})`);

        // Extract clientIp from config for per-IP rate limiting
        const clientIp = config?.clientIp || null;

        // Check FlareSolverr availability early (MkvDrama depends on it for Cloudflare bypass)
        // Only return error stream if IP is specifically rate-limited
        if (clientIp && flaresolverrManager.isIpRateLimited(clientIp)) {
            const remaining = flaresolverrManager.getIpRemainingRequests(clientIp);
            console.warn(`[${PROVIDER}] Client IP ${clientIp} rate limited (${remaining} remaining)`);
            return [createFlareSolverrErrorStream('rate_limited', { remaining })];
        }

        let meta = prefetchedMeta;
        if (!meta) {
            console.log(`[${PROVIDER}] No pre-fetched metadata, fetching from Cinemeta...`);
            meta = await Cinemeta.getMeta(type, tmdbId);
        } else {
            console.log(`[${PROVIDER}] Using pre-fetched Cinemeta metadata: "${meta.name}"`);
        }

        if (!meta?.name) {
            console.log(`[${PROVIDER}] Missing metadata for ${tmdbId}`);
            return [];
        }

        const queries = Array.from(new Set([
            meta.name,
            removeYear(meta.name),
            ...(meta.alternativeTitles || []),
            ...generateAlternativeQueries(meta.name, meta.original_title)
        ].filter(Boolean)));

        // Search with early exit on good match
        let searchResults = [];
        for (const query of queries) {
            console.log(`[${PROVIDER}] Searching for: "${query}"`);
            const results = await scrapeMkvDramaSearch(query);
            searchResults.push(...results);

            // Early exit if we found a good match
            if (results.length > 0) {
                const matches = getSortedMatches(results, meta.name);
                if (matches.length > 0 && matches[0].score >= 50) {
                    console.log(`[${PROVIDER}] Found good match early, skipping remaining queries`);
                    break;
                }
            }
        }

        if (searchResults.length === 0) {
            console.log(`[${PROVIDER}] No search results found`);
            return [];
        }

        const seenUrls = new Set();
        const uniqueResults = searchResults.filter(result => {
            if (!result?.url || seenUrls.has(result.url)) return false;
            seenUrls.add(result.url);
            return true;
        });

        const sortedMatches = getSortedMatches(uniqueResults, meta.name);
        const bestMatch = sortedMatches[0];
        if (!bestMatch?.url) {
            console.log(`[${PROVIDER}] No suitable match found for ${meta.name}`);
            return [];
        }

        console.log(`[${PROVIDER}] Loading content from: ${bestMatch.url}`);
        const content = await loadMkvDramaContent(bestMatch.url, null, {
            season,
            episode
        });
        const downloadLinks = content.downloadLinks || [];

        if (downloadLinks.length === 0) {
            console.log(`[${PROVIDER}] No download links found on ${bestMatch.url}`);
            return [];
        }

        const candidateLinks = downloadLinks.filter(isPixeldrainLink);
        const filteredLinks = (type === 'series' || type === 'tv') && episode
            ? selectEpisodeLinks(candidateLinks.filter(entry => matchesEpisode(entry, season, episode)), season, episode)
            : candidateLinks;

        const uniqueLinks = dedupeLinks(filteredLinks);

        if (uniqueLinks.length === 0) {
            console.log(`[${PROVIDER}] No pixeldrain links found for S${season}E${episode}`);
            return [];
        }

        const detectedLanguages = detectLanguagesFromTitle(content.title || meta.name || '');
        const episodeKey = (type === 'series' || type === 'tv') && episode
            ? formatEpisodeKey(season, episode)
            : null;

        if (isLazyLoadEnabled()) {
            const previewStreams = [];
            const seenKeys = new Set();
            for (const link of uniqueLinks) {
                const label = buildDisplayLabel(link, episodeKey);
                const resolutionHint = getResolutionFromName(label);

                // Generate a stream for each supported host
                for (const host of DOWNLOAD_HOSTS) {
                    const dedupeKey = buildDedupKey(link, episodeKey, host.id);
                    if (seenKeys.has(dedupeKey)) continue;
                    seenKeys.add(dedupeKey);
                    const hintedUrl = buildHintedUrl(link.url, {
                        episode: episodeKey,
                        resolution: resolutionHint !== 'other' ? resolutionHint : null,
                        host: host.id
                    });
                    previewStreams.push(createPreviewStream({
                        url: hintedUrl,
                        label: `${label} [${host.label}]`,
                        provider: PROVIDER,
                        languages: detectedLanguages
                    }));
                }
            }

            return formatPreviewStreams(previewStreams, encodeUrlForStreaming, renderLanguageFlags);
        }

        const streams = [];
        const seenKeys = new Set();
        for (const link of uniqueLinks) {
            const label = buildDisplayLabel(link, episodeKey);
            const resolutionLabel = normalizeResolution(label);
            const languageFlags = renderLanguageFlags(detectedLanguages);
            const resolutionHint = getResolutionFromName(label);

            // Generate a stream for each supported host
            for (const host of DOWNLOAD_HOSTS) {
                const dedupeKey = buildDedupKey(link, episodeKey, host.id);
                if (seenKeys.has(dedupeKey)) continue;
                seenKeys.add(dedupeKey);
                const hintedUrl = buildHintedUrl(link.url, {
                    episode: episodeKey,
                    resolution: resolutionHint !== 'other' ? resolutionHint : null,
                    host: host.id
                });

                streams.push({
                    name: `[HS+] Sootio\n${resolutionLabel}`,
                    title: `${label} [${host.label}]${languageFlags}\n${PROVIDER}`,
                    url: encodeUrlForStreaming(hintedUrl),
                    resolution: resolutionLabel,
                    needsResolution: true,
                    isPreview: true,
                    behaviorHints: {
                        bingeGroup: 'mkvdrama-streams'
                    }
                });
            }
        }

        console.log(`[${PROVIDER}] Returning ${streams.length} streams`);
        return streams;
    } catch (error) {
        console.error(`[${PROVIDER}] Failed to fetch streams: ${error.message}`);
        return [];
    }
}
