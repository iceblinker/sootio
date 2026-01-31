import axios from 'axios';
import * as cheerio from 'cheerio';
import { URL } from 'url';
import * as SqliteCache from './util/cache-store.js';
import { getResolutionFromName, formatSize } from './common/torrent-utils.js';
import Cinemeta from './util/cinemeta.js';
import { renderLanguageFlags, detectLanguagesFromTitle } from './util/language-mapping.js';
import debridProxyManager from './util/debrid-proxy.js';
import { validateSeekableUrl } from './http-streams/utils/validation.js';
import { extractFilenameFromHubPage } from './http-streams/providers/hdhub4u/extraction.js';

// Lazy-load mode - returns preview streams without full HubCloud extraction
function isLazyLoadEnabled() {
  return process.env.DISABLE_HTTP_STREAM_LAZY_LOAD !== 'true';
}

// Enable filename extraction in lazy-load mode (adds latency but provides accurate filenames)
// Enabled by default for MoviesDrive since it completes within timeout
const EXTRACT_FILENAMES_IN_LAZY_MODE = process.env.MOVIESDRIVE_EXTRACT_FILENAMES !== 'false';

// Function to encode URLs for streaming
function encodeUrlForStreaming(url) {
  if (!url) return url;

  // Don't re-encode already encoded URLs
  if (url.includes('%')) {
    return url;
  }

  try {
    const urlObj = new URL(url);
    return urlObj.toString();
  } catch (e) {
    return url
      .replace(/ /g, '%20')
      .replace(/#/g, '%23')
      .replace(/\[/g, '%5B')
      .replace(/\]/g, '%5D')
      .replace(/{/g, '%7B')
      .replace(/}/g, '%7D');
  }
}

// --- Proxy Configuration ---
const MOVIESDRIVE_PROXY_URL = process.env.MOVIESDRIVE_PROXY_URL;
if (MOVIESDRIVE_PROXY_URL) {
  console.log(`[MoviesDrive] Legacy proxy support enabled: ${MOVIESDRIVE_PROXY_URL}`);
} else {
  console.log('[MoviesDrive] No legacy proxy configured, checking debrid-proxy system');
}

// Check if httpstreams should use proxy via debrid-proxy system
const USE_HTTPSTREAMS_PROXY = debridProxyManager.shouldUseProxy('httpstreams');
if (USE_HTTPSTREAMS_PROXY) {
  console.log('[MoviesDrive] httpstreams proxy enabled via debrid-proxy system');
}

function parseSizeLabel(text = '') {
  const match = text.match(/([0-9.]+)\s*(TB|GB|MB|KB)/i);
  return match ? `${match[1]} ${match[2].toUpperCase()}` : null;
}

// Remove URLs, hostnames, and site tags so language detection does not misfire
function sanitizeForLanguageDetection(text = '') {
  if (!text) return '';
  let cleaned = text;

  // Strip URLs completely
  cleaned = cleaned.replace(/https?:\/\/\S+/gi, ' ');

  // Drop host/domain-like tokens (words containing dots or common TLDs/site names)
  cleaned = cleaned.replace(/\b\S+\.(?:com|net|org|info|biz|me|io|cc|to|xyz|site|live|app|dev|pics|sbs|cool|cloud|life|today|space|link|fans|drive|one|pro|fun|tv|in|uk|us|au|ca|cv)\b/gi, ' ');

  // Preserve content inside brackets while dropping the brackets themselves
  cleaned = cleaned.replace(/\[([^\]]+)\]/g, ' $1 ');

  // Remove common site labels and leftover bracketed tags
  cleaned = cleaned
    .replace(/\b(moviesdrive|moviesdrives|hubcloud|hubdrive|hdhub4u|sooti|sootio|tmoviesdrives?)\b/gi, ' ');

  return cleaned.replace(/\s+/g, ' ').trim();
}

function detectLanguagesSafely(text = '') {
  const cleaned = sanitizeForLanguageDetection(text);
  return detectLanguagesFromTitle(cleaned);
}

function detectLanguagesFromSources(sources = []) {
  const joined = sources.filter(Boolean).join(' ');
  return detectLanguagesSafely(joined);
}

function filenameMatchesEpisode(filename = '', episode = null) {
  if (!episode) return false;
  const ep = String(episode).padStart(2, '0');
  const lower = filename.toLowerCase();
  return new RegExp(`s\\d+e${ep}\\b`).test(lower) ||
    new RegExp(`\\be${ep}\\b`).test(lower) ||
    new RegExp(`\\bep(?:isode)?\\s*${parseInt(ep, 10)}\\b`).test(lower);
}

async function findHostLinkByEpisode(hostLinks = [], episode = null, timeout = 4000) {
  if (!episode || !hostLinks?.length) return null;
  for (const host of hostLinks) {
    try {
      if (!host.url) continue;
      const info = await extractFilenameFromHubPage(host.url, timeout);
      if (info?.filename && filenameMatchesEpisode(info.filename, episode)) {
        return { host, info };
      }
    } catch (err) {
      console.log(`[MoviesDrive] Episode match check failed for ${host.url}: ${err.message}`);
    }
  }
  return null;
}

// For TV episodes, pick the host link that corresponds to the requested episode by position
function selectHostLinkForEpisode(hostLinks = [], episode = null, { singleEpisodePage = false } = {}) {
  // For single-episode pages, don't offset by episode number—just take the first usable host
  if (singleEpisodePage) {
    episode = null;
  }
  if (!episode || !Array.isArray(hostLinks) || hostLinks.length === 0) return hostLinks[0];

  const idx = Math.max(0, parseInt(episode, 10) - 1); // 1-based to 0-based
  const isHub = (h) => h?.url && /hubcloud|hubdrive|hubcdn/i.test(h.url);
  const isGdFlix = (h) => h?.url && /gdflix|gdlink/i.test(h.url);
  const isFilesdl = (h) => h?.url && (h.type === 'filesdl' || /filesdl/i.test(h.url));

  const hubcloudLinks = hostLinks.filter(isHub);
  const gdflixLinks = hostLinks.filter(isGdFlix);
  const filesdlLinks = hostLinks.filter(isFilesdl);

  return hubcloudLinks[idx] || gdflixLinks[idx] || filesdlLinks[idx] ||
    hubcloudLinks[0] || gdflixLinks[0] || filesdlLinks[0] || hostLinks[0];
}

