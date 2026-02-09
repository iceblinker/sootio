/**
 * Scraper Orchestration Module
 *
 * Centralized scraper selection and execution logic.
 * Determines which scrapers to use based on user config and .env settings.
 * Provides smart defaults when user hasn't selected specific scrapers.
 *
 * Key feature: Returns partial results on timeout while continuing scrapers in background.
 * Background results are saved to cache for future requests.
 */

import axios from 'axios';
import * as config from '../config.js';
import * as scrapers from '../common/scrapers.js';
import performanceTracker from './scraper-performance.js';
import * as SqliteCache from './sqlite-cache.js';

const SCRAPER_PERF_ENABLED = process.env.SCRAPER_PERF_ENABLED !== 'false';
const SCRAPER_TOP_N = parseInt(process.env.SCRAPER_TOP_N || '', 10);
const SCRAPER_MIN_SCORE = parseInt(process.env.SCRAPER_MIN_SCORE || '', 10);
const SCRAPER_SLOW_THRESHOLD_MS = parseInt(process.env.SCRAPER_SLOW_THRESHOLD_MS || '', 10);

// Timeout for returning results to user (scrapers continue in background after this)
const SCRAPER_RETURN_TIMEOUT_MS = parseInt(process.env.SCRAPER_RETURN_TIMEOUT_MS || '', 10) || null;
// Minimum results before we consider returning early
const SCRAPER_MIN_RESULTS_FOR_EARLY_RETURN = parseInt(process.env.SCRAPER_MIN_RESULTS_FOR_EARLY_RETURN || '5', 10);
// How long to wait after first results before returning (if we have enough results)
const SCRAPER_EARLY_RETURN_DELAY_MS = parseInt(process.env.SCRAPER_EARLY_RETURN_DELAY_MS || '2000', 10);

function classifyScraperError(error) {
  if (!error) return 'error';
  if (axios.isCancel?.(error) || error.code === 'ERR_CANCELED') return 'aborted';
  const status = error.response?.status;
  const message = String(error.message || '').toLowerCase();
  if (error.code === 'ECONNABORTED' || message.includes('timeout')) return 'timeout';
  // Check both status code and message for 429 (proxy errors may not have response.status)
  if (status === 429 || message.includes('429') || message.includes('rate limit')) return 'rate_limit';
  if (status >= 500) return 'server_error';
  // Check for captcha/cloudflare errors (flagged by scrapers or detected in message)
  if (error.isCaptcha || (status === 403 && message.includes('captcha')) || message.includes('cloudflare')) return 'captcha';
  return 'error';
}

function getSlowThresholdMs(userConfig) {
  if (Number.isFinite(SCRAPER_SLOW_THRESHOLD_MS) && SCRAPER_SLOW_THRESHOLD_MS > 0) {
    return SCRAPER_SLOW_THRESHOLD_MS;
  }
  const baseTimeout = userConfig?.SCRAPER_TIMEOUT ?? config.SCRAPER_TIMEOUT;
  return Math.max(1000, Math.floor(baseTimeout * 0.8));
}

/**
 * Determines which scrapers to use based on user config and .env settings.
 * If user hasn't selected specific scrapers, uses ALL enabled scrapers from .env as default.
 * @param {Object} userConfig - User configuration from manifest
 * @param {string} logPrefix - Log prefix for console messages
 * @param {boolean} forceAll - If true, ignore user selection and return ALL enabled scrapers from .env
 * @returns {Object} Object with scraper names as keys and boolean values
 */
