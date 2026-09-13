const sanitizeHtml = require('sanitize-html');

/**
 * Sanitizes article HTML content: strips scripts, event handlers, and inline
 * color/font/background styling (the ID-227 dark-mode-paste vector) while
 * preserving the structure the article editor's toolbar can produce
 * (bold/italic/headings/lists/links/images).
 */
const sanitizeArticleContent = (html) => {
  if (!html) return '';

  // Preserve the article divider comment which is used by the frontend to split the description from the body
  const dividerPlaceholder = '___ARTICLE_DIVIDER_PLACEHOLDER___';
  let processedHtml = html.replace(/<!--\s*article_divider\s*-->/g, dividerPlaceholder);

  processedHtml = sanitizeHtml(processedHtml, {
    allowedTags: ['b', 'strong', 'i', 'em', 'u', 'h1', 'h2', 'h3', 'p', 'br', 'ul', 'ol', 'li', 'a',
                  'span', 'img', 'video', 'div', 'button', 'svg', 'path', 'line'],
    allowedAttributes: {
      a: ['href', 'target', 'rel', 'class'],
      img: ['src', 'class'],
      video: ['src', 'controls', 'class'],
      div: ['class', 'contenteditable'],
      button: ['type', 'class', 'title'],
      span: ['class'],
      svg: ['xmlns', 'width', 'height', 'viewBox', 'viewbox', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'class'],
      path: ['d', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin'],
      line: ['x1', 'x2', 'y1', 'y2'],
      p: ['class'],
      h1: ['class'],
      h2: ['class'],
      h3: ['class'],
      li: ['class'],
    },
    allowedClasses: {
      p: ['text-left', 'text-center', 'text-right', 'text-justify'],
      h1: ['text-left', 'text-center', 'text-right', 'text-justify'],
      h2: ['text-left', 'text-center', 'text-right', 'text-justify'],
      h3: ['text-left', 'text-center', 'text-right', 'text-justify'],
      li: ['text-left', 'text-center', 'text-right', 'text-justify'],
    },
    // No inline style anywhere: the toolbar's own generated markup uses Tailwind classes
    // (group/group-hover) instead of inline style/onmouseenter, so nothing legitimate is
    // ever lost — and this closes off the actual bug (inline color/font/background styling
    // carried in from pasted content) with a single blanket rule instead of a style allowlist.
    // "blob" covers the transient object URLs the editor inserts before upload substitution
    // replaces them with a real https URL — defensive, in case that substitution ever misses.
    allowedSchemes: ['http', 'https', 'blob'],
    disallowedTagsMode: 'discard',
    // Preserve attribute case for SVG's camelCase viewBox (sanitize-html otherwise lowercases
    // all attribute names, which silently breaks SVG icon rendering).
    parser: { lowerCaseAttributeNames: false },
  });

  // Restore the article divider comment
  return processedHtml.replace(new RegExp(dividerPlaceholder, 'g'), '<!-- article_divider -->');
};

module.exports = { sanitizeArticleContent };