// --- Domain Management ---
let moviesDriveDomain = 'https://moviesdrive.pics'; // Fallback domain
let domainCacheTimestamp = 0;
const DOMAIN_CACHE_TTL = parseInt(process.env.MOVIESDRIVE_DOMAIN_CACHE_TTL) || 1 * 60 * 1000; // 1 minute default

// Alternative domains to try if the primary one fails
const FALLBACK_DOMAINS = [
  'https://moviesdrive.forum',
  'https://moviesdrive.pics',
  'https://moviesdrive.cool',
  'https://moviesdrive.sbs',
  'https://moviesdrive.cloud',
  'https://moviesdrive.life'
];

async function getMoviesDriveDomain() {
  const now = Date.now();
  if (now - domainCacheTimestamp < DOMAIN_CACHE_TTL) {
    return moviesDriveDomain;
  }

  // Fail fast when domain endpoint is slow/unreachable to avoid upstream timeouts
  const DEFAULT_TIMEOUT = parseInt(process.env.MOVIESDRIVE_DOMAIN_TIMEOUT) || 6000;
  const MAX_RETRIES = parseInt(process.env.MOVIESDRIVE_DOMAIN_MAX_RETRIES) || 1;
  const RETRY_DELAY = parseInt(process.env.MOVIESDRIVE_DOMAIN_RETRY_DELAY) || 500;

  let lastError;

  // First, try to get the domain from the external API
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`[MoviesDrive] Fetching latest domain from API (attempt ${attempt + 1})...`);
      const response = await axios.get('https://raw.githubusercontent.com/phisher98/TVVVV/main/domains.json', { timeout: DEFAULT_TIMEOUT });
      if (response && response.data && (response.data.MoviesDrive || response.data.moviesdrive)) {
        // Check for both cases: capitalized (backward compatibility) and lowercase (current API)
        let newDomain = response.data.MoviesDrive || response.data.moviesdrive;

        // Validate the domain response before using it
        try {
          await axios.head(newDomain, { timeout: DEFAULT_TIMEOUT });
          moviesDriveDomain = newDomain;
          domainCacheTimestamp = Date.now();
          console.log(`[MoviesDrive] Updated domain to: ${moviesDriveDomain}`);
          return moviesDriveDomain;
        } catch (validationError) {
          console.warn(`[MoviesDrive] Domain validation failed for ${newDomain}:`, validationError.message);
          // Continue to try fallback domains
        }
      }
    } catch (error) {
      lastError = error;
      console.warn(`[MoviesDrive] Domain fetch attempt ${attempt + 1} failed:`, error.message);
      if (attempt < MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      }
    }
  }

  // If API fetch failed, try fallback domains
  console.log(`[MoviesDrive] API fetch failed, trying fallback domains...`);
  for (const fallbackDomain of FALLBACK_DOMAINS) {
    try {
      console.log(`[MoviesDrive] Testing fallback domain: ${fallbackDomain}`);
      await axios.head(fallbackDomain, { timeout: DEFAULT_TIMEOUT });
      moviesDriveDomain = fallbackDomain;
      domainCacheTimestamp = Date.now();
      console.log(`[MoviesDrive] Fallback domain validated successfully: ${moviesDriveDomain}`);
      return moviesDriveDomain;
    } catch (validationError) {
      console.warn(`[MoviesDrive] Fallback domain validation failed for ${fallbackDomain}:`, validationError.message);
    }
  }

  console.warn(`[MoviesDrive] All domain fetch attempts failed. Using default fallback: ${moviesDriveDomain}`);
  return moviesDriveDomain;
}

// --- Axios Instance with Proxy Support ---
const createAxiosInstance = () => {
  const config = {
    timeout: 30000,
    maxRedirects: 5,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5'
    },
    validateStatus: (status) => status < 500
  };

  // Add proxy configuration if MOVIESDRIVE_PROXY_URL is set (legacy)
  if (MOVIESDRIVE_PROXY_URL) {
    console.log(`[MoviesDrive] Using legacy proxy: ${MOVIESDRIVE_PROXY_URL}`);
  } else {
    // Use debrid-proxy system if httpstreams proxy is enabled
    const proxyAgent = debridProxyManager.getProxyAgent('httpstreams');
    if (proxyAgent) {
      config.httpAgent = proxyAgent;
      config.httpsAgent = proxyAgent;
      config.proxy = false; // Disable axios built-in proxy handling
      console.log('[MoviesDrive] Using debrid-proxy system for httpstreams');
    }
  }

  return axios.create(config);
};

const axiosInstance = createAxiosInstance();