export function getEnabledScrapers(userConfig = {}, logPrefix = 'SCRAPER', forceAll = false) {
  const userScrapers = Array.isArray(userConfig.Scrapers) ? userConfig.Scrapers : [];
  const userIndexerScrapers = Array.isArray(userConfig.IndexerScrapers) ? userConfig.IndexerScrapers : [];

  // Map of scraper IDs to their config flags
  const scraperMap = {
    'jackett': config.JACKETT_ENABLED,
    '1337x': config.TORRENT_1337X_ENABLED,
    'torrent9': config.TORRENT9_ENABLED,
    'btdig': config.BTDIG_ENABLED,
    'snowfl': config.SNOWFL_ENABLED,
    'magnetdl': config.MAGNETDL_ENABLED,
    'torrentgalaxy': config.TORRENT_GALAXY_ENABLED,
    'wolfmax4k': config.WOLFMAX4K_ENABLED,
    'bludv': config.BLUDV_ENABLED,
    'knaben': config.KNABEN_ENABLED,
    'extto': config.EXTTO_ENABLED,
    'torrentdownload': config.TORRENTDOWNLOAD_ENABLED,
    'ilcorsaronero': config.ILCORSARONERO_ENABLED,
    'thepiratebay': config.THEPIRATEBAY_ENABLED,
    'bitmagnet': config.BITMAGNET_ENABLED,
    'zilean': config.ZILEAN_ENABLED,
    'torrentio': config.TORRENTIO_ENABLED,
    'comet': config.COMET_ENABLED,
    'stremthru': config.STREMTHRU_ENABLED
  };

  // If forceAll is true, return ALL enabled scrapers from .env (for background refresh)
  if (forceAll) {
    const enabled = {};
    for (const [name, isEnabled] of Object.entries(scraperMap)) {
      if (isEnabled) {
        enabled[name] = true;
      }
    }
    console.log(`[${logPrefix}] Using ALL enabled scrapers (background): ${Object.keys(enabled).join(', ')}`);
    return enabled;
  }

  // If user has explicitly configured scrapers (ScrapersConfigured flag), use their selection
  // This handles both "user selected specific scrapers" AND "user deselected all scrapers"
  if (userConfig.ScrapersConfigured || userScrapers.length > 0 || userIndexerScrapers.length > 0) {
    const enabled = {};
    for (const scraper of userScrapers) {
      if (scraperMap[scraper]) {
        enabled[scraper] = true;
      }
    }
    for (const scraper of userIndexerScrapers) {
      if (scraperMap[scraper]) {
        enabled[scraper] = true;
      }
    }
    console.log(`[${logPrefix}] User selected scrapers: ${Object.keys(enabled).join(', ') || '(none)'}`);
    return enabled;
  }

  // No scrapers configured by user, use ALL enabled scrapers as default
  const defaults = {};
  for (const [name, isEnabled] of Object.entries(scraperMap)) {
    if (isEnabled) {
      defaults[name] = true;
    }
  }

  console.log(`[${logPrefix}] Using ALL enabled scrapers (default): ${Object.keys(defaults).join(', ')}`);
  return defaults;
}

/**
 * Check if a scraper should be enabled based on user selection
 * @param {string} scraperName - Name of the scraper to check
 * @param {Object} enabledScrapers - Object with enabled scraper flags
 * @returns {boolean} True if scraper should be enabled
 */
export function shouldEnableScraper(scraperName, enabledScrapers) {
  return enabledScrapers[scraperName] === true;
}

/**
 * Orchestrate all scrapers based on user config and return promises.
 * This centralizes the scraper orchestration logic in one place.
 *
 * @param {Object} params - Scraper orchestration parameters
 * @param {string} params.type - Content type ('movie' or 'series')
 * @param {string} params.imdbId - IMDB ID
 * @param {string} params.searchKey - Search query for scrapers
 * @param {string} params.baseSearchKey - Base search query
 * @param {string|number} params.season - Season number (for series)
 * @param {string|number} params.episode - Episode number (for series)
 * @param {AbortSignal} params.signal - Abort signal for cancellation
 * @param {string} params.logPrefix - Log prefix (e.g., 'RD', 'AD', 'TB')
 * @param {Object} params.userConfig - User configuration
 * @param {Array<string>} params.selectedLanguages - Selected languages filter
 * @param {boolean} params.forceAllScrapers - If true, use ALL enabled scrapers (for background refresh)
 * @returns {Promise<Array>} Promise that resolves to array of scraper results
 */
