import * as cheerio from 'cheerio';
import { URL, URLSearchParams } from 'url';
import FormData from 'form-data';

// Shared helpers for resolving driveseed/driveleech style redirects and extracting final download URLs.
// This util is proxy-agnostic: providers must inject their own network functions and validators.
// All functions accept injected dependencies so proxy, cookies, and caching stay in provider code.

// --- Default extractors (can be used directly or replaced by providers) ---

async function defaultTryInstantDownload($, { post, get, origin, validate, log = console }) {
  // Look for "Instant Download" text or btn-danger class
  const allInstant = $('a:contains("Instant Download"), a:contains("Instant"), a.btn-danger:contains("Download")');
  log.log(`[LinkResolver] defaultTryInstantDownload: found ${allInstant.length} matching anchor(s).`);
  
  // First check if the page URL has a 'url' parameter which might be the direct download link
  const currentUrl = origin; // origin in this context is likely the current page URL
  try {
    const urlObj = new URL(currentUrl);
    const urlParam = urlObj.searchParams.get('url');
    if (urlParam) {
      // Check if it's a valid direct download link
      if (urlParam.includes('googleusercontent.com')) {
        log.log('[LinkResolver] defaultTryInstantDownload: googleusercontent link found - skipping');
        return null;
      }
      if (urlParam.includes('workers.dev')) {
        log.log('[LinkResolver] defaultTryInstantDownload: found direct link in URL parameter');
        return urlParam;
      }
    }
  } catch (error) {
    // If URL parsing fails, continue with normal processing
    log.log(`[LinkResolver] defaultTryInstantDownload: URL parsing failed: ${error.message}`);
  }
  
  if (!allInstant.length) {
    log.log('[LinkResolver] defaultTryInstantDownload: no href on element.');
    return null;
  }

  // Iterate over all instant download buttons until one works
  for (let i = 0; i < allInstant.length; i++) {
    const instantLink = allInstant.eq(i).attr('href');
    if (!instantLink) continue;
    try {
    const urlObj = new URL(instantLink, origin);
    const keys = new URLSearchParams(urlObj.search).get('url');
    if (keys) {
      // Handle API-based download links
      const apiUrl = `${urlObj.origin}/api`;
      const formData = new FormData();
      formData.append('keys', keys);

      const resp = await post(apiUrl, formData, {
        headers: { ...formData.getHeaders(), 'x-token': urlObj.hostname }
      });

      if (resp && resp.data && resp.data.url) {
        let finalUrl = resp.data.url;
        if (typeof finalUrl === 'string' && finalUrl.includes('workers.dev')) {
          const parts = finalUrl.split('/');
          const fn = parts[parts.length - 1];
          parts[parts.length - 1] = fn.replace(/ /g, '%20');
          finalUrl = parts.join('/');
        }
        log.log('[LinkResolver] defaultTryInstantDownload: extracted API url');
        return finalUrl;
      }
    } else if (instantLink.includes('googleusercontent.com')) {
      log.log('[LinkResolver] defaultTryInstantDownload: googleusercontent link found - skipping');
      continue;
    } else if (instantLink.includes('video-leech.pro') || instantLink.includes('cdn.video-leech.pro')) {
      // Follow redirect and attempt to extract a non-google direct link
      if (!get) return null;
      try {
        const resp = await get(instantLink, { maxRedirects: 5, timeout: 15000 });
        const finalUrl = resp?.request?.res?.responseUrl;
        if (finalUrl) {
          if (finalUrl.includes('googleusercontent.com')) {
            // cdn.video-leech.pro is a known streaming CDN that redirects to googleusercontent.
            // Video players handle redirects natively, so return the CDN link directly.
            // Validation would also follow the redirect and fail the 206 check against googleusercontent.
            log.log('[LinkResolver] defaultTryInstantDownload: redirect landed on googleusercontent - returning cdn.video-leech.pro link directly (player handles redirects)');
            return instantLink;
          } else {
          const directHostHints = ['workers.dev', 'hubcdn.fans', 'r2.dev', 'pixeldrain', 'driveleech.net/d/', 'driveseed.org/d/'];
          if (directHostHints.some(hint => finalUrl.includes(hint))) {
            log.log('[LinkResolver] defaultTryInstantDownload: redirect produced direct link');
            return finalUrl;
          }
          if (validate) {
            try {
              const ok = await validate(finalUrl);
              if (ok) {
                log.log('[LinkResolver] defaultTryInstantDownload: redirect validated as direct link');
                return finalUrl;
              }
            } catch (e) {
              log.log(`[LinkResolver] defaultTryInstantDownload: validation error: ${e.message}`);
            }
          }
          const directFromParam = extractUrlParam(finalUrl, finalUrl);
          if (directFromParam && !directFromParam.includes('googleusercontent.com')) {
            log.log('[LinkResolver] defaultTryInstantDownload: extracted direct link from redirect parameter');
            return directFromParam;
          }
          }
        }
        if (resp?.data) {
          const html = resp.data;
          const directFromHtml = extractDirectLinkFromTokenPage(html, finalUrl || instantLink, log);
          if (directFromHtml) {
            log.log('[LinkResolver] defaultTryInstantDownload: extracted direct link from HTML');
            return directFromHtml;
          }
        }
      } catch (err) {
        log.log(`[LinkResolver] defaultTryInstantDownload video-leech follow error: ${err.message}`);
      }
      continue;
    } else if (instantLink.includes('workers.dev') || instantLink.includes('cdn.video-leech.pro')) {
      log.log('[LinkResolver] defaultTryInstantDownload: found direct link');
      return instantLink;
    }
    } catch (e) {
      log.log(`[LinkResolver] defaultTryInstantDownload error: ${e.message}`);
      continue;
    }
  }
  return null;
}

