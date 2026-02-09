// --- Debugging ---
export const DEBRID_DEBUG_LOGS = process.env.DEBRID_DEBUG_LOGS === 'true';
export const RD_DEBUG_LOGS = process.env.RD_DEBUG_LOGS === 'true';
export const DISABLE_VIDEO_INDICATOR_FILTER = process.env.DISABLE_VIDEO_INDICATOR_FILTER === 'true';

// --- Service URLs & API Keys ---
export const BITMAGNET_URL = process.env.BITMAGNET_URL || 'http://YOUR_BITMAGNET_URL';
export const JACKETT_URL = process.env.JACKETT_URL || 'http://YOUR_JACKETT_IP:9117';
export const JACKETT_API_KEY = process.env.JACKETT_API_KEY || '';
export const JACKETT_TIMEOUT = parseInt(process.env.JACKETT_TIMEOUT, 10) || 10000; // Jackett queries multiple indexers
export const TORRENTIO_URL = process.env.TORRENTIO_URL || 'https://torrentio.strem.fun';
// Zilean requires a self-hosted instance or paid elfhosted subscription
// Default public endpoint may not be available - configure your own ZILEAN_URL
export const ZILEAN_URL = process.env.ZILEAN_URL || '';
export const COMET_URL = process.env.COMET_URL || 'https://comet.elfhosted.com';
export const STREMTHRU_URL = process.env.STREMTHRU_URL || 'https://stremthru.elfhosted.com';
export const TORRENTGALAXY_URL = process.env.TORRENT_GALAXY_URL || 'https://torrentgalaxy.space';
export const TORRENT9_URL = process.env.TORRENT9_URL || 'https://www.torrent9.town';
export const TORRENT_1337X_URL = process.env.TORRENT_1337X_URL || 'https://1337x.bz';
export const BTDIG_URL = process.env.BTDIG_URL || 'https://btdig.com';
export const MAGNETDL_URL = process.env.MAGNETDL_URL || 'https://magnetdl.homes';
export const MAGNETDL_PROXY = process.env.MAGNETDL_PROXY || '';
export const WOLFMAX4K_URL = process.env.WOLFMAX4K_URL || 'https://wolfmax4k.com';
export const BLUDV_URL = process.env.BLUDV_URL || 'https://bludv.net';
export const KNABEN_URL = process.env.KNABEN_URL || 'https://api.knaben.org/v1';
export const EXTTO_URL = process.env.EXTTO_URL || 'https://ext.to';
export const TORRENTDOWNLOAD_URL = process.env.TORRENTDOWNLOAD_URL || 'https://torrentdownload.info';
export const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || '';
export const FLARESOLVERR_V2 = process.env.FLARESOLVERR_V2 === 'true';
export const FLARESOLVERR_PROXY_URL = process.env.FLARESOLVERR_PROXY_URL || '';
export const OUO_COOKIE = process.env.OUO_COOKIE || '';
export const VIEWCRATE_COOKIE = process.env.VIEWCRATE_COOKIE || '';
export const MKVDRAMA_COOKIE = process.env.MKVDRAMA_COOKIE || '';
export const HTTP_STREAM_USER_AGENT = process.env.HTTP_STREAM_USER_AGENT || '';

// --- Scraper Settings ---
export const SCRAPER_TIMEOUT = parseInt(process.env.SCRAPER_TIMEOUT, 10) || 5000;
export const TORZNAB_LIMIT = parseInt(process.env.TORZNAB_LIMIT, 10) || 50;
export const ZILEAN_LIMIT = parseInt(process.env.ZILEAN_LIMIT, 10) || 75;
export const TORRENT_1337X_LIMIT = parseInt(process.env.TORRENT_1337X_LIMIT, 10) || 200;
export const TORRENT_1337X_MAX_PAGES = parseInt(process.env.TORRENT_1337X_MAX_PAGES, 10) || 5;
export const BTDIG_LIMIT = parseInt(process.env.BTDIG_LIMIT, 10) || 50;
export const BTDIG_MAX_PAGES = parseInt(process.env.BTDIG_MAX_PAGES, 10) || 5;
export const BTDIG_PROXY_URL = process.env.BTDIG_PROXY_URL || '';
export const BTDIG_USE_PROXIES = process.env.BTDIG_USE_PROXIES === 'true';
export const MAGNETDL_LIMIT = parseInt(process.env.MAGNETDL_LIMIT, 10) || 200;
export const BLUDV_LIMIT = parseInt(process.env.BLUDV_LIMIT, 10) || 50;
export const BLUDV_TIMEOUT = parseInt(process.env.BLUDV_TIMEOUT, 10) || 8000;
export const KNABEN_LIMIT = parseInt(process.env.KNABEN_LIMIT, 10) || 300;
export const KNABEN_TIMEOUT = parseInt(process.env.KNABEN_TIMEOUT, 10) || 5000; // Knaben API needs more time
export const EXTTO_LIMIT = parseInt(process.env.EXTTO_LIMIT, 10) || 200;
export const EXTTO_MAX_PAGES = parseInt(process.env.EXTTO_MAX_PAGES, 10) || 2;
export const EXTTO_TIMEOUT = parseInt(process.env.EXTTO_TIMEOUT, 10) || 65000; // FlareSolverr needs more time
export const EXTTO_FLARESOLVERR_MAX_CONCURRENT = parseInt(process.env.EXTTO_FLARESOLVERR_MAX_CONCURRENT, 10) || 5;
export const EXTTO_FLARESOLVERR_QUEUE_TIMEOUT_MS = parseInt(process.env.EXTTO_FLARESOLVERR_QUEUE_TIMEOUT_MS, 10) || 60000;
export const TORRENTDOWNLOAD_LIMIT = parseInt(process.env.TORRENTDOWNLOAD_LIMIT, 10) || 100;
export const TORRENTDOWNLOAD_MAX_PAGES = parseInt(process.env.TORRENTDOWNLOAD_MAX_PAGES, 10) || 2;
export const TORRENTDOWNLOAD_TIMEOUT = parseInt(process.env.TORRENTDOWNLOAD_TIMEOUT, 10) || 10000;
export const ILCORSARONERO_URL = process.env.ILCORSARONERO_URL || 'https://ilcorsaronero.link';
export const ILCORSARONERO_LIMIT = parseInt(process.env.ILCORSARONERO_LIMIT, 10) || 25;
export const ILCORSARONERO_TIMEOUT = parseInt(process.env.ILCORSARONERO_TIMEOUT, 10) || 15000;
export const ILCORSARONERO_DETAIL_CONCURRENCY = parseInt(process.env.ILCORSARONERO_DETAIL_CONCURRENCY, 10) || 5;
export const THEPIRATEBAY_URL = process.env.THEPIRATEBAY_URL || 'https://apibay.org';
export const THEPIRATEBAY_LIMIT = parseInt(process.env.THEPIRATEBAY_LIMIT, 10) || 100;

