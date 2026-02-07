import pg from 'pg';
import * as config from '../config.js';

const { Pool } = pg;

let pool = null;
let initPromise = null;
let initFailed = false;  // Track if init failed to prevent retry loops

// Connection timeout in ms (default 5 seconds)
const CONNECTION_TIMEOUT_MS = Number(process.env.POSTGRES_CONNECT_TIMEOUT_MS) || 5000;

// Query timeout in ms (default 10 seconds) - prevents connections being held too long
const QUERY_TIMEOUT_MS = Number(process.env.POSTGRES_QUERY_TIMEOUT_MS) || 10000;

// Pool size - increase for heavy load environments
const POOL_SIZE = Number(process.env.POSTGRES_POOL_SIZE) || 50;

function buildPoolConfig() {
  const connectionString = config.POSTGRES_URL || config.DATABASE_URL;
  const baseConfig = connectionString
    ? { connectionString }
    : {
        host: config.POSTGRES_HOST,
        port: config.POSTGRES_PORT,
        user: config.POSTGRES_USER,
        password: config.POSTGRES_PASSWORD,
        database: config.POSTGRES_DB
      };

  // Add connection timeout and query timeout to prevent hanging
  const configWithTimeout = {
    ...baseConfig,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: 30000,
    max: POOL_SIZE,
    // Set statement_timeout at connection level to auto-cancel long queries
    statement_timeout: QUERY_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
    // Allow connections to be destroyed if idle for too long
    allowExitOnIdle: false
  };

  if (config.POSTGRES_SSL) {
    return {
      ...configWithTimeout,
      ssl: { rejectUnauthorized: false }
    };
  }

  return configWithTimeout;
}

export function getPool() {
  // Don't create pool if previous init failed
  if (initFailed) {
    return null;
  }
  if (!pool) {
    pool = new Pool(buildPoolConfig());
    pool.on('error', (err) => {
      console.error(`[POSTGRES] Pool error: ${err.message}`);
    });
  }
  return pool;
}

export async function initPool() {
  // If init already failed, don't retry (prevents blocking on every request)
  if (initFailed) {
    return null;
  }

  if (initPromise) return initPromise;

  initPromise = (async () => {
    const poolInstance = getPool();

    // Wrap the query in a timeout as extra protection
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Connection timeout')), CONNECTION_TIMEOUT_MS + 1000);
    });

    await Promise.race([
      poolInstance.query('SELECT 1'),
      timeoutPromise
    ]);

    console.log('[POSTGRES] Connection pool initialized successfully');
    return poolInstance;
  })().catch((error) => {
    console.error(`[POSTGRES] Failed to initialize pool: ${error.message}`);
    console.warn('[POSTGRES] Postgres unavailable - falling back to no-cache mode');
    initFailed = true;  // Mark as failed to prevent retry loops
    if (pool) {
      pool.end().catch(() => {});
    }
    pool = null;
    initPromise = null;
    return null;  // Return null instead of throwing to allow graceful fallback
  });

  return initPromise;
}

// Check if Postgres is available (for external callers)
export function isPostgresAvailable() {
  return !initFailed && pool !== null;
}

// Reset failed state (useful if Postgres comes back online)
export function resetPostgresState() {
  initFailed = false;
  initPromise = null;
}

export async function closePool() {
  if (!pool) return;
  try {
    await pool.end();
  } finally {
    pool = null;
    initPromise = null;
    initFailed = false;  // Reset on close so reconnection can be attempted
  }
}
