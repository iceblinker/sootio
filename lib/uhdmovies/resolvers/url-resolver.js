import * as cheerio from 'cheerio';
import { URL } from 'url';
import { makeRequest, axiosInstance } from '../utils/http.js';
import { validateVideoUrl } from '../utils/validation.js';
import { UHDMOVIES_PROXY_URL, USE_HTTPSTREAMS_PROXY } from '../config/proxy.js';
import { resolveSidToDriveleech } from './sid-resolver.js';
import { followRedirectToFilePage, extractFinalDownloadFromFilePage } from '../../util/linkResolver.js';

// Cache final resolved URLs per SID to avoid repeated heavy work
const resolvedCache = new Map(); // sidUrl -> { url, ts, fileName, size }
const RESOLVED_CACHE_TTL = parseInt(process.env.UHDMOVIES_RESOLVED_CACHE_TTL, 10) || (15 * 60 * 1000); // Increase cache TTL to 15 minutes for better performance

/**
 * Resolve a UHDMovies SID URL to its final direct download link
 * This is called when the user selects a stream, providing lazy resolution
 * Steps: 1) Resolve SID to driveleech URL, 2) Follow redirect to file page, 3) Extract final URL
 * @param {string} sidUrl - The original SID URL that needs resolution
 * @returns {Promise<string|null>} - Final direct streaming URL
 */
export async function resolveUHDMoviesUrl(sidUrl) {
  try {
    console.log('[UHDMOVIES-RESOLVE] Starting resolution for SID URL:', sidUrl.substring(0, 100) + '...');

    const cached = resolvedCache.get(sidUrl);
    const now = Date.now();
    if (cached && cached.url && (now - cached.ts < RESOLVED_CACHE_TTL)) {
      console.log('[UHDMOVIES-RESOLVE] Using cached resolved URL');
      return cached;
    }

    // Add small delay before SID resolution to prevent request flooding
    if (sidUrl.includes('tech.unblockedgames.world') || sidUrl.includes('tech.creativeexpressionsblog.com') || sidUrl.includes('tech.examzculture.in')) {
      await new Promise(resolve => setTimeout(resolve, 500)); // Small delay before SID resolution
    }

    // Step 1: Resolve SID to driveleech URL
    let driveleechUrl = null;
    if (sidUrl.includes('tech.unblockedgames.world') || sidUrl.includes('tech.creativeexpressionsblog.com') || sidUrl.includes('tech.examzculture.in')) {
      console.log('[UHDMOVIES-RESOLVE] Resolving SID to driveleech URL...');
      driveleechUrl = await resolveSidToDriveleech(sidUrl);
    } else if (sidUrl.includes('driveseed.org') || sidUrl.includes('driveleech.net')) {
      // If it's already a driveseed/driveleech link, use it
      driveleechUrl = sidUrl;
      console.log('[UHDMOVIES-RESOLVE] URL is already a driveleech URL');
    }

    if (!driveleechUrl) {
      console.log('[UHDMOVIES-RESOLVE] Failed to resolve SID URL');
      return null;
    }

    console.log('[UHDMOVIES-RESOLVE] Resolved SID to driveleech URL:', driveleechUrl.substring(0, 100) + '...');

    // Step 2: Follow redirect to file page
    const { finalFilePageUrl, $ } = await followRedirectToFilePage({
      redirectUrl: driveleechUrl,
      get: (url, opts) => makeRequest(url, opts),
      log: console
    });
    console.log(`[UHDMOVIES-RESOLVE] Resolved redirect to final file page: ${finalFilePageUrl}`);

    // Extract file metadata (name/size) from the DriveSeed file page
    let fileName = null;
    let fileSize = null;
    try {
      const metaItems = $('li.list-group-item');
      metaItems.each((_, el) => {
        const text = $(el).text().trim();
        if (!text) return;
        const nameMatch = text.match(/Name\s*:\s*(.+)/i);
        const sizeMatch = text.match(/Size\s*:\s*([0-9.]+\s*(?:GB|MB|KB|TB))/i);
        if (nameMatch && nameMatch[1]) fileName = nameMatch[1].trim();
        if (sizeMatch && sizeMatch[1]) fileSize = sizeMatch[1].replace(/\s+/g, ''); // normalize spacing
      });
    } catch (metaErr) {
      console.log(`[UHDMOVIES-RESOLVE] Failed to parse file metadata: ${metaErr.message}`);
    }

    // Step 3: Extract final download URL from file page
    // Use the full file page URL as the base so relative /zfile links resolve correctly
    const origin = finalFilePageUrl;
    const pollAttemptsRaw = parseInt(process.env.UHDMOVIES_ZFILE_POLL_ATTEMPTS || '15', 10);
    const pollDelayRaw = parseInt(process.env.UHDMOVIES_ZFILE_POLL_DELAY_MS || '5000', 10);
    const pollOptions = {
      attempts: Number.isFinite(pollAttemptsRaw) ? Math.max(0, pollAttemptsRaw) : 15,
      delayMs: Number.isFinite(pollDelayRaw) ? Math.max(250, pollDelayRaw) : 5000
    };
    const finalUrl = await extractFinalDownloadFromFilePage($, {
      origin,
      get: (url, opts) => makeRequest(url, opts),
      post: async (url, data, opts) => {
        if (UHDMOVIES_PROXY_URL) {
          // Legacy proxy - encode URL for proxy
          const proxiedUrl = `${UHDMOVIES_PROXY_URL}${encodeURIComponent(url)}`;
          console.log(`[UHDMovies] Making legacy proxied POST request to: ${url}`);
          return await axiosInstance.post(proxiedUrl, data, opts);
        } else if (USE_HTTPSTREAMS_PROXY) {
          // Use debrid-proxy system (no need to modify URL - agent handles it)
          console.log(`[UHDMovies] Making proxied POST request via debrid-proxy to: ${url}`);
          return await axiosInstance.post(url, data, opts);
        } else {
          // Direct request
          console.log(`[UHDMovies] Making direct POST request to: ${url}`);
          return await axiosInstance.post(url, data, opts);
        }
      },
      validate: (url) => validateVideoUrl(url),
      pollOptions,
      log: console
    });

    if (!finalUrl) {
      console.log(`[UHDMOVIES-RESOLVE] Could not extract final video URL`);
      return null;
    }

    // Filter out googleusercontent links entirely - they do not support 206 for our use case
    if (finalUrl && finalUrl.includes('googleusercontent.com')) {
      console.log('[UHDMOVIES-RESOLVE] Filtering out googleusercontent.com link (no 206 support)');
      return null;
    }

    const result = { url: finalUrl, fileName, size: fileSize };
    console.log('[UHDMOVIES-RESOLVE] Successfully resolved to:', finalUrl.substring(0, 100) + '...');
    resolvedCache.set(sidUrl, { ...result, ts: Date.now() });
    return result;
  } catch (error) {
    console.error('[UHDMOVIES-RESOLVE] Error resolving UHDMovies stream:', error.message);
    return null;
  }
}
