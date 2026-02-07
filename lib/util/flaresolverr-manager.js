/**
 * FlareSolverr Manager
 * Provides global rate limiting, circuit breaker, and overload protection for FlareSolverr
 */

import axios from 'axios';
import * as config from '../config.js';

// Configuration
const FLARESOLVERR_URL = config.FLARESOLVERR_URL || process.env.FLARESOLVERR_URL || '';
const MAX_CONCURRENT = parseInt(process.env.FLARESOLVERR_MAX_CONCURRENT, 10) || 2; // Reduced from 3
const QUEUE_MAX_DEPTH = parseInt(process.env.FLARESOLVERR_QUEUE_MAX_DEPTH, 10) || 10; // Reduced from 30
const CIRCUIT_BREAKER_THRESHOLD = parseInt(process.env.FLARESOLVERR_CIRCUIT_THRESHOLD, 10) || 3; // Reduced from 10
const CIRCUIT_BREAKER_RESET_MS = parseInt(process.env.FLARESOLVERR_CIRCUIT_RESET_MS, 10) || 120000; // Increased from 60s
const TIMEOUT_THRESHOLD_MS = parseInt(process.env.FLARESOLVERR_TIMEOUT_THRESHOLD_MS, 10) || 30000; // Consider slow if >30s

// Per-IP rate limiting
const PER_IP_HOURLY_LIMIT = parseInt(process.env.FLARESOLVERR_PER_IP_HOURLY_LIMIT, 10) || 30; // Max FlareSolverr requests per IP per hour
const IP_TRACKING_WINDOW_MS = 60 * 60 * 1000; // 1 hour window
const DIRECT_FIRST_DOMAINS = new Set([
    'hubcloud.foo', 'hubcloud.fyi', 'hubcloud.one', 'hubcloud.lol',
    'hubdrive.dad', 'hubdrive.co', 'hubcdn.fans'
]);

// State
let activeCalls = 0;
const pendingQueue = [];
let circuitFailures = 0;
let circuitOpenedAt = null;
let lastQueueWarningTime = 0;
let consecutiveSlowResponses = 0;
let lastResponseTime = 0;

// Per-IP request tracking: Map<ip, { count: number, windowStart: number }>
const ipRequestCounts = new Map();
let lastIpCleanup = Date.now();

// Domain-level cookie cache (shared across all extraction calls)
const domainCookieCache = new Map(); // domain -> { cookies, userAgent, timestamp, directAccessOk }
const COOKIE_CACHE_TTL = parseInt(process.env.FLARESOLVERR_COOKIE_TTL_MS, 10) || 30 * 60 * 1000; // 30 minutes

// Metrics
const metrics = {
    totalCalls: 0,
    directSuccesses: 0,
    flaresolverrCalls: 0,
    flaresolverrSuccesses: 0,
    flaresolverrFailures: 0,
    circuitBreakerTrips: 0,
    queueOverflows: 0,
    cacheHits: 0
};

/**
 * Get the current queue depth and load status
 */
export function getStatus() {
    return {
        activeCalls,
        queueDepth: pendingQueue.length,
        circuitOpen: isCircuitOpen(),
        metrics: { ...metrics }
    };
}

/**
 * Check if FlareSolverr is available and not overloaded
 * @param {string} clientIp - Optional client IP for per-IP rate limiting
 */
export function isAvailable(clientIp = null) {
    if (!FLARESOLVERR_URL) return false;
    if (isCircuitOpen()) return false;
    if (pendingQueue.length >= QUEUE_MAX_DEPTH) return false;
    // Check per-IP limit if IP provided
    if (clientIp && isIpRateLimited(clientIp)) return false;
    return true;
}

/**
 * Check if an IP has exceeded its hourly rate limit
 * @param {string} ip - Client IP address
 * @returns {boolean} True if rate limited
 */
