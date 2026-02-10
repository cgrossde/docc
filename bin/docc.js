#!/usr/bin/env node

import { Command } from 'commander';
import { resolve } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import {
  getDb, DB_PATH,
  insertDoc, docExists, getAllDocs, getDocsByFolder,
  upsertCentroid, getAllCentroids,
  saveBayesState, loadBayesState,
  setMeta, getMeta, hasModel, clearModel,
} from '../lib/db.js';
import { extractPdfText } from '../lib/pdf.js';
import { embed } from '../lib/embedder.js';
import { scanFolder } from '../lib/folders.js';
import { NaiveBayes, tokenize } from '../lib/bayes.js';
import { computeCentroid, adjustCentroidRemove } from '../lib/vectors.js';
import { classifyDocument } from '../lib/classifier.js';
import { startUiServer } from '../lib/ui.js';

const program = new Command();

program
  .name('docc')
  .description('PDF classification CLI — learns from organized folders, classifies new PDFs')
  .version('1.0.0');

// ─── setup ───────────────────────────────────────────────────────────────────

function commandExists(cmd) {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question(question, (answer) => {
      rl.close();
      res(answer.trim().toLowerCase().startsWith('y'));
    });
  });
}

function prompt(question, defaultValue) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question(question, (answer) => {
      rl.close();
      res(answer.trim() || defaultValue || '');
    });
  });
}

