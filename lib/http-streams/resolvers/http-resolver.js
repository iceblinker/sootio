/**
 * HTTP Stream URL Resolver
 * Resolves redirect URLs to final streaming links
 * Handles lazy-load mode for 4KHDHub, HDHub4u, and UHDMovies
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import crypto from 'crypto';
import * as config from '../../config.js';
import { getRedirectLinks, processExtractorLinkWithAwait } from '../providers/4khdhub/extraction.js';
import { validateSeekableUrl } from '../utils/validation.js';
import { makeRequest } from '../utils/http.js';
import { tryDecodeBase64 } from '../utils/encoding.js';
import { getResolutionFromName } from '../utils/parsing.js';
import { resolveUHDMoviesUrl } from '../../uhdmovies/index.js';
import * as CacheStore from '../../util/cache-store.js';

const FAST_SEEK_TIMEOUT_MS = parseInt(process.env.HTTP_STREAM_SEEK_TIMEOUT_MS, 10) || 1500;
const MAX_PARALLEL_VALIDATIONS = parseInt(process.env.HTTP_STREAM_MAX_PARALLEL, 10) || 2;
const RESOLVE_CACHE_TTL = parseInt(process.env.HTTP_STREAM_RESOLVE_CACHE_TTL, 10) || (5 * 60 * 1000); // 5 minutes

const resolveCache = new Map(); // key -> { promise, value, ts }
const DIRECT_HOST_HINTS = ['workers.dev', 'hubcdn.fans', 'r2.dev'];
const OUO_HOSTS = ['ouo.io', 'ouo.press', 'oii.la'];
const OUO_BUTTON_ID = 'btn-main';
const DEFAULT_HTTP_STREAM_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const OUO_USER_AGENT = config.HTTP_STREAM_USER_AGENT || DEFAULT_HTTP_STREAM_USER_AGENT;
const VIEWCRATE_HOSTS = ['viewcrate.cc'];
const PIXELDRAIN_HOSTS = ['pixeldrain.com', 'pixeldrain.net', 'pixeldrain.dev'];
const FILECRYPT_HOSTS = ['filecrypt.cc', 'filecrypt.co'];
const XDMOVIES_LINK_HOSTS = ['link.xdmovies.site', 'link.xdmovies.wtf'];
const UHDMOVIES_SID_HOSTS = [
    'tech.unblockedgames.world',
    'tech.creativeexpressionsblog.com',
    'tech.examzculture.in',
    'driveseed.org',
    'driveleech.net'
];
const FLARESOLVERR_URL = config.FLARESOLVERR_URL || '';
const FLARESOLVERR_V2 = config.FLARESOLVERR_V2 === true;
const FLARESOLVERR_PROXY_URL = config.FLARESOLVERR_PROXY_URL || '';
const FLARESOLVERR_PROXY_ALLOW_HUBCLOUD = process.env.FLARESOLVERR_PROXY_HUBCLOUD !== 'false';
const FLARESOLVERR_TIMEOUT = parseInt(process.env.HTTP_FLARESOLVERR_TIMEOUT, 10) || 65000;
const OUO_COOKIE = config.OUO_COOKIE || '';
const VIEWCRATE_COOKIE = config.VIEWCRATE_COOKIE || '';
const MKVDRAMA_BASE_URL = 'https://mkvdrama.net';
const MKVDRAMA_TOKEN_PARAM = 'mkv_token';
const FLARE_SESSION_TTL = 10 * 60 * 1000;
const flareSessionCache = new Map(); // domain -> { sessionId, ts }
const flareSolverrLocks = new Map(); // domain -> Promise (prevents thundering herd)
const CF_COOKIE_CACHE_TTL = parseInt(process.env.CF_COOKIE_CACHE_TTL, 10) || 0; // 0 = reuse until denied
const cfCookieCache = new Map(); // domain -> { cookies, userAgent, ts }

// Known dead HubCloud domains that should be skipped (no DNS records)
const DEAD_HUBCLOUD_DOMAINS = new Set([
    'hubcloud.ink',
    'hubcloud.co',
    'hubcloud.cc',
    'hubcloud.me',
    'hubcloud.xyz'
]);

/**
 * Check if a URL is from a known dead HubCloud domain
 * @param {string} url - URL to check
 * @returns {boolean} True if the domain is dead and should be skipped
 */
function isDeadHubcloudDomain(url) {
    if (!url) return false;
    try {
        const hostname = new URL(url).hostname.toLowerCase();
        return DEAD_HUBCLOUD_DOMAINS.has(hostname);
    } catch {
        return false;
    }
}

function shouldUseFlareProxyForDomain(domain) {
    if (!FLARESOLVERR_PROXY_URL || !domain) return false;
    const lower = domain.toLowerCase();
    if (!FLARESOLVERR_PROXY_ALLOW_HUBCLOUD && (lower.includes('hubcloud') || lower.includes('hubdrive') || lower.includes('hubcdn'))) {
        return false;
    }
    return true;
}

const VIDEO_EXTENSIONS = new Set([
    '.mp4',
    '.mkv',
    '.avi',
    '.webm',
    '.mov',
    '.m4v',
    '.ts',
    '.m3u8'
]);

const NON_VIDEO_EXTENSIONS = new Set([
    '.zip',
    '.rar',
    '.7z',
    '.iso',
    '.exe',
    '.tar',
    '.gz',
    '.bz2',
    '.xz',
    '.js',
    '.css',
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.webp',
    '.svg',
    '.ico',
    '.woff',
    '.woff2',
    '.ttf',
    '.eot',
    '.map',
    '.json'
]);

const VIDEO_EXTENSION_LIST = Array.from(VIDEO_EXTENSIONS);
const NON_VIDEO_EXTENSION_LIST = Array.from(NON_VIDEO_EXTENSIONS);

const TRUSTED_VIDEO_HOST_HINTS = [
    'pixeldrain',
    'workers.dev',
    'hubcdn.fans',
    'r2.dev',
    'googleusercontent.com'
];

const VIDEO_TYPE_HINTS = ['mp4', 'mkv', 'webm', 'm3u8', 'avi', 'mov', 'ts', 'm4v'];

