import { basename } from 'node:path';
import { createRequire } from 'node:module';
import { cosineSimilarity } from './vectors.js';
import { extractDate } from './date.js';
import { generate } from './llm.js';

const require = createRequire(import.meta.url);
const SpellChecker = require('simple-spellchecker');

const SIMILARITY_THRESHOLD = 0.97;
const MAX_SUGGESTIONS = 5;
const TEXT_LIMIT = 3000;
const MAX_NAME_LENGTH = 60;
const MAX_DIGITS = 5;

let _deDict = null;
function getGermanDict() {
  if (!_deDict) _deDict = SpellChecker.getDictionarySync('de-DE');
  return _deDict;
}

/**
 * Suggest filenames for a PDF being classified into a folder.
 *
 * @param {string} pdfPath - Absolute path to the PDF
 * @param {string} rawText - Extracted PDF text (not enriched)
 * @param {Float64Array} embedding - Document embedding
 * @param {string} targetFolder - The folder being classified into
 * @param {{ path: string, embedding: Float64Array }[]} folderDocs - Existing docs in the target folder
 * @returns {Promise<{ suggestions: { name: string, strategy: string, similarity?: number }[], date: string }>}
 */
export async function suggestFilenames(pdfPath, rawText, embedding, targetFolder, folderDocs) {
  const date = extractDate(pdfPath, rawText);
  const suggestions = [];

  // Source A: similarity matches (use raw embeddings for content-only comparison)
  const simMatches = [];
  for (const doc of folderDocs) {
    const docEmb = doc.embeddingRaw || doc.embedding;
    const sim = cosineSimilarity(embedding, docEmb);
    if (sim >= SIMILARITY_THRESHOLD) {
      simMatches.push({ path: doc.path, similarity: sim });
    }
  }
  simMatches.sort((a, b) => b.similarity - a.similarity);

  const seenNames = new Set();
  for (const match of simMatches) {
    if (suggestions.length >= MAX_SUGGESTIONS) break;
    const namePart = extractNamePart(match.path);
    if (!namePart || seenNames.has(namePart.toLowerCase())) continue;
    seenNames.add(namePart.toLowerCase());
    suggestions.push({
      name: `${date} ${namePart}.pdf`,
      strategy: 'similarity',
      similarity: match.similarity,
    });
  }

  // Source B: LLM generation (fill remaining slots)
  let llmPrompt = null;
  const remaining = MAX_SUGGESTIONS - suggestions.length;
  if (remaining > 0) {
    try {
      const llmResult = await generateNames(rawText, targetFolder, folderDocs, remaining);
      llmPrompt = llmResult.prompt;
      for (const name of llmResult.names) {
        if (suggestions.length >= MAX_SUGGESTIONS) break;
        if (seenNames.has(name.toLowerCase())) continue;
        seenNames.add(name.toLowerCase());
        suggestions.push({
          name: `${date} ${name}.pdf`,
          strategy: 'llm',
        });
      }
    } catch {
      // LLM failed — fall through to fallback
    }
  }

  // Deduplicate (spellcheck may have made LLM names match similarity names)
  const seen = new Set();
  const deduped = suggestions.filter(s => {
    const key = s.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  suggestions.length = 0;
  suggestions.push(...deduped);

  // Fallback: cleaned original filename
  if (suggestions.length === 0) {
    const cleaned = cleanFilename(pdfPath);
    suggestions.push({
      name: `${date} ${cleaned}.pdf`,
      strategy: 'fallback',
    });
  }

  return { suggestions, date, llmPrompt };
}

/**
 * Extract the name part from an existing document path, stripping date prefix and extension.
 * E.g. "/path/to/2024-03 Jahresrechnung.pdf" → "Jahresrechnung"
 */
function extractNamePart(docPath) {
  let name = basename(docPath).replace(/\.pdf$/i, '');
  // Strip leading date patterns:
  //   "YYYY-MM-DD ", "YYYY-MM ", "YYYY_MM_DD ", "YYYY_MM ", "YYYYMMDD_"
  name = name.replace(/^\d{4}[-_]\d{2}([-_]\d{2})?\s+/, '');
  name = name.replace(/^\d{8}_/, '');
  name = name.trim();
  return name || null;
}

/**
 * Generate name suggestions via LLM.
 */
async function generateNames(rawText, targetFolder, folderDocs, count) {
  // Gather example filenames from the folder
  const examples = folderDocs
    .map(d => basename(d.path).replace(/\.pdf$/i, ''))
    .slice(0, 10);

  const exampleBlock = examples.length > 0
    ? `\nExisting files in "${targetFolder}":\n${examples.map(e => `- ${e}`).join('\n')}\n`
    : '';

  const truncatedText = rawText.slice(0, TEXT_LIMIT);

  const system = `You suggest short, descriptive filenames for PDF documents. Output ONLY the name parts (no dates, no .pdf extension, no numbering). One suggestion per line. Match the naming style of existing files if provided. Names should be in the document's language.`;

  const prompt = `Suggest ${count} filename${count > 1 ? 's' : ''} for this document.
${exampleBlock}
Document text:
${truncatedText}`;

  const response = await generate(prompt, system, {
    temperature: 0.7,
    num_predict: 100,
  });

  return { names: parseNames(response, count), prompt: `[system]\n${system}\n\n[user]\n${prompt}` };
}

/**
 * Parse LLM output into clean name strings.
 */
function parseNames(response, maxCount) {
  // qwen3 may use <think>...</think> blocks — strip them
  const cleaned = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  return cleaned
    .split('\n')
    .map(line => {
      let name = line.trim();
      // Strip numbering like "1. ", "- ", "* "
      name = name.replace(/^[\d]+[.)]\s*/, '');
      name = name.replace(/^[-*]\s*/, '');
      // Strip quotes
      name = name.replace(/^["']|["']$/g, '');
      // Strip .pdf extension if included
      name = name.replace(/\.pdf$/i, '');
      // Strip any date prefix the LLM may have added (various formats)
      name = name.replace(/^\d{4}[-_]\d{2}([-_]\d{2})?\s*/, '');
      name = name.replace(/^\d{4}\s+/, '');
      // Replace underscores with spaces
      name = name.replace(/_/g, ' ');
      // Sanitize for filesystem
      name = name.replace(/[/\\:*?"<>|]/g, '').trim();
      // Collapse multiple spaces
      name = name.replace(/\s+/g, ' ');
      // Convert ALL CAPS words to title case
      name = fixAllCaps(name);
      // Fix misspelled German words (umlauts, typos)
      name = spellCheckName(name);
      // Cap length
      if (name.length > MAX_NAME_LENGTH) name = name.slice(0, MAX_NAME_LENGTH).trim();
      return name;
    })
    .filter(name => name.length > 0 && !tooManyDigits(name))
    .slice(0, maxCount);
}

/**
 * Spell-check each word using the German dictionary.
 * Fixes umlaut errors and other typos the LLM produces.
 * Falls back to character-level umlaut substitution for unknown compound words.
 */
function spellCheckName(name) {
  const dict = getGermanDict();
  return name.split(' ').map(word => {
    // Strip leading/trailing hyphens for checking, re-add after
    const leadMatch = word.match(/^(-+)/);
    const trailMatch = word.match(/(-+)$/);
    const lead = leadMatch ? leadMatch[1] : '';
    const trail = trailMatch ? trailMatch[1] : '';
    const core = word.slice(lead.length, word.length - trail.length);
    if (core.length < 3 || !dict.isMisspelled(core)) return word;
    const suggestions = dict.getSuggestions(core, 1, 2);
    if (suggestions.length > 0) {
      let fixed = suggestions[0];
      // Preserve original capitalization
      if (core[0] === core[0].toUpperCase() && fixed[0] !== fixed[0].toUpperCase()) {
        fixed = fixed[0].toUpperCase() + fixed.slice(1);
      }
      return lead + fixed + trail;
    }
    // Fallback for compound words not in dictionary: try umlaut substitutions
    return lead + tryUmlautFix(core) + trail;
  }).join(' ');
}

const UMLAUT_MAP = { A: 'Ä', O: 'Ö', U: 'Ü', a: 'ä', o: 'ö', u: 'ü' };

/**
 * Try single-character umlaut substitutions for words the spellchecker can't fix.
 * Tests each A/O/U position; picks the variant that the dictionary recognizes,
 * or whose longest known prefix is longer than the original (for compound words).
 */
function tryUmlautFix(word) {
  const dict = getGermanDict();
  // Baseline: longest known prefix of the original word
  let baselineScore = 0;
  for (let len = Math.min(word.length, 12); len >= 4; len--) {
    if (!dict.isMisspelled(word.slice(0, len))) { baselineScore = len; break; }
  }
  let best = word;
  let bestScore = baselineScore;
  for (let i = 0; i < word.length; i++) {
    const replacement = UMLAUT_MAP[word[i]];
    if (!replacement) continue;
    const candidate = word.slice(0, i) + replacement + word.slice(i + 1);
    if (!dict.isMisspelled(candidate)) return candidate;
    for (let len = Math.min(candidate.length, 12); len >= 4; len--) {
      if (!dict.isMisspelled(candidate.slice(0, len)) && len > bestScore) {
        bestScore = len;
        best = candidate;
        break;
      }
    }
  }
  return best;
}

/**
 * Check if a name part has too many digit characters (>MAX_DIGITS).
 */
function tooManyDigits(name) {
  const digits = name.replace(/\D/g, '');
  return digits.length > MAX_DIGITS;
}

/**
 * Convert ALL CAPS words to title case (first letter upper, rest lower).
 * A word is considered ALL CAPS if it has 2+ letters and all are uppercase.
 */
function fixAllCaps(name) {
  return name.replace(/\b([A-ZÄÖÜ]{2,})\b/g, (match) =>
    match.charAt(0) + match.slice(1).toLowerCase()
  );
}

/**
 * Clean original filename as fallback suggestion.
 */
function cleanFilename(pdfPath) {
  let name = basename(pdfPath).replace(/\.pdf$/i, '');
  // Remove scan patterns like "20260210_Scan_002939"
  name = name.replace(/^\d{8}_Scan_\d+$/, 'Document');
  // Replace underscores with spaces
  name = name.replace(/_/g, ' ').trim();
  // Strip leading date patterns: "YYYY MM DD ", "YYYY-MM-DD ", "YYYY-MM "
  name = name.replace(/^\d{4}[\s-]\d{2}([\s-]\d{2})?\s+/, '');
  if (name.length > MAX_NAME_LENGTH) name = name.slice(0, MAX_NAME_LENGTH).trim();
  return name || 'Document';
}
