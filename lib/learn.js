import {
  hasModel, loadBayesState, saveBayesState,
  insertDoc, docExists, getDocsByFolder, getAllDocs,
  upsertCentroid, setMeta, insertStat,
} from './db.js';
import { extractPdfText, enrichText } from './pdf.js';
import { embed, EMBED_MODEL } from './embedder.js';
import { NaiveBayes, tokenize } from './bayes.js';
import { computeCentroid } from './vectors.js';
import { scanFolder } from './folders.js';

/**
 * Index new PDFs from an organized folder structure.
 * Skips already-indexed documents (incremental).
 *
 * @param {string} rootPath - Absolute path to root folder with categorized subfolders
 * @param {{ verbose?: boolean }} options
 *   verbose: log per-file progress (default false)
 * @returns {Promise<{ newDocs: number, skipped: number, folders: string[], totalDocs: number, durationMs: number, isInitial: boolean } | null>}
 *   null if nothing to index
 */
export async function learnPdfs(rootPath, { verbose = false } = {}) {
  const isInitial = !hasModel();
  const learnStart = Date.now();

  const pdfs = scanFolder(rootPath);
  const newPdfs = pdfs.filter(p => !docExists(p.path));
  if (newPdfs.length === 0) return null;

  if (verbose) {
    console.log(`Found ${pdfs.length} PDFs, ${newPdfs.length} new to process.`);
  }

  const bayesJson = loadBayesState();
  const bayes = bayesJson ? NaiveBayes.deserialize(bayesJson) : new NaiveBayes();

  let processed = 0;
  let skipped = 0;
  const affectedFolders = new Set();

  for (const pdf of newPdfs) {
    processed++;
    if (verbose) {
      console.log(`Processing ${processed}/${newPdfs.length}: ${pdf.folder}/${pdf.path.split('/').pop()}`);
    }

    try {
      const rawText = await extractPdfText(pdf.path);
      if (!rawText || rawText.trim().length === 0) {
        if (verbose) console.warn(`  Warning: No extractable text, skipping.`);
        skipped++;
        continue;
      }

      const text = enrichText(pdf.path, rawText);
      const embedding = await embed(text);
      const embeddingRaw = await embed(rawText);

      insertDoc(pdf.path, pdf.folder, text, embedding, embeddingRaw);
      bayes.train(tokenize(text), pdf.folder);
      affectedFolders.add(pdf.folder);
    } catch (err) {
      if (verbose) console.error(`  Error processing: ${err.message}`);
      skipped++;
    }
  }

  // Recompute centroids for affected folders
  for (const folder of affectedFolders) {
    const docs = getDocsByFolder(folder);
    if (docs.length === 0) continue;
    const centroid = computeCentroid(docs.map(d => d.embedding));
    upsertCentroid(folder, centroid, docs.length);
  }

  saveBayesState(bayes.serialize());
  setMeta('root', rootPath);
  setMeta('embed_model', EMBED_MODEL);

  const newDocs = processed - skipped;
  const durationMs = Date.now() - learnStart;
  const totalDocs = getAllDocs().length;
  const folders = [...affectedFolders];

  insertStat('learn', isInitial
    ? { type: 'initial', totalDocs, skipped, folders: folders.length, durationMs }
    : { type: 'update', newDocs, skipped, totalDocs, folders: folders.length, durationMs }
  );

  return { newDocs, skipped, folders, totalDocs, durationMs, isInitial };
}