export async function orchestrateScrapers({
  type,
  imdbId,
  searchKey,
  baseSearchKey,
  season,
  episode,
  signal,
  logPrefix,
  userConfig = {},
  selectedLanguages = [],
  forceAllScrapers = false
}) {
  const forceFullScrape = userConfig?.ForceFullScrape === true || userConfig?.FORCE_FULL_SCRAPE === true;
  const enabledScrapers = getEnabledScrapers(userConfig, logPrefix, forceAllScrapers);
  const hasUserSelection = (
    userConfig.ScrapersConfigured ||
    (Array.isArray(userConfig.Scrapers) && userConfig.Scrapers.length > 0) ||
    (Array.isArray(userConfig.IndexerScrapers) && userConfig.IndexerScrapers.length > 0)
  );
  const scraperTasks = [];

  const addScraperTask = (name, run) => {
    scraperTasks.push({ name, run });
  };

  // Helper to add scraper tasks for a given config
  const addScraperTasks = (cfg, key) => {
    // Indexer scrapers (use shouldEnableScraper for consistent filtering)
    if (shouldEnableScraper('torrentio', enabledScrapers)) addScraperTask('torrentio', () => scrapers.searchTorrentio(type, imdbId, signal, logPrefix, cfg));
    if (shouldEnableScraper('zilean', enabledScrapers)) addScraperTask('zilean', () => scrapers.searchZilean(searchKey, season, episode, signal, logPrefix, cfg));
    if (shouldEnableScraper('comet', enabledScrapers)) addScraperTask('comet', () => scrapers.searchComet(type, imdbId, signal, season, episode, logPrefix, cfg));
    if (shouldEnableScraper('stremthru', enabledScrapers)) addScraperTask('stremthru', () => scrapers.searchStremthru(type, imdbId, signal, season, episode, logPrefix, cfg));

    // Torrent scrapers (check user selection)
    if (shouldEnableScraper('bitmagnet', enabledScrapers)) addScraperTask('bitmagnet', () => scrapers.searchBitmagnet(key, signal, logPrefix, cfg));
    if (shouldEnableScraper('jackett', enabledScrapers)) addScraperTask('jackett', () => scrapers.searchJackett(key, signal, logPrefix, cfg));
    if (shouldEnableScraper('torrent9', enabledScrapers)) addScraperTask('torrent9', () => scrapers.searchTorrent9(key, signal, logPrefix, cfg));
    if (shouldEnableScraper('1337x', enabledScrapers)) addScraperTask('1337x', () => scrapers.search1337x(key, signal, logPrefix, cfg));
    if (shouldEnableScraper('btdig', enabledScrapers)) addScraperTask('btdig', () => scrapers.searchBtdig(key, signal, logPrefix, cfg));
    if (shouldEnableScraper('snowfl', enabledScrapers)) addScraperTask('snowfl', () => scrapers.searchSnowfl(key, signal, logPrefix, cfg));
    if (shouldEnableScraper('magnetdl', enabledScrapers)) addScraperTask('magnetdl', () => scrapers.searchMagnetDL(key, signal, logPrefix, cfg));
    if (shouldEnableScraper('torrentgalaxy', enabledScrapers)) addScraperTask('torrentgalaxy', () => scrapers.searchTorrentGalaxy(key, signal, logPrefix, cfg));
    if (shouldEnableScraper('wolfmax4k', enabledScrapers)) addScraperTask('wolfmax4k', () => scrapers.searchWolfmax4K(key, signal, logPrefix, cfg));
    if (shouldEnableScraper('bludv', enabledScrapers)) addScraperTask('bludv', () => scrapers.searchBluDV(key, signal, logPrefix, cfg));
    if (shouldEnableScraper('knaben', enabledScrapers)) addScraperTask('knaben', () => scrapers.searchKnaben(key, signal, logPrefix, cfg));
    if (shouldEnableScraper('extto', enabledScrapers)) addScraperTask('extto', () => scrapers.searchExtTo(key, signal, logPrefix, cfg));
    if (shouldEnableScraper('torrentdownload', enabledScrapers)) addScraperTask('torrentdownload', () => scrapers.searchTorrentDownload(key, signal, logPrefix, cfg));
    if (shouldEnableScraper('ilcorsaronero', enabledScrapers)) addScraperTask('ilcorsaronero', () => scrapers.searchIlCorsaroNero(key, signal, logPrefix, cfg));
    if (shouldEnableScraper('thepiratebay', enabledScrapers)) addScraperTask('thepiratebay', () => scrapers.searchThePirateBay(key, signal, logPrefix, cfg));
  };

  // Execute scrapers based on language selection
  if (selectedLanguages.length === 0) {
    const cfg = { ...userConfig, Languages: [] };
    const key = baseSearchKey;
    addScraperTasks(cfg, key);
  } else {
    for (const lang of selectedLanguages) {
      const cfg = { ...userConfig, Languages: [lang] };
      const key = baseSearchKey;
      addScraperTasks(cfg, key);
    }
  }

  if (scraperTasks.length === 0) {
    console.error(`[${logPrefix}] No scrapers enabled after filtering`);
    return [];
  }

  const slowThresholdMs = getSlowThresholdMs(userConfig);
  let selectedTasks = scraperTasks;

  if (SCRAPER_PERF_ENABLED) {
    const enabledNames = [...new Set(scraperTasks.map(task => task.name))];
    const penalized = enabledNames.filter(name => performanceTracker.isPenalized(name));
    const unpenalized = enabledNames.filter(name => !performanceTracker.isPenalized(name));

    if (penalized.length > 0) {
      console.error(`[${logPrefix}] Skipping penalized scrapers: ${penalized.join(', ')}`);
    }

    if (unpenalized.length === 0) {
      console.error(`[${logPrefix}] All enabled scrapers are penalized; running all as fallback`);
      selectedTasks = scraperTasks;
    } else if (!hasUserSelection && !forceAllScrapers) {
      const options = {};
      if (Number.isFinite(SCRAPER_TOP_N) && SCRAPER_TOP_N > 0) options.topN = SCRAPER_TOP_N;
      if (Number.isFinite(SCRAPER_MIN_SCORE) && SCRAPER_MIN_SCORE > 0) options.minScore = SCRAPER_MIN_SCORE;
      const selectedNames = performanceTracker.selectScrapers(unpenalized, options);
      selectedTasks = scraperTasks.filter(task => selectedNames.includes(task.name));
      console.log(`[${logPrefix}] Selected scrapers: ${selectedTasks.map(task => task.name).join(', ')}`);
    } else {
      selectedTasks = scraperTasks.filter(task => unpenalized.includes(task.name));
    }
  }

  const stremthruTasks = scraperTasks.filter(task => task.name === 'stremthru');
  if (stremthruTasks.length > 0) {
    const selectedNames = new Set(selectedTasks.map(task => task.name));
    if (!selectedNames.has('stremthru')) {
      selectedTasks = selectedTasks.concat(stremthruTasks);
      console.log(`[${logPrefix}] Forcing stremthru to run for Torz API checks`);
    }
  }

  if (selectedTasks.length === 0) {
    console.error(`[${logPrefix}] No scrapers selected after performance filtering`);
    return [];
  }

  const orchestrationStart = Date.now();
  const baseTimeout = userConfig?.SCRAPER_TIMEOUT ?? config.SCRAPER_TIMEOUT;

  // Create local AbortController to cancel background scrapers when returning early
  // This prevents long-running scrapers from consuming rate limit tokens after we've returned results
  const localAbortController = new AbortController();
  const combinedSignal = signal
    ? { aborted: signal.aborted || localAbortController.signal.aborted, addEventListener: (type, listener) => {
        signal.addEventListener(type, listener);
        localAbortController.signal.addEventListener(type, listener);
      }}
    : localAbortController.signal;

  // Calculate return timeout - when to return partial results to user
  // Use SCRAPER_RETURN_TIMEOUT_MS if set, otherwise align with SCRAPER_TIMEOUT
  // (and cap it to the overall search timeout as a safety net).
  const searchTimeout = parseInt(process.env.SEARCH_TIMEOUT_MS || '15000', 10);
  const returnTimeout = Math.min(
    searchTimeout,
    SCRAPER_RETURN_TIMEOUT_MS || baseTimeout || Math.floor(searchTimeout * 0.8)
  );

  // Track results as they come in
  const collectedResults = [];
  const completedScrapers = new Set();
  const pendingScrapers = new Map(); // name -> { promise, resolve, reject }
  let firstResultTime = null;
  let hasReturned = false;
  let returnResolve = null;

  // Build cache key for saving background results
  const cacheKey = `scraper-bg:${type}:${imdbId}:${season || ''}:${episode || ''}`;

  // Create wrapped promises that track completion and collect results
  const scraperPromises = selectedTasks.map((task, index) => {
    const start = Date.now();

    const wrappedPromise = (async () => {
      try {
        const result = await task.run();
        const duration = Date.now() - start;
        const resultCount = Array.isArray(result) ? result.length : 0;

        if (SCRAPER_PERF_ENABLED) {
          const likelyTimeout = resultCount === 0 && duration >= Math.max(Math.floor(baseTimeout * 0.9), slowThresholdMs);
          if (likelyTimeout) {
            performanceTracker.recordFailure(task.name, 'timeout', duration, 'empty-results-timeout');
          } else {
            performanceTracker.recordSuccess(task.name, resultCount, duration);
          }
        }

        if (duration > slowThresholdMs) {
          console.error(`[${logPrefix} SCRAPER] Slow ${task.name} took ${duration}ms (${resultCount} results)`);
        }

        // Track first result time for early return logic
        if (resultCount > 0 && !firstResultTime) {
          firstResultTime = Date.now();
        }

        // Collect results
        if (Array.isArray(result) && result.length > 0) {
          collectedResults.push(...result);
          console.log(`[${logPrefix}] ${task.name} returned ${resultCount} results (total: ${collectedResults.length})`);
        }

        completedScrapers.add(task.name);
        return { name: task.name, result, duration, success: true };
      } catch (error) {
        const duration = Date.now() - start;
        const errorType = classifyScraperError(error);

        if (SCRAPER_PERF_ENABLED && errorType !== 'aborted') {
          performanceTracker.recordFailure(task.name, errorType, duration, error.message);
        }

        if (errorType !== 'aborted' && duration > slowThresholdMs) {
          console.error(`[${logPrefix} SCRAPER] Slow ${task.name} failed after ${duration}ms: ${error.message}`);
        }

        completedScrapers.add(task.name);
        return { name: task.name, error, duration, success: false };
      }
    })();

    pendingScrapers.set(task.name, wrappedPromise);
    return wrappedPromise;
  });

  if (forceFullScrape) {
    await Promise.allSettled(scraperPromises);
    const seenHashes = new Set();
    const dedupedResults = collectedResults.filter(r => {
      const hash = (r.InfoHash || r.hash || r.infoHash || '').toLowerCase();
      if (!hash) return true;
      if (seenHashes.has(hash)) return false;
      seenHashes.add(hash);
      return true;
    });
    console.log(`[${logPrefix}] Full scrape complete: ${dedupedResults.length} results from ${completedScrapers.size}/${selectedTasks.length} scrapers`);
    return [dedupedResults];
  }

  // Promise that resolves when we should return results
  const returnPromise = new Promise((resolve) => {
    returnResolve = resolve;
  });

  // Timer for hard timeout - return whatever we have
  const timeoutId = setTimeout(() => {
    if (!hasReturned) {
      hasReturned = true;
      console.log(`[${logPrefix}] Return timeout (${returnTimeout}ms) reached with ${collectedResults.length} results from ${completedScrapers.size}/${selectedTasks.length} scrapers`);
      returnResolve({ timeout: true, results: [...collectedResults] });
    }
  }, returnTimeout);

  // Early return logic - return quickly if we have enough good results
  const earlyReturnCheck = setInterval(() => {
    if (hasReturned) {
      clearInterval(earlyReturnCheck);
      return;
    }

    // Check if all scrapers completed
    if (completedScrapers.size === selectedTasks.length) {
      hasReturned = true;
      clearTimeout(timeoutId);
      clearInterval(earlyReturnCheck);
      console.log(`[${logPrefix}] All ${selectedTasks.length} scrapers completed with ${collectedResults.length} results`);
      returnResolve({ timeout: false, results: [...collectedResults] });
      return;
    }

    // Check for early return conditions
    if (firstResultTime && collectedResults.length >= SCRAPER_MIN_RESULTS_FOR_EARLY_RETURN) {
      const timeSinceFirstResult = Date.now() - firstResultTime;
      if (timeSinceFirstResult >= SCRAPER_EARLY_RETURN_DELAY_MS) {
        hasReturned = true;
        clearTimeout(timeoutId);
        clearInterval(earlyReturnCheck);
        console.log(`[${logPrefix}] Early return: ${collectedResults.length} results, ${completedScrapers.size}/${selectedTasks.length} scrapers done`);
        returnResolve({ timeout: false, results: [...collectedResults] });
      }
    }
  }, 100);

  // Wait for return signal (either timeout or early return)
  const { timeout: wasTimeout, results: foregroundResults } = await returnPromise;

  const totalDuration = Date.now() - orchestrationStart;
  if (totalDuration > slowThresholdMs) {
    console.error(`[${logPrefix}] Scraper orchestration slow: ${totalDuration}ms across ${completedScrapers.size}/${selectedTasks.length} scrapers`);
  }

  // Abort remaining scrapers when returning early to save resources
  // This prevents long-running scrapers from consuming rate limit tokens
  const remainingScrapers = selectedTasks.filter(t => !completedScrapers.has(t.name));
  if (remainingScrapers.length > 0) {
    console.log(`[${logPrefix}] Aborting ${remainingScrapers.length} remaining scrapers: ${remainingScrapers.map(t => t.name).join(', ')}`);

    // Abort remaining scrapers immediately to free up rate limit tokens
    localAbortController.abort();

    // Brief wait for aborted scrapers to clean up (non-blocking, just for logging)
    setImmediate(async () => {
      try {
        // Wait briefly for scrapers to acknowledge abort (max 2s)
        const abortTimeout = new Promise(resolve => setTimeout(resolve, 2000));
        await Promise.race([Promise.allSettled(scraperPromises), abortTimeout]);

        const backgroundResults = collectedResults.filter(r => !foregroundResults.includes(r));
        if (backgroundResults.length > 0) {
          console.log(`[${logPrefix}] Collected ${backgroundResults.length} additional results before abort`);
        }

        // Save collected hashes to cache for future requests
        if (SqliteCache.isEnabled() && collectedResults.length > 0) {
          try {
            const hashesToCache = [];
            for (const torrent of collectedResults) {
              const hash = (torrent.InfoHash || torrent.hash || torrent.infoHash || '').toLowerCase();
              if (hash && hash.length >= 32) {
                hashesToCache.push({
                  service: 'scraper-results',
                  hash,
                  fileName: torrent.Title || torrent.name || null,
                  size: torrent.Size || torrent.size || null,
                  releaseKey: `${type}:${imdbId}`,
                  category: torrent.category || null,
                  resolution: torrent.resolution || null,
                  data: {
                    source: torrent.source || 'scraper',
                    type,
                    imdbId,
                    season: season || null,
                    episode: episode || null,
                    Title: torrent.Title || torrent.name,
                    Size: torrent.Size || torrent.size
                  }
                });
              }
            }

            if (hashesToCache.length > 0) {
              await SqliteCache.upsertCachedMagnets(hashesToCache);
              console.log(`[${logPrefix}] Cached ${hashesToCache.length} hashes`);
            }
          } catch (cacheError) {
            console.error(`[${logPrefix}] Failed to cache scraper results:`, cacheError.message);
          }
        }
      } catch (bgError) {
        // Expected when aborted - don't log as error
        if (!bgError.message?.includes('abort')) {
          console.error(`[${logPrefix}] Background cleanup error:`, bgError.message);
        }
      }
    });
  }

  // Return results as array of arrays (to maintain compatibility)
  // Filter out duplicates by hash
  const seenHashes = new Set();
  const dedupedResults = foregroundResults.filter(r => {
    const hash = (r.InfoHash || r.hash || r.infoHash || '').toLowerCase();
    if (!hash) return true; // Keep results without hash
    if (seenHashes.has(hash)) return false;
    seenHashes.add(hash);
    return true;
  });

  return [dedupedResults];
}
