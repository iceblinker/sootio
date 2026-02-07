import * as cheerio from 'cheerio';
import { makeRequest } from '../../utils/http.js';
import { extractCleanQuality } from '../../utils/quality.js';
import { extractLanguageInfoFromHeader } from '../../utils/language.js';

// Function to extract download links from a movie page
export async function extractDownloadLinks(moviePageUrl, targetYear = null) {
  try {
    console.log(`[UHDMovies] Extracting links from: ${moviePageUrl}`);
    const response = await makeRequest(moviePageUrl);
    const $ = cheerio.load(response.data);

    const movieTitle = $('h1').first().text().trim();
    const downloadLinks = [];

    // Find all download links (the new SID links) and their associated quality information
    // Look for any links that might be SID links - be more inclusive to catch various patterns
    $('a').each((index, element) => {
      const href = $(element).attr('href') || '';
      // Only process links that have potential SID domains or known patterns
      if (!href.includes('tech.unblockedgames.world') &&
          !href.includes('tech.examzculture.in') &&
          !href.includes('tech.creativeexpressionsblog.com') &&
          !href.includes('gamerxyt.com') &&
          !href.includes('hubcloud.php') &&
          !href.includes('driveleech') &&
          !href.includes('driveseed')) {
        return; // Skip links that don't match any known SID patterns
      }
      const link = $(element).attr('href');

      if (link && !downloadLinks.some(item => item.link === link)) {
        let quality = 'Unknown Quality';
        let size = 'Unknown';

        // Method 1: Look for quality in the closest preceding paragraph or heading
        const prevElement = $(element).closest('p').prev();
        if (prevElement.length > 0) {
          const prevText = prevElement.text().trim();
          if (prevText && prevText.length > 20 && !prevText.includes('Download')) {
            quality = prevText;
          }
        }

        // Method 2: Look for quality in parent's siblings
        if (quality === 'Unknown Quality') {
          const parentSiblings = $(element).parent().prevAll().first().text().trim();
          if (parentSiblings && parentSiblings.length > 20) {
            quality = parentSiblings;
          }
        }

        // Method 3: Look for bold/strong text above the link
        if (quality === 'Unknown Quality') {
          const strongText = $(element).closest('p').prevAll().find('strong, b').last().text().trim();
          if (strongText && strongText.length > 20) {
            quality = strongText;
          }
        }

        // Method 4: Look for the entire paragraph containing quality info
        if (quality === 'Unknown Quality') {
          let currentElement = $(element).parent();
          for (let i = 0; i < 5; i++) {
            currentElement = currentElement.prev();
            if (currentElement.length === 0) break;

            const text = currentElement.text().trim();
            if (text && text.length > 30 &&
              (text.includes('1080p') || text.includes('720p') || text.includes('2160p') ||
                text.includes('4K') || text.includes('HEVC') || text.includes('x264') || text.includes('x265'))) {
              quality = text;
              break;
            }
          }
        }

        // Year-based filtering for collections
        if (targetYear && quality !== 'Unknown Quality') {
          // Check for years in quality text
          // Use negative lookahead to exclude quality resolutions like 2160p, 1080p, 720p, etc.
          const yearMatches = quality.match(/\b(\d{4})(?!p\b)/g);
          let hasMatchingYear = false;

          if (yearMatches && yearMatches.length > 0) {
            // Filter to valid movie year range to avoid false positives from file sizes (e.g. 2000MB, 1998MB)
            const validYears = yearMatches.filter(y => {
              const yr = parseInt(y.replace(/[()]/g, ''));
              return yr >= 1900 && yr <= 2030;
            });
            if (validYears.length > 0) {
              for (const yearMatch of validYears) {
                const year = parseInt(yearMatch.replace(/[()]/g, ''));
                if (year === targetYear) {
                  hasMatchingYear = true;
                  break;
                }
              }
              if (!hasMatchingYear) {
                console.log(`[UHDMovies] Skipping link due to year mismatch. Target: ${targetYear}, Found: ${validYears.join(', ')} in "${quality}"`);
                return; // Skip this link
              }
            }
          } else {
            // If no year in quality text, check filename and other indicators
            const linkText = $(element).text().trim();
            const parentText = $(element).parent().text().trim();
            const combinedText = `${quality} ${linkText} ${parentText}`;

            // Look for years in combined text (exclude quality resolutions like 2160p, 1080p)
            const allYearMatches = combinedText.match(/\b(\d{4})(?!p\b)/g);
            if (allYearMatches) {
              let foundTargetYear = false;
              for (const yearMatch of allYearMatches) {
                const year = parseInt(yearMatch.replace(/[()]/g, ''));
                if (year >= 1900 && year <= 2030) { // Valid movie year range
                  if (year === targetYear) {
                    foundTargetYear = true;
                    break;
                  }
                }
              }
              if (!foundTargetYear && allYearMatches.length > 0) {
                console.log(`[UHDMovies] Skipping link due to no matching year found. Target: ${targetYear}, Found years: ${allYearMatches.join(', ')} in combined text`);
                return; // Skip this link
              }
            }

            // Additional check: if quality contains movie names that don't match target year
            const lowerQuality = quality.toLowerCase();
            if (targetYear === 2015) {
              if (lowerQuality.includes('wasp') || lowerQuality.includes('quantumania')) {
                console.log(`[UHDMovies] Skipping link for 2015 target as it contains 'wasp' or 'quantumania': "${quality}"`);
                return; // Skip this link
              }
            }
          }
        }

        // Extract size from quality text if present
        const sizeMatch = quality.match(/[[\]]([0-9.,]+\s*[KMGT]B[^`\]]*)[[\]]/);
        if (sizeMatch) {
          size = sizeMatch[1];
        }

        // Clean up the quality information
        const cleanQuality = extractCleanQuality(quality);

        downloadLinks.push({
          quality: cleanQuality,
          size: size,
          link: link,
          rawQuality: quality.replace(/(\r\n|\n|\r)/gm, " ").replace(/\s+/g, ' ').trim(),
          languageInfo: extractLanguageInfoFromHeader(quality)
        });
      }
    });

    // Sort links by resolution (highest first), then by size (largest to smallest)
    const sortedLinks = downloadLinks.sort((a, b) => {
      // Helper function to extract resolution value in pixels
      const getResolution = (quality) => {
        if (quality.includes('2160p') || quality.includes('4K')) return 2160;
        if (quality.includes('1440p')) return 1440;
        if (quality.includes('1080p')) return 1080;
        if (quality.includes('720p')) return 720;
        if (quality.includes('480p')) return 480;
        return 0; // Unknown
      };

      // Helper function to parse size to MB for comparison
      const parseSize = (sizeStr) => {
        if (!sizeStr || sizeStr === 'Unknown') return -1; // Unknown sizes go to the end
        const match = sizeStr.match(/([0-9.]+)\s*(GB|MB)/i);
        if (!match) return -1;
        const value = parseFloat(match[1]);
        const unit = match[2].toUpperCase();
        return unit === 'GB' ? value * 1024 : value;
      };

      const resA = getResolution(a.quality);
      const resB = getResolution(b.quality);

      // First sort by resolution (highest first)
      if (resA !== resB) {
        return resB - resA;
      }

      // Then sort by size (largest to smallest)
      const sizeA = parseSize(a.size);
      const sizeB = parseSize(b.size);
      return sizeB - sizeA;
    });

    return {
      title: movieTitle,
      links: sortedLinks
    };

  } catch (error) {
    console.error(`[UHDMovies] Error extracting download links: ${error.message}`);
    return { title: 'Unknown', links: [] };
  }
}
