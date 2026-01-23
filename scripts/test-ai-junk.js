import 'dotenv/config';
import { isJunkRelease } from '../lib/util/ai-matcher.js';

async function test(title, expectedJunk) {
    console.log(`Testing: "${title}"...`);
    const isJunk = await isJunkRelease(title);
    const resultIcon = isJunk === expectedJunk ? '✅' : '❌';
    console.log(`${resultIcon} Result: ${isJunk} (Expected Junk: ${expectedJunk})`);
}

async function run() {
    console.log('--- Starting AI Junk Filter Tests ---');

    await test("Avatar.The.Way.Of.Water.2022.HDCAM.x264-TGx", true);
    await test("Spider-Man.No.Way.Home.2021.1080p.TELESYNC.x264", true); // Regex might catch this, but AI should too
    await test("Avengers.Endgame.2019.2160p.BluRay.x265", false);
    await test("The.Office.S01E01.1080p.WEB-DL", false);

    // Tricky one
    await test("Dune.Part.Two.2024.HQ.CAM.x264", true);

    console.log('--- Tests Completed ---');
}

run();