const TOKEN_DIRECT_HOST_HINTS = [
  'workers.dev',
  'hubcdn.fans',
  'r2.dev',
  'pixeldrain',
  'driveleech.net/d/',
  'driveseed.org/d/'
];

const TOKEN_WRAPPER_HOST_HINTS = [
  'video-leech.pro',
  'cdn.video-leech.pro',
  'video-seed.pro',
  'driveleech.net/file/',
  'driveseed.org/file/',
  '/zfile/'
];

const TOKEN_DIRECT_VIDEO_EXTENSIONS = [
  '.mp4',
  '.mkv',
  '.avi',
  '.webm',
  '.mov',
  '.m4v',
  '.ts',
  '.m3u8'
];

function maybeDecodeBase64Url(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9+/=]{20,}$/.test(trimmed)) return null;
  try {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
    if (decoded.startsWith('http')) return decoded;
  } catch {
    // ignore decode failures
  }
  return null;
}

function extractUrlParam(value, baseUrl) {
  if (!value || typeof value !== 'string') return null;
  try {
    const urlObj = new URL(value, baseUrl);
    const rawParam = urlObj.searchParams.get('url');
    if (!rawParam) return null;
    try {
      return decodeURIComponent(rawParam);
    } catch {
      return rawParam;
    }
  } catch {
    return null;
  }
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

function normalizeUrlCandidate(candidate, baseUrl) {
  if (!candidate || typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  if (!trimmed) return null;
  const decoded = trimmed.replace(/&amp;/g, '&');
  try {
    return new URL(decoded, baseUrl).href;
  } catch {
    return null;
  }
}

function expandCandidate(value, baseUrl) {
  const extras = [];
  const urlParam = extractUrlParam(value, baseUrl);
  if (urlParam) extras.push(urlParam);
  const decodedBase64 = maybeDecodeBase64Url(value);
  if (decodedBase64) extras.push(decodedBase64);
  return extras;
}

function isLikelyDirectTokenUrl(url) {
  const lower = url.toLowerCase();
  if (TOKEN_WRAPPER_HOST_HINTS.some(hint => lower.includes(hint))) return false;
  if (TOKEN_DIRECT_HOST_HINTS.some(hint => lower.includes(hint))) return true;
  const ext = getFileExtension(lower);
  return TOKEN_DIRECT_VIDEO_EXTENSIONS.includes(ext);
}

function extractDirectLinkFromTokenPage(html, baseUrl, log = console) {
  if (!html) return null;

  const candidates = [];
  const pushCandidate = (value) => {
    if (value && typeof value === 'string') {
      candidates.push(value);
      const extras = expandCandidate(value, baseUrl);
      extras.forEach(extra => candidates.push(extra));
    }
  };

  try {
    const urlObj = new URL(baseUrl);
    const urlParam = urlObj.searchParams.get('url');
    if (urlParam) {
      pushCandidate(urlParam);
    }
  } catch {
    // ignore base URL parsing errors
  }

  try {
    const $ = cheerio.load(html);
    const downloadBtn = $('#downloadBtn');
    if (downloadBtn.length) {
      pushCandidate(downloadBtn.attr('href'));
      pushCandidate(downloadBtn.attr('data-href'));
      pushCandidate(downloadBtn.attr('data-url'));
      pushCandidate(downloadBtn.attr('data-link'));
      pushCandidate(downloadBtn.attr('data-download'));
    }

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      const text = ($(el).text() || '').toLowerCase();
      if (!href) return;
      if (text.includes('download') || text.includes('direct') || href.toLowerCase().includes('download')) {
        pushCandidate(href);
      }
    });

    const metaRefresh = $('meta[http-equiv="refresh"]').attr('content') || '';
    const metaMatch = metaRefresh.match(/url=([^;]+)/i);
    if (metaMatch && metaMatch[1]) {
      pushCandidate(metaMatch[1]);
    }
  } catch (err) {
    log.log(`[LinkResolver] Token page parse error: ${err.message}`);
  }

  if (typeof html === 'string') {
    const scriptPatterns = [
      /window\.location\.replace\(['"]([^'"]+)['"]\)/i,
      /window\.location\.href\s*=\s*['"]([^'"]+)['"]/i,
      /window\.location\s*=\s*['"]([^'"]+)['"]/i,
      /location\.href\s*=\s*['"]([^'"]+)['"]/i,
      /window\.open\(['"]([^'"]+)['"]/i,
      /downloadBtn\.href\s*=\s*['"]([^'"]+)['"]/i,
      /downloadBtn\.setAttribute\(\s*['"]href['"]\s*,\s*['"]([^'"]+)['"]\s*\)/i,
      /download(?:Url|URL|Link|Href)\s*[:=]\s*['"]([^'"]+)['"]/i
    ];
    for (const pattern of scriptPatterns) {
      const match = html.match(pattern);
      if (match && match[1]) {
        pushCandidate(match[1]);
      }
    }

    const atobMatches = html.matchAll(/atob\(['"]([^'"]+)['"]\)/gi);
    for (const match of atobMatches) {
      if (match && match[1]) {
        const decoded = maybeDecodeBase64Url(match[1]);
        if (decoded) pushCandidate(decoded);
      }
    }

    const base64Matches = html.matchAll(/Base64\.decode\(['"]([^'"]+)['"]\)/gi);
    for (const match of base64Matches) {
      if (match && match[1]) {
        const decoded = maybeDecodeBase64Url(match[1]);
        if (decoded) pushCandidate(decoded);
      }
    }

    const urlMatches = html.match(/https?:\/\/[^"'\\s]+/g) || [];
    urlMatches.forEach(pushCandidate);
  }

  const seen = new Set();
  for (const candidate of candidates) {
    const normalized = normalizeUrlCandidate(candidate, baseUrl);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    if (normalized.includes('googleusercontent.com')) continue;
    if (!isLikelyDirectTokenUrl(normalized)) continue;
    log.log(`[LinkResolver] Token page direct link extracted: ${normalized.substring(0, 100)}...`);
    return normalized;
  }

  return null;
}

async function defaultTryResumeCloud($, { origin, get, post, validate, log = console, pollOptions }) {
  // Helper: prefer workers.dev ::key links (these support 206 and are stable)
  const pickWorkersLink = async (ctx) => {
    const workersLinks = ctx('a[href*="workers.dev"]');
    for (let i = 0; i < workersLinks.length; i++) {
      const href = ctx(workersLinks[i]).attr('href');
      if (href && href.includes('::')) {
        log.log(`[LinkResolver] Found workers.dev link with ::key format: ${href.substring(0, 100)}...`);
        if (validate) {
          try {
            const ok = await validate(href);
            if (ok) return href;
            log.log('[LinkResolver] Validation failed, but keeping workers.dev link');
            return href;
          } catch (e) {
            log.log(`[LinkResolver] Validation error, keeping workers.dev link: ${e.message}`);
            return href;
          }
        }
        return href;
      }
    }
    return null;
  };

  // Look for "Resume Cloud" text, /zfile/ link, or btn-warning class (DriveSeed styles)
  const resumeAnchor = $('a').filter((_, el) => {
    const text = ($(el).text() || '').toLowerCase();
    const href = ($(el).attr('href') || '').toLowerCase();
    return text.includes('resume cloud') ||
      text.includes('cloud resume') ||
      text.includes('resume worker') ||
      href.includes('/zfile/') ||
      $(el).hasClass('btn-warning');
  });
  log.log(`[LinkResolver] defaultTryResumeCloud: found ${resumeAnchor.length} candidate button(s).`);

  // If no explicit resume button, still allow direct workers.dev links on the current page
  if (resumeAnchor.length === 0) {
    const workersDirect = await pickWorkersLink($);
    if (workersDirect) return workersDirect;
  }

  if (resumeAnchor.length === 0) {
    // For /zfile/ URLs in the page origin, prioritize extracting direct workers.dev links with ::key format
    if (origin && origin.includes('/zfile/')) {
      log.log('[LinkResolver] Detected /zfile/ URL in origin, looking for direct workers.dev links with ::key format');

      // Look for workers.dev links that contain the ::key separator (these are the working format)
      const workersLinks = $('a[href*="workers.dev"]');
      for (let i = 0; i < workersLinks.length; i++) {
        const href = $(workersLinks[i]).attr('href');
        if (href && href.includes('::')) {
          log.log(`[LinkResolver] Found workers.dev link with ::key format: ${href.substring(0, 100)}...`);
          const ok = validate ? await validate(href) : true;
          if (ok) return href;
        }
      }

      log.log('[LinkResolver] No direct workers.dev links with ::key found');
    }

    // Try direct links on page - add more patterns to catch zfile links AND video-leech links
    const direct = $('a[href*="workers.dev"], a[href*="workerseed"], a[href*="worker"], a[href*="driveleech.net/d/"], a[href*="driveseed.org/d/"], a[href*="/zfile/"], a[href*="video-leech.pro"], a[href*="cdn.video-leech.pro"]').attr('href');
    log.log(`[LinkResolver] defaultTryResumeCloud: checking for direct links, found: ${direct ? direct.substring(0, 100) : 'none'}`);
    if (direct) {
      // Check if it's a video-seed.pro link with a 'url' parameter
      if (direct.includes('video-seed.pro') && direct.includes('?url=')) {
        try {
          const urlObj = new URL(direct);
          const urlParam = urlObj.searchParams.get('url');
          if (urlParam) {
            log.log('[LinkResolver] Extracted direct URL from video-seed.pro parameter');
            return urlParam;
          }
        } catch (e) {
          // If URL parsing fails, proceed with validation of original link
          log.log(`[LinkResolver] URL parsing failed for video-seed.pro: ${e.message}`);
        }
      }
      
      // Handle video-leech.pro links that redirect to video-seed.pro - either extract URL parameter or parse HTML
      if (direct.includes('video-leech.pro') || direct.includes('cdn.video-leech.pro')) {
        try {
          log.log(`[LinkResolver] Processing video-leech link to extract final URL: ${direct}`);
          
          // Make a request to follow redirect and get the final page content
          const response = await get(direct, { 
            maxRedirects: 5,  // Allow redirects to reach the final page
            headers: {
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 15000
          });
          
          // If the final URL contains ?url= parameter, extract it
          if (response && response.request && response.request.res && response.request.res.responseUrl) {
            const finalUrl = response.request.res.responseUrl;
            if (finalUrl.includes('video-seed.pro') && finalUrl.includes('?url=')) {
              try {
                const urlObj = new URL(finalUrl);
                const urlParam = urlObj.searchParams.get('url');
                if (urlParam && urlParam.includes('googleusercontent.com')) {
                  log.log('[LinkResolver] Extracted Google URL from redirected video-seed.pro parameter');
                  return urlParam;
                }
              } catch (urlParseError) {
                log.log(`[LinkResolver] URL parsing failed for redirected video-seed.pro: ${urlParseError.message}`);
              }
            }
          }
          
          // If we got HTML content, try to extract the Google URL from the page
          if (response && response.data) {
            const html = response.data;
            // Look for the download button with Google URL in the HTML
            const downloadButtonMatch = html.match(/id=["']downloadBtn["'][^>]*href=["']([^"']*)["']/i);
            if (downloadButtonMatch && downloadButtonMatch[1] && downloadButtonMatch[1].includes('googleusercontent.com')) {
              log.log('[LinkResolver] Extracted Google URL from video-seed page HTML - skipping (googleusercontent filtered)');
            }

            // Alternative: Look for any Google URL in the HTML
            const googleUrlMatch = html.match(/https:\/\/video-downloads\.googleusercontent\.com[^\s"'\]]+/i);
            if (googleUrlMatch) {
              log.log('[LinkResolver] Found Google URL in video-seed page HTML - skipping (googleusercontent filtered)');
            }
          }
        } catch (redirectError) {
          log.log(`[LinkResolver] Video-leech redirect processing failed: ${redirectError.message}`);
          // If redirect processing fails, continue with validation of original link
        }
      }
      
      if (direct.includes('googleusercontent.com')) {
        log.log('[LinkResolver] defaultTryResumeCloud: googleusercontent direct link found - skipping');
      } else {
        if (validate) {
          try {
            const ok = await validate(direct);
            if (!ok) log.log('[LinkResolver] Validation failed, keeping direct link');
          } catch (e) {
            log.log(`[LinkResolver] Validation error, keeping direct link: ${e.message}`);
          }
        }
        return direct;
      }
    }
    return null;
  }

  // Iterate through all candidate buttons until one yields a usable link
  for (let i = 0; i < resumeAnchor.length; i++) {
    const href = resumeAnchor.eq(i).attr('href');
    if (!href) continue;

    try {
      const resumeUrl = href.startsWith('http') ? href : new URL(href, origin).href;
      // Fetch the zfile page (or whatever the resume link points to)
      const res = await get(resumeUrl, { maxRedirects: 10 });
      const z$ = cheerio.load(res.data);

      // First choice: workers.dev ::key
      const workersLink = await pickWorkersLink(z$);
      if (workersLink) return workersLink;

      // DriveSeed zfile pages require a POST request to generate the cloud link
      // Check if this is a zfile page by looking for the generate function
      const pageHtml = res.data;
      const keyMatch = pageHtml.match(/formData\.append\("key",\s*"([^"]+)"\)/);
      if (keyMatch && resumeUrl.includes('/zfile/') && post) {
        log.log('[LinkResolver] Detected DriveSeed zfile page, attempting POST to generate cloud link');
        const key = keyMatch[1];

        try {
          // Make POST request to generate the cloud link
          const urlObj = new URL(resumeUrl);
          const formData = new FormData();
          formData.append('action', 'cloud');
          formData.append('key', key);
          formData.append('action_token', '');

          const postRes = await post(resumeUrl, formData, {
            headers: {
              ...formData.getHeaders(),
              'x-token': urlObj.hostname,
              'Referer': resumeUrl,
              'Origin': urlObj.origin
            }
          });

          // Parse JSON response
          let postData;
          if (typeof postRes.data === 'string') {
            try {
              postData = JSON.parse(postRes.data);
            } catch (e) {
              postData = postRes.data;
            }
          } else {
            postData = postRes.data;
          }

          if (postData && (postData.url || postData.visit_url)) {
            const rawTokenUrl = postData.visit_url || postData.url;
            const tokenUrl = rawTokenUrl.startsWith('http')
              ? rawTokenUrl
              : new URL(rawTokenUrl, urlObj.origin).href;
            log.log(`[LinkResolver] Got token URL from DriveSeed: ${tokenUrl.substring(0, 100)}...`);

            // Fetch the token URL page to look for workers.dev links
            const tokenRes = await get(tokenUrl, { maxRedirects: 10 });
            const t$ = cheerio.load(tokenRes.data);

            // Check for workers.dev links on the token page
            const tokenWorkersLink = await pickWorkersLink(t$);
            if (tokenWorkersLink) return tokenWorkersLink;

            // Attempt to extract direct link from token page (download button / JS redirect)
            const tokenDirectLink = extractDirectLinkFromTokenPage(tokenRes.data, tokenUrl, log);
            if (tokenDirectLink) return tokenDirectLink;

            const pollAttemptsRaw = Number.isFinite(pollOptions?.attempts)
              ? pollOptions.attempts
              : parseInt(process.env.DRIVESEED_TOKEN_POLL_ATTEMPTS || process.env.UHDMOVIES_ZFILE_POLL_ATTEMPTS || '5', 10);
            const pollDelayRaw = Number.isFinite(pollOptions?.delayMs)
              ? pollOptions.delayMs
              : parseInt(process.env.DRIVESEED_TOKEN_POLL_DELAY_MS || process.env.UHDMOVIES_ZFILE_POLL_DELAY_MS || '3000', 10);
            const pollAttempts = Number.isFinite(pollAttemptsRaw) ? Math.max(0, pollAttemptsRaw) : 2;
            const pollDelayMs = Number.isFinite(pollDelayRaw) ? Math.max(250, pollDelayRaw) : 1500;

            for (let attempt = 1; attempt <= pollAttempts; attempt++) {
              await new Promise(resolve => setTimeout(resolve, pollDelayMs));
              log.log(`[LinkResolver] Polling DriveSeed token page for direct link (${attempt}/${pollAttempts})`);
              const pollRes = await get(tokenUrl, { maxRedirects: 10 });
              const poll$ = cheerio.load(pollRes.data);
              const pollWorkersLink = await pickWorkersLink(poll$);
              if (pollWorkersLink) return pollWorkersLink;
              const pollDirectLink = extractDirectLinkFromTokenPage(pollRes.data, tokenUrl, log);
              if (pollDirectLink) return pollDirectLink;
            }

            // If no direct link yet, the file may still be processing
            log.log('[LinkResolver] DriveSeed zfile: no direct link found on token page (file may still be processing)');
          }
        } catch (postError) {
          log.log(`[LinkResolver] DriveSeed zfile POST error: ${postError.message}`);
        }
      }

      // Fallback: any non-google direct link on the zfile page
      const fallback = z$('a[href*="workers.dev"], a[href*="driveleech.net/d/"], a[href*="driveseed.org/d/"], a[href*="video-leech.pro"], a[href*="cdn.video-leech.pro"]').attr('href');
      if (fallback && !fallback.includes('googleusercontent.com')) {
        if (validate) {
          try {
            const ok = await validate(fallback);
            if (!ok) log.log('[LinkResolver] Validation failed, keeping fallback link');
          } catch (e) {
            log.log(`[LinkResolver] Validation error, keeping fallback link: ${e.message}`);
          }
        }
        return fallback;
      }
    } catch (e) {
      log.log(`[LinkResolver] defaultTryResumeCloud error: ${e.message}`);
      continue;
    }
  }
  return null;
}

// --- Core steps ---

async function followRedirectToFilePage({ redirectUrl, get, log = console }) {
  const res = await get(redirectUrl, { maxRedirects: 10 });
  let finalFilePageUrl = res?.request?.res?.responseUrl || redirectUrl;
  let $ = cheerio.load(res.data);
  const scriptContent = $('script').html() || '';

  // Try multiple JavaScript redirect patterns
  const patterns = [
    /window\.location\.replace\("([^"]+)"\)/,
    /window\.location\.href\s*=\s*"([^"]+)"/,
    /window\.location\s*=\s*"([^"]+)"/,
    /location\.href\s*=\s*"([^"]+)"/
  ];

  let match = null;
  for (const pattern of patterns) {
    match = scriptContent.match(pattern);
    if (match && match[1]) break;
  }

  if (match && match[1]) {
    const base = new URL(redirectUrl).origin;
    finalFilePageUrl = new URL(match[1], base).href;
    log.log(`[LinkResolver] Redirect resolved to final file page: ${finalFilePageUrl}`);
    const finalRes = await get(finalFilePageUrl, { maxRedirects: 10 });
    $ = cheerio.load(finalRes.data);
  }
  return { $, finalFilePageUrl };
}

async function extractFinalDownloadFromFilePage($, {
  origin,
  get,
  post,
  validate,
  log = console,
  tryResumeCloud = defaultTryResumeCloud,
  tryInstantDownload = defaultTryInstantDownload,
  pollOptions
}) {
  // Require either a Resume Cloud indicator or a workers.dev ::key link on the page
  const resumeCloudPresent = $('a').filter((_, el) => {
    const text = ($(el).text() || '').toLowerCase();
    const href = ($(el).attr('href') || '').toLowerCase();
    return text.includes('resume cloud') || text.includes('cloud resume') || href.includes('/zfile/') || $(el).hasClass('btn-warning');
  }).length > 0;
  const workersKeyPresent = $('a[href*="workers.dev"]').filter((_, el) => {
    const href = ($(el).attr('href') || '');
    return href.includes('::');
  }).length > 0;

  if (!resumeCloudPresent && !workersKeyPresent) {
    log.log('[LinkResolver] Missing "Resume Cloud" button or workers.dev ::key on file page – skipping link');
    return null;
  }

  // Try known methods
  const methods = [
    async () => await tryResumeCloud($, { origin, get, post, validate, log, pollOptions }),
    async () => await tryInstantDownload($, { post, get, origin, log })
  ];

  for (const fn of methods) {
    try {
      const url = await fn();
      if (url && !url.includes('googleusercontent.com')) {
        if (validate) {
          try {
            const ok = await validate(url);
            if (!ok) log.log('[LinkResolver] Validation failed, keeping URL because Resume Cloud is present');
          } catch (e) {
            log.log(`[LinkResolver] Validation error, keeping URL: ${e.message}`);
          }
        }
        return url;
      }
    } catch (e) {
      log.log(`[LinkResolver] method error: ${e.message}`);
    }
  }

  // Last resort: scan for plausible direct links
  // Prioritize workers.dev links with ::key format (more reliable)
  const workersLinks = $('a[href*="workers.dev"]');
  for (let i = 0; i < workersLinks.length; i++) {
    const href = $(workersLinks[i]).attr('href');
    if (href && href.includes('::')) {
      log.log(`[LinkResolver] Last resort: Found workers.dev link with ::key format: ${href.substring(0, 100)}...`);
      if (href.includes('googleusercontent.com')) continue;
      if (validate) {
        try {
          const ok = await validate(href);
          if (!ok) log.log('[LinkResolver] Validation failed on last resort link, keeping anyway');
        } catch (e) {
          log.log(`[LinkResolver] Validation error on last resort link, keeping anyway: ${e.message}`);
        }
      }
      return href;
    }
  }

  // If no ::key format found, try any direct link
  let direct = $('a[href*="workers.dev"], a[href*="workerseed"], a[href*="worker"], a[href*="driveleech.net/d/"], a[href*="driveseed.org/d/"]').attr('href');
  if (direct && !direct.includes('googleusercontent.com')) {
    if (validate) {
      try {
        const ok = await validate(direct);
        if (!ok) log.log('[LinkResolver] Validation failed on direct link, keeping anyway');
      } catch (e) {
        log.log(`[LinkResolver] Validation error on direct link, keeping anyway: ${e.message}`);
      }
    }
    return direct;
  }
  return null;
}

// Resolve SID (tech.unblockedgames.world etc.) to intermediate redirect (driveleech/driveseed)
// createSession(jar) must return an axios-like instance with get/post that respects proxy and cookie jar
async function resolveSidToRedirect({ sidUrl, createSession, jar, log = console }) {
  const session = await createSession(jar);
  // Step 0
  const step0 = await session.get(sidUrl);
  let $ = cheerio.load(step0.data);
  const form0 = $('#landing');
  const wp_http = form0.find('input[name="_wp_http"]').val();
  const action0 = form0.attr('action');
  if (!wp_http || !action0) return null;
  // Step 1
  const step1 = await session.post(action0, new URLSearchParams({ '_wp_http': wp_http }), {
    headers: { 'Referer': sidUrl, 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  // Step 2
  $ = cheerio.load(step1.data);
  const form1 = $('#landing');
  const action1 = form1.attr('action');
  const wp_http2 = form1.find('input[name="_wp_http2"]').val();
  const token = form1.find('input[name="token"]').val();
  if (!action1) return null;
  const step2 = await session.post(action1, new URLSearchParams({ '_wp_http2': wp_http2, token }), {
    headers: { 'Referer': step1.request?.res?.responseUrl || sidUrl, 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  // Step 3 - meta refresh
  $ = cheerio.load(step2.data);
  const meta = $('meta[http-equiv="refresh"]').attr('content') || '';
  const m = meta.match(/url=(.*)/i);
  if (!m || !m[1]) return null;
  const origin = new URL(sidUrl).origin;
  const redirectUrl = new URL(m[1].replace(/"/g, '').replace(/'/g, ''), origin).href;
  log.log(`[LinkResolver] SID resolved to redirect: ${redirectUrl}`);
  return redirectUrl;
}

export {
  defaultTryInstantDownload,
  defaultTryResumeCloud,
  followRedirectToFilePage,
  extractFinalDownloadFromFilePage,
  resolveSidToRedirect
};
