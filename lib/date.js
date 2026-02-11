import { statSync } from 'node:fs';
import { basename } from 'node:path';

// German month names (full + abbreviated)
const DE_MONTHS = {
  'januar': 1, 'jan': 1, 'jänner': 1,
  'februar': 2, 'feb': 2,
  'märz': 3, 'mär': 3, 'maerz': 3,
  'april': 4, 'apr': 4,
  'mai': 5,
  'juni': 6, 'jun': 6,
  'juli': 7, 'jul': 7,
  'august': 8, 'aug': 8,
  'september': 9, 'sep': 9, 'sept': 9,
  'oktober': 10, 'okt': 10,
  'november': 11, 'nov': 11,
  'dezember': 12, 'dez': 12,
};

// English month names
const EN_MONTHS = {
  'january': 1, 'jan': 1,
  'february': 2, 'feb': 2,
  'march': 3, 'mar': 3,
  'april': 4, 'apr': 4,
  'may': 5,
  'june': 6, 'jun': 6,
  'july': 7, 'jul': 7,
  'august': 8, 'aug': 8,
  'september': 9, 'sep': 9, 'sept': 9,
  'october': 10, 'oct': 10,
  'november': 11, 'nov': 11,
  'december': 12, 'dec': 12,
};

const ALL_MONTHS = { ...DE_MONTHS, ...EN_MONTHS };

// Date keywords that signal a document date nearby
const DATE_KEYWORDS = /datum|date|rechnungsdatum|ausgestellt|issued|invoice date|belegdatum|vom/i;

function isValidDate(year, month, day) {
  if (year < 1990 || year > new Date().getFullYear() + 1) return false;
  if (month < 1 || month > 12) return false;
  if (day !== null && (day < 1 || day > 31)) return false;
  return true;
}

function fmt(year, month, day) {
  const mm = String(month).padStart(2, '0');
  if (day) {
    const dd = String(day).padStart(2, '0');
    return `${year}-${mm}-${dd}`;
  }
  return `${year}-${mm}`;
}

/**
 * Extract a date from PDF text and filename.
 * Returns "YYYY-MM-DD" or "YYYY-MM".
 *
 * Waterfall: text regex → filename pattern → file mtime.
 * @param {string} pdfPath - Absolute path to PDF
 * @param {string} text - Extracted PDF text
 * @returns {string}
 */
export function extractDate(pdfPath, text) {
  const fromText = extractDateFromText(text);
  if (fromText) return fromText;

  const fromFilename = extractDateFromFilename(pdfPath);
  if (fromFilename) return fromFilename;

  return extractDateFromMtime(pdfPath);
}

function extractDateFromText(text) {
  // Use first ~2000 chars for speed
  const chunk = text.slice(0, 2000);
  const lines = chunk.split('\n');

  // Collect candidate dates with proximity scoring to date keywords
  const candidates = [];

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const hasKeyword = DATE_KEYWORDS.test(line);
    // Also check adjacent lines for keywords
    const prevHasKeyword = lineIdx > 0 && DATE_KEYWORDS.test(lines[lineIdx - 1]);
    const nearKeyword = hasKeyword || prevHasKeyword;

    // DD.MM.YYYY or DD/MM/YYYY
    for (const m of line.matchAll(/\b(\d{1,2})[./](\d{1,2})[./](\d{4})\b/g)) {
      const day = parseInt(m[1]), month = parseInt(m[2]), year = parseInt(m[3]);
      if (isValidDate(year, month, day)) {
        candidates.push({ date: fmt(year, month, day), priority: nearKeyword ? 0 : 1, lineIdx });
      }
    }

    // YYYY-MM-DD (ISO)
    for (const m of line.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
      const year = parseInt(m[1]), month = parseInt(m[2]), day = parseInt(m[3]);
      if (isValidDate(year, month, day)) {
        candidates.push({ date: fmt(year, month, day), priority: nearKeyword ? 0 : 1, lineIdx });
      }
    }

    // "DD. Monat YYYY" or "DD. Mon. YYYY" (German written dates)
    for (const m of line.matchAll(/\b(\d{1,2})\.\s*([A-Za-zÄÖÜäöü]+)\.?\s+(\d{4})\b/g)) {
      const day = parseInt(m[1]);
      const monthName = m[2].toLowerCase();
      const year = parseInt(m[3]);
      const month = ALL_MONTHS[monthName];
      if (month && isValidDate(year, month, day)) {
        candidates.push({ date: fmt(year, month, day), priority: nearKeyword ? 0 : 1, lineIdx });
      }
    }

    // "Month DD, YYYY" (English written)
    for (const m of line.matchAll(/\b([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})\b/g)) {
      const monthName = m[1].toLowerCase();
      const day = parseInt(m[2]);
      const year = parseInt(m[3]);
      const month = ALL_MONTHS[monthName];
      if (month && isValidDate(year, month, day)) {
        candidates.push({ date: fmt(year, month, day), priority: nearKeyword ? 0 : 1, lineIdx });
      }
    }

    // "Monat YYYY" or "MM/YYYY" (month-only)
    for (const m of line.matchAll(/\b([A-Za-zÄÖÜäöü]+)\s+(\d{4})\b/g)) {
      const monthName = m[1].toLowerCase();
      const year = parseInt(m[2]);
      const month = ALL_MONTHS[monthName];
      if (month && isValidDate(year, month, null)) {
        candidates.push({ date: fmt(year, month, null), priority: nearKeyword ? 2 : 3, lineIdx });
      }
    }

    for (const m of line.matchAll(/\b(\d{1,2})\/(\d{4})\b/g)) {
      const month = parseInt(m[1]), year = parseInt(m[2]);
      if (isValidDate(year, month, null)) {
        candidates.push({ date: fmt(year, month, null), priority: nearKeyword ? 2 : 3, lineIdx });
      }
    }
  }

  if (candidates.length === 0) return null;

  // Sort: near-keyword first, then by line position (earlier = better)
  candidates.sort((a, b) => a.priority - b.priority || a.lineIdx - b.lineIdx);
  return candidates[0].date;
}

function extractDateFromFilename(pdfPath) {
  const name = basename(pdfPath);

  // YYYYMMDD_Scan_* pattern → month precision only
  const scanMatch = name.match(/^(\d{4})(\d{2})\d{2}_/);
  if (scanMatch) {
    const year = parseInt(scanMatch[1]);
    const month = parseInt(scanMatch[2]);
    if (isValidDate(year, month, null)) {
      return fmt(year, month, null);
    }
  }

  // YYYY-MM-DD in filename
  const isoMatch = name.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    const year = parseInt(isoMatch[1]);
    const month = parseInt(isoMatch[2]);
    const day = parseInt(isoMatch[3]);
    if (isValidDate(year, month, day)) {
      return fmt(year, month, day);
    }
  }

  // YYYY-MM in filename
  const monthMatch = name.match(/(\d{4})-(\d{2})/);
  if (monthMatch) {
    const year = parseInt(monthMatch[1]);
    const month = parseInt(monthMatch[2]);
    if (isValidDate(year, month, null)) {
      return fmt(year, month, null);
    }
  }

  return null;
}

function extractDateFromMtime(pdfPath) {
  try {
    const stat = statSync(pdfPath);
    const d = stat.mtime;
    return fmt(d.getFullYear(), d.getMonth() + 1, null);
  } catch {
    const now = new Date();
    return fmt(now.getFullYear(), now.getMonth() + 1, null);
  }
}
