import 'dotenv/config';
import { extractLinksFromHtml } from '../lib/util/ai-matcher.js';
import process from 'process';


// Node 18+ has native fetch, and ai-matcher handles its own imports.


async function run() {
    console.log('--- Starting AI HTML Parser Test ---');

    // Mock HTML that mimics a broken site layout (no standard classes)
    const brokenHtml = `
    <div class="unknown-container">
       <h3>Release: Movie.Title.2024.1080p.WEB-DL</h3>
       <p>Click here to download:</p>
       <a href="magnet:?xt=urn:btih:1234567890abcdef1234567890abcdef12345678&dn=Movie.Title">Magnet Download</a>
       <br>
       <span>Alternative:</span>
       <a href="https://pixeldrain.com/u/12345abc">Direct Link</a>
    </div>
    `;

    console.log('Input HTML length:', brokenHtml.length);
    console.log('Extracting...');

    const start = Date.now();
    const links = await extractLinksFromHtml(brokenHtml);
    const duration = Date.now() - start;

    console.log(`Found ${links.length} links in ${duration}ms`);
    console.log('Results:', JSON.stringify(links, null, 2));

    if (links.length >= 2) {
        console.log('✅ Test Passed: AI successfully found links in broken HTML.');
    } else {
        console.log('❌ Test Failed: AI missed links.');
    }
}

run();
