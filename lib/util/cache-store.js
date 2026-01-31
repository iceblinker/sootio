import * as config from '../config.js';
import * as postgresCache from './postgres-cache.js';
import * as sqliteCache from './sqlite-cache.js';

const backend = config.CACHE_BACKEND === 'postgres' ? postgresCache : sqliteCache;

export const {
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
} = backend;

export default backend;
