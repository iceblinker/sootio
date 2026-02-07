/**
 * @fileoverview
 * PostgreSQL-backed cache implementation.
 */
import * as config from '../config.js';
import { closePool, getPool, initPool, isPostgresAvailable } from './postgres-client.js';

let initPromise = null;
let cleanupIntervalId = null;
const debug = process.env.SQLITE_DEBUG_LOGS === 'true' || process.env.DEBUG_SQLITE === 'true';

// Rate limiting for upserts to prevent pool exhaustion
const UPSERT_CONCURRENCY = Number(process.env.POSTGRES_UPSERT_CONCURRENCY) || 10;
const UPSERT_QUEUE_MAX = Number(process.env.POSTGRES_UPSERT_QUEUE_MAX) || 500;
let upsertQueue = [];
let activeUpserts = 0;
let upsertProcessing = false;
let consecutiveUpsertFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 5;
let upsertCircuitOpen = false;
let circuitResetTimeout = null;

function normalizeSize(value) {
  if (value == null) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.round(num);
}

export function isEnabled() {
  return Boolean(config.SQLITE_CACHE_ENABLED);
}

function ttlDate(customTtlMs) {
  if (typeof customTtlMs === 'number' && customTtlMs > 0) {
    return new Date(Date.now() + customTtlMs).toISOString();
  }

  const days = Number(config.SQLITE_CACHE_TTL_DAYS || 30);
  const ms = Date.now() + days * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

async function createTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cache (
      service TEXT NOT NULL,
      hash TEXT NOT NULL,
      file_name TEXT,
      size BIGINT,
      data TEXT,
      release_key TEXT,
      category TEXT,
      resolution TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ,
      PRIMARY KEY (service, hash)
    )
  `);

  await pool.query('CREATE INDEX IF NOT EXISTS idx_cache_release_key ON cache(service, release_key)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_cache_expires_at ON cache(expires_at)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_cache_hash_service ON cache(hash, service)');
}

export async function initSqlite() {
  if (!isEnabled()) {
    if (debug) console.log('[POSTGRES CACHE] Cache is disabled by configuration');
    return null;
  }
  if (initPromise) {
    if (debug) console.log('[POSTGRES CACHE] Using existing initialization promise');
    return initPromise;
  }

  initPromise = (async () => {
    try {
      const pool = await initPool();
      await createTables(pool);
      setupCleanupJob();
      console.log('[POSTGRES CACHE] Cache initialized successfully');
      return pool;
    } catch (error) {
      console.warn(`[POSTGRES CACHE] Failed to initialize: ${error.message}`);
      console.warn('[POSTGRES CACHE] Falling back to no-cache mode');
      initPromise = null;
      return null;
    }
  })();

  return initPromise;
}

export async function getDatabase() {
  if (!isEnabled()) {
    if (debug) console.log('[POSTGRES CACHE] getDatabase: cache is not enabled');
    return null;
  }
  const pool = await initSqlite();
  if (!pool) return null;
  return getPool();
}

function setupCleanupJob() {
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }

  if (debug) {
    console.log('[POSTGRES CACHE] Setting up periodic cleanup job for expired cache entries');
  }

  cleanupIntervalId = setInterval(async () => {
    try {
      const pool = await getDatabase();
      if (!pool) return;

      const startTime = Date.now();
      const result = await pool.query('DELETE FROM cache WHERE expires_at <= NOW()');
      const duration = Date.now() - startTime;

      if (result.rowCount > 0) {
        console.log(`[POSTGRES CACHE] Cleaned up ${result.rowCount} expired cache entries in ${duration}ms`);
      } else if (debug) {
        console.log(`[POSTGRES CACHE] No expired cache entries to clean up (checked in ${duration}ms)`);
      }
    } catch (error) {
      console.error(`[POSTGRES CACHE] Error cleaning up expired entries: ${error.message}`);
    }
  }, 30 * 60 * 1000);
}

/**
 * Process queued upserts with concurrency limiting
 */
async function processUpsertQueue() {
  if (upsertProcessing || upsertQueue.length === 0) return;
  upsertProcessing = true;

  while (upsertQueue.length > 0 && activeUpserts < UPSERT_CONCURRENCY) {
    // Check circuit breaker
    if (upsertCircuitOpen) {
      if (debug) console.log('[POSTGRES CACHE] Circuit breaker open, dropping queued upserts');
      upsertQueue = [];
      break;
    }

    const { record, options, resolve } = upsertQueue.shift();
    activeUpserts++;

    executeUpsert(record, options)
      .then(result => {
        consecutiveUpsertFailures = 0; // Reset on success
        resolve(result);
      })
      .catch(err => {
        consecutiveUpsertFailures++;
        if (consecutiveUpsertFailures >= MAX_CONSECUTIVE_FAILURES && !upsertCircuitOpen) {
          console.warn(`[POSTGRES CACHE] Circuit breaker OPEN after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`);
          upsertCircuitOpen = true;
          // Reset circuit after 30 seconds
          circuitResetTimeout = setTimeout(() => {
            console.log('[POSTGRES CACHE] Circuit breaker RESET');
            upsertCircuitOpen = false;
            consecutiveUpsertFailures = 0;
          }, 30000);
        }
        resolve(false);
      })
      .finally(() => {
        activeUpserts--;
        // Continue processing queue
        if (upsertQueue.length > 0 && !upsertCircuitOpen) {
          setImmediate(processUpsertQueue);
        }
      });
  }

  upsertProcessing = false;
}

/**
 * Execute a single upsert operation
 */
async function executeUpsert(record, options = {}) {
  const pool = getPool();
  if (!pool || !isPostgresAvailable()) return false;

  const service = String(record.service || '').toLowerCase();
  const hash = String(record.hash || '').toLowerCase();
  if (!service || !hash) return false;

  const now = new Date().toISOString();
  const expiresAt = ttlDate(options?.ttlMs);

  const sql = `
    INSERT INTO cache
      (service, hash, file_name, size, data, release_key, category, resolution, created_at, updated_at, expires_at)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT (service, hash)
    DO UPDATE SET
      file_name = EXCLUDED.file_name,
      size = EXCLUDED.size,
      data = EXCLUDED.data,
      release_key = EXCLUDED.release_key,
      category = EXCLUDED.category,
      resolution = EXCLUDED.resolution,
      updated_at = EXCLUDED.updated_at,
      expires_at = EXCLUDED.expires_at
  `;

  const startTime = Date.now();
  await pool.query(sql, [
    service,
    hash,
    record.fileName || null,
    normalizeSize(record.size),
    record.data ? JSON.stringify(record.data) : null,
    record.releaseKey || null,
    record.category || null,
    record.resolution || null,
    now,
    now,
    expiresAt
  ]);

  if (debug) {
    const duration = Date.now() - startTime;
    console.log(`[POSTGRES CACHE] Upsert completed in ${duration}ms: service=${service}, hash=${hash}`);
  }

  return true;
}

export async function upsertCachedMagnet(record, options = {}) {
  if (!isEnabled()) {
    if (debug) console.log(`[POSTGRES CACHE] Cache is not enabled, skipping upsert for hash ${record.hash}`);
    return false;
  }

  // Circuit breaker check
  if (upsertCircuitOpen) {
    return false;
  }

  // Queue overflow protection
  if (upsertQueue.length >= UPSERT_QUEUE_MAX) {
    if (debug) console.warn(`[POSTGRES CACHE] Upsert queue full (${UPSERT_QUEUE_MAX}), dropping oldest entries`);
    // Drop oldest 10% of queue
    upsertQueue = upsertQueue.slice(Math.floor(UPSERT_QUEUE_MAX * 0.1));
  }

  const service = String(record.service || '').toLowerCase();
  const hash = String(record.hash || '').toLowerCase();
  if (!service || !hash) {
    if (debug) console.log(`[POSTGRES CACHE] Invalid service (${service}) or hash (${hash}) for upsert`);
    return false;
  }

  // Queue the upsert and process asynchronously
  return new Promise(resolve => {
    upsertQueue.push({ record, options, resolve });
    setImmediate(processUpsertQueue);
  });
}

export async function upsertCachedMagnets(records, options = {}) {
  if (!isEnabled() || !Array.isArray(records) || records.length === 0) {
    if (debug) {
      console.log(`[POSTGRES CACHE] Bulk upsert skipped: enabled=${isEnabled()}, records length=${Array.isArray(records) ? records.length : 'N/A'}`);
    }
    return false;
  }

  const pool = await getDatabase();
  if (!pool) return false;

  const now = new Date().toISOString();
  const expiresAt = ttlDate(options?.ttlMs);
  const sql = `
    INSERT INTO cache
      (service, hash, file_name, size, data, release_key, category, resolution, created_at, updated_at, expires_at)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT (service, hash)
    DO UPDATE SET
      file_name = EXCLUDED.file_name,
      size = EXCLUDED.size,
      data = EXCLUDED.data,
      release_key = EXCLUDED.release_key,
      category = EXCLUDED.category,
      resolution = EXCLUDED.resolution,
      updated_at = EXCLUDED.updated_at,
      expires_at = EXCLUDED.expires_at
  `;

  let successCount = 0;
  const startTime = Date.now();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const record of records) {
      const service = String(record.service || '').toLowerCase();
      const hash = String(record.hash || '').toLowerCase();
      if (!service || !hash) {
        if (debug) console.log(`[POSTGRES CACHE] Skipping invalid record: service=${record.service}, hash=${record.hash}`);
        continue;
      }

      await client.query(sql, [
        service,
        hash,
        record.fileName || null,
        normalizeSize(record.size),
        record.data ? JSON.stringify(record.data) : null,
        record.releaseKey || null,
        record.category || null,
        record.resolution || null,
        now,
        now,
        expiresAt
      ]);
      successCount++;
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`[POSTGRES CACHE] Error upserting magnet records: ${error.message}`);
    return false;
  } finally {
    client.release();
  }

  const duration = Date.now() - startTime;
  if (debug) {
    console.log(`[POSTGRES CACHE] Individual upserts completed in ${duration}ms for ${successCount}/${records.length} records`);
  }

  return successCount > 0;
}

export async function getCachedHashes(service, hashes) {
  if (!isEnabled()) {
    console.log(`[POSTGRES CACHE] Cache is not enabled, skipping check for ${hashes?.length || 0} hashes`);
    return new Set();
  }

  try {
    const pool = await getDatabase();
    if (!pool || !Array.isArray(hashes) || hashes.length === 0) return new Set();

    const lower = hashes.map((hash) => String(hash || '').toLowerCase()).filter(Boolean);
    if (lower.length === 0) return new Set();

    const serviceKey = String(service || '').toLowerCase();
    const sql = `
      SELECT DISTINCT hash
      FROM cache
      WHERE service = $1
        AND hash = ANY($2)
        AND (expires_at IS NULL OR expires_at > NOW())
    `;

    const startTime = Date.now();
    const result = await pool.query(sql, [serviceKey, lower]);
    const duration = Date.now() - startTime;

    const foundHashes = result.rows.map((row) => row.hash);
    const foundSet = new Set(foundHashes);

    console.log(`[POSTGRES CACHE] Found ${foundHashes.length} cached hashes for service ${serviceKey} in ${duration}ms`);

    if (debug) {
      console.log(`[POSTGRES CACHE] Cache hit rate: ${foundHashes.length}/${lower.length} (${(foundHashes.length / lower.length) * 100}%)`);
    }

    return foundSet;
  } catch (error) {
    console.warn(`[POSTGRES CACHE] Error checking cached hashes: ${error.message}`);
    return new Set();
  }
}

export async function deleteCachedHash(service, hash) {
  if (!isEnabled()) {
    console.log(`[POSTGRES CACHE] Cache is not enabled, skipping delete for ${hash}`);
    return { success: false, message: 'Cache not enabled' };
  }

  try {
    const pool = await getDatabase();
    if (!pool) return { success: false, message: 'Database not available' };

    const serviceKey = String(service || '').toLowerCase();
    const hashKey = String(hash || '').toLowerCase();
    if (!serviceKey || !hashKey) {
      return { success: false, message: 'Invalid service or hash' };
    }

    const startTime = Date.now();
    const result = await pool.query(
      'DELETE FROM cache WHERE service = $1 AND hash = $2',
      [serviceKey, hashKey]
    );
    const duration = Date.now() - startTime;

    if (result.rowCount > 0) {
      console.log(`[POSTGRES CACHE] Deleted cached hash ${hashKey} for ${serviceKey} in ${duration}ms`);
    }
    return { success: true, deletedCount: result.rowCount || 0 };
  } catch (error) {
    console.error(`[POSTGRES CACHE] Error deleting cached hash: ${error.message}`);
    return { success: false, message: error.message };
  }
}

export async function getCachedRecord(service, hash) {
  if (!isEnabled()) {
    console.log(`[POSTGRES CACHE] Cache is not enabled, skipping single hash check for ${hash}`);
    return null;
  }

  try {
    const pool = await getDatabase();
    if (!pool) return null;

    const serviceKey = String(service || '').toLowerCase();
    const hashKey = String(hash || '').toLowerCase();

    const sql = `
      SELECT
        file_name AS "fileName",
        size,
        data,
        release_key AS "releaseKey",
        category,
        resolution,
        updated_at AS "updatedAt",
        expires_at AS "expiresAt"
      FROM cache
      WHERE service = $1
        AND hash = $2
        AND (expires_at IS NULL OR expires_at > NOW())
      LIMIT 1
    `;

    const startTime = Date.now();
    const result = await pool.query(sql, [serviceKey, hashKey]);
    const duration = Date.now() - startTime;
    const record = result.rows[0] || null;

    if (record?.data) {
      try {
        record.data = JSON.parse(record.data);
      } catch (e) {
        console.warn(`[POSTGRES CACHE] Error parsing cached data for hash ${hash}: ${e.message}`);
      }
    }

    if (debug) {
      console.log(`[POSTGRES CACHE] Single hash lookup took ${duration}ms`);
    }

    return record;
  } catch (error) {
    console.warn(`[POSTGRES CACHE] Error checking cached record: ${error.message}`);
    return null;
  }
}

export async function getReleaseCounts(service, releaseKey) {
  const empty = { byCategory: {}, byCategoryResolution: {}, total: 0 };
  if (!isEnabled()) return empty;

  try {
    const pool = await getDatabase();
    if (!pool || !service || !releaseKey) return empty;

    const svc = String(service || '').toLowerCase();
    const rel = String(releaseKey);
    const sql = `
      SELECT category, resolution
      FROM cache
      WHERE service = $1
        AND release_key = $2
        AND (expires_at IS NULL OR expires_at > NOW())
    `;

    const startTime = Date.now();
    const result = await pool.query(sql, [svc, rel]);
    const duration = Date.now() - startTime;

    const byCategory = {};
    const byCategoryResolution = {};
    let total = 0;

    for (const row of result.rows) {
      const cat = row.category || 'Other';
      const res = row.resolution || 'unknown';
      byCategory[cat] = (byCategory[cat] || 0) + 1;
      byCategoryResolution[cat] = byCategoryResolution[cat] || {};
      byCategoryResolution[cat][res] = (byCategoryResolution[cat][res] || 0) + 1;
      total += 1;
    }

    if (debug) {
      console.log(`[POSTGRES CACHE] Release count aggregation completed in ${duration}ms for ${result.rows.length} records`);
    }

    return { byCategory, byCategoryResolution, total };
  } catch (error) {
    console.error(`[POSTGRES CACHE] Error aggregating release counts for ${service}/${releaseKey}: ${error.message}`);
    return empty;
  }
}

export async function clearSearchCache() {
  if (!isEnabled()) {
    return { success: false, message: 'Cache not enabled' };
  }

  try {
    const pool = await getDatabase();
    if (!pool) return { success: false, message: 'Database not available' };

    const startTime = Date.now();
    const result = await pool.query(
      'DELETE FROM cache WHERE release_key LIKE $1 AND release_key IS NOT NULL',
      ['%-search:%']
    );
    const duration = Date.now() - startTime;

    console.log(`[POSTGRES CACHE] Cleared ${result.rowCount} search cache entries in ${duration}ms`);
    return { success: true, deletedCount: result.rowCount };
  } catch (error) {
    console.error(`[POSTGRES CACHE] Error clearing search cache: ${error.message}`);
    return { success: false, message: error.message };
  }
}

export async function clearTorrentCache(service = null) {
  if (!isEnabled()) {
    return { success: false, message: 'Cache not enabled' };
  }

  try {
    const pool = await getDatabase();
    if (!pool) return { success: false, message: 'Database not available' };

    const startTime = Date.now();
    let result;
    if (service) {
      result = await pool.query(
        'DELETE FROM cache WHERE hash IS NOT NULL AND service = $1',
        [service.toLowerCase()]
      );
    } else {
      result = await pool.query('DELETE FROM cache WHERE hash IS NOT NULL');
    }
    const duration = Date.now() - startTime;

    const msg = service
      ? `Cleared ${result.rowCount} torrent cache entries for ${service} in ${duration}ms`
      : `Cleared ${result.rowCount} torrent cache entries for all services in ${duration}ms`;
    console.log(`[POSTGRES CACHE] ${msg}`);
    return { success: true, deletedCount: result.rowCount, message: msg };
  } catch (error) {
    console.error(`[POSTGRES CACHE] Error clearing torrent cache: ${error.message}`);
    return { success: false, message: error.message };
  }
}

export async function clearAllCache() {
  if (!isEnabled()) {
    return { success: false, message: 'Cache not enabled' };
  }

  try {
    const pool = await getDatabase();
    if (!pool) return { success: false, message: 'Database not available' };

    const startTime = Date.now();
    const result = await pool.query('DELETE FROM cache');
    const duration = Date.now() - startTime;

    console.log(`[POSTGRES CACHE] Cleared ${result.rowCount} total cache entries in ${duration}ms`);
    return { success: true, deletedCount: result.rowCount };
  } catch (error) {
    console.error(`[POSTGRES CACHE] Error clearing all cache: ${error.message}`);
    return { success: false, message: error.message };
  }
}

/**
 * Clear all cache entries for a specific debrid service (including search cache)
 * This clears both:
 * - Entries with service = '<provider>' (torrent cache)
 * - Entries with service = 'search' AND hash LIKE '<provider>-%' (search result cache)
 * @param {string} service - Service name (e.g., 'offcloud', 'realdebrid')
 * @returns {Promise<{success: boolean, deletedCount: number, torrentCount: number, searchCount: number}>}
 */
export async function clearServiceCache(service) {
  if (!isEnabled()) {
    return { success: false, message: 'Cache not enabled' };
  }

  if (!service) {
    return { success: false, message: 'Service name required' };
  }

  try {
    const pool = await getDatabase();
    if (!pool) return { success: false, message: 'Database not available' };

    const serviceKey = String(service).toLowerCase();
    const startTime = Date.now();

    // Clear torrent cache entries (service = '<provider>')
    const torrentResult = await pool.query(
      'DELETE FROM cache WHERE service = $1',
      [serviceKey]
    );

    // Clear search cache entries (service = 'search' AND hash LIKE '<provider>-%')
    const searchResult = await pool.query(
      'DELETE FROM cache WHERE service = $1 AND hash LIKE $2',
      ['search', `${serviceKey}-%`]
    );

    const duration = Date.now() - startTime;
    const torrentCount = torrentResult.rowCount || 0;
    const searchCount = searchResult.rowCount || 0;
    const totalCount = torrentCount + searchCount;

    console.log(`[POSTGRES CACHE] Cleared ${totalCount} cache entries for ${serviceKey} in ${duration}ms (${torrentCount} torrent, ${searchCount} search)`);
    return { success: true, deletedCount: totalCount, torrentCount, searchCount };
  } catch (error) {
    console.error(`[POSTGRES CACHE] Error clearing service cache: ${error.message}`);
    return { success: false, message: error.message };
  }
}

export async function closeSqlite() {
  console.log('[POSTGRES CACHE] Closing Postgres connection and cleaning up resources...');

  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }

  // Clear circuit breaker timeout
  if (circuitResetTimeout) {
    clearTimeout(circuitResetTimeout);
    circuitResetTimeout = null;
  }

  // Clear upsert queue
  upsertQueue = [];
  upsertCircuitOpen = false;
  consecutiveUpsertFailures = 0;

  try {
    const debridHelpers = await import('./debrid-helpers.js');
    if (debridHelpers.stopUpsertsFlush) {
      debridHelpers.stopUpsertsFlush();
    }
  } catch (err) {
    console.error(`[POSTGRES CACHE] Error stopping upserts flush: ${err.message}`);
  }

  try {
    await closePool();
  } catch (error) {
    console.error(`[POSTGRES CACHE] Error closing Postgres pool: ${error.message}`);
  }

  initPromise = null;
}

export async function getCachedSearchResults(service, type, id, config) {
  if (!isEnabled()) return null;

  try {
    const pool = await getDatabase();
    if (!pool) return null;

    const langKey = (config.Languages || []).join(',');
    const providerKey = String(service).toLowerCase().replace(/[^a-z0-9]/g, '');
    const normalizedId = type === 'series' ? id.replace(/:/g, '_') : id;
    const cacheKey = `${providerKey}-search-${'v2'}:${type}:${normalizedId}:${langKey}`;

    const sql = `
      SELECT
        file_name AS "fileName",
        size,
        data,
        release_key AS "releaseKey",
        category,
        resolution,
        updated_at AS "updatedAt",
        expires_at AS "expiresAt"
      FROM cache
      WHERE service = $1
        AND hash = $2
        AND (expires_at IS NULL OR expires_at > NOW())
      LIMIT 1
    `;

    const result = await pool.query(sql, [String(service || '').toLowerCase(), String(cacheKey || '').toLowerCase()]);
    const record = result.rows[0] || null;

    if (record?.data) {
      try {
        record.data = JSON.parse(record.data);
      } catch (e) {
        console.warn(`[POSTGRES CACHE] Error parsing cached data for hash ${cacheKey}: ${e.message}`);
      }
    }

    return record;
  } catch (error) {
    console.warn(`[POSTGRES CACHE] Error checking cached search results: ${error.message}`);
    return null;
  }
}

/**
 * Get all cached scraper results for a specific release (movie or series episode).
 * @param {string} type - Content type ('movie' or 'series')
 * @param {string} imdbId - IMDB ID
 * @param {number|string} season - Season number (for series, optional)
 * @param {number|string} episode - Episode number (for series, optional)
 * @returns {Promise<Array>} Array of cached torrent objects
 */
export async function getCachedScraperResults(type, imdbId, season = null, episode = null) {
  if (!isEnabled()) {
    return [];
  }
  try {
    const pool = await getDatabase();
    if (!pool) return [];

    const releaseKey = `${type}:${imdbId}`;

    if (debug) {
      console.log(`[POSTGRES CACHE] Getting cached scraper results for ${releaseKey}`);
    }

    const startTime = Date.now();
    const result = await pool.query(`
      SELECT hash, file_name, size, data, release_key, category, resolution, updated_at
      FROM cache
      WHERE (service = 'scraper-results' OR service LIKE '%debrid%' OR service = 'realdebrid' OR service = 'alldebrid' OR service = 'torbox' OR service = 'premiumize')
        AND release_key LIKE $1
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY updated_at DESC
      LIMIT 1000
    `, [`${releaseKey}%`]);

    const duration = Date.now() - startTime;

    const parsed = result.rows.map(row => {
      let data = {};
      if (row.data) {
        try {
          data = JSON.parse(row.data);
        } catch {}
      }
      return {
        hash: row.hash,
        InfoHash: row.hash,
        fileName: row.file_name,
        Title: row.file_name || data.Title,
        name: row.file_name || data.Title,
        size: row.size,
        Size: row.size || data.Size,
        category: row.category,
        resolution: row.resolution,
        source: 'cache',
        isCached: true,
        ...data
      };
    });

    console.log(`[POSTGRES CACHE] Found ${parsed.length} cached scraper results for ${releaseKey} in ${duration}ms`);
    return parsed;
  } catch (error) {
    console.warn(`[POSTGRES CACHE] Error getting cached scraper results: ${error.message}`);
    return [];
  }
}

/**
 * Get all cached hashes for a release (across all services).
 * @param {string} type - Content type ('movie' or 'series')
 * @param {string} imdbId - IMDB ID
 * @returns {Promise<Set>} Set of cached info hashes
 */
export async function getCachedHashesForRelease(type, imdbId) {
  if (!isEnabled()) {
    return new Set();
  }
  try {
    const pool = await getDatabase();
    if (!pool) return new Set();

    const releaseKey = `${type}:${imdbId}`;

    const startTime = Date.now();
    const result = await pool.query(`
      SELECT DISTINCT hash
      FROM cache
      WHERE release_key LIKE $1
        AND hash IS NOT NULL
        AND hash != ''
        AND (expires_at IS NULL OR expires_at > NOW())
    `, [`${releaseKey}%`]);

    const duration = Date.now() - startTime;

    const hashes = new Set(result.rows.map(row => row.hash.toLowerCase()));
    console.log(`[POSTGRES CACHE] Found ${hashes.size} cached hashes for ${releaseKey} in ${duration}ms`);
    return hashes;
  } catch (error) {
    console.warn(`[POSTGRES CACHE] Error getting cached hashes for release: ${error.message}`);
    return new Set();
  }
}

/**
 * Clean up HTTP streams cache entries older than the specified number of days
 * @param {number} days - Number of days to keep (default from HTTP_STREAMS_CACHE_TTL_DAYS config)
 * @returns {Promise<{success: boolean, deletedCount: number}>}
 */
export async function cleanupHttpStreamsCache(days = null) {
  if (!isEnabled()) {
    console.log('[POSTGRES CACHE] Cache is not enabled, skipping HTTP streams cleanup');
    return { success: false, deletedCount: 0 };
  }

  const ttlDays = days ?? Number(config.HTTP_STREAMS_CACHE_TTL_DAYS || 30);
  const cutoffDate = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000).toISOString();

  try {
    const pool = getPool();
    if (!pool) {
      return { success: false, deletedCount: 0 };
    }

    const startTime = Date.now();

    // Delete HTTP streams cache entries older than the cutoff
    // HTTP streams entries have hash patterns like: httpstreaming-search-*
    const result = await pool.query(
      `DELETE FROM cache
       WHERE hash LIKE 'httpstreaming-search-%'
         AND updated_at < $1`,
      [cutoffDate]
    );

    const duration = Date.now() - startTime;
    const deletedCount = result.rowCount || 0;

    console.log(`[POSTGRES CACHE] Cleaned up ${deletedCount} HTTP streams cache entries older than ${ttlDays} days in ${duration}ms`);
    return { success: true, deletedCount };
  } catch (error) {
    console.error(`[POSTGRES CACHE] Error cleaning up HTTP streams cache: ${error.message}`);
    return { success: false, deletedCount: 0 };
  }
}

export default {
  upsertCachedMagnet,
  upsertCachedMagnets,
  getCachedHashes,
  deleteCachedHash,
  getCachedRecord,
  getReleaseCounts,
  clearSearchCache,
  clearTorrentCache,
  clearAllCache,
  closeSqlite,
  isEnabled,
  getCachedSearchResults,
  initSqlite,
  getDatabase,
  getCachedScraperResults,
  getCachedHashesForRelease,
  cleanupHttpStreamsCache
};
