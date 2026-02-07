import fs from 'fs';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import * as config from '../config.js';
import { getPool, initPool } from './postgres-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const debug = process.env.CINEMETA_CACHE_DEBUG === 'true';
const CINEMETA_CACHE_BACKEND = (config.CINEMETA_CACHE_BACKEND || 'sqlite').toLowerCase();
const CINEMETA_SQL_CACHE_ENABLED = config.CINEMETA_SQL_CACHE_ENABLED !== false;
const DEFAULT_TTL_MS = Number.isFinite(config.CINEMETA_CACHE_TTL_MS)
    ? config.CINEMETA_CACHE_TTL_MS
    : parseInt(process.env.CINEMETA_CACHE_TTL_MS || '300000', 10);
const SQLITE_PATH = config.CINEMETA_SQLITE_PATH || path.join(__dirname, '..', '..', 'data', 'cinemeta-cache.db');

let sqliteDb = null;
let pgPool = null;
let initPromise = null;
let disabled = false;

const isPostgres = () => CINEMETA_CACHE_BACKEND === 'postgres';

async function init() {
    if (disabled || !CINEMETA_SQL_CACHE_ENABLED) return null;
    if (initPromise) return initPromise;

    initPromise = (async () => {
        if (isPostgres()) {
            const pool = await initPool();
            pgPool = getPool();
            await pool.query(`
                CREATE TABLE IF NOT EXISTS cinemeta_cache (
                    type TEXT NOT NULL,
                    imdb_id TEXT NOT NULL,
                    meta JSONB,
                    expires_at TIMESTAMPTZ,
                    PRIMARY KEY (type, imdb_id)
                );
                CREATE INDEX IF NOT EXISTS cinemeta_cache_expires_idx ON cinemeta_cache (expires_at);
            `);
            if (debug) console.log('[Cinemeta-DB] Postgres cache ready');
            return;
        }

        fs.mkdirSync(path.dirname(SQLITE_PATH), { recursive: true });
        sqliteDb = new Database(SQLITE_PATH);
        sqliteDb.pragma('journal_mode = WAL');
        sqliteDb.pragma('synchronous = NORMAL');
        sqliteDb.exec(`
            CREATE TABLE IF NOT EXISTS cinemeta_cache (
                type TEXT NOT NULL,
                imdb_id TEXT NOT NULL,
                meta TEXT,
                expires_at INTEGER,
                PRIMARY KEY (type, imdb_id)
            );
            CREATE INDEX IF NOT EXISTS cinemeta_cache_expires_idx ON cinemeta_cache (expires_at);
        `);
        if (debug) console.log('[Cinemeta-DB] SQLite cache ready:', SQLITE_PATH);
    })().catch(err => {
        disabled = true;
        console.error(`[Cinemeta-DB] Failed to init cache store: ${err.message}`);
    });

    return initPromise;
}

// Track consecutive failures for circuit breaker pattern
let consecutiveCacheErrors = 0;
const MAX_CACHE_ERRORS = 5;

export async function getCachedMeta(type, imdbId) {
    if (disabled || !CINEMETA_SQL_CACHE_ENABLED) return { hit: false };
    try {
        await init();
        if (disabled || (!pgPool && !sqliteDb)) return { hit: false };

        const now = Date.now();

        if (pgPool) {
            const res = await pgPool.query(
                'SELECT meta, expires_at FROM cinemeta_cache WHERE type = $1 AND imdb_id = $2',
                [type, imdbId]
            );
            consecutiveCacheErrors = 0; // Reset on success
            if (!res.rowCount) return { hit: false };

            const row = res.rows[0];
            const expiresMs = row.expires_at ? new Date(row.expires_at).getTime() : null;
            if (expiresMs && expiresMs <= now) {
                await pgPool.query('DELETE FROM cinemeta_cache WHERE type = $1 AND imdb_id = $2', [type, imdbId]).catch(() => {});
                return { hit: false };
            }
            return { hit: true, meta: row.meta ?? null };
        }

        const row = sqliteDb.prepare('SELECT meta, expires_at FROM cinemeta_cache WHERE type = ? AND imdb_id = ?').get(type, imdbId);
        consecutiveCacheErrors = 0; // Reset on success
        if (!row) return { hit: false };
        if (row.expires_at && row.expires_at <= now) {
            sqliteDb.prepare('DELETE FROM cinemeta_cache WHERE type = ? AND imdb_id = ?').run(type, imdbId);
            return { hit: false };
        }

        const parsed = row.meta ? JSON.parse(row.meta) : null;
        return { hit: true, meta: parsed };
    } catch (err) {
        consecutiveCacheErrors++;
        // Only disable after multiple consecutive failures (circuit breaker)
        if (consecutiveCacheErrors >= MAX_CACHE_ERRORS) {
            disabled = true;
            console.error(`[Cinemeta-DB] Disabling cache after ${MAX_CACHE_ERRORS} consecutive failures: ${err.message}`);
        } else if (debug) {
            console.warn(`[Cinemeta-DB] Cache read error (${consecutiveCacheErrors}/${MAX_CACHE_ERRORS}): ${err.message}`);
        }
        return { hit: false };
    }
}

export async function upsertCachedMeta(type, imdbId, meta, ttlMs = DEFAULT_TTL_MS) {
    if (disabled || !CINEMETA_SQL_CACHE_ENABLED) return false;
    try {
        await init();
        if (disabled || (!pgPool && !sqliteDb)) return false;

        const expiresMs = Date.now() + (Number.isFinite(ttlMs) ? ttlMs : DEFAULT_TTL_MS);
        const toStore = meta === undefined ? null : meta;

        if (pgPool) {
            await pgPool.query(
                `INSERT INTO cinemeta_cache (type, imdb_id, meta, expires_at)
                 VALUES ($1, $2, $3, to_timestamp($4 / 1000.0))
                 ON CONFLICT (type, imdb_id) DO UPDATE SET meta = EXCLUDED.meta, expires_at = EXCLUDED.expires_at`,
                [type, imdbId, toStore, expiresMs]
            );
            consecutiveCacheErrors = 0; // Reset on success
            return true;
        }

        sqliteDb.prepare(`
            INSERT INTO cinemeta_cache (type, imdb_id, meta, expires_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(type, imdb_id) DO UPDATE SET meta = excluded.meta, expires_at = excluded.expires_at
        `).run(type, imdbId, toStore === null ? null : JSON.stringify(toStore), expiresMs);
        consecutiveCacheErrors = 0; // Reset on success
        return true;
    } catch (err) {
        consecutiveCacheErrors++;
        // Only disable after multiple consecutive failures (circuit breaker)
        if (consecutiveCacheErrors >= MAX_CACHE_ERRORS) {
            disabled = true;
            console.error(`[Cinemeta-DB] Disabling cache after ${MAX_CACHE_ERRORS} consecutive failures: ${err.message}`);
        } else if (debug) {
            console.warn(`[Cinemeta-DB] Cache write error (${consecutiveCacheErrors}/${MAX_CACHE_ERRORS}): ${err.message}`);
        }
        return false;
    }
}

export default { getCachedMeta, upsertCachedMeta };