// --- HTTP Request Handler ---
async function makeRequest(url, options = {}) {
  // Shorter defaults so the provider returns before the global 45s cap
  const DEFAULT_TIMEOUT = parseInt(process.env.MOVIESDRIVE_REQUEST_TIMEOUT) || 12000;
  const MAX_RETRIES = parseInt(process.env.MOVIESDRIVE_REQUEST_MAX_RETRIES) || 1;
  const RETRY_DELAY = parseInt(process.env.MOVIESDRIVE_REQUEST_RETRY_DELAY) || 800;

  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      let response;

      if (MOVIESDRIVE_PROXY_URL && !url.includes('raw.githubusercontent.com')) {
        // Route through legacy proxy
        const proxiedUrl = `${MOVIESDRIVE_PROXY_URL}${encodeURIComponent(url)}`;
        console.log(`[MoviesDrive] Making legacy proxied request to: ${url} (attempt ${attempt + 1})`);
        response = await axiosInstance.get(proxiedUrl, {
          ...options,
          timeout: DEFAULT_TIMEOUT
        });
      } else if (USE_HTTPSTREAMS_PROXY) {
        // Using debrid-proxy system, no need to modify URL - agent handles it
        console.log(`[MoviesDrive] Making proxied request via debrid-proxy to: ${url} (attempt ${attempt + 1})`);
        response = await axiosInstance.get(url, {
          ...options,
          timeout: DEFAULT_TIMEOUT
        });
      } else {
        // Direct request without proxy
        console.log(`[MoviesDrive] Making direct request to: ${url} (attempt ${attempt + 1})`);
        response = await axiosInstance.get(url, {
          ...options,
          timeout: DEFAULT_TIMEOUT
        });
      }

      // Parse HTML if requested
      if (options.parseHTML && response.data) {
        const $ = cheerio.load(response.data);
        return {
          document: $,
          data: response.data,
          status: response.status,
          url: response.request?.res?.responseUrl || url
        };
      }

      return response;
    } catch (error) {
      lastError = error;
      console.error(`[MoviesDrive] Request failed (attempt ${attempt + 1}):`, error.message);
      if (attempt < MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      }
    }
  }

  throw lastError;
}

// --- Search Functions ---
async function searchMovies(query) {
  console.log(`[MoviesDrive] Searching for: "${query}"`);

  // --- Primary path: new search API ---
  try {
    const domain = await getMoviesDriveDomain();
    const searchUrl = new URL('/searchapi.php', domain);
    searchUrl.searchParams.set('q', query.trim());
    searchUrl.searchParams.set('page', '1');
    console.log(`[MoviesDrive] Search API URL: ${searchUrl.toString()}`);

    const response = await makeRequest(searchUrl.toString());
    const hits = Array.isArray(response?.data?.hits) ? response.data.hits : [];
    const foundCount = typeof response?.data?.found === 'number' ? response.data.found : 'unknown';
    console.log(`[MoviesDrive] Search API returned ${hits.length} hits (found=${foundCount})`);

    const results = hits.map((hit) => {
      const doc = hit?.document || {};
      const title = (doc.post_title || '').trim();
      const permalink = doc.permalink ? new URL(doc.permalink, domain).toString() : null;
      if (!title || !permalink) return null;

      let slug = null;
      try {
        const urlObj = new URL(permalink);
        slug = urlObj.pathname.replace(/\/+$/, '').split('/').filter(Boolean).pop() || null;
      } catch (err) {
        console.log(`[MoviesDrive] Failed to parse permalink for slug: ${permalink}`);
      }

      const yearMatch = title.match(/\b(19|20)\d{2}\b/);
      const year = yearMatch ? parseInt(yearMatch[0], 10) : null;

      return {
        title,
        url: permalink,
        slug,
        year
      };
    }).filter(Boolean);

    const uniqueResults = results.filter((result, index, self) =>
      index === self.findIndex((r) => r.url === result.url)
    );

    if (uniqueResults.length > 0) {
      console.log(`[MoviesDrive] Using ${uniqueResults.length} results from search API`);
      return uniqueResults;
    }
    console.log('[MoviesDrive] Search API returned no usable results, falling back to legacy search');
  } catch (error) {
    console.error(`[MoviesDrive] Search API failed:`, error.message);
  }

  // --- Fallback path: legacy HTML search (may be empty on newer site builds) ---
  try {
    const domain = await getMoviesDriveDomain();
    const searchQuery = query.replace(/\s+/g, '+');
    const searchUrl = `${domain}/?s=${searchQuery}`;
    console.log(`[MoviesDrive] Legacy search URL: ${searchUrl}`);

    const response = await makeRequest(searchUrl, { parseHTML: true });
    const $ = response.document;

    // Get the actual domain after any redirects
    const actualDomain = response.url ? new URL(response.url).origin : domain;
    console.log(`[MoviesDrive] Actual domain (after redirects): ${actualDomain}`);

    const results = [];

    $('a[href]').each((i, elem) => {
      const href = $(elem).attr('href');
      const text = $(elem).text().trim();
      if (!href || !text) return;

      // Accept both absolute and relative links
      const isAbsoluteMatch = href.includes(actualDomain);
      const isRelativeMatch = href.startsWith('/') && !href.startsWith('//');
      if (!isAbsoluteMatch && !isRelativeMatch) return;

      if (href.includes('?s=') ||
          href.includes('/feed/') ||
          href.includes('/category/') ||
          href.includes('/tag/') ||
          href.includes('/search/') ||
          href.includes('#')) {
        return;
      }

      const hrefToUse = isRelativeMatch ? new URL(href, actualDomain).toString() : href;
      if (!hrefToUse.match(/\/[a-z0-9-]+\/?$/i)) return;

      const urlMatch = hrefToUse.match(/\/([^/]+)\/?$/);
      const slug = urlMatch ? urlMatch[1] : null;

      let year = null;
      const yearMatchSlug = slug ? slug.match(/[-_](\d{4})/) : null;
      const yearMatchText = text.match(/\((\d{4})\)/);
      if (yearMatchSlug) {
        year = parseInt(yearMatchSlug[1]);
      } else if (yearMatchText) {
        year = parseInt(yearMatchText[1]);
      }

      results.push({
        title: text,
        url: hrefToUse,
        slug,
        year
      });
    });

    const uniqueResults = results.filter((result, index, self) =>
      index === self.findIndex((r) => r.url === result.url)
    );

    console.log(`[MoviesDrive] Legacy search found ${uniqueResults.length} unique results`);
    return uniqueResults;
  } catch (error) {
    console.error(`[MoviesDrive] Legacy search failed:`, error.message);
  }

  console.log('[MoviesDrive] No search results found via API or legacy search');
  return [];
}

