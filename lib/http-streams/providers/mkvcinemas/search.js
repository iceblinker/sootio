/**
 * MKVCinemas search helpers
 * Provides search and post parsing utilities for mkvcinemas.pink
 */

import * as cheerio from 'cheerio';
import { makeRequest } from '../../utils/http.js';
import { cleanTitle } from '../../utils/parsing.js';

const BASE_URL = 'https://mkvcinemas.vc';

// Cache configuration
const SEARCH_CACHE_TTL = parseInt(process.env.MKVCINEMAS_SEARCH_CACHE_TTL, 10) || 30 * 60 * 1000; // 30 minutes
const CONTENT_CACHE_TTL = parseInt(process.env.MKVCINEMAS_CONTENT_CACHE_TTL, 10) || 10 * 60 * 1000; // 10 minutes

// In-memory cache only
const searchCache = new Map();
const contentCache = new Map();

function normalizeUrl(href, base = BASE_URL) {
    if (!href) return null;
    try {
        return new URL(href, base).toString();
    } catch {
        return null;
    }
}

export async function scrapeMKVCinemasSearch(query, signal = null) {
    if (!query) return [];

    // MKVCinemas search breaks when query contains colons - strip them
    const cleanQuery = query.replace(/:/g, '').replace(/\s+/g, ' ').trim();

    // Check in-memory cache first (only use if we have actual results)
    const cacheKey = cleanQuery.toLowerCase();
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < SEARCH_CACHE_TTL && Array.isArray(cached.data) && cached.data.length > 0) {
        console.log(`[MKVCinemas] Search cache hit (memory) for "${query}"`);
        return cached.data;
    }

    const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(cleanQuery)}`;
    try {
        const response = await makeRequest(searchUrl, { parseHTML: true, signal });
        if (!response.document) return [];

        const $ = response.document;
        const results = [];
        $('article.entry-card').each((_, el) => {
            const anchor = $(el).find('h2.entry-title a');
            const title = anchor.text().trim();
            const url = normalizeUrl(anchor.attr('href'));

            if (!title || !url) return;

            const yearMatch = title.match(/\b(19|20)\d{2}\b/);
            const poster = $(el).find('img').attr('src') || null;

            results.push({
                title,
                url,
                year: yearMatch ? parseInt(yearMatch[0], 10) : null,
                poster,
                normalizedTitle: cleanTitle(title)
            });
        });

        // Cache the results in memory - only if we have results
        if (results.length > 0) {
            searchCache.set(cacheKey, { data: results, ts: Date.now() });
        }

        return results;
    } catch (error) {
        console.error(`[MKVCinemas] Search failed for "${query}": ${error.message}`);
        return [];
    }
}

export async function loadMKVCinemasContent(postUrl, signal = null) {
    if (!postUrl) return { title: '', downloadPages: [], languages: [] };

    // Check in-memory cache first (only use if we have actual download pages)
    const cached = contentCache.get(postUrl);
    if (cached && Date.now() - cached.ts < CONTENT_CACHE_TTL && cached.data?.downloadPages?.length > 0) {
        console.log(`[MKVCinemas] Content cache hit (memory) for ${postUrl}`);
        return cached.data;
    }

    try {
        const response = await makeRequest(postUrl, { parseHTML: true, signal });
        if (!response.document) {
            return { title: '', downloadPages: [], languages: [] };
        }

        const $ = response.document;
        let title = $('h1.entry-title').text().trim() || $('title').text().trim() || '';
        // Clean up site branding from title (e.g., "Mkvcinemas.com | Mkvcinema | ... - Mkvcinemas" -> just the movie title)
        title = title
            .replace(/^Mkvcinemas?\.com\s*\|\s*Mkvcinemas?\s*\|\s*Hindi Dubbed Dual Audio Movies and Web Series/i, '')
            .replace(/\s*-\s*Mkvcinemas?$/i, '')
            .replace(/\s*\|\s*Mkvcinemas?$/i, '')
            .trim();

        const languages = [];
        $('.series-info .language, li.language, li:contains("Language")').each((_, el) => {
            const text = $(el).text().replace(/Language:/i, '').trim();
            if (text) {
                // Split on common separators: comma, ampersand, slash, plus
                text.split(/[,&/+]+/).forEach(lang => {
                    const cleaned = lang.trim();
                    if (cleaned) languages.push(cleaned);
                });
            }
        });

        const downloadPagesSet = new Set();
        $('.entry-content a[href]').each((_, el) => {
            const href = $(el).attr('href');
            const text = $(el).text().trim();

            // New format: fly2url links with base64-encoded URLs
            if (href && href.includes('fly2url.com')) {
                try {
                    const url = new URL(href);
                    const encodedUrl = url.searchParams.get('url');
                    if (encodedUrl) {
                        const decodedUrl = Buffer.from(encodedUrl, 'base64').toString('utf-8');
                        console.log(`[MKVCinemas] Decoded fly2url: ${decodedUrl}`);
                        downloadPagesSet.add(decodedUrl);
                    }
                } catch (err) {
                    console.log(`[MKVCinemas] Failed to decode fly2url: ${err.message}`);
                }
            }
            // Old format: direct links to download pages
            else if (href && /filesdl|view|downloads?|hubdrive|gdflix|vcloud/i.test(href)) {
                const absolute = normalizeUrl(href, postUrl);
                if (absolute) downloadPagesSet.add(absolute);
            }
        });

        const result = {
            title,
            languages,
            downloadPages: Array.from(downloadPagesSet)
        };

        // Cache the result in memory - only if we have download pages
        if (result.downloadPages.length > 0) {
            contentCache.set(postUrl, { data: result, ts: Date.now() });
        }

        return result;
    } catch (error) {
        console.error(`[MKVCinemas] Failed to load post ${postUrl}: ${error.message}`);
        return { title: '', downloadPages: [], languages: [] };
    }
}
