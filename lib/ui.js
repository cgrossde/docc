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
import { getAllCentroids, loadBayesState, getMeta, getAllDocs, getDocsByFolder, insertStat } from './db.js';
import { findDuplicates, cosineSimilarity } from './vectors.js';
import { suggestFilenames } from './namer.js';

/**
 * Start the web UI server.
 * @param {string} targetFolder - Absolute path to folder with unclassified PDFs
 * @param {{ port: number }} options
 */
export function startUiServer(targetFolder, { port }) {
  // Load model once at startup
  const centroids = getAllCentroids();
  const bayesJson = loadBayesState();
  const bayes = NaiveBayes.deserialize(bayesJson);
  const rootPath = getMeta('root');
  const allDocs = getAllDocs();

  const folderNames = centroids.map(c => c.folder).sort();

  // Cache rawText + embedding from classify for async name suggestions
  const classifyCache = new Map();

  /** List PDF files in target folder (non-recursive) */
  function listPdfs() {
    return readdirSync(targetFolder)
      .filter(f => extname(f).toLowerCase() === '.pdf')
      .sort();
  }

  /** Validate a filename is safe (no path traversal) */
  function isSafeFilename(name) {
    if (!name || typeof name !== 'string') return false;
    const normalized = normalize(name);
    return normalized === basename(normalized) && !normalized.startsWith('.');
  }

  /** Read JSON body from request */
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

  /** Send JSON response */
  function json(res, data, status = 200) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${port}`);
      const path = url.pathname;

      // Static SPA assets
      if (req.method === 'GET' && (path === '/' || path === '/style.css' || path === '/app.js')) {
        const fileMap = {
          '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
          '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
          '/app.js': { file: 'app.js', type: 'application/javascript; charset=utf-8' },
        };
        const { file, type } = fileMap[path];
        const content = readFileSync(join(uiDir, file));
        res.writeHead(200, {
          'Content-Type': type,
          'Content-Length': content.length,
        });
        res.end(content);
        return;
      }

      // GET /api/pdfs — list PDFs in target folder
      if (req.method === 'GET' && path === '/api/pdfs') {
        json(res, { pdfs: listPdfs() });
        return;
      }

      // GET /api/pdf/:filename — serve raw PDF for preview
      if (req.method === 'GET' && path.startsWith('/api/pdf/')) {
        const filename = decodeURIComponent(path.slice('/api/pdf/'.length));
        if (!isSafeFilename(filename)) {
          json(res, { error: 'Invalid filename' }, 400);
          return;
        }
        const filePath = join(targetFolder, filename);
        if (!existsSync(filePath)) {
          json(res, { error: 'File not found' }, 404);
          return;
        }
        const data = readFileSync(filePath);
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Length': data.length,
          'Content-Disposition': `inline; filename="${filename}"`,
        });
        res.end(data);
        return;
      }

      // GET /api/folders — all known folders
      if (req.method === 'GET' && path === '/api/folders') {
        json(res, { folders: folderNames });
        return;
      }

      // POST /api/classify — classify a PDF
      if (req.method === 'POST' && path === '/api/classify') {
        const body = await readBody(req);
        const filename = body.filename;
        if (!isSafeFilename(filename)) {
          json(res, { error: 'Invalid filename' }, 400);
          return;
        }
        const filePath = join(targetFolder, filename);
        if (!existsSync(filePath)) {
          json(res, { error: 'File not found' }, 404);
          return;
        }

        const classifyStart = Date.now();

        const rawText = await extractPdfText(filePath);
        if (!rawText || rawText.trim().length === 0) {
          json(res, { error: 'No extractable text in this PDF' }, 422);
          return;
        }

        const text = enrichText(filePath, rawText);
        const embedStart = Date.now();
        const embedding = await embed(text);
        const embeddingRaw = await embed(rawText);
        const embedDurationMs = Date.now() - embedStart;
        const tokens = tokenize(text);
        const bayesRanking = bayes.classify(tokens);
        const results = classifyDocument(embedding, centroids, bayesRanking);

        // Cache for async name suggestion (use raw embedding for similarity)
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

        const classifyDurationMs = Date.now() - classifyStart;
        insertStat('classify', {
          filename, durationMs: classifyDurationMs, embedDurationMs,
          topFolder: top?.folder || null, topScore: top ? +top.score.toFixed(3) : null,
        });

        json(res, { results, duplicates });
        return;
      }

      // POST /api/suggest-names — async name suggestions for a classified PDF
      if (req.method === 'POST' && path === '/api/suggest-names') {
        const body = await readBody(req);
        const { filename, folder } = body;
        if (!filename || !folder) {
          json(res, { error: 'Missing filename or folder' }, 400);
          return;
        }
        const cached = classifyCache.get(filename);
        if (!cached) {
          json(res, { error: 'No cached data — classify first' }, 404);
          return;
        }
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
        return;
      }

      // GET /api/folder-files?folder=X&filename=Y — list files in a folder (with optional similarity)
      if (req.method === 'GET' && path === '/api/folder-files') {
        const folder = url.searchParams.get('folder');
        const inboxFilename = url.searchParams.get('filename');
        if (!folder || typeof folder !== 'string') {
          json(res, { files: [] });
          return;
        }
        const dir = resolve(rootPath, folder);
        if (!dir.startsWith(rootPath)) {
          json(res, { files: [] });
          return;
        }
        if (!existsSync(dir)) {
          json(res, { files: [] });
          return;
        }
        try {
          // Build similarity lookup if we have a cached embedding
          let simMap = null;
          if (inboxFilename) {
            const cached = classifyCache.get(inboxFilename);
            if (cached) {
              const folderDocs = getDocsByFolder(folder);
              simMap = {};
              for (const doc of folderDocs) {
                const fname = basename(doc.path);
                // Use raw embeddings for content-only similarity
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
        return;
      }

      // POST /api/open-folder — open folder in Finder/file manager
      if (req.method === 'POST' && path === '/api/open-folder') {
        const body = await readBody(req);
        const folder = body.folder;
        if (!folder || typeof folder !== 'string') {
          json(res, { error: 'Missing folder' }, 400);
          return;
        }
        const dir = resolve(rootPath, folder);
        if (!dir.startsWith(rootPath)) {
          json(res, { error: 'Invalid folder path' }, 400);
          return;
        }
        const cmd = platform() === 'darwin' ? 'open' : 'xdg-open';
        exec(`${cmd} "${dir}"`);
        json(res, { ok: true });
        return;
      }

      // POST /api/move — move PDF to folder
      if (req.method === 'POST' && path === '/api/move') {
        const body = await readBody(req);
        const { filename, folder, newName } = body;

        if (!isSafeFilename(filename)) {
          json(res, { error: 'Invalid source filename' }, 400);
          return;
        }
        if (!folder || typeof folder !== 'string') {
          json(res, { error: 'Missing folder' }, 400);
          return;
        }
        // Validate folder doesn't escape root
        const destDir = resolve(rootPath, folder);
        if (!destDir.startsWith(rootPath)) {
          json(res, { error: 'Invalid folder path' }, 400);
          return;
        }

        const destName = newName && isSafeFilename(newName) ? newName : filename;
        // Ensure .pdf extension
        const finalName = extname(destName).toLowerCase() === '.pdf' ? destName : destName + '.pdf';

        const srcPath = join(targetFolder, filename);
        if (!existsSync(srcPath)) {
          json(res, { error: 'Source file not found' }, 404);
          return;
        }

        const destPath = join(destDir, finalName);
        if (existsSync(destPath)) {
          json(res, { error: `File already exists: ${finalName} in ${folder}` }, 409);
          return;
        }

        // Create dest dir if needed
        mkdirSync(destDir, { recursive: true });

        // Move file (with EXDEV fallback for cross-device)
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
        return;
      }

      // GET /api/doc-pdf?path=<relative-path> — serve a PDF from root
      if (req.method === 'GET' && path === '/api/doc-pdf') {
        const relPath = url.searchParams.get('path');
        if (!relPath) {
          json(res, { error: 'Missing path parameter' }, 400);
          return;
        }
        const absPath = resolve(rootPath, relPath);
        if (!absPath.startsWith(rootPath)) {
          json(res, { error: 'Invalid path' }, 400);
          return;
        }
        if (!existsSync(absPath)) {
          json(res, { error: 'File not found' }, 404);
          return;
        }
        const data = readFileSync(absPath);
        const fname = basename(absPath);
        const encoded = encodeURIComponent(fname).replace(/'/g, '%27');
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Length': data.length,
          'Content-Disposition': `inline; filename*=UTF-8''${encoded}`,
        });
        res.end(data);
        return;
      }

      // POST /api/log — log a client-side action to the console
      if (req.method === 'POST' && path === '/api/log') {
        const body = await readBody(req);
        if (body.action && body.filename) {
          console.log(`  ${body.action.padEnd(8)} ${body.filename}`);
          if (body.action === 'skip') {
            insertStat('skip', {
              filename: body.filename,
              hadDuplicate: body.hadDuplicate ?? false,
            });
          }
        }
        json(res, { ok: true });
        return;
      }

      // POST /api/delete — delete a PDF from the inbox
      if (req.method === 'POST' && path === '/api/delete') {
        const body = await readBody(req);
        const { filename } = body;
        if (!isSafeFilename(filename)) {
          json(res, { error: 'Invalid filename' }, 400);
          return;
        }
        const filePath = join(targetFolder, filename);
        if (!existsSync(filePath)) {
          json(res, { error: 'File not found' }, 404);
          return;
        }
        unlinkSync(filePath);
        console.log(`  delete  ${filename}`);
        insertStat('delete', {
          filename,
          hadDuplicate: body.hadDuplicate ?? false,
        });
        json(res, { ok: true });
        return;
      }

      // 404 fallback
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

    // Auto-open browser
    const cmd = platform() === 'darwin' ? 'open' : 'xdg-open';
    exec(`${cmd} ${url}`);
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    server.close(() => process.exit(0));
  });
}