// --- Media Comparison ---
function compareMedia(mediaInfo, searchResult, requestedSeason = null) {
  // Normalize titles for comparison
  const normalizeTitle = (title) => {
    let normalized = title.toLowerCase()
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    // Normalize common number-to-word variations for better matching
    // e.g., "Fantastic 4" <-> "Fantastic Four"
    const numberWords = {
      '1': 'one', '2': 'two', '3': 'three', '4': 'four', '5': 'five',
      '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine', '10': 'ten'
    };

    // Replace standalone numbers with their word equivalents
    Object.keys(numberWords).forEach(num => {
      const word = numberWords[num];
      // Replace number with word (e.g., " 4 " -> " four ")
      normalized = normalized.replace(new RegExp(`\\b${num}\\b`, 'g'), word);
      // Already handles word form, so no need to reverse
    });

    return normalized;
  };

  const mediaTitle = normalizeTitle(mediaInfo.title);
  const resultTitle = normalizeTitle(searchResult.title);

  // For TV shows, remove season/episode numbers from result for matching
  // e.g., "The Witcher Season 1" -> "the witcher"
  const resultTitleClean = resultTitle
    .replace(/\s+season\s+\d+/gi, '')
    .replace(/\s+s\d+/gi, '')
    .replace(/\s+complete/gi, '')
    .trim();

  // Check if titles match (more lenient for TV shows)
  const titleMatch = resultTitleClean.includes(mediaTitle) ||
                     mediaTitle.includes(resultTitleClean) ||
                     resultTitle.includes(mediaTitle) ||
                     mediaTitle.includes(resultTitle);

  // Check year if available
  // For TV series with specific seasons requested, be more lenient with year matching
  // because Season 3 of a 2019 show might be released in 2025
  let yearMatch = true;
  if (mediaInfo.year && searchResult.year) {
    if (requestedSeason) {
      // For TV series with season requested, allow any year >= show start year
      // and within reasonable range (show probably won't have new seasons 20+ years later)
      yearMatch = searchResult.year >= mediaInfo.year - 1 && searchResult.year <= mediaInfo.year + 15;
    } else {
      // For movies or series without specific season, use tighter matching
      yearMatch = Math.abs(mediaInfo.year - searchResult.year) <= 2;
    }
  }
  // If search result has no year, only rely on title matching
  // This helps with TV series that don't have years in their URLs

  // SEASON VALIDATION: If a specific season is requested, verify the result contains it
  let seasonMatch = true;
  if (requestedSeason) {
    const resultTitleLower = searchResult.title.toLowerCase();
    // Check for season number in title (e.g., "Season 3", "S03", "S3")
    const seasonPatterns = [
      new RegExp(`season\\s*${requestedSeason}\\b`, 'i'),
      new RegExp(`\\bs0*${requestedSeason}\\b`, 'i'),
      new RegExp(`\\bseason\\s+${requestedSeason}\\b`, 'i')
    ];

    const hasRequestedSeason = seasonPatterns.some(pattern => pattern.test(searchResult.title));

    // If title mentions a DIFFERENT season, reject it
    const seasonNumberMatch = resultTitleLower.match(/season\s*(\d+)|s(\d+)/i);
    if (seasonNumberMatch) {
      const foundSeason = parseInt(seasonNumberMatch[1] || seasonNumberMatch[2]);
      if (foundSeason !== parseInt(requestedSeason)) {
        console.log(`[MoviesDrive] Season mismatch: found Season ${foundSeason}, requested Season ${requestedSeason} - "${searchResult.title}"`);
        seasonMatch = false;
      }
    }
  }

  return titleMatch && yearMatch && seasonMatch;
}

// --- Score Results ---
function scoreResult(resultTitle, season, originalTitle) {
  let score = 0;
  const normalizedResult = resultTitle.toLowerCase();
  const normalizedOriginal = originalTitle.toLowerCase();

  // Exact title match
  if (normalizedResult.includes(normalizedOriginal)) {
    score += 50;
  }

  // Season match for TV shows
  if (season && normalizedResult.includes(`season ${season}`)) {
    score += 30;
  }

  // Prefer complete seasons over individual episodes
  if (normalizedResult.includes('complete') || normalizedResult.includes('full season')) {
    score += 20;
  }

  // Quality indicators
  if (normalizedResult.includes('2160p') || normalizedResult.includes('4k')) {
    score += 15;
  } else if (normalizedResult.includes('1080p')) {
    score += 10;
  } else if (normalizedResult.includes('720p')) {
    score += 5;
  }

  return score;
}

// --- Extract Download Links from Movie Page ---
async function extractMoviePageLinks(movieUrl, { mediaType = 'movie', season = null, episode = null } = {}) {
  console.log(`[MoviesDrive] Extracting links from movie page: ${movieUrl}`);

  try {
    const response = await makeRequest(movieUrl, { parseHTML: true });
    const $ = response.document;
    const title = $('h1.entry-title').text().trim() || $('title').text().trim() || 'MoviesDrive Stream';

    // Look for mdrive links (mdrive.today, mdrive.lol, etc.)
    let links = [];
    $('a[href*="mdrive"]').each((i, elem) => {
      const href = $(elem).attr('href');
      if (href && /mdrive\.[a-z]+\/archives\//i.test(href)) {
        const quality = $(elem).text().trim();
        const size = parseSizeLabel(quality);
        const resolution = getResolutionFromName(quality);
        const languages = detectLanguagesFromSources([quality, title]);
        links.push({
          url: href,
          quality,
          size,
          resolution,
          languages,
          displayTitle: title
        });
      }
    });

    // For TV episodes, prefer the "Single Episode" links; otherwise drop archives/packs
    if ((mediaType === 'tv' || mediaType === 'series') && episode) {
      const singleEpisodeLinks = links.filter(l => /single\s+episode/i.test(l.quality || ''));
      if (singleEpisodeLinks.length > 0) {
        console.log(`[MoviesDrive] Narrowing to ${singleEpisodeLinks.length} "Single Episode" links for episode ${episode}.`);
        links = singleEpisodeLinks;
      } else {
        links = links.filter(l => !/zip|rar|7z|pack|archive/i.test((l.quality || l.title || '').toLowerCase()));
        console.log(`[MoviesDrive] No "Single Episode" marker found; removed archive/pack links, remaining ${links.length}.`);
      }
    }

    console.log(`[MoviesDrive] Found ${links.length} mdrive links`);
    return links;
  } catch (error) {
    console.error(`[MoviesDrive] Failed to extract movie page links:`, error.message);
    return [];
  }
}

