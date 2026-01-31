import { extractCleanQuality } from '../../utils/quality.js';
import { extractLanguageInfoFromHeader } from '../../utils/language.js';

// Extract a normalized size string from a quality header.
// Handles per-episode suffixes like "[1.3 GB/E]" or ranges like "[9 GB-16 GB/E]".
function extractSize(qualityText) {
  if (!qualityText) return 'Unknown';

  // Capture the primary size (optionally a range) and drop any trailing "/E" style markers.
  // Avoid matching audio bitrates like "640Kbps" by ensuring the unit is not followed by "ps".
  const sizeRegex = /([0-9.,]+\s*[KMGT]B(?!ps)(?:\s*-\s*[0-9.,]+\s*[KMGT]B(?!ps)?)*)(?:\s*\/\s*E(?:P|PISODE)?\b)?/i;
  const match = qualityText.match(sizeRegex);
  if (!match) return 'Unknown';

  return match[1].replace(/\s+/g, ' ').trim();
}

// Extract episode links for tech.unblockedgames.world and tech.examzculture.in patterns
export function extractEpisodeLinksStandard($el, episode, qualityText, downloadLinks, $) {
  // Is this a paragraph with episode links?
  // ONLY select maxbutton links (proper buttons), NOT bare text links
  // EXCLUDE maxbutton-gdrive-zip (season packs)
  if ($el.is('p') && $el.find('a.maxbutton[href*="tech.unblockedgames.world"]:not(.maxbutton-gdrive-zip), a.maxbutton[href*="tech.examzculture.in"]:not(.maxbutton-gdrive-zip)').length > 0) {
    const linksParagraph = $el;
    const episodeRegex = new RegExp(`^Episode\\s+0*${episode}(?!\\d)`, 'i');
    const targetEpisodeLink = linksParagraph.find('a').filter((i, el) => {
      return episodeRegex.test($(el).text().trim());
    }).first();

    if (targetEpisodeLink.length > 0) {
      const link = targetEpisodeLink.attr('href');
      if (link && !downloadLinks.some(item => item.link === link)) {
        const size = extractSize(qualityText);

        const cleanQuality = extractCleanQuality(qualityText);
        const rawQuality = qualityText.replace(/(\r\n|\n|\r)/gm, " ").replace(/\s+/g, ' ').trim();

        // Extract language information from quality header text
        const languageInfo = extractLanguageInfoFromHeader(qualityText);

        console.log(`[UHDMovies] Found match: Quality='${qualityText}', Link='${link}'`);
        downloadLinks.push({ quality: cleanQuality, size: size, link: link, rawQuality: rawQuality, languageInfo: languageInfo });
      }
    }
  }
}

// Extract episode links for maxbutton-gdrive-episode structure
export function extractEpisodeLinksMaxButton($el, episode, qualityText, downloadLinks, $) {
  // ONLY select episode buttons, NOT season pack buttons (maxbutton-gdrive-zip)
  if ($el.is('p') && $el.find('a.maxbutton-gdrive-episode:not(.maxbutton-gdrive-zip)').length > 0) {
    const episodeRegex = new RegExp(`^Episode\\s+0*${episode}(?!\\d)`, 'i');
    const targetEpisodeLink = $el.find('a.maxbutton-gdrive-episode:not(.maxbutton-gdrive-zip)').filter((i, el) => {
      const episodeText = $(el).find('.mb-text').text().trim();
      return episodeRegex.test(episodeText);
    }).first();

    if (targetEpisodeLink.length > 0) {
      const link = targetEpisodeLink.attr('href');
      if (link && !downloadLinks.some(item => item.link === link)) {
        const size = extractSize(qualityText);

        const cleanQuality = extractCleanQuality(qualityText);
        const rawQuality = qualityText.replace(/(\r\n|\n|\r)/gm, " ").replace(/\s+/g, ' ').trim();

        // Extract language information from quality header text
        const languageInfo = extractLanguageInfoFromHeader(qualityText);

        console.log(`[UHDMovies] Found match (maxbutton): Quality='${qualityText}', Link='${link}'`);
        downloadLinks.push({ quality: cleanQuality, size: size, link: link, rawQuality: rawQuality, languageInfo: languageInfo });
      }
    }
  }
}

