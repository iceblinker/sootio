import fetch from 'node-fetch';

const MATCH_CACHE = new Map();
const CACHE_SIZE = 1000;
const ENABLED = process.env.AI_MATCHING_ENABLED === 'true';
// General AI Config (Defaults to local Ollama)
const AI_BASE_URL = process.env.AI_API_BASE || process.env.OLLAMA_URL || 'http://ollama:11434/v1';
const AI_MODEL = process.env.AI_MODEL || process.env.OLLAMA_MODEL || 'llama3.1:8b';
const AI_KEY = process.env.AI_API_KEY || process.env.OLLAMA_API_KEY || 'ollama';

/**
 * AI-powered semantic matcher for titles
 */
export async function areTitlesSemanticallyEquivalent(candidate, expected) {
  if (!ENABLED) return false;
  if (!candidate || !expected) return false;

  // Normalization for cache key
  const key = `${candidate.toLowerCase().trim()}|${expected.toLowerCase().trim()}`;

  // Check cache
  if (MATCH_CACHE.has(key)) {
    return MATCH_CACHE.get(key);
  }

  try {
    const prompt = `
    Determine if these two TV show/movie titles refer to the same content.
    Ignore minor differences in punctuation, case, year suffixes, or regional tags (e.g., US/UK) if they are commonly understandable as the same intellectual property context.
    
    Title 1: "${candidate}"
    Title 2: "${expected}"
    
    Answer strictly with JSON: {"match": true} or {"match": false}.
    `;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout

    // Standard OpenAI-compatible endpoint construction
    const baseURL = AI_BASE_URL.endsWith('/') ? AI_BASE_URL.slice(0, -1) : AI_BASE_URL;
    const endpoint = baseURL.endsWith('/v1') ? `${baseURL}/chat/completions` : `${baseURL}/v1/chat/completions`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AI_KEY}`
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          { role: "system", content: "You are a precise title matching assistant. Output valid JSON only." },
          { role: "user", content: prompt }
        ],
        temperature: 0.1,
        response_format: { type: "json_object" }
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`AI API status ${response.status}`);
    }

    const data = await response.json();
    let result = false;

    try {
      const content = data.choices[0].message.content;
      const jsonResponse = JSON.parse(content);
      result = jsonResponse.match === true;
    } catch (e) {
      console.warn('[AI-MATCH] JSON parse failed, fallback check', e);
      const text = data.choices?.[0]?.message?.content?.toLowerCase() || '';
      result = text.includes('true') || text.includes('yes');
    }

    // Cache result
    if (MATCH_CACHE.size >= CACHE_SIZE) {
      const firstKey = MATCH_CACHE.keys().next().value;
      MATCH_CACHE.delete(firstKey);
    }
    MATCH_CACHE.set(key, result);

    if (result) {
      console.log(`[AI-MATCH] Matched: "${candidate}" == "${expected}"`);
    }

    return result;

  } catch (error) {
    console.warn(`[AI-MATCH] Failed: ${error.message}`);
    return false; // Fail safe
  }
}

/**
 * AI-powered junk detector
 */
export async function isJunkRelease(title) {
  if (!ENABLED) return false;
  if (!title) return false;

  const key = `junk:${title.toLowerCase().trim()}`;
  if (MATCH_CACHE.has(key)) return MATCH_CACHE.get(key);

  try {
    const prompt = `
    Analyze this release title: "${title}"
    Is it a "Junk" release (CAM, TS, Telesync, Pre-DVD, Screener, or otherwise unwatchable quality)?
    Ignore 4K/1080p Web-DLs, WebRips, or Blurays - those are NOT junk.
    Answer strictly with JSON: {"is_junk": true} or {"is_junk": false}.
    `;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000); // 3s timeout

    // Standard OpenAI-compatible endpoint construction
    const baseURL = AI_BASE_URL.endsWith('/') ? AI_BASE_URL.slice(0, -1) : AI_BASE_URL;
    const endpoint = baseURL.endsWith('/v1') ? `${baseURL}/chat/completions` : `${baseURL}/v1/chat/completions`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AI_KEY}`
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          { role: "system", content: "You are a quality control bot. Output valid JSON only." },
          { role: "user", content: prompt }
        ],
        temperature: 0.1,
        response_format: { type: "json_object" }
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) throw new Error(`AI API status ${response.status}`);

    const data = await response.json();
    let result = false;

    try {
      const content = data.choices[0].message.content;
      const jsonResponse = JSON.parse(content);
      result = jsonResponse.is_junk === true;
    } catch (e) {
      const text = data.choices?.[0]?.message?.content?.toLowerCase() || '';
      result = text.includes('true') || text.includes('yes');
    }

    if (MATCH_CACHE.size >= CACHE_SIZE) MATCH_CACHE.delete(MATCH_CACHE.keys().next().value);
    MATCH_CACHE.set(key, result);

    if (result) console.log(`[AI-JUNK] Flagged as junk: "${title}"`);

    return result;

  } catch (error) {
    console.warn(`[AI-JUNK] Failed: ${error.message}`);
    return false;
  }
}
}

/**
 * AI-powered HTML link extractor (Resilient Parsing)
 * Falls back to AI when regex fails to match standard site patterns.
 */
export async function extractLinksFromHtml(htmlSnippet) {
  if (!ENABLED) return [];
  if (!htmlSnippet || htmlSnippet.length < 50) return [];

  try {
    // Truncate HTML to avoid token limits (approx 1500 chars should be enough for a relevant snippet)
    const cleanHtml = htmlSnippet.replace(/\s+/g, ' ').substring(0, 2000);

    const prompt = `
    Extract download links from this HTML snippet.
    Look for magnet links, .torrent links, or file host links (Google Drive, PixelDrain, 1fichier, etc.).
    Ignore navigation links or ads.
    
    HTML: "${cleanHtml}"
    
    Answer strictly with JSON array of objects: 
    [{"title": "Release Name or Filename", "link": "https://...", "size": "1.2GB" (optional)}]
    If none found, return [].
    `;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s generous timeout for extraction

    const baseURL = AI_BASE_URL.endsWith('/') ? AI_BASE_URL.slice(0, -1) : AI_BASE_URL;
    const endpoint = baseURL.endsWith('/v1') ? `${baseURL}/chat/completions` : `${baseURL}/v1/chat/completions`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AI_KEY}`
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          { role: "system", content: "You are a specialized HTML scraper. Output valid JSON only." },
          { role: "user", content: prompt }
        ],
        temperature: 0.1,
        response_format: { type: "json_object" }
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) throw new Error(`AI API status ${response.status}`);

    const data = await response.json();
    let links = [];

    try {
      const content = data.choices[0].message.content;
      const jsonResponse = JSON.parse(content);
      // Handle various JSON structures LLM might return
      if (Array.isArray(jsonResponse)) {
        links = jsonResponse;
      } else if (jsonResponse.links && Array.isArray(jsonResponse.links)) {
        links = jsonResponse.links;
      } else if (jsonResponse.results && Array.isArray(jsonResponse.results)) {
        links = jsonResponse.results;
      }
    } catch (e) {
      console.warn('[AI-HTML] JSON parse failed', e);
    }

    if (links.length > 0) {
      console.log(`[AI-HTML] Extracted ${links.length} links using AI`);
    }

    return links;

  } catch (error) {
    console.warn(`[AI-HTML] Extraction failed: ${error.message}`);
    return [];
  }
}