// --- Extract HubCloud Links from MDrive Page ---
async function extractMDriveLinks(mdriveUrl) {
  console.log(`[MoviesDrive] Extracting HubCloud links from: ${mdriveUrl}`);

  try {
    const response = await makeRequest(mdriveUrl, { parseHTML: true });
    const $ = response.document;

    const links = [];

    // Extract title and file info
    const title = $('h1.entry-title').text().trim() || $('title').text().trim();

    // Look for hubcloud/hubdrive/hubcdn links (accept any hub domain)
    $('a[href]').each((i, elem) => {
      const href = $(elem).attr('href');
      if (href && /hubcloud|hubdrive|hubcdn/i.test(href)) {
        links.push({
          url: href,
          title: title,
          type: 'hubcloud'
        });
      }
    });

    // Also look for gdflix/gdlink links as alternative
    $('a[href]').each((i, elem) => {
      const href = $(elem).attr('href');
      if (href && /gdflix|gdlink/i.test(href)) {
        links.push({
          url: href,
          title: title,
          type: 'gdflix'
        });
      }
    });

    // Capture filesdl/cloud direct links as a last resort
    $('a[href]').each((i, elem) => {
      const href = $(elem).attr('href') || '';
      if (/filesdl|cloud\/[A-Za-z0-9]/i.test(href)) {
        links.push({
          url: href,
          title: title,
          type: 'filesdl'
        });
      }
    });

    console.log(`[MoviesDrive] Found ${links.length} hosting links`);
    return links;
  } catch (error) {
    console.error(`[MoviesDrive] Failed to extract MDrive links:`, error.message);
    return [];
  }
}

// --- Import HubCloud Extractor ---
import { extractHubCloudLinks } from './http-streams.js';

