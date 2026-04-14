/**
 * Robustly sanitizes HTML content into plain text for Node.js environments.
 * Strips all HTML tags while preserving line breaks and converting common block elements.
 */
const sanitizeContent = (html) => {
  if (!html) return '';
  
  // 1. Convert block-level tags to newlines to preserve formatting
  let text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ') // Bullet points for lists
    .replace(/<\/li>/gi, '')
    .replace(/<h[1-6][^>]*>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n');

  // 2. Strip all remaining HTML tags
  text = text.replace(/<[^>]*>/g, '');

  // 3. Decode common HTML entities
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\u00A0/g, ' '); // Non-breaking space

  // 4. Normalize spacing and newlines
  text = text
    .replace(/\r\n/g, '\n')       // Normalize CRLF to LF
    .replace(/hashtag(#\w+)/gi, "$1") // Clean "hashtag#tag" artifact from some rich text sources
    .replace(/[ \t]+/g, ' ')      // Consolidate multiple spaces/tabs
    .replace(/\n\s*\n\n+/g, '\n\n') // Max 2 consecutive newlines
    .trim();

  return text;
};

module.exports = { sanitizeContent };
