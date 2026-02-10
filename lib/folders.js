import { readdirSync, statSync } from 'node:fs';
import { join, relative, dirname, extname } from 'node:path';

/**
 * Recursively scan a folder tree for PDFs.
 * Returns entries with { path (absolute), folder (category) }.
 * Category = relative path of the PDF's parent dir from root.
 * PDFs directly in root (folder === '.') are skipped.
 *
 * @param {string} rootPath - Absolute path to the root folder
 * @returns {{ path: string, folder: string }[]}
 */
export function scanFolder(rootPath) {
  const results = [];
  const skipped = [];

  function walk(dir) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue; // skip hidden dirs
        walk(fullPath);
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.pdf') {
        const folder = relative(rootPath, dirname(fullPath));
        if (!folder || folder === '.') {
          skipped.push(entry.name);
          continue;
        }
        results.push({ path: fullPath, folder });
      }
    }
  }

  walk(rootPath);

  if (skipped.length > 0) {
    console.warn(
      `Warning: Skipped ${skipped.length} PDF(s) in root directory (no category): ${skipped.join(', ')}`
    );
  }

  return results;
}
