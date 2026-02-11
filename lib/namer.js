import { basename } from 'node:path';
import { cosineSimilarity } from './vectors.js';
import { extractDate } from './date.js';
import { generate } from './llm.js';

const SIMILARITY_THRESHOLD = 0.97;
const MAX_SUGGESTIONS = 5;
const TEXT_LIMIT = 3000;
const MAX_NAME_LENGTH = 60;

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
  const remaining = MAX_SUGGESTIONS - suggestions.length;
  if (remaining > 0) {
    try {
      const llmNames = await generateNames(rawText, targetFolder, folderDocs, remaining);
      for (const name of llmNames) {
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

  // Fallback: cleaned original filename
  if (suggestions.length === 0) {
    const cleaned = cleanFilename(pdfPath);
    suggestions.push({
      name: `${date} ${cleaned}.pdf`,
      strategy: 'fallback',
    });
  }

  return { suggestions, date };
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

  return parseNames(response, count);
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
      // Fix German umlauts (ASCII-fication from LLM)
      name = restoreUmlauts(name);
      // Convert ALL CAPS words to title case
      name = fixAllCaps(name);
      // Cap length
      if (name.length > MAX_NAME_LENGTH) name = name.slice(0, MAX_NAME_LENGTH).trim();
      return name;
    })
    .filter(name => name.length > 0)
    .slice(0, maxCount);
}

/**
 * Replace ASCII digraphs with German umlauts.
 * Handles: ae→ä, oe→ö, ue→ü, Ae→Ä, Oe→Ö, Ue→Ü, ss→ß (only for common words).
 */
function restoreUmlauts(name) {
  // ae/oe/ue → ä/ö/ü (case-aware)
  name = name.replace(/Ae/g, 'Ä');
  name = name.replace(/Oe/g, 'Ö');
  name = name.replace(/Ue/g, 'Ü');
  name = name.replace(/ae/g, 'ä');
  name = name.replace(/oe/g, 'ö');
  name = name.replace(/ue/g, 'ü');
  return name;
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
