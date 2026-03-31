import {
  getDb, hasModel, loadBayesState, saveBayesState,
  insertDoc, docExists, getDocsByFolder, getAllDocs,
  upsertCentroid, setMeta, insertStat,
} from './db.js';
import { extractPdfText, enrichText } from './pdf.js';
import { embed, EMBED_MODEL } from './embedder.js';
import { NaiveBayes, tokenize } from './bayes.js';
import { computeCentroid } from './vectors.js';
import { scanFolder } from './folders.js';

// Number of PDFs to embed concurrently (Ollama handles parallel requests fine)
const EMBED_BATCH_SIZE = 4;

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

  let skipped = 0;
  const affectedFolders = new Set();
  const pendingInserts = [];

  for (let i = 0; i < newPdfs.length; i += EMBED_BATCH_SIZE) {
    const batch = newPdfs.slice(i, i + EMBED_BATCH_SIZE);

    const batchResults = await Promise.all(batch.map(async (pdf) => {
      try {
        const rawText = await extractPdfText(pdf.path);
        if (!rawText?.trim()) return { ok: false, pdf };
        const text = enrichText(pdf.path, rawText);
        // Embed enriched and raw text concurrently
        const [embedding, embeddingRaw] = await Promise.all([embed(text), embed(rawText)]);
        return { ok: true, pdf, text, embedding, embeddingRaw };
      } catch (err) {
        if (verbose) console.error(`\n  Error: ${pdf.path.split('/').pop()}: ${err.message}`);
        return { ok: false, pdf };
      }
    }));

    for (const result of batchResults) {
      if (!result.ok) { skipped++; continue; }
      const { pdf, text } = result;
      pendingInserts.push(result);
      bayes.train(tokenize(text), pdf.folder);
      affectedFolders.add(pdf.folder);
    }

    if (verbose) {
      process.stdout.write(`\r  Processing ${Math.min(i + EMBED_BATCH_SIZE, newPdfs.length)}/${newPdfs.length}...`);
    }
  }

  if (verbose) process.stdout.write('\n');

  if (pendingInserts.length > 0) {
    // Commit all inserts + centroid updates + Bayes state atomically
    getDb().transaction(() => {
      for (const { pdf, text, embedding, embeddingRaw } of pendingInserts) {
        insertDoc(pdf.path, pdf.folder, text, embedding, embeddingRaw);
      }
      for (const folder of affectedFolders) {
        const docs = getDocsByFolder(folder);
        if (docs.length === 0) continue;
        const centroid = computeCentroid(docs.map(d => d.embedding));
        upsertCentroid(folder, centroid, docs.length);
      }
      saveBayesState(bayes.serialize());
      setMeta('root', rootPath);
      setMeta('embed_model', EMBED_MODEL);
    })();
  }

  const newDocs = pendingInserts.length;
  const durationMs = Date.now() - learnStart;
  const totalDocs = getAllDocs().length;
  const folders = [...affectedFolders];

  insertStat('learn', isInitial
    ? { type: 'initial', totalDocs, skipped, folders: folders.length, durationMs }
    : { type: 'update', newDocs, skipped, totalDocs, folders: folders.length, durationMs }
  );

  return { newDocs, skipped, folders, totalDocs, durationMs, isInitial };
}
