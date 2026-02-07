/**
 * Universal Debrid Service Helpers
 *
 * Common utility functions used across all debrid services.
 * Consolidates duplicated code for caching, formatting, and processing.
 */

import * as sqliteCache from './cache-store.js';
import { setMaxListeners } from 'events';

// ---------------------------------------------------------------------------------
// Abort Controller Management
// ---------------------------------------------------------------------------------

/**
 * Create a new AbortController for each request.
 * Each request gets its own controller to prevent concurrent requests from canceling each other.
 *
 * @returns {AbortController} A new abort controller instance
 */
export function createAbortController() {
  const abortController = new AbortController();

  // Increase max listeners to prevent warnings when multiple scrapers use the same signal
  // Default is 10, but with multiple languages and many scrapers we can have 100+ listeners
  // Set to 0 for unlimited (safe since each request gets its own controller)
  setMaxListeners(0, abortController.signal);

  return abortController;
}

/**
 * Create an AbortController with automatic timeout enforcement.
 * This ensures scrapers are forcefully aborted after the specified timeout,
 * preventing runaway requests from blocking the system.
 *
 * @param {number} timeoutMs - Timeout in milliseconds (default: 30000ms)
 * @param {string} [logPrefix='ABORT'] - Prefix for log messages
 * @returns {{ controller: AbortController, signal: AbortSignal, cleanup: () => void }}
 */
export function createAbortControllerWithTimeout(timeoutMs = 30000, logPrefix = 'ABORT') {
  const abortController = new AbortController();
  setMaxListeners(0, abortController.signal);

  const timeoutId = setTimeout(() => {
    if (!abortController.signal.aborted) {
      console.warn(`[${logPrefix}] Hard timeout after ${timeoutMs}ms - aborting all operations`);
      abortController.abort();
    }
  }, timeoutMs);

  // Cleanup function to clear the timeout when operations complete normally
  const cleanup = () => {
    clearTimeout(timeoutId);
  };

  return {
    controller: abortController,
    signal: abortController.signal,
    cleanup
  };
}

// ---------------------------------------------------------------------------------
// SQLite Cache Helpers
// ---------------------------------------------------------------------------------

/**
 * Bounded queue for pending SQLite upserts to prevent memory leaks
 * When setImmediate() is used without bounds, callbacks can accumulate faster than
 * they execute, especially when SQLite is slow or under heavy load.
 */
const MAX_PENDING_UPSERTS = 200; // Maximum queue size before forced flush
const FLUSH_INTERVAL_MS = 2000;  // Flush every 2 seconds
let pendingUpserts = [];
let isFlushingUpserts = false;
let sqliteBackpressure = false;   // Set to true when SQLite is overloaded
let flushInterval = null;

/**
 * Initialize the periodic flush of pending upserts
 * (disabled when immediate saves are enabled)
 */
function initUpsertsFlush() {
  // Flush interval is not initialized when using immediate saves
  // All upserts are saved immediately instead of being queued
  return;
}

/**
 * Flush pending upserts to SQLite
 * (no-op when using immediate saves)
 */
async function flushPendingUpserts() {
  // No-op when using immediate saves - data is saved right away
  return;
}

/**
 * Stop the upserts flush interval (for cleanup)
 */
export function stopUpsertsFlush() {
  if (flushInterval) {
    clearInterval(flushInterval);
    flushInterval = null;
    console.log('[SQLITE] Upserts flush interval stopped');
  }

  // Flush any remaining upserts
  if (pendingUpserts.length > 0) {
    console.log(`[SQLITE] Flushing ${pendingUpserts.length} remaining upserts before shutdown`);
    flushPendingUpserts().catch(() => {});
  }
}

// Initialize the flush interval when module is loaded
initUpsertsFlush();

/**
 * Add a hash to SQLite cache (queued save)
 *
 * This version queues the upsert for rate-limited processing.
 * The postgres-cache module handles concurrency limiting internally.
 */
export function addHashToSqlite(hash, fileName = null, size = null, data = null, service = null) {
  try {
    if (!hash || !service || !sqliteCache?.isEnabled()) return;

    const payload = {
      service: String(service).toLowerCase(),
      hash: String(hash).toLowerCase(),
      fileName,
      size,
      data
    };

    // Fire and forget - the cache module handles rate limiting
    sqliteCache.upsertCachedMagnet(payload).catch(() => {
      // Silently ignore - cache failures shouldn't affect main flow
    });
  } catch (err) {
    // Silently ignore cache errors
  }
}

/**
 * Save hashes to SQLite (batched, rate-limited)
 *
 * This queues records for rate-limited processing by the cache module.
 * Cache failures are silently ignored to prevent cascading failures.
 */
export function deferSqliteUpserts(payloads = []) {
  try {
    if (!sqliteCache?.isEnabled() || !Array.isArray(payloads) || payloads.length === 0) {
      return;
    }

    // Queue each payload - the cache module handles rate limiting
    for (const payload of payloads) {
      sqliteCache.upsertCachedMagnet(payload).catch(() => {
        // Silently ignore - cache failures shouldn't affect main flow
      });
    }
  } catch (err) {
    // Silently ignore cache errors
  }
}