function run(cmd, args, { label } = {}) {
  return new Promise((res, reject) => {
    if (label) console.log(label);
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('close', (code) => {
      if (code === 0) res();
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

async function ollamaIsServing() {
  try {
    const res = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForOllama(maxWaitMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await ollamaIsServing()) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

program
  .command('setup')
  .description('Install Ollama, start the server, and pull the embedding model')
  .action(async () => {
    // 1. Check / install Ollama
    if (commandExists('ollama')) {
      console.log('Ollama is already installed.');
    } else {
      if (!commandExists('brew')) {
        console.error('Error: Homebrew is required to install Ollama. Install it from https://brew.sh');
        process.exit(1);
      }
      const yes = await confirm('Ollama is not installed. Install via Homebrew? [y/N] ');
      if (!yes) {
        console.log('Setup cancelled.');
        return;
      }
      await run('brew', ['install', 'ollama'], { label: '\nInstalling Ollama...' });
      console.log('Ollama installed.');
    }

    // 2. Start server if not running
    if (await ollamaIsServing()) {
      console.log('Ollama server is already running.');
    } else {
      console.log('Starting Ollama server...');
      // Detach so it keeps running after docc exits
      const child = spawn('ollama', ['serve'], {
        stdio: 'ignore',
        detached: true,
      });
      child.unref();

      if (await waitForOllama()) {
        console.log('Ollama server is running.');
      } else {
        console.error('Error: Ollama server did not start in time. Try running `ollama serve` manually.');
        process.exit(1);
      }
    }

    // 3. Pull the embedding model
    console.log('\nPulling nomic-embed-text model (this may take a minute on first run)...');
    await run('ollama', ['pull', 'nomic-embed-text']);

    // 4. Configure doc directory and inbox
    getDb();
    const currentRoot = getMeta('root');
    const currentInbox = getMeta('inbox');

    console.log('\n── Configuration ──\n');

    const rootDefault = currentRoot || '';
    const rootPrompt = currentRoot
      ? `Doc directory [${currentRoot}]: `
      : 'Doc directory (root folder with categorized PDFs): ';
    const newRoot = await prompt(rootPrompt, rootDefault);

    if (newRoot) {
      const resolvedRoot = resolve(newRoot);
      if (!existsSync(resolvedRoot)) {
        console.log(`  Warning: ${resolvedRoot} does not exist yet.`);
      }
      if (currentRoot && resolvedRoot !== currentRoot && hasModel()) {
        const yes = await confirm('Root changed. This will clear the learned model. Continue? [y/N] ');
        if (!yes) {
          console.log('Root not changed.');
        } else {
          clearModel();
          setMeta('root', resolvedRoot);
          console.log(`  Root set to ${resolvedRoot} (model cleared).`);
        }
      } else {
        setMeta('root', resolvedRoot);
        console.log(`  Root set to ${resolvedRoot}`);
      }
    }

    const inboxDefault = currentInbox || '';
    const inboxPrompt = currentInbox
      ? `Inbox folder [${currentInbox}]: `
      : 'Inbox folder (optional, for unclassified PDFs): ';
    const newInbox = await prompt(inboxPrompt, inboxDefault);

    if (newInbox) {
      const resolvedInbox = resolve(newInbox);
      if (!existsSync(resolvedInbox)) {
        console.log(`  Warning: ${resolvedInbox} does not exist yet.`);
      }
      setMeta('inbox', resolvedInbox);
      console.log(`  Inbox set to ${resolvedInbox}`);
    }

    console.log('\nSetup complete. Run `docc learn` to index your documents.');
  });

// ─── config ──────────────────────────────────────────────────────────────────

program
  .command('config')
  .description('View or set configuration (root, inbox)')
  .argument('[key]', 'Config key: root or inbox')
  .argument('[value]', 'New value to set')
  .action(async (key, value) => {
    getDb();
    const validKeys = ['root', 'inbox'];

    if (!key) {
      // Show all config
      const root = getMeta('root');
      const inbox = getMeta('inbox');
      console.log(`root:  ${root || '(not set)'}`);
      console.log(`inbox: ${inbox || '(not set)'}`);
      return;
    }

    if (!validKeys.includes(key)) {
      console.error(`Error: Unknown config key "${key}". Valid keys: ${validKeys.join(', ')}`);
      process.exit(1);
    }

    if (!value) {
      // Show single value
      const current = getMeta(key);
      console.log(`${key}: ${current || '(not set)'}`);
      return;
    }

    const resolvedValue = resolve(value);

    if (!existsSync(resolvedValue)) {
      console.log(`Warning: ${resolvedValue} does not exist yet.`);
    }

    if (key === 'root') {
      const currentRoot = getMeta('root');
      if (currentRoot && resolvedValue !== currentRoot && hasModel()) {
        const yes = await confirm('Root changed. This will clear the learned model. Continue? [y/N] ');
        if (!yes) {
          console.log('Root not changed.');
          return;
        }
        clearModel();
        console.log('Learned model cleared.');
      }
    }

    setMeta(key, resolvedValue);
    console.log(`${key} set to ${resolvedValue}`);
  });

// ─── learn ───────────────────────────────────────────────────────────────────

program
  .command('learn')
  .description('Learn from an organized folder of PDFs')
  .argument('[folder]', 'Root folder containing categorized PDFs in subfolders (default: configured root)')
  .action(async (folder) => {
    if (!folder) {
      getDb();
      const storedRoot = getMeta('root');
      if (!storedRoot) {
        console.error('No folder specified and no root configured. Run `docc setup` or `docc config root <path>`.');
        process.exit(1);
      }
      folder = storedRoot;
    }
    const rootPath = resolve(folder);
    if (!existsSync(rootPath)) {
      console.error(`Error: Folder not found: ${rootPath}`);
      process.exit(1);
    }

    // Scan for PDFs
    const pdfs = scanFolder(rootPath);
    if (pdfs.length === 0) {
      console.error('No PDFs found in subfolders. PDFs must be in subdirectories (not the root).');
      process.exit(1);
    }

    // Initialize DB
    getDb();

    // Load or create Bayes classifier
    const bayesJson = loadBayesState();
    const bayes = bayesJson ? NaiveBayes.deserialize(bayesJson) : new NaiveBayes();

    // Filter out already-indexed PDFs
    const newPdfs = pdfs.filter(p => !docExists(p.path));
    if (newPdfs.length === 0) {
      console.log(`All ${pdfs.length} PDFs already indexed. Nothing to do.`);
      return;
    }

    console.log(`Found ${pdfs.length} PDFs, ${newPdfs.length} new to process.`);

    let processed = 0;
    let skipped = 0;

    for (const pdf of newPdfs) {
      processed++;
      console.log(`Processing ${processed}/${newPdfs.length}: ${pdf.folder}/${pdf.path.split('/').pop()}`);

      try {
        // Extract text
        const text = await extractPdfText(pdf.path);
        if (!text || text.trim().length === 0) {
          console.warn(`  Warning: No extractable text, skipping.`);
          skipped++;
          continue;
        }

        // Embed
        const embedding = await embed(text);

        // Store in DB
        insertDoc(pdf.path, pdf.folder, text, embedding);

        // Train Bayes
        const tokens = tokenize(text);
        bayes.train(tokens, pdf.folder);
      } catch (err) {
        console.error(`  Error processing: ${err.message}`);
        skipped++;
      }
    }

    // Compute centroids per folder
    const folders = [...new Set(pdfs.map(p => p.folder))];
    for (const f of folders) {
      const docs = getDocsByFolder(f);
      if (docs.length === 0) continue;
      const centroid = computeCentroid(docs.map(d => d.embedding));
      upsertCentroid(f, centroid, docs.length);
    }

    // Save Bayes state
    saveBayesState(bayes.serialize());

    // Save root path
    setMeta('root', rootPath);

    const successCount = processed - skipped;
    console.log(`\nLearned ${successCount} documents across ${folders.length} folders.`);
    if (skipped > 0) {
      console.log(`Skipped ${skipped} documents due to errors or empty text.`);
    }
  });

// ─── classify ────────────────────────────────────────────────────────────────

program
  .command('classify')
  .description('Classify a PDF into the best-matching folder')
  .argument('<pdf>', 'Path to a PDF file to classify')
  .action(async (pdf) => {
    const pdfPath = resolve(pdf);
    if (!existsSync(pdfPath)) {
      console.error(`Error: File not found: ${pdfPath}`);
      process.exit(1);
    }

    getDb();
    if (!hasModel()) {
      console.error('Error: No model found. Run `docc learn <folder>` first.');
      process.exit(1);
    }

    // Extract and embed
    const text = await extractPdfText(pdfPath);
    if (!text || text.trim().length === 0) {
      console.error('Error: No extractable text in this PDF.');
      process.exit(1);
    }

    const embedding = await embed(text);

    // Load model
    const centroids = getAllCentroids();
    const bayesJson = loadBayesState();
    const bayes = NaiveBayes.deserialize(bayesJson);

    // Classify
    const tokens = tokenize(text);
    const bayesRanking = bayes.classify(tokens);
    const results = classifyDocument(embedding, centroids, bayesRanking);

    // Print results
    console.log('');
    console.log('Folder                          Score   Cosine  Bayes');
    console.log('\u2500'.repeat(56));
    results.forEach((r, i) => {
      const rank = `${i + 1}.`;
      const folder = r.folder.padEnd(32);
      const score = r.score.toFixed(2);
      const cosine = `#${r.centroidRank} ${r.centroidScore.toFixed(3)}`;
      const bayes = `#${r.bayesRank}`;
      console.log(`${rank.padEnd(3)} ${folder} ${score}    ${cosine.padEnd(10)} ${bayes}`);
    });
    console.log('');
  });

// ─── test ────────────────────────────────────────────────────────────────────

program
  .command('test')
  .description('Leave-one-out cross-validation on the learned model')
  .action(async () => {
    getDb();
    if (!hasModel()) {
      console.error('Error: No model found. Run `docc learn <folder>` first.');
      process.exit(1);
    }

    const docs = getAllDocs();
    const centroids = getAllCentroids();
    const bayesJson = loadBayesState();
    const bayes = NaiveBayes.deserialize(bayesJson);

    const centroidMap = {};
    for (const c of centroids) {
      centroidMap[c.folder] = { embedding: c.embedding, docCount: c.docCount };
    }

    const folders = [...new Set(docs.map(d => d.folder))];
    const results = []; // { correct, predicted, rank }
    const perFolder = {}; // { [folder]: { total, top1, top3, top5 } }
    const confusionPairs = {}; // { "A → B": count }

    for (const f of folders) {
      perFolder[f] = { total: 0, top1: 0, top3: 0, top5: 0 };
    }

    console.log(`Testing ${docs.length} documents across ${folders.length} folders...\n`);

    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      const tokens = tokenize(doc.text);

      // Temporarily adjust centroid
      const centInfo = centroidMap[doc.folder];
      const adjustedCentroid = adjustCentroidRemove(
        centInfo.embedding, doc.embedding, centInfo.docCount
      );

      // Build adjusted centroids list
      const adjustedCentroids = centroids.map(c => {
        if (c.folder === doc.folder) {
          if (!adjustedCentroid) return null; // single-doc folder
          return { folder: c.folder, embedding: adjustedCentroid, docCount: c.docCount - 1 };
        }
        return c;
      }).filter(Boolean);

      // Temporarily untrain Bayes
      bayes.untrain(tokens, doc.folder);

      // Classify
      const bayesRanking = bayes.classify(tokens);
      const ranked = classifyDocument(doc.embedding, adjustedCentroids, bayesRanking, folders.length);

      // Restore Bayes
      bayes.train(tokens, doc.folder);

      // Find rank of correct folder
      const rankIdx = ranked.findIndex(r => r.folder === doc.folder);
      const rank = rankIdx >= 0 ? rankIdx + 1 : ranked.length + 1;
      const predicted = ranked[0]?.folder || '(none)';

      results.push({ correct: doc.folder, predicted, rank });
      perFolder[doc.folder].total++;
      if (rank <= 1) perFolder[doc.folder].top1++;
      if (rank <= 3) perFolder[doc.folder].top3++;
      if (rank <= 5) perFolder[doc.folder].top5++;

      if (predicted !== doc.folder) {
        const pairKey = [doc.folder, predicted].sort().join(' \u2194 ');
        confusionPairs[pairKey] = (confusionPairs[pairKey] || 0) + 1;
      }

      if ((i + 1) % 10 === 0 || i === docs.length - 1) {
        process.stdout.write(`\r  Tested ${i + 1}/${docs.length}`);
      }
    }

    console.log('\n');

    // Summary
    const top1 = results.filter(r => r.rank <= 1).length;
    const top3 = results.filter(r => r.rank <= 3).length;
    const top5 = results.filter(r => r.rank <= 5).length;
    const total = results.length;

    console.log(`Leave-one-out accuracy (${total} documents, ${folders.length} folders):\n`);
    console.log(`  Top-1: ${(100 * top1 / total).toFixed(1)}%  (${top1}/${total})`);
    console.log(`  Top-3: ${(100 * top3 / total).toFixed(1)}%  (${top3}/${total})`);
    console.log(`  Top-5: ${(100 * top5 / total).toFixed(1)}%  (${top5}/${total})`);

    // Per-folder breakdown
    console.log('\nPer-folder breakdown:');
    const sortedFolders = folders.sort((a, b) =>
      perFolder[b].total - perFolder[a].total
    );
    for (const f of sortedFolders) {
      const pf = perFolder[f];
      const label = `  ${f} (${pf.total} docs)`.padEnd(36);
      const t1 = `Top-1: ${pf.total ? (100 * pf.top1 / pf.total).toFixed(1) : 0}%`;
      const t3 = `Top-3: ${pf.total ? (100 * pf.top3 / pf.total).toFixed(1) : 0}%`;
      console.log(`${label} ${t1.padEnd(16)} ${t3}`);
    }

    // Most confused pairs
    const pairs = Object.entries(confusionPairs).sort((a, b) => b[1] - a[1]);
    if (pairs.length > 0) {
      console.log('\nMost confused pairs:');
      for (const [pair, count] of pairs.slice(0, 5)) {
        console.log(`  ${pair} (${count} misclassification${count > 1 ? 's' : ''})`);
      }
    }

    console.log('');
  });

// ─── ui ──────────────────────────────────────────────────────────────────────

program
  .command('ui')
  .description('Open a web UI to interactively classify PDFs from a folder')
  .argument('[folder]', 'Folder containing unclassified PDFs (default: configured inbox or cwd)')
  .option('-p, --port <number>', 'Port number', '3141')
  .action(async (folder, opts) => {
    if (!folder) {
      getDb();
      folder = getMeta('inbox') || '.';
    }
    const targetFolder = resolve(folder);
    if (!existsSync(targetFolder)) {
      console.error(`Error: Folder not found: ${targetFolder}`);
      process.exit(1);
    }

    getDb();
    if (!hasModel()) {
      console.error('Error: No model found. Run `docc learn <folder>` first.');
      process.exit(1);
    }

    const root = getMeta('root');
    if (!root) {
      console.error('Error: No root path stored. Run `docc learn <folder>` first.');
      process.exit(1);
    }

    const port = parseInt(opts.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      console.error('Error: Invalid port number.');
      process.exit(1);
    }

    startUiServer(targetFolder, { port });
  });

// ─── reset ───────────────────────────────────────────────────────────────────

program
  .command('reset')
  .description('Clear the learned model (keeps configuration)')
  .action(() => {
    getDb();
    if (!hasModel()) {
      console.log('No model found. Nothing to clear.');
      return;
    }
    clearModel();
    console.log('Learned model cleared. Configuration (root, inbox) preserved.');
  });

program.parse();