export function isIpRateLimited(ip) {
    if (!ip || PER_IP_HOURLY_LIMIT <= 0) return false;

    cleanupExpiredIpCounts();

    const record = ipRequestCounts.get(ip);
    if (!record) return false;

    const now = Date.now();
    if (now - record.windowStart >= IP_TRACKING_WINDOW_MS) {
        // Window expired, reset
        ipRequestCounts.delete(ip);
        return false;
    }

    return record.count >= PER_IP_HOURLY_LIMIT;
}

/**
 * Record a FlareSolverr request for an IP
 * @param {string} ip - Client IP address
 */
export function recordIpRequest(ip) {
    if (!ip || PER_IP_HOURLY_LIMIT <= 0) return;

    const now = Date.now();
    const record = ipRequestCounts.get(ip);

    if (!record || (now - record.windowStart >= IP_TRACKING_WINDOW_MS)) {
        // New window
        ipRequestCounts.set(ip, { count: 1, windowStart: now });
    } else {
        record.count++;
    }
}

/**
 * Get remaining FlareSolverr requests for an IP in current hour
 * @param {string} ip - Client IP address
 * @returns {number} Remaining requests (-1 if unlimited)
 */
export function getIpRemainingRequests(ip) {
    if (!ip || PER_IP_HOURLY_LIMIT <= 0) return -1;

    const record = ipRequestCounts.get(ip);
    if (!record) return PER_IP_HOURLY_LIMIT;

    const now = Date.now();
    if (now - record.windowStart >= IP_TRACKING_WINDOW_MS) {
        return PER_IP_HOURLY_LIMIT;
    }

    return Math.max(0, PER_IP_HOURLY_LIMIT - record.count);
}

/**
 * Clean up expired IP tracking records (called periodically)
 */
function cleanupExpiredIpCounts() {
    const now = Date.now();
    // Only cleanup every 5 minutes
    if (now - lastIpCleanup < 5 * 60 * 1000) return;
    lastIpCleanup = now;

    for (const [ip, record] of ipRequestCounts.entries()) {
        if (now - record.windowStart >= IP_TRACKING_WINDOW_MS) {
            ipRequestCounts.delete(ip);
        }
    }
}

/**
 * Check if the circuit breaker is open (FlareSolverr failing)
 */
function isCircuitOpen() {
    if (circuitOpenedAt === null) return false;
    const elapsed = Date.now() - circuitOpenedAt;
    if (elapsed > CIRCUIT_BREAKER_RESET_MS) {
        // Reset circuit breaker
        circuitOpenedAt = null;
        circuitFailures = 0;
        console.log('[FlareSolverr Manager] Circuit breaker reset');
        return false;
    }
    return true;
}

/**
 * Record a FlareSolverr failure
 */
function recordFailure() {
    circuitFailures++;
    if (circuitFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        circuitOpenedAt = Date.now();
        metrics.circuitBreakerTrips++;
        console.warn(`[FlareSolverr Manager] Circuit breaker OPENED after ${circuitFailures} failures`);
    }
}

/**
 * Record a FlareSolverr success (resets failure counter)
 */
function recordSuccess() {
    circuitFailures = Math.max(0, circuitFailures - 1);
    consecutiveSlowResponses = 0;
}

/**
 * Record a slow response (may trip circuit breaker)
 */
function recordSlowResponse(durationMs) {
    lastResponseTime = durationMs;
    if (durationMs > TIMEOUT_THRESHOLD_MS) {
        consecutiveSlowResponses++;
        console.warn(`[FlareSolverr Manager] Slow response: ${durationMs}ms (consecutive: ${consecutiveSlowResponses})`);
        if (consecutiveSlowResponses >= CIRCUIT_BREAKER_THRESHOLD) {
            circuitOpenedAt = Date.now();
            metrics.circuitBreakerTrips++;
            console.warn(`[FlareSolverr Manager] Circuit breaker OPENED due to slow responses`);
        }
    } else {
        consecutiveSlowResponses = Math.max(0, consecutiveSlowResponses - 1);
    }
}

/**
 * Public function to record a failure from external code
 */
export function reportFailure() {
    recordFailure();
}

/**
 * Public function to record a timeout from external code
 */