/**
 * Remove duplicate payloads by service+hash
 */
export function uniqueUpserts(payloads = []) {
  const seen = new Set();
  const out = [];
  for (const p of payloads) {
    const key = `${p.service || ''}:${(p.hash || '').toLowerCase()}`;
    if (!p.hash || seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------------
// String Normalization
// ---------------------------------------------------------------------------------

/**
 * Normalize string for comparison (remove quotes, extra spaces, lowercase)
 */
export function norm(s) {
  return (s || '').replace(/[''`]/g, '').replace(/\s+/g, ' ').toLowerCase().trim();
}

// ---------------------------------------------------------------------------------
// Quality Category Detection
// ---------------------------------------------------------------------------------

/**
 * Determine quality category from torrent name
 */
export function getQualityCategory(torrentName) {
  const name = (torrentName || '').toLowerCase();

  if (/(\s|\.)(aac|opus)\b/.test(name)) {
    return 'Audio-Focused';
  }

  if (/\bremux\b/.test(name)) {
    return 'Remux';
  }

  if (/\b(web-?rip|brrip|dlrip|bluray\s*rip)\b/.test(name)) {
    return 'BRRip/WEBRip';
  }

  if (/\b(blu-?ray|bdrip)\b/.test(name)) {
    return 'BluRay';
  }

  if (/\b(web-?\.?dl|web\b)/.test(name)) {
    return 'WEB/WEB-DL';
  }

  return 'Other';
}

// ---------------------------------------------------------------------------------
// Release Key Generation
// ---------------------------------------------------------------------------------

/**
 * Generate a consistent release key for caching
 */
export function makeReleaseKey(type, imdbId, season = null, episode = null) {
  if (type === 'series' && season != null && episode != null) {
    return `${imdbId}:s${String(season).padStart(2, '0')}e${String(episode).padStart(2, '0')}`;
  }
  return imdbId;
}

// ---------------------------------------------------------------------------------
// File Filtering
// ---------------------------------------------------------------------------------

/**
 * Filter files by keywords in title
 */
export function filterFilesByKeywords(files, searchKey) {
  if (!searchKey || !Array.isArray(files)) return files;

  const keywords = searchKey.toLowerCase().split(/\s+/).filter(Boolean);
  if (keywords.length === 0) return files;

  return files.filter(file => {
    const fileName = (file.name || file.path || '').toLowerCase();
    return keywords.some(keyword => fileName.includes(keyword));
  });
}

// ---------------------------------------------------------------------------------
// Result Formatting (Base Templates)
// ---------------------------------------------------------------------------------

/**
 * Format a cached result (base template)
 */
export function formatCachedResult(torrent, isCached, additionalFields = {}) {
  const episodeHint = torrent.episodeFileHint || null;

  return {
    name: torrent.Title || torrent.name || 'Unknown',
    title: torrent.Title || torrent.name || 'Unknown',
    size: torrent.Size || torrent.size || 0,
    seeders: torrent.Seeders || torrent.seeders || 0,
    infoHash: torrent.InfoHash || torrent.infoHash || torrent.hash || '',
    isCached: isCached,
    isPersonal: torrent.isPersonal || false,
    magnetLink: torrent.Link || torrent.magnetLink || torrent.link || '',
    episodeFileHint: episodeHint,
    ...additionalFields
  };
}

/**
 * Format an external search result (base template)
 */
export function formatExternalResult(result, additionalFields = {}) {
  return {
    name: result.Title || result.name || 'Unknown',
    title: result.Title || result.name || 'Unknown',
    size: result.Size || result.size || 0,
    seeders: result.Seeders || result.seeders || 0,
    infoHash: result.InfoHash || result.infoHash || result.hash || '',
    isCached: false,
    isPersonal: false,
    magnetLink: result.Link || result.magnetLink || result.link || '',
    ...additionalFields
  };
}

// ---------------------------------------------------------------------------------
// Result Combining
// ---------------------------------------------------------------------------------

/**
 * Combine personal files with external search results
 */
export function combineAndMarkResults(apiKey, personalFiles, externalSources, specificSearchKey) {
  const combined = [...personalFiles];

  // Flatten external sources (array of arrays from scrapers)
  const externalFlat = Array.isArray(externalSources)
    ? externalSources.flat().filter(Boolean)
    : [];

  combined.push(...externalFlat);

  return combined;
}

// ---------------------------------------------------------------------------------
// Delay Utility
// ---------------------------------------------------------------------------------

/**
 * Simple delay/sleep utility
 */
export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------------
// Export all utilities
// ---------------------------------------------------------------------------------

export default {
  createAbortController,
  createAbortControllerWithTimeout,
  addHashToSqlite,
  deferSqliteUpserts,
  uniqueUpserts,
  norm,
  getQualityCategory,
  makeReleaseKey,
  filterFilesByKeywords,
  formatCachedResult,
  formatExternalResult,
  combineAndMarkResults,
  delay,
  stopUpsertsFlush
};
