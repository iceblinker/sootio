import 'dotenv/config';
import { areTitlesSemanticallyEquivalent } from '../lib/util/ai-matcher.js';

async function test(candidate, expected, shouldMatch) {
    console.log(`Testing: "${candidate}" vs "${expected}"...`);
    const start = Date.now();
    const result = await areTitlesSemanticallyEquivalent(candidate, expected);
    const duration = Date.now() - start;

    const icon = result === shouldMatch ? '✅' : '❌';
    console.log(`${icon} Result: ${result} (Expected: ${shouldMatch}) - ${duration}ms`);
}

async function run() {
    console.log('--- Starting AI Semantic Matching Tests ---');

    // Easy matches (should be fast if using regex, but we are testing AI here)
    await test("The Office (US)", "The Office", true);
    await test("Doctor Who (2005)", "Doctor Who", true);

    // Negative matches
    await test("Shameless (US)", "Shameless (UK)", false);
    await test("The Office", "The Office (UK)", false); // Debatable, but usually distinct

    // Tricky matches
    await test("House M.D.", "House", true);
    await test("NCIS: Naval Criminal Investigative Service", "NCIS", true);

    console.log('--- Tests Completed ---');
}

run();
