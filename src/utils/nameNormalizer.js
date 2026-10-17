/**
 * Converts a skill or interest name to Title Case.
 * Capitalize the first letter of each word and convert all remaining letters to lowercase.
 * e.g.:
 * - "cloud computing" -> "Cloud Computing"
 * - "sql" -> "Sql"
 * - "postgresql" -> "Postgresql"
 * - "machine learning" -> "Machine Learning"
 * - "PHOTOGRAPHY" -> "Photography"
 *
 * @param {string} raw
 * @returns {string}
 */
function toTitleCase(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map(word => word ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() : '')
    .filter(Boolean)
    .join(' ');
}

module.exports = {
  toTitleCase
};