// --- Scraper Enable/Disable Flags ---
export const BITMAGNET_ENABLED = process.env.BITMAGNET_ENABLED === 'true';
export const JACKETT_ENABLED = process.env.JACKETT_ENABLED === 'true';
export const TORRENTIO_ENABLED = process.env.TORRENTIO_ENABLED === 'true';
export const ZILEAN_ENABLED = process.env.ZILEAN_ENABLED === 'true';
export const COMET_ENABLED = process.env.COMET_ENABLED === 'true';
export const STREMTHRU_ENABLED = process.env.STREMTHRU_ENABLED === 'true';
export const TORRENT_GALAXY_ENABLED = process.env.TORRENT_GALAXY_ENABLED !== 'false';
export const TORRENT9_ENABLED = process.env.TORRENT9_ENABLED === 'true';
export const SNOWFL_ENABLED = process.env.SNOWFL_ENABLED === 'true';
export const TORRENT_1337X_ENABLED = process.env.TORRENT_1337X_ENABLED === 'true';
export const BTDIG_ENABLED = process.env.BTDIG_ENABLED === 'true';
export const MAGNETDL_ENABLED = process.env.MAGNETDL_ENABLED === 'true';
export const WOLFMAX4K_ENABLED = process.env.WOLFMAX4K_ENABLED === 'true';
export const BLUDV_ENABLED = process.env.BLUDV_ENABLED === 'true';
export const KNABEN_ENABLED = process.env.KNABEN_ENABLED === 'true';
export const EXTTO_ENABLED = process.env.EXTTO_ENABLED === 'true';
export const TORRENTDOWNLOAD_ENABLED = process.env.TORRENTDOWNLOAD_ENABLED !== 'false';
export const ILCORSARONERO_ENABLED = process.env.ILCORSARONERO_ENABLED === 'true';
export const THEPIRATEBAY_ENABLED = process.env.THEPIRATEBAY_ENABLED === 'true';

// --- Real-Debrid Specific Priority & Filtering Configuration ---

// General Skips
export const PRIORITY_SKIP_WEBRIP_ENABLED = process.env.PRIORITY_SKIP_WEBRIP_ENABLED === 'true';
export const PRIORITY_SKIP_AAC_OPUS_ENABLED = process.env.PRIORITY_SKIP_AAC_OPUS_ENABLED === 'true';

// Quality Quotas
export const MAX_RESULTS_PER_QUALITY = parseInt(process.env.MAX_RESULTS_PER_QUALITY, 10) || 2;
export const MAX_RESULTS_REMUX = parseInt(process.env.MAX_RESULTS_REMUX, 10) || MAX_RESULTS_PER_QUALITY;
export const MAX_RESULTS_BLURAY = parseInt(process.env.MAX_RESULTS_BLURAY, 10) || MAX_RESULTS_PER_QUALITY;
export const MAX_RESULTS_WEBDL = parseInt(process.env.MAX_RESULTS_WEBDL, 10) || MAX_RESULTS_PER_QUALITY;
export const MAX_RESULTS_WEBRIP = parseInt(process.env.MAX_RESULTS_WEBRIP, 10) || 1;
export const MAX_RESULTS_AUDIO = parseInt(process.env.MAX_RESULTS_AUDIO, 10) || 1;
export const MAX_RESULTS_OTHER = parseInt(process.env.MAX_RESULTS_OTHER, 10) || 10;

