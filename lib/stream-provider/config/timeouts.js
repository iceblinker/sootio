/**
 * Service timeout configuration (in milliseconds)
 * Prevents slow services from blocking fast ones
 */
import { recordTiming } from '../../util/timing-metrics-store.js';
import { getAdaptiveTimeoutSync, getTimeoutBounds } from '../../util/adaptive-timeout.js';

// Default timeout for debrid services (150 seconds)
export const SERVICE_TIMEOUT_MS = parseInt(process.env.SERVICE_TIMEOUT_MS) || 150000;

// Timeout for HTTP streaming services (4 seconds - aggressive to keep UI snappy)
export const HTTP_STREAMING_TIMEOUT_MS = parseInt(process.env.HTTP_STREAMING_TIMEOUT_MS) || 4000;

// Timeout for Usenet services (20 seconds - slower than HTTP but faster than torrents)
export const USENET_TIMEOUT_MS = parseInt(process.env.USENET_TIMEOUT_MS) || 20000;

// Cache version for search results - increment to invalidate all search caches
// This should be bumped when the format of cached results changes or when
// the underlying scrapers (4KHDHub, UHDMovies, etc.) are significantly updated
export const SEARCH_CACHE_VERSION = 'v3';

function parseTimeoutOverride(value) {
  if (value == null || value === '') return null;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function getProviderEnvKey(provider) {
  return String(provider || '')
    .trim()
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

export function getHttpStreamingTimeoutMs(provider) {
  const providerKey = getProviderEnvKey(provider);

  // 1. Check for environment variable override (highest priority)
  const override = providerKey
    ? parseTimeoutOverride(
      process.env[`HTTP_STREAMING_TIMEOUT_MS_${providerKey}`]
        ?? process.env[`HTTP_STREAMING_TIMEOUT_${providerKey}`]
    )
    : null;

  if (override !== null) {
    return override;
  }

  // 2. Check for cached adaptive timeout (falls back to provider defaults)
  const adaptiveTimeout = getAdaptiveTimeoutSync(provider);
  const baseTimeout = adaptiveTimeout || HTTP_STREAMING_TIMEOUT_MS;

  // 3. Apply provider-specific minimums to avoid premature timeouts
  if (providerKey === 'MKVDRAMA') {
    // MKVDrama requires FlareSolverr to bypass Cloudflare which can take 30-60+ seconds
    return Math.max(baseTimeout, 45000);
  }

  if (providerKey === 'MOVIESDRIVE') {
    return Math.max(baseTimeout, 25000);
  }

  if (providerKey === '4KHDHUB' || providerKey === 'HDHUB4U' || providerKey === 'CINEDOZE' || providerKey === 'UHDMOVIES' || providerKey === 'XDMOVIES') {
    return Math.max(baseTimeout, 12000);
  }

  return baseTimeout;
}

/**
 * Wraps a promise with a timeout to prevent slow services from blocking fast ones
 * Also records timing metrics for adaptive timeout calculation.
 * @param {Promise} promise - The promise to wrap
 * @param {number} timeoutMs - Timeout in milliseconds
 * @param {string} serviceName - Name of the service (for logging)
 * @returns {Promise} - Promise that resolves/rejects with timeout
 */
export function withTimeout(promise, timeoutMs, serviceName = 'service') {
  const startTime = Date.now();

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`${serviceName} timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise])
    .then(result => {
      // Record successful timing
      const duration = Date.now() - startTime;
      const resultCount = Array.isArray(result) ? result.length : (result ? 1 : 0);
      recordTiming(serviceName, duration, 'success', resultCount);
      return result;
    })
    .catch(err => {
      const duration = Date.now() - startTime;

      if (err.message.includes('timeout')) {
        console.warn(`[TIMEOUT] ${serviceName} exceeded ${timeoutMs}ms - returning empty results`);
        recordTiming(serviceName, duration, 'timeout', 0);
      } else {
        console.error(`[ERROR] ${serviceName} failed:`, err.message);
        recordTiming(serviceName, duration, 'error', 0);
      }
      return []; // Return empty array on timeout or error
    });
}