// --- Main Stream Function ---
async function getMoviesDriveStreams(imdbId, tmdbId, mediaType = 'movie', season = null, episode = null, config = {}, prefetchedMeta = null) {
  console.log(`[MoviesDrive] Fetching streams for TMDB ID: ${tmdbId}, Type: ${mediaType}${mediaType === 'tv' ? `, S:${season}E:${episode}` : ''}`);

  // Create unique timer ID to prevent duplicates when concurrent requests for same content
  const requestId = Math.random().toString(36).substring(7);
  const cinemetaTimerId = `[MoviesDrive-${requestId}] Cinemeta lookup`;

  try {
    // Use pre-fetched metadata if available, otherwise fetch it (fallback for direct calls)
    let cinemetaDetails = prefetchedMeta;
    if (!cinemetaDetails) {
      console.log(`[MoviesDrive] No pre-fetched metadata, fetching from Cinemeta...`);
      console.time(cinemetaTimerId);
      cinemetaDetails = await Cinemeta.getMeta(mediaType, imdbId);
      try { console.timeEnd(cinemetaTimerId); } catch {}
    } else {
      console.log(`[MoviesDrive] Using pre-fetched Cinemeta metadata: "${cinemetaDetails.name}"`);
    }

    if (!cinemetaDetails) {
      throw new Error('Could not get Cinemeta details');
    }

    const mediaInfo = {
      title: cinemetaDetails.name,
      year: parseInt((cinemetaDetails.year || '').split('–')[0], 10)
    };

    if (!mediaInfo.title) {
      throw new Error('Could not extract title from Cinemeta');
    }

    console.log(`[MoviesDrive] Cinemeta Info: "${mediaInfo.title}" (${mediaInfo.year || 'N/A'})`);

    // Search for media
    let searchTitle = mediaInfo.title.replace(/:/g, '').replace(/\s*&\s*/g, ' and ');
    console.log(`[MoviesDrive] Search title: ${searchTitle}`);

    let searchResults = await searchMovies(searchTitle);

    // For TV shows, pass the season to compareMedia for validation
    // Note: mediaType can be 'tv' or 'series' depending on the caller
    const isTvShow = mediaType === 'tv' || mediaType === 'series';
    const requestedSeason = isTvShow && season ? season : null;

    // Try fallback search if no results
    if (searchResults.length === 0 || !searchResults.some(result => compareMedia(mediaInfo, result, requestedSeason))) {
      console.log(`[MoviesDrive] Primary search failed. Trying fallback...`);
      let fallbackTitle = mediaInfo.title.split(':')[0].trim();
      if (fallbackTitle !== searchTitle) {
        searchResults = await searchMovies(fallbackTitle);
      }

      // Try second fallback: convert word numbers to digits
      // e.g., "Fantastic Four" -> "Fantastic 4"
      if (searchResults.length === 0 || !searchResults.some(result => compareMedia(mediaInfo, result, requestedSeason))) {
        console.log(`[MoviesDrive] First fallback failed. Trying word-to-number conversion...`);
        const wordToNumber = {
          'one': '1', 'two': '2', 'three': '3', 'four': '4', 'five': '5',
          'six': '6', 'seven': '7', 'eight': '8', 'nine': '9', 'ten': '10'
        };

        let numberTitle = fallbackTitle;
        Object.keys(wordToNumber).forEach(word => {
          const number = wordToNumber[word];
          // Replace word with number (case insensitive)
          numberTitle = numberTitle.replace(new RegExp(`\\b${word}\\b`, 'gi'), number);
        });

        if (numberTitle !== fallbackTitle) {
          console.log(`[MoviesDrive] Trying number-converted search: "${numberTitle}"`);
          searchResults = await searchMovies(numberTitle);
        }
      }

      // Try third fallback for TV shows: search with season number
      if (isTvShow && season && (searchResults.length === 0 || !searchResults.some(result => compareMedia(mediaInfo, result, requestedSeason)))) {
        const seasonSearch = `${mediaInfo.title} Season ${season}`;
        console.log(`[MoviesDrive] Trying season-specific search: "${seasonSearch}"`);
        const seasonResults = await searchMovies(seasonSearch);
        if (seasonResults.length > 0) {
          searchResults = [...searchResults, ...seasonResults];
        }
      }
    }

    if (searchResults.length === 0) {
      console.log(`[MoviesDrive] No search results found`);
      return [];
    }

    // Find best match
    console.log(`[MoviesDrive] Search results:`, searchResults.map(r => `"${r.title}" (${r.year})`));
    const matchingResults = searchResults.filter(result => {
      const match = compareMedia(mediaInfo, result, requestedSeason);
      console.log(`[MoviesDrive] Comparing "${mediaInfo.title}" (${mediaInfo.year}) with "${result.title}" (${result.year})${requestedSeason ? ` [Season ${requestedSeason}]` : ''}: ${match ? 'MATCH' : 'NO MATCH'}`);
      return match;
    });

    if (matchingResults.length === 0) {
      console.log(`[MoviesDrive] No matching results found after comparison`);
      return [];
    }

    let matchingResult;
    if (matchingResults.length === 1) {
      matchingResult = matchingResults[0];
    } else {
      const scoredResults = matchingResults.map(result => ({
        ...result,
        score: scoreResult(result.title, mediaType === 'tv' ? season : null, mediaInfo.title)
      })).sort((a, b) => b.score - a.score);
      matchingResult = scoredResults[0];
      console.log(`[MoviesDrive] Best match: "${matchingResult.title}" (score: ${matchingResult.score})`);
    }

    // Extract movie page links
    let moviePageLinks = await extractMoviePageLinks(matchingResult.url, { mediaType, season, episode });
    if (moviePageLinks.length === 0) {
      console.log(`[MoviesDrive] No download links found on movie page`);
      return [];
    }

    // For TV, keep only links that look like the requested episode (avoid season packs/wrong episodes)
    if ((mediaType === 'tv' || mediaType === 'series') && episode) {
      const targetSeason = season ? String(season).padStart(2, '0') : null;
      const targetEpisode = String(episode).padStart(2, '0');

      const isSeasonPack = (text = '') => {
        const t = text.toLowerCase();
        const hasSeasonWord = /complete|full\s*season|all\s*episodes/i.test(t);
        const hasExplicitSeason = /season\s*\d+/.test(t);
        const isArchive = /zip|rar|7z|\.zip|\.rar|\.7z|pack|archive/i.test(t);
        const hasEpisode = /e\d+|episode\s*\d+|ep\s*\d+/i.test(t);
        return (hasSeasonWord || hasExplicitSeason || isArchive) && !hasEpisode;
      };

      const matchesEpisode = (text = '', url = '') => {
        const haystack = `${text} ${url}`.toLowerCase();
        const patterns = [
          new RegExp(`s${targetSeason || '\\d{2}'}e${targetEpisode}`, 'i'),
          new RegExp(`\\bs${targetSeason || '\\d{1,2}'}\\s*ep?\\s*${targetEpisode}\\b`, 'i'),
          new RegExp(`\\bepisode\\s*${parseInt(targetEpisode, 10)}\\b`, 'i'),
          new RegExp(`\\bep\\s*${parseInt(targetEpisode, 10)}\\b`, 'i'),
          new RegExp(`\\be${targetEpisode}\\b`, 'i')
        ];
        return patterns.some(p => p.test(haystack));
      };

      const beforeCount = moviePageLinks.length;
      const episodeLinks = moviePageLinks.filter(link => matchesEpisode(link.quality || link.url, link.url) && !isSeasonPack(link.quality || link.title));
      if (episodeLinks.length > 0) {
        moviePageLinks = episodeLinks;
        console.log(`[MoviesDrive] Filtered links for S${season}E${episode}: kept ${episodeLinks.length}/${beforeCount}`);
      } else {
        // Drop obvious season packs to reduce wrong episodes
        moviePageLinks = moviePageLinks.filter(link => !isSeasonPack(link.quality || link.title));
        console.log(`[MoviesDrive] No direct episode match; removed season packs, remaining ${moviePageLinks.length}/${beforeCount}`);
      }
    }

    // LAZY-LOAD MODE: Return preview streams based on movie page links without full HubCloud extraction
    // This reduces response time from 8+ seconds to ~1-2 seconds
    if (isLazyLoadEnabled()) {
      console.log(`[MoviesDrive] Lazy-load enabled: returning ${moviePageLinks.length} preview streams without HubCloud extraction`);

      const previewStreams = (await Promise.all(moviePageLinks.map(async (link) => {
        let targetUrl = link.url;
        let extractedFilename = null;
        let extractedSize = null;

        // Upgrade mdrive archives to the first host link (hubcloud/gdflix/filesdl) so resolver can handle it
        if (/mdrive\.[a-z]+\/archives\//i.test(link.url)) {
          try {
            const hostLinks = await extractMDriveLinks(link.url);
            let hostCandidate = selectHostLinkForEpisode(
              hostLinks,
              episode,
              { singleEpisodePage: /single\s+episode/i.test(link.quality || link.title || '') }
            );
            // Try to pick the host whose filename matches the requested episode
            if (episode && hostLinks?.length) {
              const matched = await findHostLinkByEpisode(hostLinks, episode, 4000);
              if (matched?.host) {
                hostCandidate = matched.host;
                extractedFilename = matched.info?.filename || extractedFilename;
                extractedSize = matched.info?.size || extractedSize;
                console.log(`[MoviesDrive] Matched episode ${episode} host via filename: ${extractedFilename || hostCandidate.url}`);
              }
            }
            if (hostCandidate?.url) {
              targetUrl = hostCandidate.url;

              // Try to extract filename from hubcloud page if enabled
              if (EXTRACT_FILENAMES_IN_LAZY_MODE && /hubcloud|hubdrive|hubcdn/i.test(hostCandidate.url)) {
                try {
                  const filenameInfo = await extractFilenameFromHubPage(hostCandidate.url, 5000);
                  if (filenameInfo?.filename) {
                    extractedFilename = filenameInfo.filename;
                    extractedSize = filenameInfo.size || link.size;
                    console.log(`[MoviesDrive] Extracted filename: ${extractedFilename}`);
                  }
                } catch (err) {
                  console.log(`[MoviesDrive] Filename extraction failed: ${err.message}`);
                }
              }
            }
          } catch (err) {
            console.log(`[MoviesDrive] Failed to upgrade mdrive archive link ${link.url}: ${err.message}`);
          }
        }

        const resolution = getResolutionFromName(link.quality || link.title || '');
        let resolutionLabel = resolution === '2160p' ? '4k' : resolution;
        if (!['4k', '1080p', '720p', '480p'].includes(resolutionLabel)) {
          resolutionLabel = 'other';
        }

        const languages = link.languages && link.languages.length
          ? link.languages
          : detectLanguagesFromSources([extractedFilename, link.quality, link.title, targetUrl]);
        const langFlags = renderLanguageFlags(languages);

        // Use extracted filename if available, otherwise fall back to original
        const displayTitle = extractedFilename || link.displayTitle || link.title || 'MoviesDrive Stream';
        const displaySize = extractedSize || link.size || 'Unknown';

        return {
          name: `[HS+] Sootio\n${resolutionLabel}`,
          title: `${displayTitle}${langFlags}\n💾 ${displaySize} | MoviesDrive`,
          url: targetUrl, // Host link or MDrive page URL - will be resolved on click
          needsResolution: true, // Flag for lazy resolution
          size: displaySize,
          resolution: resolutionLabel,
          behaviorHints: (() => {
            const filename = (extractedFilename || link.displayTitle || link.title || link.quality || '').trim();
            const hints = {
              bingeGroup: 'sootio-moviesdrive',
              notWebReady: true
            };
            if (filename) {
              hints.filename = filename;
            }
            return hints;
          })()
        };
      }))).filter(Boolean);

      console.log(`[MoviesDrive] Returning ${previewStreams.length} preview streams (lazy-load mode)`);
      return previewStreams;
    }

    // LEGACY MODE: Full HubCloud extraction (slow but thorough)
    console.log(`[MoviesDrive] Lazy-load disabled: extracting all HubCloud links (legacy mode)`);
    const limitedLinks = moviePageLinks;
    console.log(`[MoviesDrive] Processing ${limitedLinks.length} quality variants...`);

    const streamPromises = limitedLinks.map(async (link) => {
      try {
        const mdriveLinks = await extractMDriveLinks(link.url);

        // For TV episodes, pick the episode-indexed host link; otherwise process all
        let linksToProcess = mdriveLinks;
        if (mediaType === 'tv' && episode) {
          const picked = selectHostLinkForEpisode(
            mdriveLinks,
            episode,
            { singleEpisodePage: /single\s+episode/i.test(link.quality || link.title || '') }
          );
          linksToProcess = picked ? [picked] : mdriveLinks;
        }

        // Process hosting links (hubcloud AND gdflix) in parallel
        // GDFlix links are also compatible with extractHubCloudLinks
        console.log(`[MoviesDrive] Processing ${linksToProcess.length} hosting links (HubCloud + GDFlix)`);

        const hubcloudPromises = linksToProcess
          .map(async (mdriveLink) => {
            try {
              const linkType = mdriveLink.type === 'gdflix' ? 'GDFlix' : (mdriveLink.type === 'filesdl' ? 'FilesDL' : 'HubCloud');
              console.log(`[MoviesDrive] Extracting from ${linkType}: ${mdriveLink.url}`);

              // Fast-path for direct FilesDL/cloud links: validate and return as-is
              if (mdriveLink.type === 'filesdl') {
                const validation = await validateSeekableUrl(mdriveLink.url, { requirePartialContent: true, timeout: 4000 });
                if (!validation.isValid) {
                  console.log(`[MoviesDrive] Skipping non-seekable FilesDL link (${validation.statusCode || 'unknown'}): ${mdriveLink.url}`);
                  return [];
                }
                const sizeMatch = mdriveLink.title?.match(/\[([0-9.]+\s*(?:GB|MB))\]/i);
                const size = sizeMatch ? sizeMatch[1].toUpperCase() : (validation.contentLength ? formatSize(validation.contentLength) : 'Unknown');
                const resolution = getResolutionFromName(mdriveLink.title || '');
                let resolutionLabel = resolution === '2160p' ? '4k' : resolution;
                if (!['4k', '1080p', '720p', '480p'].includes(resolutionLabel)) {
                  resolutionLabel = 'other';
                }
                const languages = detectLanguagesFromSources([mdriveLink.title, mdriveLink.quality, mdriveLink.url, mediaInfo.title]);
                const langFlags = renderLanguageFlags(languages);
                const formattedTitle = `${mdriveLink.title || mediaInfo.title}${langFlags}\n💾 ${size || 'Unknown'} | MoviesDrive`;
                const filename = (mdriveLink.title || mediaInfo.title || '').trim();
                return [{
                  name: `[HS+] Sootio\n${resolutionLabel}`,
                  title: formattedTitle,
                  url: encodeUrlForStreaming(mdriveLink.url),
                  behaviorHints: (() => {
                    const hints = {
                      bingeGroup: 'sootio-moviesdrive',
                      notWebReady: true
                    };
                    if (filename) {
                      hints.filename = filename;
                    }
                    return hints;
                  })()
                }];
              }

              const hubcloudStreams = await extractHubCloudLinks(mdriveLink.url, 'MoviesDrive');

              // Filter for ONLY PixelDrain and FSL servers
              const filteredStreams = hubcloudStreams.filter(stream => {
                const streamName = (stream.name || '').toLowerCase();
                const streamUrl = (stream.url || '').toLowerCase();

                const isPixelDrain = streamName.includes('pixelserver') ||
                                     streamName.includes('pixeldrain') ||
                                     streamUrl.includes('pixeldrain');
                const isFSL = streamName.includes('fsl server');

                const isExcluded = streamName.includes('10gbps') ||
                                  streamName.includes('s3 server') ||
                                  streamName.includes('buzzserver') ||
                                  streamName.includes('workers.dev') ||
                                  streamName.includes('hubcdn.fans');

                return !isExcluded && (isPixelDrain || isFSL);
              });

              // Format streams
              return filteredStreams.map(stream => {
                let rawTitle = stream.title || '';

                // Clean up title: remove all moviesdrives branding variations
                rawTitle = rawTitle
                  .replace(/\[\[moviesdrives?\.com\s*\]\]\s*/gi, '')  // Remove [[moviesdrives.com ]]
                  .replace(/^moviesdrives?\.co[-\s]*/gi, '')  // Remove Moviesdrives.co- at start
                  .replace(/[-\s]*\[moviesdrives?\.(?:co|com|eu|oc)\]\.mkv$/gi, '.mkv')  // Remove -[moviesdrives.co].mkv at end
                  .replace(/[-\s]*\[moviesdrives?\.(?:co|com|eu|oc)\]$/gi, '')  // Remove -[moviesdrives.co] at end
                  .replace(/[-\s]+moviesdrives?\.(?:co|com|eu|oc)\.mkv$/gi, '.mkv')  // Remove - moviesdrives.com.mkv at end
                  .replace(/[-\s]+moviesdrives?\.(?:co|com|eu|oc)$/gi, '')  // Remove - moviesdrives.com at end
                  .trim();

                // Extract resolution from cleaned title (must be done AFTER cleaning)
                const resolution = getResolutionFromName(rawTitle);

                let resolutionLabel = resolution === '2160p' ? '4k' : resolution;
                if (!['4k', '1080p', '720p', '480p'].includes(resolutionLabel)) {
                  resolutionLabel = 'other';
                }

                const languages = detectLanguagesSafely(rawTitle);
                const langFlags = renderLanguageFlags(languages);
                const size = stream.size || 'Unknown';

                // Convert PixelDrain URLs from /u/ID to /api/file/ID?download for direct download
                let finalUrl = stream.url;
                if (finalUrl && finalUrl.includes('pixeldrain')) {
                  const pixelMatch = finalUrl.match(/pixeldrain\.[^/]+\/u\/([a-zA-Z0-9]+)/);
                  if (pixelMatch) {
                    const fileId = pixelMatch[1];
                    finalUrl = `https://pixeldrain.dev/api/file/${fileId}?download`;
                    console.log(`[MoviesDrive] Converted PixelDrain URL: ${stream.url} -> ${finalUrl}`);
                  }
                }

                return {
                  name: `[HS+] Sootio\n${resolutionLabel}`,
                  title: `${rawTitle}${langFlags}\n💾 ${size} | MoviesDrive`,
                  url: finalUrl,
                  behaviorHints: (() => {
                    const hints = {
                      bingeGroup: 'sootio-moviesdrive',
                      notWebReady: true
                    };
                    if (rawTitle) {
                      hints.filename = rawTitle.trim();
                    }
                    return hints;
                  })()
                };
              });
            } catch (error) {
              console.error(`[MoviesDrive] HubCloud extraction failed:`, error.message);
              return [];
            }
          });

        const results = await Promise.all(hubcloudPromises);
        return results.flat();
      } catch (error) {
        console.error(`[MoviesDrive] MDrive link extraction failed:`, error.message);
        return [];
      }
    });

    const allStreamsNested = await Promise.all(streamPromises);
    const allStreams = allStreamsNested.flat();

    // Sort by resolution first (4K -> 1080p -> 720p -> 480p -> other), then by size within each resolution
    const parseSizeInBytes = (sizeStr) => {
      if (!sizeStr || sizeStr === 'Unknown') return 0;
      const match = sizeStr.match(/([\d.]+)\s*(GB|MB|KB|TB)/i);
      if (!match) return 0;

      const value = parseFloat(match[1]);
      const unit = match[2].toUpperCase();

      const multipliers = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
      return value * (multipliers[unit] || 0);
    };

    const resolutionOrder = { '4k': 1, '1080p': 2, '720p': 3, '480p': 4, 'other': 5 };

    allStreams.sort((a, b) => {
      // Extract resolution from name (format: "[HS+] Sootio\n{resolution}")
      const resA = a.name ? a.name.split('\n')[1] || 'other' : 'other';
      const resB = b.name ? b.name.split('\n')[1] || 'other' : 'other';

      const orderA = resolutionOrder[resA] || 5;
      const orderB = resolutionOrder[resB] || 5;

      // First sort by resolution
      if (orderA !== orderB) {
        return orderA - orderB;
      }

      // Within same resolution, sort by size (big to small)
      const sizeA = a.title ? a.title.match(/💾\s*([^|]+)/)?.[1]?.trim() : '';
      const sizeB = b.title ? b.title.match(/💾\s*([^|]+)/)?.[1]?.trim() : '';
      return parseSizeInBytes(sizeB) - parseSizeInBytes(sizeA); // Descending order (big to small)
    });

    // Filter out archive files (zip, rar, 7z, pack) - we only want direct video files
    const beforeArchiveFilter = allStreams.length;
    let filteredStreams = allStreams.filter(stream => {
      const title = (stream.title || '').toLowerCase();
      const url = (stream.url || '').toLowerCase();
      const isArchive = /\.(zip|rar|7z|tar|gz|pack)(\s|$|\|)/i.test(title) ||
                        /\.(zip|rar|7z|tar|gz|pack)(\?|$)/i.test(url);
      if (isArchive) {
        console.log(`[MoviesDrive] Filtering out archive file: ${stream.title}`);
        return false;
      }
      return true;
    });

    console.log(`[MoviesDrive] Returning ${filteredStreams.length} streams (filtered ${beforeArchiveFilter - filteredStreams.length} archive files, sorted by resolution, then size)`);
    return filteredStreams;

  } catch (error) {
    console.error(`[MoviesDrive] Error:`, error.message);
    return [];
  }
}

export { getMoviesDriveStreams };