// Codec Diversity
export const DIVERSIFY_CODECS_ENABLED = process.env.DIVERSIFY_CODECS_ENABLED === 'true';
export const MAX_H265_RESULTS_PER_QUALITY = parseInt(process.env.MAX_H265_RESULTS_PER_QUALITY, 10) || 2;
export const MAX_H264_RESULTS_PER_QUALITY = parseInt(process.env.MAX_H264_RESULTS_PER_QUALITY, 10) || 2;

// Global Limits & Exit Conditions
export const TARGET_CODEC_COUNT = parseInt(process.env.TARGET_CODEC_COUNT, 10) || 10;
export const EARLY_EXIT_QUALITY_THRESHOLD = process.env.EARLY_EXIT_QUALITY_THRESHOLD || 'BluRay';

// --- Performance & Concurrency ---
// Increased default from 10 to 30 for better multi-user support
// Since RD rate limit is 250/min PER TOKEN, higher concurrency is safe
export const RD_CONCURRENCY = parseInt(process.env.RD_CONCURRENCY, 10) || 30;

// --- Season Pack Inspection ---
export const MAX_PACKS_TO_INSPECT = parseInt(process.env.MAX_PACKS_TO_INSPECT, 10) || 5;
export const MAX_PACK_ROUNDS = parseInt(process.env.MAX_PACK_ROUNDS, 10) || 3;

// (Removed) File caching configuration: local file cache is no longer used.



// --- Cache Backend Selection ---
export const CACHE_BACKEND = (process.env.CACHE_BACKEND || 'sqlite').toLowerCase();

// --- Cinemeta SQL Cache ---
export const CINEMETA_SQL_CACHE_ENABLED = process.env.CINEMETA_SQL_CACHE_ENABLED !== 'false';
export const CINEMETA_CACHE_BACKEND = (process.env.CINEMETA_CACHE_BACKEND || CACHE_BACKEND || 'sqlite').toLowerCase();
export const CINEMETA_CACHE_TTL_MS = parseInt(process.env.CINEMETA_CACHE_TTL_MS || '300000', 10); // 5 minutes default
export const CINEMETA_SQLITE_PATH = process.env.CINEMETA_SQLITE_PATH || '';

// --- Postgres Cache (Optional, Shared) ---
export const DATABASE_URL = process.env.DATABASE_URL || '';
export const POSTGRES_URL = process.env.POSTGRES_URL || '';
export const POSTGRES_HOST = process.env.POSTGRES_HOST || 'localhost';
export const POSTGRES_PORT = parseInt(process.env.POSTGRES_PORT, 10) || 5432;
export const POSTGRES_DB = process.env.POSTGRES_DB || 'sootio';
export const POSTGRES_USER = process.env.POSTGRES_USER || 'sootio';
export const POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD || 'sootio';
export const POSTGRES_SSL = process.env.POSTGRES_SSL === 'true';

// --- SQLite Cache (Optional, Global) ---
// Enable to use SQLite-backed magnet cache for all debrid providers
export const SQLITE_CACHE_ENABLED = process.env.SQLITE_CACHE_ENABLED === 'true';
// Default TTL is 30 days unless overridden
export const SQLITE_CACHE_TTL_DAYS = parseInt(process.env.SQLITE_CACHE_TTL_DAYS, 10) || 30;
// HTTP Streams specific cache TTL (default 30 days) - separate from global TTL
export const HTTP_STREAMS_CACHE_TTL_DAYS = parseInt(process.env.HTTP_STREAMS_CACHE_TTL_DAYS, 10) || 30;

// --- Cache Background Refresh Settings ---
// Enable to allow background refresh of cached results
export const CACHE_BACKGROUND_REFRESH_ENABLED = process.env.CACHE_BACKGROUND_REFRESH_ENABLED !== 'false';
// TTL for search cache (in minutes) - typically shorter than magnet cache
export const SEARCH_CACHE_TTL_MINUTES = parseInt(process.env.SEARCH_CACHE_TTL_MINUTES, 10) || 1440; // 24 hours

// --- Adaptive Timeout Settings ---
// Enable adaptive timeouts based on historical P95 response times
export const ADAPTIVE_TIMEOUT_ENABLED = process.env.ADAPTIVE_TIMEOUT_ENABLED !== 'false';
// Buffer to add on top of P95 (0.25 = 25%)
export const ADAPTIVE_TIMEOUT_P95_BUFFER = parseFloat(process.env.ADAPTIVE_TIMEOUT_P95_BUFFER) || 0.25;
// Time window for P95 calculation (in ms, default 1 hour)
export const ADAPTIVE_TIMEOUT_WINDOW_MS = parseInt(process.env.ADAPTIVE_TIMEOUT_WINDOW_MS, 10) || 3600000;
// Minimum samples required before using adaptive timeout
export const ADAPTIVE_TIMEOUT_MIN_SAMPLES = parseInt(process.env.ADAPTIVE_TIMEOUT_MIN_SAMPLES, 10) || 10;
