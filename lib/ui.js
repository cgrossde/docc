import { createServer } from 'node:http';
import { readdirSync, readFileSync, renameSync, mkdirSync, existsSync, copyFileSync, unlinkSync, statSync } from 'node:fs';
import { join, basename, extname, resolve, normalize, relative, dirname } from 'node:path';
import { exec } from 'node:child_process';
import { platform } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const uiDir = join(__dirname, 'ui');

import { extractPdfText, enrichText } from './pdf.js';
import { embed } from './embedder.js';
import { NaiveBayes, tokenize } from './bayes.js';
import { classifyDocument } from './classifier.js';
import { getAllCentroids, loadBayesState, getMeta, getAllDocs, getDocsByFolder, insertStat, getStats } from './db.js';
import { findDuplicates, cosineSimilarity } from './vectors.js';
import { suggestFilenames } from './namer.js';
import { learnPdfs } from './learn.js';

const CLASSIFY_CACHE_MAX = 50;

/**
 * Start the web UI server.
 * @param {string} targetFolder - Absolute path to folder with unclassified PDFs
 * @param {{ port: number }} options
 */
export function startUiServer(targetFolder, { port }) {
  const rootPath = getMeta('root');

  // Group mutable model state for atomic swaps — no request sees a mix of old/new values
  let model = {
    centroids: getAllCentroids(),
    bayes: NaiveBayes.deserialize(loadBayesState()),
    allDocs: getAllDocs(),
  };

  // Merge indexed folders (from centroids) with all subfolders on disk
  function scanAllFolders(root) {
    const result = new Set();
    function walk(dir, rel) {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue;
        const childRel = rel ? rel + '/' + e.name : e.name;
        result.add(childRel);
        walk(join(dir, e.name), childRel);
      }
    }
    if (root) walk(root, '');
    return result;
  }
  const diskFolders = rootPath ? scanAllFolders(rootPath) : new Set();
  model.centroids.forEach(c => diskFolders.add(c.folder));
  const folderNames = [...diskFolders].sort();

  // Cache rawText + embedding from classify for async name suggestions (capped to avoid unbounded growth)
  const classifyCache = new Map();

  // === Helpers ===

  function listPdfs() {
    return readdirSync(targetFolder)
      .filter(f => extname(f).toLowerCase() === '.pdf')
      .sort();
  }

  function isSafeFilename(name) {
    if (!name || typeof name !== 'string') return false;
    const normalized = normalize(name);
    return normalized === basename(normalized) && !normalized.startsWith('.');
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(e); }
      });
      req.on('error', reject);
    });
  }

  function json(res, data, status = 200) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  // === Route Handlers ===

  async function handleGetPdfs(_req, res) {
    json(res, { pdfs: listPdfs() });
  }

  async function handleGetFolders(_req, res) {
    json(res, { folders: folderNames });
  }

  async function handleGetStats(_req, res) {
    json(res, { stats: getStats() });
  }

  async function handleGetFolderFiles(_req, res, url) {
    const folder = url.searchParams.get('folder');
    const inboxFilename = url.searchParams.get('filename');
    if (!folder || typeof folder !== 'string') { json(res, { files: [] }); return; }
    const dir = resolve(rootPath, folder);
    if (!dir.startsWith(rootPath)) { json(res, { files: [] }); return; }
    if (!existsSync(dir)) { json(res, { files: [] }); return; }
    try {
      let simMap = null;
      if (inboxFilename) {
        const cached = classifyCache.get(inboxFilename);
        if (cached) {
          const folderDocs = getDocsByFolder(folder);
          simMap = {};
          for (const doc of folderDocs) {
            const fname = basename(doc.path);
            const queryEmb = cached.embeddingRaw || cached.embedding;
            const docEmb = doc.embeddingRaw || doc.embedding;
            simMap[fname] = cosineSimilarity(queryEmb, docEmb);
          }
        }
      }
      const entries = readdirSync(dir)
        .filter(f => {
          if (f === '.DS_Store') return false;
          try { return statSync(join(dir, f)).isFile(); } catch { return false; }
        })
        .map(f => {
          const st = statSync(join(dir, f));
          const entry = { name: f, mtime: st.mtimeMs };
          if (simMap && simMap[f] != null) entry.similarity = simMap[f];
          return entry;
        })
        .sort((a, b) => b.mtime - a.mtime);
      json(res, { files: entries });
    } catch {
      json(res, { files: [] });
    }
  }

  async function handleGetDocPdf(_req, res, url) {
    const relPath = url.searchParams.get('path');
    if (!relPath) { json(res, { error: 'Missing path parameter' }, 400); return; }
    const absPath = resolve(rootPath, relPath);
    if (!absPath.startsWith(rootPath)) { json(res, { error: 'Invalid path' }, 400); return; }
    if (!existsSync(absPath)) { json(res, { error: 'File not found' }, 404); return; }
    const data = readFileSync(absPath);
    const fname = basename(absPath);
    const encoded = encodeURIComponent(fname).replace(/'/g, '%27');
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': data.length,
      'Content-Disposition': `inline; filename*=UTF-8''${encoded}`,
    });
    res.end(data);
  }

  async function handleGetInboxPdf(_req, res, path) {
    const filename = decodeURIComponent(path.slice('/api/pdf/'.length));
    if (!isSafeFilename(filename)) { json(res, { error: 'Invalid filename' }, 400); return; }
    const filePath = join(targetFolder, filename);
    if (!existsSync(filePath)) { json(res, { error: 'File not found' }, 404); return; }
    const data = readFileSync(filePath);
    const encoded = encodeURIComponent(filename).replace(/'/g, '%27');
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': data.length,
      'Content-Disposition': `inline; filename*=UTF-8''${encoded}`,
    });
    res.end(data);
  }

  async function handlePostClassify(req, res) {
    const { centroids, bayes, allDocs } = model; // snapshot for this request
    const body = await readBody(req);
    const filename = body.filename;
    if (!isSafeFilename(filename)) { json(res, { error: 'Invalid filename' }, 400); return; }
    const filePath = join(targetFolder, filename);
    if (!existsSync(filePath)) { json(res, { error: 'File not found' }, 404); return; }

    const classifyStart = Date.now();
    const rawText = await extractPdfText(filePath);
    if (!rawText || rawText.trim().length === 0) {
      json(res, { error: 'No extractable text in this PDF' }, 422);
      return;
    }

    const text = enrichText(filePath, rawText);
    const embedStart = Date.now();
    const [embedding, embeddingRaw] = await Promise.all([embed(text), embed(rawText)]);
    const embedDurationMs = Date.now() - embedStart;
    const tokens = tokenize(text);
    const bayesRanking = bayes.classify(tokens);
    const results = classifyDocument(embedding, centroids, bayesRanking);

    // Cache for async name suggestions — evict oldest when full
    if (classifyCache.size >= CLASSIFY_CACHE_MAX) {
      classifyCache.delete(classifyCache.keys().next().value);
    }
    classifyCache.set(filename, { rawText, embedding, embeddingRaw, filePath });

    const duplicates = findDuplicates(embeddingRaw, allDocs).map(d => ({
      ...d,
      relativePath: relative(rootPath, d.path),
    }));

    const top = results[0];
    console.log(`  classify  ${filename} → ${top ? top.folder + ' (' + (top.score * 100).toFixed(0) + '%)' : 'no results'}`);
    if (duplicates.length > 0) {
      const d = duplicates[0];
      console.log(`  duplicate ${filename} ≈ ${d.folder}/${d.filename} (${(d.similarity * 100).toFixed(1)}%)`);
    }

    insertStat('classify', {
      filename, durationMs: Date.now() - classifyStart, embedDurationMs,
      topFolder: top?.folder || null, topScore: top ? +top.score.toFixed(3) : null,
    });

    json(res, { results, duplicates });
  }

  async function handlePostSuggestNames(req, res) {
    const body = await readBody(req);
    const { filename, folder } = body;
    if (!filename || !folder) { json(res, { error: 'Missing filename or folder' }, 400); return; }
    const cached = classifyCache.get(filename);
    if (!cached) { json(res, { error: 'No cached data — classify first' }, 404); return; }
    const folderDocs = getDocsByFolder(folder);
    console.log(`  names   ${filename} → ${folder} ...`);
    const nameStart = Date.now();
    const result = await suggestFilenames(cached.filePath, cached.rawText, cached.embeddingRaw, folder, folderDocs);
    const elapsed = ((Date.now() - nameStart) / 1000).toFixed(1);
    const top = result.suggestions[0];
    console.log(`  names   ${filename} → ${top ? top.name : '(none)'} (${elapsed}s, ${result.suggestions.length} suggestions)`);
    insertStat('suggest-names', {
      filename, folder, durationMs: Date.now() - nameStart, suggestionCount: result.suggestions.length,
    });
    json(res, result);
  }

  async function handlePostOpenFolder(req, res) {
    const body = await readBody(req);
    const folder = body.folder;
    if (!folder || typeof folder !== 'string') { json(res, { error: 'Missing folder' }, 400); return; }
    const dir = resolve(rootPath, folder);
    if (!dir.startsWith(rootPath)) { json(res, { error: 'Invalid folder path' }, 400); return; }
    const cmd = platform() === 'darwin' ? 'open' : 'xdg-open';
    exec(`${cmd} "${dir}"`);
    json(res, { ok: true });
  }

  async function handlePostMove(req, res) {
    const body = await readBody(req);
    const { filename, folder, newName } = body;
    if (!isSafeFilename(filename)) { json(res, { error: 'Invalid source filename' }, 400); return; }
    if (!folder || typeof folder !== 'string') { json(res, { error: 'Missing folder' }, 400); return; }
    const destDir = resolve(rootPath, folder);
    if (!destDir.startsWith(rootPath)) { json(res, { error: 'Invalid folder path' }, 400); return; }

    const destName = newName && isSafeFilename(newName) ? newName : filename;
    const finalName = extname(destName).toLowerCase() === '.pdf' ? destName : destName + '.pdf';
    const srcPath = join(targetFolder, filename);
    if (!existsSync(srcPath)) { json(res, { error: 'Source file not found' }, 404); return; }
    const destPath = join(destDir, finalName);
    if (existsSync(destPath)) { json(res, { error: `File already exists: ${finalName} in ${folder}` }, 409); return; }

    mkdirSync(destDir, { recursive: true });
    try {
      renameSync(srcPath, destPath);
    } catch (err) {
      if (err.code === 'EXDEV') {
        copyFileSync(srcPath, destPath);
        unlinkSync(srcPath);
      } else {
        throw err;
      }
    }

    const renamedPart = finalName !== filename ? ` (renamed: ${finalName})` : '';
    console.log(`  move    ${filename} → ${folder}${renamedPart}`);
    insertStat('move', {
      filename, folder,
      chosenRank: body.chosenRank ?? null,
      wasManual: body.wasManual ?? false,
      centroidRank: body.centroidRank ?? null,
      bayesRank: body.bayesRank ?? null,
      score: body.score ?? null,
      hadDuplicate: body.hadDuplicate ?? false,
    });
    json(res, { ok: true, dest: destPath });
  }

  async function handlePostLog(req, res) {
    const body = await readBody(req);
    if (body.action && body.filename) {
      console.log(`  ${body.action.padEnd(8)} ${body.filename}`);
      if (body.action === 'skip') {
        insertStat('skip', { filename: body.filename, hadDuplicate: body.hadDuplicate ?? false });
      }
    }
    json(res, { ok: true });
  }

  async function handlePostDelete(req, res) {
    const body = await readBody(req);
    const { filename } = body;
    if (!isSafeFilename(filename)) { json(res, { error: 'Invalid filename' }, 400); return; }
    const filePath = join(targetFolder, filename);
    if (!existsSync(filePath)) { json(res, { error: 'File not found' }, 404); return; }
    unlinkSync(filePath);
    console.log(`  delete  ${filename}`);
    insertStat('delete', { filename, hadDuplicate: body.hadDuplicate ?? false });
    json(res, { ok: true });
  }

  async function handleStatic(_req, res, path) {
    let file, type;
    if (path === '/') {
      file = 'index.html';
      type = 'text/html; charset=utf-8';
    } else if (path === '/style.css') {
      file = 'style.css';
      type = 'text/css; charset=utf-8';
    } else if (path.endsWith('.js')) {
      file = path.slice(1);
      const resolved = resolve(uiDir, file);
      if (!resolved.startsWith(uiDir + '/') || !resolved.endsWith('.js')) {
        json(res, { error: 'Not found' }, 404);
        return;
      }
      type = 'application/javascript; charset=utf-8';
    } else {
      json(res, { error: 'Not found' }, 404);
      return;
    }
    const filePath = join(uiDir, file);
    if (!existsSync(filePath)) { json(res, { error: 'Not found' }, 404); return; }
    const content = readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': content.length });
    res.end(content);
  }

  // === Route dispatch table (exact API paths) ===
  const apiRoutes = {
    'GET /api/pdfs':           handleGetPdfs,
    'GET /api/folders':        handleGetFolders,
    'GET /api/stats':          handleGetStats,
    'GET /api/folder-files':   handleGetFolderFiles,
    'GET /api/doc-pdf':        handleGetDocPdf,
    'POST /api/classify':      handlePostClassify,
    'POST /api/suggest-names': handlePostSuggestNames,
    'POST /api/open-folder':   handlePostOpenFolder,
    'POST /api/move':          handlePostMove,
    'POST /api/log':           handlePostLog,
    'POST /api/delete':        handlePostDelete,
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${port}`);
      const path = url.pathname;

      // Exact API route dispatch
      const apiHandler = apiRoutes[`${req.method} ${path}`];
      if (apiHandler) {
        await apiHandler(req, res, url);
        return;
      }

      // Prefix route: serve PDF from inbox
      if (req.method === 'GET' && path.startsWith('/api/pdf/')) {
        await handleGetInboxPdf(req, res, path);
        return;
      }

      // Static SPA assets (GET only)
      if (req.method === 'GET') {
        await handleStatic(req, res, path);
        return;
      }

      json(res, { error: 'Not found' }, 404);
    } catch (err) {
      console.error('Server error:', err);
      json(res, { error: err.message }, 500);
    }
  });

  server.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}`;
    console.log(`\ndocc UI running at ${url}`);
    console.log(`Classifying PDFs from: ${targetFolder}`);
    console.log(`Filing into: ${rootPath}\n`);

    const cmd = platform() === 'darwin' ? 'open' : 'xdg-open';
    exec(`${cmd} ${url}`);

    // Background reindex: pick up any new PDFs added since last learn.
    // Swap model atomically so in-flight requests always see a consistent snapshot.
    if (rootPath) {
      (async () => {
        const result = await learnPdfs(rootPath);
        if (!result) return;
        model = {
          centroids: getAllCentroids(),
          bayes: NaiveBayes.deserialize(loadBayesState()),
          allDocs: getAllDocs(),
        };
        console.log(`[reindex] Indexed ${result.newDocs} new doc(s) across ${result.folders.length} folder(s).`);
      })().catch(err => console.error('[reindex] Failed:', err.message));
    }
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    server.close(() => process.exit(0));
  });
}