function isAssetUrl(candidate) {
    if (!candidate) return true;
    const lower = candidate.toLowerCase();
    return /\.(?:js|css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|map|json)(?:$|[?#])/.test(lower);
}

function normalizeAbsoluteUrl(href, baseUrl) {
    if (!href) return null;
    try {
        return new URL(href, baseUrl).toString();
    } catch {
        return null;
    }
}

function extractCookies(setCookieHeader) {
    if (!setCookieHeader) return [];
    const values = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
    return values.map(cookie => cookie.split(';')[0].trim()).filter(Boolean);
}

function mergeCookieHeader(existing, setCookieHeader) {
    const cookieMap = new Map();
    if (existing) {
        existing.split(';').forEach(cookie => {
            const [name, ...rest] = cookie.trim().split('=');
            if (!name || rest.length === 0) return;
            cookieMap.set(name, rest.join('='));
        });
    }
    extractCookies(setCookieHeader).forEach(cookie => {
        const [name, ...rest] = cookie.split('=');
        if (!name || rest.length === 0) return;
        cookieMap.set(name, rest.join('='));
    });
    return Array.from(cookieMap.entries())
        .map(([name, value]) => `${name}=${value}`)
        .join('; ');
}

function parseCookieHeader(cookieHeader = '', domain = null) {
    if (!cookieHeader) return [];
    return cookieHeader.split(';').map(part => part.trim()).map((part) => {
        if (!part) return null;
        const [name, ...rest] = part.split('=');
        if (!name || rest.length === 0) return null;
        return {
            name,
            value: rest.join('='),
            ...(domain ? { domain } : {})
        };
    }).filter(Boolean);
}

/**
 * Get cached Cloudflare cookies for a domain
 * @param {string} domain - The domain to get cookies for
 * @returns {{ cookies: string, userAgent: string } | null}
 */
function getCachedCfCookies(domain) {
    if (!domain) return null;
    const cached = cfCookieCache.get(domain);
    if (!cached) return null;
    if (CF_COOKIE_CACHE_TTL > 0 && (Date.now() - cached.ts > CF_COOKIE_CACHE_TTL)) {
        cfCookieCache.delete(domain);
        return null;
    }
    return { cookies: cached.cookies, userAgent: cached.userAgent };
}

/**
 * Get related domains that should share cookies (e.g., ouo.io and ouo.press)
 */
function getRelatedDomains(domain) {
    if (!domain) return [domain];
    const relatedGroups = [
        ['ouo.io', 'ouo.press'],
        ['viewcrate.cc', 'viewcrate.xyz']
    ];
    for (const group of relatedGroups) {
        if (group.some(d => domain.includes(d))) {
            return group;
        }
    }
    return [domain];
}

/**
 * Cache Cloudflare cookies from FlareSolverr response
 * FlareSolverr returns cookies as array: [{ name, value, domain, ... }]
 * @param {string} domain - The domain to cache cookies for
 * @param {Array} cookies - Array of cookie objects from FlareSolverr
 * @param {string} userAgent - The user agent used (cookies are tied to UA)
 */
function cacheCfCookies(domain, cookies, userAgent) {
    if (!domain || !cookies || !Array.isArray(cookies) || cookies.length === 0) return;

    // Filter for cf_clearance and other relevant cookies
    const relevantCookies = cookies.filter(c =>
        c.name === 'cf_clearance' ||
        c.name === 'cf_chl_seq' ||
        c.name === '__cf_bm'
    );

    if (relevantCookies.length === 0) return;

    const cookieString = relevantCookies
        .map(c => `${c.name}=${c.value}`)
        .join('; ');

    const cacheEntry = {
        cookies: cookieString,
        userAgent: userAgent || OUO_USER_AGENT,
        ts: Date.now()
    };

    // Cache for the domain and all related domains
    const domains = getRelatedDomains(domain);
    for (const d of domains) {
        cfCookieCache.set(d, cacheEntry);
    }

    console.log(`[HTTP-RESOLVE] Cached CF cookies for ${domains.join(', ')}: ${relevantCookies.map(c => c.name).join(', ')}`);
}

function extractRedirectCandidates(body = '', document = null, baseUrl = '') {
    const candidates = [];

    if (document) {
        const refresh = document('meta[http-equiv=\"refresh\"]').attr('content') || '';
        const refreshMatch = refresh.match(/url=([^;]+)/i);
        if (refreshMatch?.[1]) {
            const resolved = normalizeAbsoluteUrl(refreshMatch[1].trim(), baseUrl);
            if (resolved) candidates.push(resolved);
        }

        document('a[href]').each((_, el) => {
            const href = document(el).attr('href');
            const resolved = normalizeAbsoluteUrl(href, baseUrl);
            if (resolved) candidates.push(resolved);
        });
    }

    const scriptMatches = body.match(/location\.(?:href|replace|assign)\s*(?:\(\s*)?['"]([^'"]+)['"]\s*\)?/i);
    if (scriptMatches?.[1]) {
        const resolved = normalizeAbsoluteUrl(scriptMatches[1], baseUrl);
        if (resolved) candidates.push(resolved);
    }

    const windowOpenMatch = body.match(/window\.open\(\s*['"]([^'"]+)['"]/i);
    if (windowOpenMatch?.[1]) {
        const resolved = normalizeAbsoluteUrl(windowOpenMatch[1], baseUrl);
        if (resolved) candidates.push(resolved);
    }

    const urlMatches = body.match(/https?:\/\/[^\s"'<>]+/gi) || [];
    urlMatches.forEach(match => {
        const resolved = normalizeAbsoluteUrl(match, baseUrl);
        if (resolved) candidates.push(resolved);
    });

    const base64Matches = body.match(/[A-Za-z0-9+/=]{40,}/g) || [];
    base64Matches.forEach(raw => {
        const decoded = tryDecodeBase64(raw);
        if (decoded && decoded.startsWith('http')) {
            const resolved = normalizeAbsoluteUrl(decoded.trim(), baseUrl);
            if (resolved) candidates.push(resolved);
        }
    });

    return candidates;
}

/**
 * Check if a URL is just a homepage without a meaningful path
 * e.g., http://pixeldrain.com/ or https://gofile.io/home
 */
function isHomepageUrl(url) {
    try {
        const parsed = new URL(url);
        const path = parsed.pathname.replace(/\/+$/, ''); // Remove trailing slashes
        // Homepage patterns: empty path, just /, /home, /index, /index.html
        if (!path || path === '' || path === '/home' || path === '/index' || path === '/index.html') {
            return true;
        }
        return false;
    } catch {
        return false;
    }
}

function pickFirstExternalCandidate(candidates, baseUrl, allowedHosts = []) {
    const baseHost = (() => {
        try {
            return new URL(baseUrl).hostname.toLowerCase();
        } catch {
            return '';
        }
    })();
    const normalizedAllowed = (allowedHosts || []).filter(Boolean).map(host => host.toLowerCase());

    for (const candidate of candidates) {
        if (!candidate) continue;
        const lower = candidate.toLowerCase();
        if (OUO_HOSTS.some(host => lower.includes(host))) continue;
        if (baseHost && lower.includes(baseHost)) continue;
        if (isAssetUrl(candidate)) continue;
        if (isHomepageUrl(candidate)) continue; // Skip homepage-only URLs
        if (normalizedAllowed.length && !normalizedAllowed.some(host => lower.includes(host))) continue;
        return candidate;
    }
    return null;
}

function pickPixeldrainCandidate(candidates) {
    return candidates.find(candidate =>
        candidate && PIXELDRAIN_HOSTS.some(host => candidate.toLowerCase().includes(host))
    ) || null;
}

function parseStreamHints(rawUrl) {
    if (!rawUrl || !rawUrl.includes('#')) {
        return { baseUrl: rawUrl, hints: {} };
    }

    const [baseUrl, hash] = rawUrl.split('#', 2);
    const params = new URLSearchParams(hash || '');
    return {
        baseUrl,
        hints: {
            episode: params.get('ep') || null,
            resolution: params.get('res') || null,
            host: params.get('host') || null
        }
    };
}

function extractMkvDramaToken(url) {
    if (!url) return null;
    try {
        const parsed = new URL(url);
        return parsed.searchParams.get(MKVDRAMA_TOKEN_PARAM);
    } catch {
        return null;
    }
}

async function resolveMkvDramaToken(token) {
    if (!token) return null;
    const candidates = [
        `${MKVDRAMA_BASE_URL}/?download=${token}`,
        `${MKVDRAMA_BASE_URL}/?go=${token}`,
        `${MKVDRAMA_BASE_URL}/?dl=${token}`,
        `${MKVDRAMA_BASE_URL}/?link=${token}`,
        `${MKVDRAMA_BASE_URL}/?r=${token}`,
        `${MKVDRAMA_BASE_URL}/?id=${token}`
    ];

    for (const candidate of candidates) {
        try {
            const response = await fetchWithCloudflare(candidate, {
                headers: {
                    'User-Agent': OUO_USER_AGENT,
                    'Referer': MKVDRAMA_BASE_URL
                },
                preferFlareSolverr: true
            });

            const resolvedUrl = response?.url;
            if (resolvedUrl && !resolvedUrl.includes('mkvdrama.net')) {
                return resolvedUrl;
            }

            const extracted = extractRedirectCandidates(response?.body || '', response?.document || null, candidate)
                .filter(url => url && !url.includes('mkvdrama.net'));
            if (extracted.length) {
                return extracted[0];
            }
        } catch (err) {
            console.log(`[HTTP-RESOLVE] MKVDrama token resolution failed for ${candidate}: ${err.message}`);
        }
    }

    return null;
}

async function resolveXDMoviesRedirect(url) {
    if (!url || !XDMOVIES_LINK_HOSTS.some(host => url.includes(host))) {
        return url;
    }

    try {
        const response = await makeRequest(url, {
            allowRedirects: false,
            parseHTML: false,
            timeout: 8000
        });

        const location = response.headers?.location || response.headers?.['Location'];
        if (location) {
            return new URL(location, url).toString();
        }

        if (response.url && response.url !== url) {
            return response.url;
        }

        const body = response.body || '';
        const hubMatch = body.match(/https?:\/\/[^\s"'<>]*(?:hubcloud|hubdrive|hubcdn)[^\s"'<>]*/i);
        if (hubMatch?.[0]) {
            return hubMatch[0];
        }
    } catch (err) {
        console.log(`[HTTP-RESOLVE] XDMovies redirect resolution failed: ${err.message}`);
    }

    return url;
}

function normalizePixeldrainUrl(url) {
    if (!url) return null;
    try {
        const parsed = new URL(url);
        if (!PIXELDRAIN_HOSTS.includes(parsed.hostname)) {
            return url;
        }
        if (parsed.pathname.startsWith('/api/file/')) {
            return parsed.toString();
        }
        const match = parsed.pathname.match(/\/u\/([^/]+)/);
        if (match?.[1]) {
            return `https://pixeldrain.com/api/file/${match[1]}?download`;
        }
        return parsed.toString();
    } catch {
        return url;
    }
}

function collectViewcrateEntries(document, baseUrl) {
    const candidates = [];
    const seen = new Set();

    if (!document) return candidates;

    // Strategy 1: Find all onclick handlers that contain /get/ URLs (most robust)
    // This works regardless of class name changes
    document('[onclick*="/get/"]').each((_, el) => {
        const $el = document(el);
        const onclick = $el.attr('onclick') || '';
        const getMatch = onclick.match(/\/get\/[A-Za-z0-9]+/);
        if (!getMatch) return;

        const getPath = getMatch[0];
        const getUrl = normalizeAbsoluteUrl(getPath, baseUrl);
        if (!getUrl || seen.has(getUrl)) return;
        seen.add(getUrl);

        // Walk up to find episode and host info from parent containers
        let episodeKey = null;
        let host = null;
        let filename = null;

        // Look for episode info in parent elements (check data attributes and text)
        const $parent = $el.closest('[class^="z_"]');
        if ($parent.length) {
            // Try data attributes first
            const dataAttrs = $parent.get(0)?.attribs || {};
            for (const [attr, val] of Object.entries(dataAttrs)) {
                if (attr.startsWith('data-') && /^S\d{1,2}E\d{1,3}$/i.test(val)) {
                    episodeKey = val.toUpperCase();
                    break;
                }
            }
            // Try text content
            if (!episodeKey) {
                const text = $parent.find('h2, h3, [class^="x_"]').first().text().trim();
                const epMatch = text.match(/S\d{1,2}E\d{1,3}/i);
                if (epMatch) episodeKey = epMatch[0].toUpperCase();
            }
        }

        // Look for host info in sibling/parent elements
        const $entry = $el.closest('[class^="y_"]');
        if ($entry.length) {
            // Check data attributes for host
            const dataAttrs = $entry.get(0)?.attribs || {};
            for (const [attr, val] of Object.entries(dataAttrs)) {
                if (attr.startsWith('data-') && val && !val.startsWith('S')) {
                    const lower = val.toLowerCase();
                    if (lower.includes('.') || PIXELDRAIN_HOSTS.some(h => lower.includes(h))) {
                        host = lower;
                        break;
                    }
                }
            }
            // Try text content for host
            if (!host) {
                const hostText = $entry.find('[class^="w_"]').first().text().trim().toLowerCase();
                if (hostText && (hostText.includes('.') || hostText.includes('pixeldrain'))) {
                    host = hostText;
                }
            }
            // Try to extract filename
            filename = $entry.find('[class^="x_"], span').first().text().trim();
        }

        const resolution = getResolutionFromName(filename || '');

        candidates.push({
            episodeKey,
            host,
            filename,
            resolution,
            getUrl
        });
    });

    // Strategy 2: Legacy selectors (fallback for older page versions)
    if (candidates.length === 0) {
        const blockSelectors = [
            { selector: '.z_qmnyt', episodeAttr: 'data-8wg7v' },
            { selector: '.z_w78ax', episodeAttr: 'data-rjcoq' },
            { selector: '.z_26tgx', episodeAttr: 'data-pirz6' },
            { selector: '[data-8wg7v]', episodeAttr: 'data-8wg7v' },
            { selector: '[data-rjcoq]', episodeAttr: 'data-rjcoq' },
            { selector: '[data-pirz6]', episodeAttr: 'data-pirz6' }
        ];

        blockSelectors.forEach(({ selector, episodeAttr }) => {
            document(selector).each((_, block) => {
                const $block = document(block);
                const episodeKey = $block.attr(episodeAttr) ||
                    $block.find('h2').first().text().trim();

                $block.find('.y_u5qme, .y_tpl1j, .y_vbmuk, [data-ogehf], [data-7kuiu], [data-s5t96]').each((__, entry) => {
                    const $entry = document(entry);
                    const hostAttr = $entry.attr('data-ogehf') || $entry.attr('data-7kuiu') || $entry.attr('data-s5t96') || '';
                    let host = hostAttr.toLowerCase();
                    if (!host) {
                        const hostText = $entry.find('.w_po9rr, .w_4vj7h, .w_t2b66').first().text().trim();
                        host = hostText.toLowerCase();
                    }

                    const filename = $entry.find('.x_qwwj2, .x_i29qt, .x_aegdv').first().text().trim() ||
                        $entry.find('span').first().text().trim();
                    const resolution = getResolutionFromName(filename);
                    const opener = $entry.find('.v_wldd7, .v_65zvr, [onclick*="/get/"]').attr('onclick') || '';
                    const getMatch = opener.match(/\/get\/[A-Za-z0-9]+/);
                    const getPath = getMatch ? getMatch[0] : null;
                    const getUrl = normalizeAbsoluteUrl(getPath, baseUrl);

                    if (!getUrl) return;
                    const key = `${episodeKey || ''}|${host || ''}|${getUrl}`;
                    if (seen.has(key)) return;
                    seen.add(key);

                    candidates.push({
                        episodeKey,
                        host,
                        filename,
                        resolution,
                        getUrl
                    });
                });
            });
        });
    }

    return candidates;
}

function parseViewcrateEncryptedPayload(body = '') {
    if (!body) return null;

    const extract = (key) => {
        // Fix: use correct escaping for RegExp constructor
        // \\.  -> \.  in regex (matches literal dot)
        // \\s  -> \s  in regex (matches whitespace)
        const pattern = new RegExp(`window\\.${key}\\s*=\\s*["']([^"']+)["']`);
        const match = body.match(pattern);
        return match?.[1] || null;
    };

    const encodedKey = extract('_k');
    const encodedIv = extract('_i');
    const encodedCiphertext = extract('_c');

    if (!encodedKey || !encodedIv || !encodedCiphertext) {
        console.log('[HTTP-RESOLVE] ViewCrate encrypted payload missing keys', {
            hasKey: Boolean(encodedKey),
            hasIv: Boolean(encodedIv),
            hasCiphertext: Boolean(encodedCiphertext)
        });
        return null;
    }

    try {
        const key = Buffer.from(encodedKey, 'base64');
        const iv = Buffer.from(encodedIv, 'base64');
        const data = Buffer.from(encodedCiphertext, 'base64');
        if (key.length !== 32) {
            console.log(`[HTTP-RESOLVE] ViewCrate key length unexpected: ${key.length}`);
        }
        if (iv.length < 12) {
            console.log(`[HTTP-RESOLVE] ViewCrate IV length unexpected: ${iv.length}`);
        }
        if (data.length <= 16) {
            return null;
        }

        const tag = data.slice(data.length - 16);
        const ciphertext = data.slice(0, data.length - 16);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
        return JSON.parse(decrypted);
    } catch (error) {
        console.log(`[HTTP-RESOLVE] ViewCrate decrypt failed: ${error.message}`);
        return null;
    }
}

function collectViewcrateEncryptedEntries(body, baseUrl) {
    const payload = parseViewcrateEncryptedPayload(body);
    if (!payload || !Array.isArray(payload.d)) {
        return [];
    }

    const candidates = [];

    payload.d.forEach(entry => {
        const episodeKey = entry?.t || null;
        const links = Array.isArray(entry?.l) ? entry.l : [];
        links.forEach(link => {
            const filename = link?.n || '';
            const host = (link?.h || '').toLowerCase();
            const token = link?.u || '';
            if (!token) return;

            const getPath = token.startsWith('/get/')
                ? token
                : `/get/${token.replace(/^\/+/, '')}`;
            const getUrl = normalizeAbsoluteUrl(getPath, baseUrl);
            if (!getUrl) return;

            candidates.push({
                episodeKey,
                host,
                filename,
                resolution: getResolutionFromName(filename),
                getUrl
            });
        });
    });

    return candidates;
}

function normalizeHostHint(host) {
    if (!host) return null;
    const lower = host.toLowerCase();
    if (lower.includes('pixeldrain')) return 'pixeldrain';
    return lower;
}

function candidateMatchesHost(candidate, hostHint) {
    if (!hostHint || !candidate?.host) return false;
    const host = candidate.host.toLowerCase();
    if (hostHint === 'pixeldrain') return host.includes('pixeldrain');
    return host.includes(hostHint);
}

function orderViewcrateCandidates(candidates, hints = {}) {
    if (!candidates.length) return [];

    let filtered = candidates;

    if (hints.episode) {
        filtered = filtered.filter(candidate => candidate.episodeKey === hints.episode);
    }

    if (hints.resolution) {
        const normalizedResolution = hints.resolution === '4k' ? '2160p' : hints.resolution;
        filtered = filtered.filter(candidate => candidate.resolution === normalizedResolution);
    }

    const hostHint = normalizeHostHint(hints.host || null);
    if (hostHint) {
        const hostFiltered = filtered.filter(candidate => candidateMatchesHost(candidate, hostHint));
        if (hostFiltered.length) {
            filtered = hostFiltered;
        }
    }

    if (!filtered.length) {
        if (hostHint) {
            const hostFallback = candidates.filter(candidate => candidateMatchesHost(candidate, hostHint));
            filtered = hostFallback.length ? hostFallback : candidates;
        } else {
            filtered = candidates;
        }
    }

    const preferredHost = normalizeHostHint(hints.host || 'pixeldrain.com');
    const matchesHost = (candidate) => {
        if (!preferredHost || !candidate?.host) return false;
        const host = candidate.host.toLowerCase();
        if (preferredHost === 'pixeldrain') return host.includes('pixeldrain');
        return host.includes(preferredHost);
    };

    const preferred = filtered.filter(matchesHost);
    const fallback = filtered.filter(candidate => !matchesHost(candidate));
    return [...preferred, ...fallback];
}

function extractKeyFromJk(jkSource = '') {
    if (!jkSource) return null;
    const match = jkSource.match(/return\s+['"]([0-9a-f]{32})['"]/i);
    return match ? match[1] : null;
}

async function fetchViewcrateCnlLinks(viewcrateUrl) {
    if (!viewcrateUrl) return [];
    let publicId = null;
    try {
        const url = new URL(viewcrateUrl);
        const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
        publicId = parts[parts.length - 1] || null;
    } catch {
        return [];
    }
    if (!publicId) return [];

    const apiUrl = `https://viewcrate.cc/api/cnl_encrypt/${publicId}`;
    const response = await fetchWithCloudflare(apiUrl, {
        method: 'POST',
        timeout: 12000,
        headers: {
            'User-Agent': OUO_USER_AGENT,
            'Referer': viewcrateUrl,
            ...(VIEWCRATE_COOKIE ? { 'Cookie': VIEWCRATE_COOKIE } : {})
        }
    });

    if (!response?.body) return [];
    let payload = null;
    try {
        payload = JSON.parse(response.body);
    } catch {
        return [];
    }
    if (!payload?.crypted || !payload?.jk) return [];

    const keyHex = extractKeyFromJk(payload.jk);
    if (!keyHex) return [];

    try {
        const key = Buffer.from(keyHex, 'hex');
        const encrypted = Buffer.from(payload.crypted, 'base64');
        const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0));
        decipher.setAutoPadding(false);
        const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
        const text = decrypted.toString('utf8');
        const links = text.match(/https?:\/\/[^\s"'<>]+/g) || [];
        return links;
    } catch {
        return [];
    }
}

async function resolveViewcrateGetLink(getUrl, referer, hints = {}) {
    if (!getUrl) return null;
    const resolved = await fetchWithCloudflare(getUrl, {
        timeout: 12000,
        allowRedirects: false,
        headers: {
            'User-Agent': OUO_USER_AGENT,
            'Referer': referer || getUrl,
            ...(VIEWCRATE_COOKIE ? { 'Cookie': VIEWCRATE_COOKIE } : {})
        }
    });

    let directUrl = null;
    const status = resolved?.statusCode || null;
    if (status && [301, 302, 307, 308].includes(status) && resolved.headers?.location) {
        directUrl = normalizeAbsoluteUrl(resolved.headers.location, getUrl);
        if (directUrl) {
            console.log(`[HTTP-RESOLVE] ViewCrate get redirected to ${directUrl.substring(0, 80)}...`);
        }
    }

    if (!directUrl) {
        const candidates = extractRedirectCandidates(resolved.body, resolved.document, getUrl);
        directUrl = pickPixeldrainCandidate(candidates) || resolved.url;
    }

    const normalized = normalizePixeldrainUrl(directUrl);
    if (!normalized) return null;

    // If not a Pixeldrain URL, return as-is (might be another host)
    if (!PIXELDRAIN_HOSTS.some(host => normalized.toLowerCase().includes(host))) {
        return normalized;
    }

    return resolvePixeldrainDownload(normalized);
}

async function resolvePixeldrainDownload(pixeldrainUrl) {
    if (!pixeldrainUrl) return null;
    const normalized = normalizePixeldrainUrl(pixeldrainUrl);

    if (normalized && normalized.includes('/api/file/')) {
        return normalized;
    }

    const response = await makeRequest(pixeldrainUrl, {
        parseHTML: true,
        timeout: 12000,
        headers: { 'User-Agent': OUO_USER_AGENT, 'Referer': pixeldrainUrl }
    });

    const direct = pickPixeldrainCandidate(
        extractRedirectCandidates(response.body, response.document, response.url || pixeldrainUrl)
    ) || response.url;

    return normalizePixeldrainUrl(direct);
}

function isCloudflareChallenge(body = '', statusCode = null) {
    const lower = (body || '').toLowerCase();
    // Note: removed 'cf_clearance' check as it causes false positives on valid pages
    // that mention the cookie name in JavaScript
    return lower.includes('cf-mitigated') ||
        lower.includes('just a moment') ||
        lower.includes('cf_chl') ||
        (lower.includes('challenge-platform') && lower.includes('cf_chl')) ||
        lower.includes('cf-turnstile') ||
        lower.includes('verify_turnstile') ||
        (lower.includes('security check') && lower.includes('cloudflare'));
}

function shouldBypassFlareSolverr(domain) {
    if (!domain) return false;
    const lower = domain.toLowerCase();
    return lower.includes('hubcloud') || lower.includes('hubdrive') || lower.includes('hubcdn');
}

function getCloudflareMarkers(body = '') {
    const lower = (body || '').toLowerCase();
    const markers = [];
    if (lower.includes('cf-mitigated')) markers.push('cf-mitigated');
    if (lower.includes('just a moment')) markers.push('just-a-moment');
    if (lower.includes('cf_chl')) markers.push('cf_chl');
    if (lower.includes('challenge-platform')) markers.push('challenge-platform');
    if (lower.includes('cf-turnstile')) markers.push('cf-turnstile');
    if (lower.includes('verify_turnstile')) markers.push('verify_turnstile');
    if (lower.includes('security check')) markers.push('security-check');
    if (lower.includes('cloudflare')) markers.push('cloudflare');
    return markers;
}

async function fetchWithUndici(url, { method = 'GET', headers = {}, timeout = 12000, body = null } = {}) {
    if (typeof fetch !== 'function') return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(url, {
            method,
            headers,
            body,
            redirect: 'follow',
            signal: controller.signal
        });
        const text = await response.text();
        return {
            body: text,
            url: response.url || url,
            document: cheerio.load(text),
            statusCode: response.status,
            headers: Object.fromEntries(response.headers.entries())
        };
    } catch (error) {
        console.log(`[HTTP-RESOLVE] Undici fetch error: ${error.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

async function getOrCreateFlareSession(domain) {
    if (!FLARESOLVERR_URL || !domain) return null;
    const cached = flareSessionCache.get(domain);
    if (cached && (Date.now() - cached.ts) < FLARE_SESSION_TTL) {
        return cached.sessionId;
    }

    const sessionId = `sootio_http_${domain.replace(/\./g, '_')}`;
    const proxyConfig = shouldUseFlareProxyForDomain(domain) ? { url: FLARESOLVERR_PROXY_URL } : null;

    try {
        const list = await axios.post(`${FLARESOLVERR_URL}/v1`, { cmd: 'sessions.list' }, {
            timeout: 10000,
            headers: { 'Content-Type': 'application/json' }
        });
        if (list.data?.sessions?.includes(sessionId)) {
            flareSessionCache.set(domain, { sessionId, ts: Date.now() });
            return sessionId;
        }
    } catch {
        // ignore list errors
    }

    try {
        const createBody = {
            cmd: 'sessions.create',
            session: sessionId
        };
        if (proxyConfig) {
            createBody.proxy = proxyConfig;
        }
        const create = await axios.post(`${FLARESOLVERR_URL}/v1`, createBody, {
            timeout: 30000,
            headers: { 'Content-Type': 'application/json' }
        });
        if (create.data?.status === 'ok') {
            flareSessionCache.set(domain, { sessionId, ts: Date.now() });
            return sessionId;
        }
    } catch (error) {
        if (error.response?.data?.message?.includes('already exists')) {
            flareSessionCache.set(domain, { sessionId, ts: Date.now() });
            return sessionId;
        }
        console.log(`[HTTP-RESOLVE] FlareSolverr session create failed: ${error.message}`);
    }

    return null;
}

// Internal function that actually calls FlareSolverr
async function _doFlareSolverrRequest(url, { method = 'GET', postData = null, headers = {}, timeout = FLARESOLVERR_TIMEOUT } = {}) {
    const domain = (() => {
        try { return new URL(url).hostname; } catch { return null; }
    })();
    const sessionId = await getOrCreateFlareSession(domain);
    const hasSession = Boolean(sessionId);
    const proxyConfig = shouldUseFlareProxyForDomain(domain) ? { url: FLARESOLVERR_PROXY_URL } : null;

    const flareTimeout = hasSession
        ? Math.max(timeout || 0, 30000)
        : Math.max((timeout || 0) * 4, 60000);

    const requestBody = {
        cmd: method === 'POST' ? 'request.post' : 'request.get',
        url,
        maxTimeout: flareTimeout
    };

    const cookieHeader = headers['Cookie'] || headers['cookie'] || '';
    const flareCookies = parseCookieHeader(cookieHeader, domain);
    if (flareCookies.length) {
        requestBody.cookies = flareCookies;
    }

    if (sessionId) {
        requestBody.session = sessionId;
    }
    if (postData) {
        requestBody.postData = postData;
    }
    if (!sessionId && proxyConfig) {
        requestBody.proxy = proxyConfig;
    }

    try {
        const response = await axios.post(`${FLARESOLVERR_URL}/v1`, requestBody, {
            timeout: flareTimeout + 5000,
            headers: { 'Content-Type': 'application/json' }
        });

        if (response.data?.status === 'ok' && response.data?.solution?.response) {
            const body = response.data.solution.response;
            const finalUrl = response.data.solution.url || url;
            const statusCode = response.data.solution.status;
            const responseHeaders = response.data.solution.headers || {};

            // Cache CF cookies from FlareSolverr for future direct requests
            const solutionCookies = response.data.solution.cookies;
            const solverUserAgent = response.data.solution.userAgent || userAgent || OUO_USER_AGENT;
            if (domain && solutionCookies) {
                cacheCfCookies(domain, solutionCookies, solverUserAgent);
            }

            return {
                success: true,
                result: {
                    body,
                    url: finalUrl,
                    document: cheerio.load(body),
                    statusCode,
                    headers: responseHeaders
                }
            };
        }

        if (proxyConfig && !requestBody.proxy) {
            const retryBody = { ...requestBody, proxy: proxyConfig };
            if (retryBody.session) delete retryBody.session;
            const retryResponse = await axios.post(`${FLARESOLVERR_URL}/v1`, retryBody, {
                timeout: flareTimeout + 5000,
                headers: { 'Content-Type': 'application/json' }
            });
            if (retryResponse.data?.status === 'ok' && retryResponse.data?.solution?.response) {
                const body = retryResponse.data.solution.response;
                const finalUrl = retryResponse.data.solution.url || url;
                const statusCode = retryResponse.data.solution.status;
                const responseHeaders = retryResponse.data.solution.headers || {};

                const solutionCookies = retryResponse.data.solution.cookies;
                const solverUserAgent = retryResponse.data.solution.userAgent || userAgent || OUO_USER_AGENT;
                if (domain && solutionCookies) {
                    cacheCfCookies(domain, solutionCookies, solverUserAgent);
                }

                return {
                    success: true,
                    result: {
                        body,
                        url: finalUrl,
                        document: cheerio.load(body),
                        statusCode,
                        headers: responseHeaders
                    }
                };
            }
        }

        console.log(`[HTTP-RESOLVE] FlareSolverr response status: ${response.data?.status} message: ${response.data?.message || 'n/a'}`);
        if (hasSession && domain) {
            flareSessionCache.delete(domain);
        }
    } catch (error) {
        console.log(`[HTTP-RESOLVE] FlareSolverr error: ${error.message}`);
        if (hasSession && domain) {
            flareSessionCache.delete(domain);
        }
    }

    return { success: false, result: null };
}

// Wrapper that prevents thundering herd - only one FlareSolverr call per domain at a time
async function fetchWithFlareSolverr(url, options = {}) {
    if (!FLARESOLVERR_URL) return null;

    const domain = (() => {
        try { return new URL(url).hostname; } catch { return null; }
    })();

    // If there's already a FlareSolverr request in progress for this domain, wait for it
    const existingLock = domain ? flareSolverrLocks.get(domain) : null;
    if (existingLock) {
        console.log(`[HTTP-RESOLVE] Waiting for existing FlareSolverr request for ${domain}...`);
        try {
            await existingLock;
            // After waiting, check if we now have cached cookies
            const cached = getCachedCfCookies(domain);
            if (cached?.cookies) {
                console.log(`[HTTP-RESOLVE] Using cookies from completed FlareSolverr request for ${domain}`);
                return null; // Return null to signal caller should retry with cached cookies
            }
        } catch {
            // Lock failed, continue to make our own request
        }
    }

    // Create a lock for this domain
    let resolveLock;
    const lockPromise = new Promise(resolve => { resolveLock = resolve; });
    if (domain) {
        flareSolverrLocks.set(domain, lockPromise);
    }

    try {
        const { success, result } = await _doFlareSolverrRequest(url, options);
        return success ? result : null;
    } finally {
        // Release the lock
        if (domain) {
            flareSolverrLocks.delete(domain);
        }
        resolveLock?.();
    }
}

async function fetchWithCloudflare(url, options = {}) {
    const {
        preferFlareSolverr = false,
        method = 'GET',
        headers = {},
        timeout,
        body,
        ...rest
    } = options;

    // Extract domain for cookie caching
    const domain = (() => {
        try { return new URL(url).hostname; } catch { return null; }
    })();

    const requestOptions = {
        method,
        headers,
        timeout,
        body,
        ...rest,
        parseHTML: true
    };

    let sawChallenge = false;
    let sawError = false;

    const runFlareSolverr = async () => {
        const flareResponse = await fetchWithFlareSolverr(url, {
            method,
            headers,
            timeout,
            postData: body || null
        });

        // FlareSolverr returned null - maybe we waited for another request that got cookies
        // Check if we now have cached cookies and retry the direct request
        if (!flareResponse) {
            const newCached = getCachedCfCookies(domain);
            if (newCached?.cookies) {
                console.log(`[HTTP-RESOLVE] Retrying with fresh CF cookies for ${domain}`);
                const cookieHeader = headers['Cookie'] || headers['cookie'] || '';
                const mergedCookies = cookieHeader ? `${cookieHeader}; ${newCached.cookies}` : newCached.cookies;
                try {
                    const retryResponse = await makeRequest(url, {
                        ...requestOptions,
                        headers: {
                            ...headers,
                            'Cookie': mergedCookies,
                            'User-Agent': newCached.userAgent
                        }
                    });
                    if (retryResponse && !isCloudflareChallenge(retryResponse.body || '', retryResponse.statusCode)) {
                        console.log(`[HTTP-RESOLVE] Retry with fresh cookies succeeded for ${domain}`);
                        return retryResponse;
                    }
                } catch (retryErr) {
                    console.log(`[HTTP-RESOLVE] Retry with fresh cookies failed: ${retryErr.message}`);
                }
            }
            return null;
        }
        if (isCloudflareChallenge(flareResponse.body || '', flareResponse.statusCode)) {
            const snippet = (flareResponse.body || '').replace(/\s+/g, ' ').slice(0, 160);
            console.log(`[HTTP-RESOLVE] FlareSolverr still blocked for ${url}: ${snippet}`);
        }
        return flareResponse;
    };

    // Try cached CF cookies first (fast path - avoids FlareSolverr)
    const cachedCf = getCachedCfCookies(domain);
    if (cachedCf) {
        console.log(`[HTTP-RESOLVE] Using cached CF cookies for ${domain}`);
        const cookieHeader = headers['Cookie'] || headers['cookie'] || '';
        const mergedCookies = cookieHeader ? `${cookieHeader}; ${cachedCf.cookies}` : cachedCf.cookies;
        const cachedRequestOptions = {
            ...requestOptions,
            headers: {
                ...headers,
                'Cookie': mergedCookies,
                'User-Agent': cachedCf.userAgent // Use same UA as when cookie was obtained
            }
        };

        try {
            const cachedResponse = await makeRequest(url, cachedRequestOptions);
            if (cachedResponse && !isCloudflareChallenge(cachedResponse.body || '', cachedResponse.statusCode)) {
                console.log(`[HTTP-RESOLVE] Cached CF cookies worked for ${domain}`);
                return cachedResponse;
            }
            // Cookies didn't work, clear the cache for this domain and related domains
            console.log(`[HTTP-RESOLVE] Cached CF cookies expired/invalid for ${domain}`);
            for (const d of getRelatedDomains(domain)) {
                cfCookieCache.delete(d);
            }
            sawChallenge = true;
        } catch (error) {
            console.log(`[HTTP-RESOLVE] Cached CF cookies request failed: ${error.message}`);
            for (const d of getRelatedDomains(domain)) {
                cfCookieCache.delete(d);
            }
            sawError = true;
        }
    }

    let response = null;
    try {
        response = await makeRequest(url, requestOptions);
    } catch (error) {
        sawError = true;
    }

    if (response && !isCloudflareChallenge(response.body || '', response.statusCode)) {
        return response;
    }

    if (response && isCloudflareChallenge(response.body || '', response.statusCode)) {
        sawChallenge = true;
        const undiciResponse = await fetchWithUndici(url, { method, headers, timeout, body });
        if (undiciResponse && !isCloudflareChallenge(undiciResponse.body || '', undiciResponse.statusCode)) {
            return undiciResponse;
        }
    }

    if (!FLARESOLVERR_URL) {
        return response;
    }

    const allowFlareSolverr = !shouldBypassFlareSolverr(domain);
    if ((sawChallenge || sawError || preferFlareSolverr) && allowFlareSolverr) {
        const reasonParts = [];
        if (sawChallenge) reasonParts.push('challenge-detected');
        if (sawError) reasonParts.push('request-error');
        if (preferFlareSolverr) reasonParts.push('prefer-flare');
        const reason = reasonParts.join(',') || 'unknown';
        const markers = sawChallenge && response?.body ? getCloudflareMarkers(response.body) : [];
        const status = response?.statusCode || 'n/a';
        console.error(`[HTTP-RESOLVE] Using FlareSolverr reason=${reason} status=${status} markers=${markers.join('|') || 'none'} domain=${domain || 'n/a'} url=${url}`);
        const flareResponse = await runFlareSolverr();
        if (flareResponse) {
            return flareResponse;
        }
    }

    if (response) {
        return response;
    }

    throw new Error('FlareSolverr failed to fetch Cloudflare-protected page');
}

async function fetchOuoPage(url, options = {}) {
    return fetchWithCloudflare(url, { ...options, preferFlareSolverr: true });
}

// Cache for resolved OUO links - saves 30-60 seconds per link
const OUO_RESOLVE_CACHE = new Map(); // shortUrl path -> { value, ts }
const OUO_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days - short links rarely change

async function resolveOuoLink(shortUrl, hints = {}) {
    // Extract cache key at start
    let ouoCacheKey = null;
    try {
        ouoCacheKey = new URL(shortUrl).pathname;
        // Check in-memory cache first (fastest)
        const memCached = OUO_RESOLVE_CACHE.get(ouoCacheKey);
        if (memCached?.value && Date.now() - memCached.ts < OUO_CACHE_TTL) {
            console.log(`[HTTP-RESOLVE] Using cached OUO resolution for ${ouoCacheKey} (memory)`);
            return memCached.value;
        }
        // Check database cache (survives restarts)
        if (CacheStore.isEnabled()) {
            const dbCached = await CacheStore.getCachedRecord('ouo-resolve', ouoCacheKey);
            if (dbCached?.data?.url) {
                // Populate in-memory cache
                OUO_RESOLVE_CACHE.set(ouoCacheKey, { value: dbCached.data.url, ts: Date.now() });
                console.log(`[HTTP-RESOLVE] Using cached OUO resolution for ${ouoCacheKey} (DB)`);
                return dbCached.data.url;
            }
        }
    } catch (e) {
        // Continue without cache
    }

    // Helper to cache and return result
    const cacheAndReturn = (result) => {
        if (result && ouoCacheKey) {
            // Save to in-memory cache
            OUO_RESOLVE_CACHE.set(ouoCacheKey, { value: result, ts: Date.now() });
            // Save to database (async, don't wait)
            if (CacheStore.isEnabled()) {
                CacheStore.upsertCachedMagnet({
                    service: 'ouo-resolve',
                    hash: ouoCacheKey,
                    data: { url: result },
                    releaseKey: 'ouo-resolution'
                }, { ttlMs: OUO_CACHE_TTL }).catch(() => {});
            }
            console.log(`[HTTP-RESOLVE] Cached OUO resolution for ${ouoCacheKey}`);
        }
        return result;
    };

    let cookieHeader = OUO_COOKIE || '';
    if (cookieHeader) {
        console.log('[HTTP-RESOLVE] Using OUO cookie for resolution');
    }
    let request = { url: shortUrl, method: 'GET', body: null, referer: null };
    const visited = new Set();
    const maxSteps = 3; // Reduced from 4 - most resolutions complete in 2-3 steps

    for (let step = 0; step < maxSteps; step += 1) {
        const visitKey = `${request.method}:${request.url}:${request.body || ''}`;
        if (visited.has(visitKey)) {
            console.log('[HTTP-RESOLVE] Ouo loop detected, aborting');
            return null;
        }
        visited.add(visitKey);

        const response = await fetchOuoPage(request.url, {
            method: request.method,
            body: request.body,
            headers: {
                'User-Agent': OUO_USER_AGENT,
                'Referer': request.referer || request.url,
                ...(cookieHeader ? { 'Cookie': cookieHeader } : {}),
                ...(request.method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {})
            }
        });

        cookieHeader = mergeCookieHeader(cookieHeader, response.headers?.['set-cookie']);

        const directFromPage = pickFirstExternalCandidate(
            extractRedirectCandidates(response.body, response.document, response.url || request.url),
            response.url || request.url,
            [...PIXELDRAIN_HOSTS, ...VIEWCRATE_HOSTS, ...FILECRYPT_HOSTS, hints.host]
        );
        if (directFromPage) {
            const directHost = normalizeHostHint(directFromPage);
            const hintHost = normalizeHostHint(hints.host || null);
            if (hintHost && directHost && directHost !== hintHost) {
                console.log(`[HTTP-RESOLVE] Skipping ${directHost} link due to host hint`);
            } else {
                return cacheAndReturn(directFromPage);
            }
        }

        const viewcrateCandidates = collectViewcrateEntries(response.document, response.url || request.url);
        const orderedCandidates = orderViewcrateCandidates(viewcrateCandidates, hints);
        for (const entry of orderedCandidates) {
            if (!entry?.getUrl) continue;
            const direct = await resolveViewcrateGetLink(entry.getUrl, response.url || request.url, hints);
            if (direct) return cacheAndReturn(direct);
            if (entry.host) {
                console.log(`[HTTP-RESOLVE] ViewCrate candidate failed for host ${entry.host}`);
            }
        }

        if (response.url && !OUO_HOSTS.some(host => response.url.includes(host))) {
            return cacheAndReturn(response.url);
        }

        const $ = response.document;
        const button = $ ? $(`#${OUO_BUTTON_ID}`) : null;
        let form = button && button.length ? button.closest('form') : null;
        if (!form || !form.length) {
            form = $ ? $('form').first() : null;
        }

        if (!form || !form.length) {
            const snippet = (response.body || '').replace(/\s+/g, ' ').slice(0, 160);
            console.log(`[HTTP-RESOLVE] Ouo page missing form (status ${response.statusCode || 'unknown'}): ${snippet}`);
            return null;
        }

        const actionHint = button?.attr('formaction') || null;
        const action = form.attr('action') || actionHint || request.url;
        const method = (form.attr('method') || 'POST').toUpperCase();
        const actionUrl = normalizeAbsoluteUrl(action, request.url) || request.url;

        const formData = {};
        const inputs = form.find('input[name]').length ? form.find('input[name]') : ($ ? $('input[name]') : []);
        inputs.each((_, input) => {
            const name = $(input).attr('name');
            const value = $(input).attr('value') || '';
            if (name) formData[name] = value;
        });

        const submitButton = button && button.length ? button : form.find('button[type="submit"], input[type="submit"]').first();
        if (submitButton?.length) {
            const name = submitButton.attr('name');
            const value = submitButton.attr('value') || submitButton.text().trim() || '1';
            if (name && !formData[name]) {
                formData[name] = value;
            }
        }

        if (!actionUrl || actionUrl === request.url) {
            const actionMatch = response.body?.match(/\/go\/[A-Za-z0-9]+/);
            const derived = actionMatch ? normalizeAbsoluteUrl(actionMatch[0], request.url) : null;
            if (derived) {
                request = { url: derived, method: 'GET', body: null, referer: request.url };
                continue;
            }
        }

        const body = new URLSearchParams(formData).toString();
        if (method === 'GET') {
            const connector = actionUrl.includes('?') ? '&' : '?';
            const urlWithQuery = body ? `${actionUrl}${connector}${body}` : actionUrl;
            request = { url: urlWithQuery, method: 'GET', body: null, referer: request.url };
        } else {
            request = { url: actionUrl, method: 'POST', body, referer: request.url };
        }
    }

    return null;
}

async function resolveViewcrateLink(viewcrateUrl, hints = {}) {
    if (VIEWCRATE_COOKIE) {
        console.log('[HTTP-RESOLVE] Using ViewCrate cookie for resolution');
    }
    const response = await fetchWithCloudflare(viewcrateUrl, {
        timeout: 12000,
        headers: {
            'User-Agent': OUO_USER_AGENT,
            ...(VIEWCRATE_COOKIE ? { 'Cookie': VIEWCRATE_COOKIE } : {})
        },
        // When cookie is provided, try direct request first (cookie is tied to User-Agent)
        preferFlareSolverr: !VIEWCRATE_COOKIE
    });

    const $ = response.document;
    if (!$) {
        return null;
    }

    let candidates = collectViewcrateEntries($, response.url || viewcrateUrl);
    if (candidates.length === 0) {
        candidates = collectViewcrateEncryptedEntries(response.body || '', response.url || viewcrateUrl);
        if (candidates.length) {
            console.log(`[HTTP-RESOLVE] ViewCrate decrypted ${candidates.length} entries`);
        }
    }

    if (candidates.length === 0) {
        const cnlLinks = await fetchViewcrateCnlLinks(viewcrateUrl);
        if (cnlLinks.length) {
            console.log(`[HTTP-RESOLVE] ViewCrate CNL returned ${cnlLinks.length} links`);
            const preferredHost = normalizeHostHint(hints.host || 'pixeldrain.com');
            const preferred = cnlLinks.find(link => {
                const lower = link.toLowerCase();
                if (preferredHost === 'pixeldrain') return lower.includes('pixeldrain');
                return preferredHost ? lower.includes(preferredHost) : false;
            });
            const fallback = cnlLinks.find(link => link.toLowerCase().includes('pixeldrain')) || cnlLinks[0];
            const chosen = preferred || fallback;
            const normalized = normalizePixeldrainUrl(chosen);
            if (normalized && PIXELDRAIN_HOSTS.some(host => normalized.toLowerCase().includes(host))) {
                return resolvePixeldrainDownload(normalized);
            }
            return chosen || null;
        }

        console.log('[HTTP-RESOLVE] ViewCrate entries not found in HTML or encrypted payload');
        return null;
    }

    const ordered = orderViewcrateCandidates(candidates, hints);
    for (const entry of ordered) {
        if (!entry?.getUrl) continue;
        const direct = await resolveViewcrateGetLink(entry.getUrl, viewcrateUrl, hints);
        if (direct) return direct;
        if (entry.host) {
            console.log(`[HTTP-RESOLVE] ViewCrate candidate failed for host ${entry.host}`);
        }
    }

    return null;
}

/**
 * Collect download entries from a Filecrypt container page
 * Each entry has: host, filename, size, linkId
 */
function collectFilecryptEntries(document, baseUrl) {
    const entries = [];
    if (!document) return entries;

    // Find all download buttons in table rows
    document('tr.kwj3').each((_, row) => {
        const $row = document(row);
        const button = $row.find('button.download');
        if (!button.length) return;

        // Extract the link ID from the data-* attribute
        // Button has data-{id}="{linkId}" where id is lowercase version of the button's id
        const buttonId = button.attr('id');
        if (!buttonId) return;
        const dataAttr = `data-${buttonId.toLowerCase()}`;
        const linkId = button.attr(dataAttr);
        if (!linkId) return;

        // Extract host from the external_link anchor
        const hostLink = $row.find('a.external_link');
        const hostHref = hostLink.attr('href') || '';
        let host = '';
        try {
            host = new URL(hostHref).hostname.toLowerCase();
        } catch {
            host = hostHref.replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
        }

        // Extract filename from title attribute
        const titleCell = $row.find('td[title]');
        const filename = titleCell.attr('title') || '';

        // Extract file size
        const cells = $row.find('td');
        let size = '';
        cells.each((i, cell) => {
            const text = document(cell).text().trim();
            if (/^\d+(\.\d+)?\s*(GB|MB|KB|TB)$/i.test(text)) {
                size = text;
            }
        });

        // Check online status
        const isOnline = $row.find('i.online').length > 0;

        entries.push({
            linkId,
            host,
            filename,
            size,
            isOnline,
            linkUrl: `https://filecrypt.cc/Link/${linkId}.html`
        });
    });

    return entries;
}

/**
 * Order Filecrypt entries by preferred hosts
 */
function orderFilecryptEntries(entries, hints = {}) {
    const preferred = [];
    const fallback = [];

    for (const entry of entries) {
        // Skip offline entries
        if (!entry.isOnline) {
            fallback.push(entry);
            continue;
        }

        // Prefer pixeldrain
        if (PIXELDRAIN_HOSTS.some(h => entry.host.includes(h))) {
            preferred.unshift(entry);
        } else if (hints.host && entry.host.includes(hints.host)) {
            preferred.push(entry);
        } else {
            fallback.push(entry);
        }
    }

    return [...preferred, ...fallback];
}

// Ad/tracking domains to skip
const FILECRYPT_BLOCKED_DOMAINS = ['linkonclick.com', 'adf.ly', 'bc.vc', 'sh.st', 'ouo.io', 'ouo.press'];

/**
 * Check if a URL is an invalid filecrypt redirect target
 */
function isInvalidFilecryptRedirect(url) {
    if (!url) return true;
    const lower = url.toLowerCase();
    // Check for 404 page
    if (lower.includes('/404') || lower.includes('not-found') || lower.includes('notfound')) {
        return true;
    }
    // Check for blocked ad/tracking domains
    if (FILECRYPT_BLOCKED_DOMAINS.some(d => lower.includes(d))) {
        return true;
    }
    // Check for pixeldrain homepage (no file ID) - these are invalid
    // Valid pixeldrain URLs have /u/{id} or /api/file/{id}
    if (lower.includes('pixeldrain.com')) {
        try {
            const parsed = new URL(url);
            const path = parsed.pathname;
            // Homepage or generic paths are invalid
            if (path === '/' || path === '/home' || path === '') {
                return true;
            }
            // Must have /u/ or /api/file/ with an ID
            if (!path.includes('/u/') && !path.includes('/api/file/')) {
                return true;
            }
        } catch {
            return true;
        }
    }
    return false;
}

/**
 * Resolve a single Filecrypt link to get the final download URL
 */
async function resolveFilecryptLink(linkUrl, referer, cookies = '') {
    if (!linkUrl) return null;

    try {
        // First fetch the Link page to get the redirect
        const linkResponse = await makeRequest(linkUrl, {
            timeout: 10000,
            allowRedirects: false, // Don't follow redirects automatically
            headers: {
                'User-Agent': OUO_USER_AGENT,
                'Referer': referer,
                ...(cookies ? { 'Cookie': cookies } : {})
            }
        });

        // Check if we got an HTTP redirect
        const httpRedirect = linkResponse.headers?.location || linkResponse.headers?.Location;
        if (httpRedirect) {
            if (isInvalidFilecryptRedirect(httpRedirect)) {
                return null; // Skip invalid redirects silently
            }
        }

        // Check if the response URL itself is invalid (in case redirects were followed)
        if (linkResponse.url && isInvalidFilecryptRedirect(linkResponse.url)) {
            return null;
        }

        // Extract the redirect URL from the JS: top.location.href='...'
        const redirectMatch = linkResponse.body?.match(/top\.location\.href\s*=\s*['"]([^'"]+)['"]/);
        if (!redirectMatch?.[1]) {
            // Maybe it's a direct redirect in the location header
            if (httpRedirect && !isInvalidFilecryptRedirect(httpRedirect)) {
                const fullRedirect = httpRedirect.startsWith('http') ? httpRedirect : `https://filecrypt.cc${httpRedirect}`;
                // Check if it's a Go page
                if (fullRedirect.includes('/Go/')) {
                    return await resolveFilecryptGoPage(fullRedirect, linkUrl, cookies);
                }
            }
            return null;
        }

        const goUrl = redirectMatch[1].startsWith('http')
            ? redirectMatch[1]
            : `https://filecrypt.cc${redirectMatch[1]}`;

        if (isInvalidFilecryptRedirect(goUrl)) {
            return null;
        }

        return await resolveFilecryptGoPage(goUrl, linkUrl, cookies);
    } catch (err) {
        // Don't log every failure - too noisy
        return null;
    }
}

/**
 * Resolve a Filecrypt Go page to extract the final URL
 */
async function resolveFilecryptGoPage(goUrl, referer, cookies = '') {
    try {
        const goResponse = await makeRequest(goUrl, {
            parseHTML: true,
            timeout: 10000,
            headers: {
                'User-Agent': OUO_USER_AGENT,
                'Referer': referer,
                ...(cookies ? { 'Cookie': cookies } : {})
            }
        });

        // Check if we got redirected to an invalid URL
        if (goResponse.url && isInvalidFilecryptRedirect(goResponse.url)) {
            return null;
        }

        const $ = goResponse.document;
        if (!$) {
            return null;
        }

        // Try to extract the final URL from meta tags
        const ogUrl = $('meta[property="og:url"]').attr('content');
        if (ogUrl && !ogUrl.includes('filecrypt.cc') && !isInvalidFilecryptRedirect(ogUrl)) {
            console.log(`[HTTP-RESOLVE] Filecrypt: Found og:url -> ${ogUrl.substring(0, 60)}...`);
            return ogUrl;
        }

        // Try og:video
        const ogVideo = $('meta[property="og:video"]').attr('content');
        if (ogVideo && !ogVideo.includes('filecrypt.cc') && !isInvalidFilecryptRedirect(ogVideo)) {
            console.log(`[HTTP-RESOLVE] Filecrypt: Found og:video -> ${ogVideo.substring(0, 60)}...`);
            return ogVideo;
        }

        // Try to extract from viewer_data JSON (pixeldrain embeds)
        const viewerDataMatch = goResponse.body?.match(/window\.viewer_data\s*=\s*(\{[^;]+\});/);
        if (viewerDataMatch?.[1]) {
            try {
                const viewerData = JSON.parse(viewerDataMatch[1]);
                if (viewerData?.api_response?.id) {
                    const fileId = viewerData.api_response.id;
                    const directUrl = `https://pixeldrain.com/api/file/${fileId}?download`;
                    console.log(`[HTTP-RESOLVE] Filecrypt: Extracted from viewer_data -> ${directUrl}`);
                    return directUrl;
                }
            } catch {
                // Ignore JSON parse errors
            }
        }

        // Check if we got redirected to a valid different host
        if (goResponse.url && !goResponse.url.includes('filecrypt.cc') && !isInvalidFilecryptRedirect(goResponse.url)) {
            console.log(`[HTTP-RESOLVE] Filecrypt: Redirected to -> ${goResponse.url.substring(0, 60)}...`);
            return goResponse.url;
        }

        return null;
    } catch {
        return null;
    }
}

/**
 * Filter filecrypt entries by episode hint
 */
function filterFilecryptEntriesByEpisode(entries, hints) {
    if (!hints.episode) return entries;

    // Parse episode hint (e.g., "S01E06" -> { season: 1, episode: 6 })
    const epMatch = hints.episode.match(/S(\d+)E(\d+)/i);
    if (!epMatch) return entries;

    const targetSeason = parseInt(epMatch[1], 10);
    const targetEpisode = parseInt(epMatch[2], 10);

    // Filter entries whose filename matches the episode
    const filtered = entries.filter(entry => {
        if (!entry.filename) return false;
        const fnMatch = entry.filename.match(/S(\d+)E(\d+)/i);
        if (!fnMatch) return false;
        const season = parseInt(fnMatch[1], 10);
        const episode = parseInt(fnMatch[2], 10);
        return season === targetSeason && episode === targetEpisode;
    });

    return filtered.length > 0 ? filtered : entries;
}

/**
 * Resolve a Filecrypt container URL to get download links
 */
async function resolveFilecryptContainer(filecryptUrl, hints = {}) {
    console.log('[HTTP-RESOLVE] Filecrypt container detected, extracting links...');

    const response = await fetchWithCloudflare(filecryptUrl, {
        timeout: 15000,
        headers: {
            'User-Agent': OUO_USER_AGENT
        }
    });

    const $ = response.document;
    if (!$) {
        console.log('[HTTP-RESOLVE] Filecrypt: Failed to parse container page');
        return null;
    }

    // Extract cookies from response for subsequent requests
    const cookies = response.headers?.['set-cookie'] || '';
    const cookieHeader = Array.isArray(cookies)
        ? cookies.map(c => c.split(';')[0]).join('; ')
        : cookies.split(';')[0] || '';

    let entries = collectFilecryptEntries($, response.url || filecryptUrl);
    if (entries.length === 0) {
        console.log('[HTTP-RESOLVE] Filecrypt: No download entries found');
        return null;
    }

    console.log(`[HTTP-RESOLVE] Filecrypt: Found ${entries.length} entries`);

    // Filter by episode if hint provided
    entries = filterFilecryptEntriesByEpisode(entries, hints);
    if (entries.length < 150) {
        console.log(`[HTTP-RESOLVE] Filecrypt: Filtered to ${entries.length} entries for episode ${hints.episode || 'all'}`);
    }

    // Order entries by preference
    const ordered = orderFilecryptEntries(entries, hints);

    // Limit how many entries we try to avoid too many requests
    const maxTries = 10;
    let tries = 0;

    // Try to resolve each entry until we get a working one
    for (const entry of ordered) {
        if (tries >= maxTries) {
            console.log(`[HTTP-RESOLVE] Filecrypt: Reached max tries (${maxTries}), stopping`);
            break;
        }
        tries++;

        const directUrl = await resolveFilecryptLink(entry.linkUrl, filecryptUrl, cookieHeader);
        if (directUrl) {
            console.log(`[HTTP-RESOLVE] Filecrypt: Success with ${entry.host} -> ${directUrl.substring(0, 60)}...`);
            // If it's a pixeldrain URL, resolve it further
            if (PIXELDRAIN_HOSTS.some(h => directUrl.includes(h))) {
                const pixeldrainResolved = await resolvePixeldrainDownload(directUrl);
                if (pixeldrainResolved) {
                    return pixeldrainResolved;
                }
            }
            return directUrl;
        }
    }

    console.log('[HTTP-RESOLVE] Filecrypt: All entries failed to resolve');
    return null;
}

function getFileExtension(urlString) {
    try {
        const cleanedUrl = urlString.split('?')[0].split('#')[0];
        const lastSlash = cleanedUrl.lastIndexOf('/');
        const filename = lastSlash >= 0 ? cleanedUrl.slice(lastSlash + 1) : cleanedUrl;
        const lastDot = filename.lastIndexOf('.');
        if (lastDot === -1) {
            return '';
        }
        return filename.slice(lastDot);
    } catch {
        return '';
    }
}

function evaluateVideoCandidate(candidate) {
    if (!candidate?.url) {
        return { isVideo: false, reason: 'missing URL' };
    }

    const urlLower = candidate.url.toLowerCase();

    if (TRUSTED_VIDEO_HOST_HINTS.some(host => urlLower.includes(host))) {
        return { isVideo: true };
    }

    const extension = getFileExtension(urlLower);
    if (extension) {
        if (NON_VIDEO_EXTENSIONS.has(extension)) {
            return { isVideo: false, reason: `${extension} file` };
        }
        if (VIDEO_EXTENSIONS.has(extension)) {
            return { isVideo: true };
        }
    }

    const label = `${candidate.title || ''} ${candidate.name || ''}`.toLowerCase();
    if (label) {
        if (VIDEO_EXTENSION_LIST.some(ext => label.includes(ext))) {
            return { isVideo: true };
        }
        if (NON_VIDEO_EXTENSION_LIST.some(ext => label.includes(ext))) {
            return { isVideo: false, reason: 'non-video label' };
        }
    }

    if (candidate.type) {
        const typeLower = candidate.type.toLowerCase();
        if (VIDEO_TYPE_HINTS.some(type => typeLower.includes(type))) {
            return { isVideo: true };
        }
        if (typeLower.includes('zip') || typeLower.includes('rar')) {
            return { isVideo: false, reason: 'non-video type' };
        }
    }

    // Default to video when we can't confidently determine the file type
    return { isVideo: true };
}

async function findSeekableLink(results, { timeoutMs = FAST_SEEK_TIMEOUT_MS, maxParallel = MAX_PARALLEL_VALIDATIONS } = {}) {
    if (!Array.isArray(results) || results.length === 0) {
        return null;
    }

    const cache = new Map();

    const checkUrl = async (candidate, label) => {
        if (!candidate?.url) return false;
        if (cache.has(candidate.url)) {
            return cache.get(candidate.url);
        }

        const { isVideo, reason } = evaluateVideoCandidate(candidate);
        if (!isVideo) {
            console.log(`[HTTP-RESOLVE] Skipping ${label} link because it is not a video file${reason ? ` (${reason})` : ''}`);
            cache.set(candidate.url, false);
            return false;
        }

        try {
            const validation = await validateSeekableUrl(candidate.url, {
                requirePartialContent: true,
                timeout: timeoutMs
            });

            // Check if the extracted filename reveals this is actually a non-video file (e.g., .zip)
            // This catches cases where trusted hosts serve ZIP files with obfuscated URLs
            if (validation.filename) {
                const filenameLower = validation.filename.toLowerCase();
                const isNonVideoFile = NON_VIDEO_EXTENSION_LIST.some(ext => filenameLower.endsWith(ext));
                if (isNonVideoFile) {
                    console.log(`[HTTP-RESOLVE] Skipping ${label} link - Content-Disposition reveals non-video file: ${validation.filename}`);
                    cache.set(candidate.url, false);
                    return false;
                }
            }

            if (validation.isValid) {
                console.log(`[HTTP-RESOLVE] Selected ${label} link with confirmed 206 support`);
                cache.set(candidate.url, true);
                return true;
            }
            const hostname = (() => {
                try { return new URL(candidate.url).hostname.toLowerCase(); } catch { return ''; }
            })();
            const isPixeldrain = hostname.includes('pixeldrain');
            const isHubCdn = hostname.includes('hubcdn.fans');
            if (isPixeldrain && [403, 451].includes(validation.statusCode)) {
                console.log(`[HTTP-RESOLVE] Allowing ${label} Pixeldrain link despite ${validation.statusCode} (likely proxy restriction)`);
                cache.set(candidate.url, true);
                return true;
            }
            if (isHubCdn && [301, 302, 307, 308].includes(validation.statusCode)) {
                console.log(`[HTTP-RESOLVE] Allowing ${label} HubCDN redirect link despite ${validation.statusCode}`);
                cache.set(candidate.url, true);
                return true;
            }
            console.log(`[HTTP-RESOLVE] Rejected ${label} link (status: ${validation.statusCode || 'unknown'}) due to missing 206 support`);
            cache.set(candidate.url, false);
            return false;
        } catch (error) {
            console.error(`[HTTP-RESOLVE] Error validating ${label} link: ${error.message}`);
            cache.set(candidate.url, false);
            return false;
        }
    };

    // Sort by priority field from extraction (higher priority first), then deduplicate by URL
    const seen = new Set();
    const candidates = [];

    // Sort results by priority (descending) - extraction already set priority based on button labels
    const sortedResults = [...results].sort((a, b) => {
        const priorityA = a.priority ?? 0;
        const priorityB = b.priority ?? 0;
        return priorityB - priorityA; // Higher priority first
    });

    for (const candidate of sortedResults) {
        if (!candidate?.url || seen.has(candidate.url)) {
            continue;
        }

        const label = candidate.serverType || candidate.name || 'Unknown';
        candidates.push({ candidate, label });
        seen.add(candidate.url);
    }

    console.log(`[HTTP-RESOLVE] Testing ${candidates.length} candidates in priority order:`);
    candidates.forEach((entry, idx) => {
        console.log(`[HTTP-RESOLVE]   ${idx + 1}. [${entry.label}] priority=${entry.candidate.priority ?? 0}`);
    });

    // Validate candidates in small parallel batches to cut down total resolve time
    const batchSize = Math.max(1, maxParallel);
    for (let i = 0; i < candidates.length; i += batchSize) {
        const batch = candidates.slice(i, i + batchSize);
        const validationResults = await Promise.all(
            batch.map(entry => checkUrl(entry.candidate, entry.label))
        );
        const winnerIndex = validationResults.findIndex(Boolean);
        if (winnerIndex !== -1) {
            return batch[winnerIndex].candidate.url;
        }
    }

    return null;
}

/**
 * Resolve a redirect URL to its final direct streaming link
 * Handles lazy-load resolution for 4KHDHub, HDHub4u, and UHDMovies
 * This is called when the user selects a stream, providing lazy resolution
 * Steps: 1) Resolve redirect to file hosting URL, 2) Extract/decrypt to final stream URL, 3) Validate with 206 check
 * @param {string} redirectUrl - Original redirect URL that needs resolution + decryption
 * @returns {Promise<string|null>} - Final direct streaming URL with confirmed 206 support
 */
export async function resolveHttpStreamUrl(redirectUrl) {
    const decodedUrl = decodeURIComponent(redirectUrl);

    // Skip known dead HubCloud domains early
    if (isDeadHubcloudDomain(decodedUrl)) {
        console.log(`[HTTP-RESOLVE] Skipping dead HubCloud domain: ${decodedUrl.substring(0, 60)}...`);
        return null;
    }

    const { baseUrl, hints } = parseStreamHints(decodedUrl);
    const cacheKey = decodedUrl;

    const now = Date.now();
    const cached = resolveCache.get(cacheKey);
    if (cached) {
        if (cached.value && now - cached.ts < RESOLVE_CACHE_TTL) {
            console.log('[HTTP-RESOLVE] Using cached result');
            return cached.value;
        }
        if (cached.promise) {
            console.log('[HTTP-RESOLVE] Joining in-flight resolve');
            return cached.promise;
        }
    }

    const resolverPromise = (async () => {
        console.log('[HTTP-RESOLVE] Starting lazy resolution (on-demand extraction + validation)');
        let workingUrl = baseUrl;
        console.log('[HTTP-RESOLVE] Redirect URL:', decodedUrl.substring(0, 100) + '...');

        const mkvDramaToken = extractMkvDramaToken(workingUrl);
        if (mkvDramaToken) {
            console.log('[HTTP-RESOLVE] MKVDrama token detected, resolving...');
            const resolved = await resolveMkvDramaToken(mkvDramaToken);
            if (!resolved) {
                console.log('[HTTP-RESOLVE] MKVDrama token resolution failed');
                resolveCache.set(cacheKey, { value: null, ts: Date.now() });
                return null;
            }
            workingUrl = resolved;
            console.log('[HTTP-RESOLVE] MKVDrama token resolved to:', workingUrl.substring(0, 100) + '...');
        }

        if (OUO_HOSTS.some(host => workingUrl.includes(host))) {
            console.log('[HTTP-RESOLVE] Ouo short link detected, resolving...');
            try {
                const resolved = await resolveOuoLink(workingUrl, hints);
                if (!resolved) {
                    console.log('[HTTP-RESOLVE] Failed to resolve Ouo link');
                    resolveCache.set(cacheKey, { value: null, ts: Date.now() });
                    return null;
                }
                workingUrl = resolved;
                console.log('[HTTP-RESOLVE] Ouo link resolved to:', workingUrl.substring(0, 100) + '...');
            } catch (err) {
                console.log(`[HTTP-RESOLVE] Ouo resolution failed: ${err.message}`);
                resolveCache.set(cacheKey, { value: null, ts: Date.now() });
                return null;
            }
        }

        if (VIEWCRATE_HOSTS.some(host => workingUrl.includes(host))) {
            console.log('[HTTP-RESOLVE] ViewCrate link detected, extracting Pixeldrain URL...');
            try {
                const resolved = await resolveViewcrateLink(workingUrl, hints);
                if (!resolved) {
                    console.log('[HTTP-RESOLVE] Failed to extract Pixeldrain link from ViewCrate');
                    resolveCache.set(cacheKey, { value: null, ts: Date.now() });
                    return null;
                }
                workingUrl = resolved;
                console.log('[HTTP-RESOLVE] ViewCrate resolved to:', workingUrl.substring(0, 100) + '...');
            } catch (err) {
                console.log(`[HTTP-RESOLVE] ViewCrate resolution failed: ${err.message}`);
                resolveCache.set(cacheKey, { value: null, ts: Date.now() });
                return null;
            }
        }

        if (FILECRYPT_HOSTS.some(host => workingUrl.includes(host))) {
            console.log('[HTTP-RESOLVE] Filecrypt link detected, extracting download URL...');
            try {
                const resolved = await resolveFilecryptContainer(workingUrl, hints);
                if (!resolved) {
                    console.log('[HTTP-RESOLVE] Failed to extract download link from Filecrypt');
                    resolveCache.set(cacheKey, { value: null, ts: Date.now() });
                    return null;
                }
                workingUrl = resolved;
                console.log('[HTTP-RESOLVE] Filecrypt resolved to:', workingUrl.substring(0, 100) + '...');
            } catch (err) {
                console.log(`[HTTP-RESOLVE] Filecrypt resolution failed: ${err.message}`);
                resolveCache.set(cacheKey, { value: null, ts: Date.now() });
                return null;
            }
        }

        if (PIXELDRAIN_HOSTS.some(host => workingUrl.includes(host))) {
            console.log('[HTTP-RESOLVE] Pixeldrain link detected, returning direct download URL...');
            try {
                const resolved = await resolvePixeldrainDownload(workingUrl);
                if (resolved) {
                    resolveCache.set(cacheKey, { value: resolved, ts: Date.now() });
                    return resolved;
                }
            } catch (err) {
                console.log(`[HTTP-RESOLVE] Pixeldrain resolution failed: ${err.message}`);
            }
        }

        if (XDMOVIES_LINK_HOSTS.some(host => workingUrl.includes(host))) {
            console.log('[HTTP-RESOLVE] XDMovies redirect detected, resolving...');
            const resolved = await resolveXDMoviesRedirect(workingUrl);
            if (resolved && resolved !== workingUrl) {
                console.log('[HTTP-RESOLVE] XDMovies resolved to:', resolved.substring(0, 100) + '...');
                workingUrl = resolved;
            }
        }

        if (UHDMOVIES_SID_HOSTS.some(host => workingUrl.includes(host))) {
            console.log('[HTTP-RESOLVE] UHDMovies SID detected, resolving via UHDMovies resolver...');
            try {
                const resolved = await resolveUHDMoviesUrl(workingUrl);
                const finalUrl = typeof resolved === 'string' ? resolved : resolved?.url;
                if (!finalUrl) {
                    console.log('[HTTP-RESOLVE] UHDMovies resolution failed');
                    resolveCache.set(cacheKey, { value: null, ts: Date.now() });
                    return null;
                }
                try {
                    const validation = await validateSeekableUrl(finalUrl, { requirePartialContent: true, timeout: FAST_SEEK_TIMEOUT_MS });
                    if (!validation.isValid) {
                        console.log('[HTTP-RESOLVE] UHDMovies resolved URL failed 206 validation');
                        resolveCache.set(cacheKey, { value: null, ts: Date.now() });
                        return null;
                    }
                } catch (err) {
                    console.log(`[HTTP-RESOLVE] UHDMovies 206 validation error: ${err.message}`);
                    resolveCache.set(cacheKey, { value: null, ts: Date.now() });
                    return null;
                }

                resolveCache.set(cacheKey, { value: finalUrl, ts: Date.now() });
                return finalUrl;
            } catch (err) {
                console.log(`[HTTP-RESOLVE] UHDMovies resolution error: ${err.message}`);
                resolveCache.set(cacheKey, { value: null, ts: Date.now() });
                return null;
            }
        }

        // Detect provider type from URL
        let provider = 'Unknown';
        if (workingUrl.includes('hubcloud') || workingUrl.includes('hubdrive') || workingUrl.includes('4khdhub')) {
            provider = '4KHDHub/HDHub4u';
        } else if (workingUrl.includes('hubcdn.fans')) {
            provider = 'HDHub4u';
        }
        console.log('[HTTP-RESOLVE] Detected provider:', provider);

        // Handle gdlink.dev directly via extractor path
        if (workingUrl.includes('gdlink.dev')) {
            console.log('[HTTP-RESOLVE] gdlink.dev detected, attempting extractor resolution');
            try {
                const extracted = await processExtractorLinkWithAwait(workingUrl, 99) || [];
                const seekable = await findSeekableLink(extracted);
                resolveCache.set(cacheKey, { value: seekable, ts: Date.now() });
                return seekable;
            } catch (err) {
                console.log(`[HTTP-RESOLVE] gdlink.dev resolution failed: ${err.message}`);
                resolveCache.set(cacheKey, { value: null, ts: Date.now() });
                return null;
            }
        }

        // Handle CineDoze links (cinedoze.tv/links/xxx -> savelinks.me -> hubcloud)
        if (workingUrl.includes('cinedoze.tv/links/')) {
            console.log('[HTTP-RESOLVE] CineDoze link detected, expanding to HubCloud URL...');
            try {
                // Follow redirect to savelinks.me and extract HubCloud link
                const response = await makeRequest(workingUrl, { parseHTML: false, timeout: 12000 });
                const body = response.body || '';

                // Extract hubcloud/hubdrive links from the page
                const hubcloudMatch = body.match(/https?:\/\/[^\s"'<>]*(?:hubcloud|hubdrive|hubcdn)[^\s"'<>]*/gi);
                if (hubcloudMatch && hubcloudMatch.length > 0) {
                    const hubcloudUrl = hubcloudMatch[0];
                    console.log(`[HTTP-RESOLVE] Extracted HubCloud URL: ${hubcloudUrl.substring(0, 80)}...`);

                    // Now process the HubCloud URL through the extractor
                    const extracted = await processExtractorLinkWithAwait(hubcloudUrl, 99) || [];
                    const seekable = await findSeekableLink(extracted);
                    resolveCache.set(cacheKey, { value: seekable, ts: Date.now() });
                    return seekable;
                }
                console.log('[HTTP-RESOLVE] No HubCloud link found in CineDoze page');
                resolveCache.set(cacheKey, { value: null, ts: Date.now() });
                return null;
            } catch (err) {
                console.log(`[HTTP-RESOLVE] CineDoze resolution failed: ${err.message}`);
                resolveCache.set(cacheKey, { value: null, ts: Date.now() });
                return null;
            }
        }

        // Fast-path: direct hosts (workers/hubcdn/r2) — validate and return without extractor
        if (DIRECT_HOST_HINTS.some(h => workingUrl.includes(h))) {
            console.log('[HTTP-RESOLVE] Direct host detected, performing fast 206 validation');
            try {
                const validation = await validateSeekableUrl(workingUrl, { requirePartialContent: true, timeout: FAST_SEEK_TIMEOUT_MS });
                if (validation.isValid) {
                    resolveCache.set(cacheKey, { value: workingUrl, ts: Date.now() });
                    return workingUrl;
                }
                console.log('[HTTP-RESOLVE] Direct host failed 206 validation');
            } catch (err) {
                console.log(`[HTTP-RESOLVE] Direct host validation error: ${err.message}`);
            }
        }

        // Step 1: Resolve redirect to file hosting URL (hubcloud/hubdrive)
        let fileHostingUrl;
        const hasRedirectParam = /[?&]id=/i.test(workingUrl);
        if (hasRedirectParam) {
            console.log('[HTTP-RESOLVE] Resolving redirect to file hosting URL...');
            fileHostingUrl = await getRedirectLinks(workingUrl);
            if (!fileHostingUrl || !fileHostingUrl.trim()) {
                console.log('[HTTP-RESOLVE] Failed to resolve redirect');
                return null;
            }
            console.log('[HTTP-RESOLVE] Resolved to file hosting URL:', fileHostingUrl.substring(0, 100) + '...');
        } else {
            // Already a direct URL
            fileHostingUrl = workingUrl;
            console.log('[HTTP-RESOLVE] URL is already a file hosting URL');
        }

        // Step 2: Decrypt file hosting URL to final streaming URL
        console.log('[HTTP-RESOLVE] Decrypting file hosting URL...');
        const result = await processExtractorLinkWithAwait(fileHostingUrl, 99);  // Get ALL results, not just 1

        if (!result || !Array.isArray(result) || result.length === 0) {
            console.log('[HTTP-RESOLVE] No valid stream found after decryption');
            return null;
        }

        // Filter out null/empty entries defensively before logging/validation
        const sanitizedResults = result.filter(r => r && r.url);
        if (sanitizedResults.length === 0) {
            console.log('[HTTP-RESOLVE] No usable streams after filtering null/empty results');
            return null;
        }

        console.log(`[HTTP-RESOLVE] Found ${sanitizedResults.length} potential stream(s), selecting best one...`);

        // Log all results for debugging
        sanitizedResults.forEach((r, idx) => {
            const type = r.url.includes('pixeldrain') ? 'Pixeldrain' :
                r.url.includes('googleusercontent') ? 'GoogleUserContent' :
                    r.url.includes('workers.dev') ? 'Workers.dev' :
                        r.url.includes('hubcdn') ? 'HubCDN' :
                            r.url.includes('r2.dev') ? 'R2' : 'Other';
            console.log(`[HTTP-RESOLVE]   ${idx + 1}. [${type}] ${r.url.substring(0, 80)}...`);
        });

        const seekableLink = await findSeekableLink(sanitizedResults);
        if (seekableLink) {
            console.log(`[HTTP-RESOLVE] Returning seekable link: ${seekableLink.substring(0, 100)}...`);
            return seekableLink;
        }

        console.log('[HTTP-RESOLVE] No links with confirmed 206 support were found');
        return null;
    })();

    resolveCache.set(cacheKey, { promise: resolverPromise, ts: now });

    const result = await resolverPromise;
    resolveCache.set(cacheKey, { value: result, ts: Date.now() });
    return result;
}
