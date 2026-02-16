// ─── Pure utility functions ───

/** Returns a debounced version of fn that delays invocation by ms. Has .cancel(). */
export function debounce(fn, ms) {
  let id;
  const debounced = (...args) => {
    clearTimeout(id);
    id = setTimeout(() => fn(...args), ms);
  };
  debounced.cancel = () => clearTimeout(id);
  return debounced;
}

/** Escape HTML special characters */
export function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Format a timestamp as relative time (e.g. "3d ago") */
export function relTime(mtimeMs) {
  const diff = Date.now() - mtimeMs;
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.floor(hrs / 24);
  if (days < 30) return days + 'd ago';
  const months = Math.floor(days / 30);
  if (months < 12) return months + 'mo ago';
  return Math.floor(months / 12) + 'y ago';
}

/**
 * Space-separated fuzzy match — all terms must appear as substrings (case-insensitive).
 * Normalizes to NFC to handle macOS NFD folder paths.
 */
export function fuzzyMatch(query, text) {
  const t = text.normalize('NFC').toLowerCase();
  const terms = query.normalize('NFC').toLowerCase().split(/\s+/).filter(Boolean);
  for (let i = 0; i < terms.length; i++) {
    if (t.indexOf(terms[i]) === -1) return false;
  }
  return true;
}