export function reportTimeout() {
    consecutiveSlowResponses++;
    recordFailure();
    console.warn(`[FlareSolverr Manager] Timeout reported (consecutive: ${consecutiveSlowResponses}, failures: ${circuitFailures})`);
}

/**
 * Get cached cookies for a domain
 * @param {string} domain - Domain to get cookies for
 * @returns {{ cookies: string, userAgent: string, directAccessOk: boolean } | null}
 */
export function getCachedCookies(domain) {
    const cached = domainCookieCache.get(domain);
    if (!cached) return null;

    // Check TTL
    if (Date.now() - cached.timestamp > COOKIE_CACHE_TTL) {
        domainCookieCache.delete(domain);
        return null;
    }

    metrics.cacheHits++;
    return cached;
}

/**
 * Cache cookies for a domain
 * @param {string} domain - Domain to cache cookies for
 * @param {string} cookies - Cookie string
 * @param {string} userAgent - User agent string
 * @param {boolean} directAccessOk - Whether direct access worked (no FlareSolverr needed)
 */
export function cacheCookies(domain, cookies, userAgent, directAccessOk = false) {
    domainCookieCache.set(domain, {
        cookies,
        userAgent,
        timestamp: Date.now(),
        directAccessOk
    });
    console.log(`[FlareSolverr Manager] Cached cookies for ${domain} (directOk: ${directAccessOk})`);
}

/**
 * Mark that a domain doesn't need FlareSolverr (direct HTTP works)
 * @param {string} domain - Domain to mark
 */
export function markDirectAccessOk(domain) {
    const cached = domainCookieCache.get(domain);
    if (cached) {
        cached.directAccessOk = true;
        cached.timestamp = Date.now();
    } else {
        domainCookieCache.set(domain, {
            cookies: '',
            userAgent: '',
            timestamp: Date.now(),
            directAccessOk: true
        });
    }
    metrics.directSuccesses++;
}

/**
 * Clear cached cookies for a domain
 * @param {string} domain - Domain to clear
 */
export function clearCachedCookies(domain) {
    domainCookieCache.delete(domain);
}

/**
 * Check if a domain should try direct access first
 * @param {string} domain - Domain to check
 * @returns {boolean}
 */
export function shouldTryDirectFirst(domain) {
    // Check if we've cached that direct access works for this domain
    const cached = getCachedCookies(domain);
    if (cached?.directAccessOk) return true;

    // Check if domain is in known "direct-first" list
    return DIRECT_FIRST_DOMAINS.has(domain);
}

/**
 * Acquire a slot for FlareSolverr request (rate limiting)
 * @param {number} timeout - Max wait time in ms
 * @param {string} clientIp - Optional client IP for per-IP rate limiting
 * @returns {Promise<{acquired: boolean, release: Function}>}
 */
export async function acquireSlot(timeout = 30000, clientIp = null) {
    metrics.totalCalls++;

    // Check circuit breaker
    if (isCircuitOpen()) {
        console.warn('[FlareSolverr Manager] Circuit breaker is OPEN, rejecting request');
        return { acquired: false, release: () => {}, reason: 'circuit_open' };
    }

    // Check per-IP rate limit
    if (clientIp && isIpRateLimited(clientIp)) {
        const remaining = getIpRemainingRequests(clientIp);
        console.warn(`[FlareSolverr Manager] IP ${clientIp} rate limited (${remaining} remaining this hour)`);
        return { acquired: false, release: () => {}, reason: 'ip_rate_limited', remaining };
    }

    // Check queue depth
    if (pendingQueue.length >= QUEUE_MAX_DEPTH) {
        const now = Date.now();
        if (now - lastQueueWarningTime > 5000) {
            console.warn(`[FlareSolverr Manager] Queue full (${pendingQueue.length}/${QUEUE_MAX_DEPTH}), rejecting request`);
            lastQueueWarningTime = now;
        }
        metrics.queueOverflows++;
        return { acquired: false, release: () => {}, reason: 'queue_full' };
    }

    // Record this request for the IP
    if (clientIp) {
        recordIpRequest(clientIp);
    }

    // If we have capacity, grant immediately
    if (activeCalls < MAX_CONCURRENT) {
        activeCalls++;
        return {
            acquired: true,
            release: () => {
                activeCalls--;
                processQueue();
            }
        };
    }

    // Queue the request
    return new Promise((resolve) => {
        const timeoutId = setTimeout(() => {
            const idx = pendingQueue.findIndex(p => p.resolve === resolve);
            if (idx !== -1) pendingQueue.splice(idx, 1);
            resolve({ acquired: false, release: () => {}, reason: 'timeout' });
        }, timeout);

        pendingQueue.push({
            resolve,
            timeoutId
        });
    });
}