// Fallback: Extract episode links using maxbutton structure with season filtering
export function extractEpisodeLinksMaxButtonFallback($, season, episode, downloadLinks) {
  // ONLY select episode buttons, NOT season pack buttons (maxbutton-gdrive-zip)
  $('.entry-content').find('a.maxbutton-gdrive-episode:not(.maxbutton-gdrive-zip)').each((i, el) => {
    const linkElement = $(el);
    const episodeText = linkElement.find('.mb-text').text().trim();
    const episodeRegex = new RegExp(`^Episode\\s+0*${episode}(?!\\d)`, 'i');

    if (episodeRegex.test(episodeText)) {
      const link = linkElement.attr('href');
      if (link && !downloadLinks.some(item => item.link === link)) {
        let qualityText = 'Unknown Quality';

        // Look for quality info in the preceding paragraph or heading
        const parentP = linkElement.closest('p, div');
        const prevElement = parentP.prev();
        if (prevElement.length > 0) {
          const prevText = prevElement.text().trim();
          if (prevText && prevText.length > 5 && !prevText.toLowerCase().includes('download')) {
            qualityText = prevText;
          }
        }

        // Check if this episode belongs to the correct season
        // Enhanced season check - look for various season formats
        const seasonCheckRegexes = [
          new RegExp(`\.S0*${season}[\.]`, 'i'),  // .S01.
          new RegExp(`S0*${season}[\.]`, 'i'),     // S01.
          new RegExp(`S0*${season}\b`, 'i'),       // S01 (word boundary)
          new RegExp(`Season\s+0*${season}\b`, 'i'), // Season 1
          new RegExp(`S0*${season}`, 'i')           // S01 anywhere
        ];

        const seasonMatch = seasonCheckRegexes.some(regex => regex.test(qualityText));
        if (!seasonMatch) {
          console.log(`[UHDMovies] Skipping episode from different season: Quality='${qualityText}'`);
          return; // Skip this episode as it's from a different season
        }

        const size = extractSize(qualityText);
        const cleanQuality = extractCleanQuality(qualityText);
        const rawQuality = qualityText.replace(/(\r\n|\n|\r)/gm, " ").replace(/\s+/g, ' ').trim();

        // Extract language information from quality header text
        const languageInfo = extractLanguageInfoFromHeader(qualityText);

        console.log(`[UHDMovies] Found match via enhanced fallback (maxbutton): Quality='${qualityText}', Link='${link}'`);
        downloadLinks.push({ quality: cleanQuality, size: size, link: link, rawQuality: rawQuality, languageInfo: languageInfo });
      }
    }
  });
}

// Fallback: Extract episode links using standard structure with season filtering
export function extractEpisodeLinksStandardFallback($, season, episode, downloadLinks) {
  // ONLY select maxbutton links (proper buttons), NOT bare text links
  // EXCLUDE maxbutton-gdrive-zip (season packs)
  $('.entry-content').find('a.maxbutton[href*="tech.unblockedgames.world"]:not(.maxbutton-gdrive-zip), a.maxbutton[href*="tech.examzculture.in"]:not(.maxbutton-gdrive-zip)').each((i, el) => {
    const linkElement = $(el);
    const episodeRegex = new RegExp(`^Episode\\s+0*${episode}(?!\\d)`, 'i');

    if (episodeRegex.test(linkElement.text().trim())) {
      const link = linkElement.attr('href');
      if (link && !downloadLinks.some(item => item.link === link)) {
        let qualityText = 'Unknown Quality';
        const parentP = linkElement.closest('p, div');
        const prevElement = parentP.prev();
        if (prevElement.length > 0) {
          const prevText = prevElement.text().trim();
          if (prevText && prevText.length > 5 && !prevText.toLowerCase().includes('download')) {
            qualityText = prevText;
          }
        }

        // Check if this episode belongs to the correct season
        // Enhanced season check - look for various season formats
        const seasonCheckRegexes = [
          new RegExp(`\.S0*${season}[\.]`, 'i'),  // .S01.
          new RegExp(`S0*${season}[\.]`, 'i'),     // S01.
          new RegExp(`S0*${season}\b`, 'i'),       // S01 (word boundary)
          new RegExp(`Season\s+0*${season}\b`, 'i'), // Season 1
          new RegExp(`S0*${season}`, 'i')           // S01 anywhere
        ];

        const seasonMatch = seasonCheckRegexes.some(regex => regex.test(qualityText));
        if (!seasonMatch) {
          console.log(`[UHDMovies] Skipping episode from different season: Quality='${qualityText}'`);
          return; // Skip this episode as it's from a different season
        }

        const size = extractSize(qualityText);
        const cleanQuality = extractCleanQuality(qualityText);
        const rawQuality = qualityText.replace(/(\r\n|\n|\r)/gm, " ").replace(/\s+/g, ' ').trim();

        // Extract language information from quality header text
        const languageInfo = extractLanguageInfoFromHeader(qualityText);

        console.log(`[UHDMovies] Found match via original fallback: Quality='${qualityText}', Link='${link}'`);
        downloadLinks.push({ quality: cleanQuality, size: size, link: link, rawQuality: rawQuality, languageInfo: languageInfo });
      }
    }
  });
}
// Fallback: AI Extraction (Placeholder/Basic Regex Implementation)
export async function extractEpisodeLinksAI($, season, episode, downloadLinks) {
  // This is a placeholder for the AI extraction logic referenced in links.js
  // For now, we'll implement a basic search similar to the other fallbacks to prevent the SyntaxError
  // The original error was: SyntaxError: The requested module './episode-parser.js' does not provide an export named 'extractEpisodeLinksAI'

  // Implementation can be expanded later if actual AI logic is needed.
  // For now, it's safe to return if no links found, as the caller handles empty array.
  console.log('[UHDMovies] AI Extraction fallback invoked (Placeholder).');
  return;
}
