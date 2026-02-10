import { readFile } from 'node:fs/promises';
import { extractText } from 'unpdf';

// Suppress noisy PDF.js warnings (Type3 fonts, missing glyphs, etc.)
const _warn = console.warn;
const PDF_WARNING = /Type3 font|font resource|glyph|standardFontDataUrl|cMap/i;

/**
 * Extract text content from a PDF file.
 * @param {string} pdfPath - Absolute path to a PDF file
 * @returns {Promise<string>} Extracted text
 */
export async function extractPdfText(pdfPath) {
  const buffer = await readFile(pdfPath);
  const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  console.warn = (...args) => {
    if (typeof args[0] === 'string' && PDF_WARNING.test(args[0])) return;
    _warn.apply(console, args);
  };

  try {
    const { text } = await extractText(data, { mergePages: true });
    return text;
  } finally {
    console.warn = _warn;
  }
}