/**
 * Process the pending queue when a slot becomes available
 */
function processQueue() {
    if (activeCalls >= MAX_CONCURRENT || pendingQueue.length === 0) return;

    const next = pendingQueue.shift();
    if (!next) return;

    clearTimeout(next.timeoutId);
    activeCalls++;

    next.resolve({
        acquired: true,
        release: () => {
            activeCalls--;
            processQueue();
        }
    });
}

/**
 * Make a FlareSolverr request with rate limiting
 * @param {string} url - URL to fetch
 * @param {Object} options - Options
 * @returns {Promise<{body: string, cookies: Array, userAgent: string}|null>}
 */
export async function fetchWithFlaresolverr(url, options = {}) {
    if (!FLARESOLVERR_URL) {
        console.log('[FlareSolverr Manager] FlareSolverr not configured');
        return null;
    }

    const { timeout = 45000, headers = {} } = options;

    const slot = await acquireSlot(timeout);
    if (!slot.acquired) {
        console.warn(`[FlareSolverr Manager] Could not acquire slot: ${slot.reason}`);
        return null;
    }

    metrics.flaresolverrCalls++;
    const startTime = Date.now();

    try {
        const requestBody = {
            cmd: 'request.get',
            url,
            maxTimeout: timeout
        };

        if (headers['User-Agent']) {
            requestBody.userAgent = headers['User-Agent'];
        }

        const response = await axios.post(`${FLARESOLVERR_URL}/v1`, requestBody, {
            timeout: timeout + 5000,
            headers: { 'Content-Type': 'application/json' }
        });

        const solution = response?.data?.solution;
        if (!solution?.response) {
            console.log(`[FlareSolverr Manager] No response from FlareSolverr for ${url}`);
            recordFailure();
            metrics.flaresolverrFailures++;
            return null;
        }

        recordSuccess();
        metrics.flaresolverrSuccesses++;

        const duration = Date.now() - startTime;
        console.log(`[FlareSolverr Manager] Success for ${url} in ${duration}ms`);

        return {
            body: solution.response,
            cookies: solution.cookies || [],
            userAgent: solution.userAgent || headers['User-Agent'] || '',
            url: solution.url || url,
            status: solution.status
        };
    } catch (error) {
        console.error(`[FlareSolverr Manager] Error for ${url}: ${error.message}`);
        recordFailure();
        metrics.flaresolverrFailures++;
        return null;
    } finally {
        slot.release();
    }
}

/**
 * Get an "overloaded" error response for HTTP streams
 * Used when FlareSolverr is unavailable/overloaded
 */
export function getOverloadedResponse() {
    return {
        overloaded: true,
        message: 'Server is processing many requests. Please try again in a moment.',
        retryAfter: 30
    };
}

/**
 * Reset all state (for testing)
 */
export function reset() {
    activeCalls = 0;
    pendingQueue.length = 0;
    circuitFailures = 0;
    circuitOpenedAt = null;
    domainCookieCache.clear();
    ipRequestCounts.clear();
    Object.keys(metrics).forEach(k => metrics[k] = 0);
}

export default {
    getStatus,
    isAvailable,
    isIpRateLimited,
    recordIpRequest,
    getIpRemainingRequests,
    getCachedCookies,
    cacheCookies,
    clearCachedCookies,
    markDirectAccessOk,
    shouldTryDirectFirst,
    acquireSlot,
    fetchWithFlaresolverr,
    getOverloadedResponse,
    reportFailure,
    reportTimeout,
    reset
};
