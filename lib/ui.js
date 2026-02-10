import { createServer } from 'node:http';
import { readdirSync, readFileSync, renameSync, mkdirSync, existsSync, copyFileSync, unlinkSync, statSync } from 'node:fs';
import { join, basename, extname, resolve, normalize } from 'node:path';
import { exec } from 'node:child_process';
import { platform } from 'node:os';

import { extractPdfText } from './pdf.js';
import { embed } from './embedder.js';
import { NaiveBayes, tokenize } from './bayes.js';
import { classifyDocument } from './classifier.js';
import { getAllCentroids, loadBayesState, getMeta } from './db.js';

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

  const folderNames = centroids.map(c => c.folder).sort();

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

      // GET / — serve SPA
      if (req.method === 'GET' && path === '/') {
        const html = buildHtml();
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(html),
        });
        res.end(html);
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

        const text = await extractPdfText(filePath);
        if (!text || text.trim().length === 0) {
          json(res, { error: 'No extractable text in this PDF' }, 422);
          return;
        }

        const embedding = await embed(text);
        const tokens = tokenize(text);
        const bayesRanking = bayes.classify(tokens);
        const results = classifyDocument(embedding, centroids, bayesRanking);

        json(res, { results });
        return;
      }

      // GET /api/folder-files?folder=X — list files in a folder
      if (req.method === 'GET' && path === '/api/folder-files') {
        const folder = url.searchParams.get('folder');
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
          const entries = readdirSync(dir)
            .filter(f => {
              try { return statSync(join(dir, f)).isFile(); } catch { return false; }
            })
            .map(f => {
              const st = statSync(join(dir, f));
              return { name: f, mtime: st.mtimeMs };
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

        json(res, { ok: true, dest: destPath });
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

// ─── Inline SPA ──────────────────────────────────────────────────────────────

function buildHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>docc — PDF Classifier</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #f5f5f5;
    color: #222;
    height: 100vh;
    display: flex;
    flex-direction: column;
  }
  header {
    background: #1a1a2e;
    color: #fff;
    padding: 12px 24px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-shrink: 0;
  }
  header h1 { font-size: 18px; font-weight: 600; }
  header .progress { font-size: 14px; opacity: 0.8; display: flex; align-items: center; gap: 10px; }
  header .progress .nav-btn {
    background: none;
    border: 1px solid rgba(255,255,255,0.3);
    color: #fff;
    border-radius: 4px;
    padding: 2px 10px;
    font-size: 13px;
    cursor: pointer;
    font-weight: 500;
  }
  header .progress .nav-btn:hover { border-color: rgba(255,255,255,0.7); }
  header .progress .nav-btn:disabled { opacity: 0.3; cursor: default; border-color: rgba(255,255,255,0.15); }

  .main {
    display: flex;
    flex: 1;
    overflow: hidden;
    min-height: 0;
  }

  .preview-pane {
    flex: 0 0 60%;
    background: #e0e0e0;
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
  }
  .preview-pane iframe {
    width: 100%;
    height: 100%;
    border: none;
  }
  .preview-placeholder {
    color: #888;
    font-size: 16px;
  }

  .right-side {
    flex: 0 0 40%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .control-pane {
    flex: 1;
    padding: 24px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .filename {
    font-size: 15px;
    font-weight: 600;
    word-break: break-all;
    color: #333;
  }
  .moved-badge {
    display: inline-block;
    padding: 2px 8px;
    background: #d4edda;
    color: #155724;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 500;
    margin-left: 8px;
  }
  .moved-info {
    background: #f0f7f0;
    border: 1px solid #c3e6cb;
    border-radius: 8px;
    padding: 14px 16px;
    font-size: 13px;
    color: #333;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .moved-info .moved-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #888;
  }
  .moved-info .moved-value {
    font-weight: 500;
    word-break: break-all;
  }

  .section-label {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #888;
    margin-bottom: 8px;
  }

  .suggestions { display: flex; flex-direction: column; gap: 8px; }
  .suggestion-btn {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 16px;
    border: 2px solid #ddd;
    border-radius: 8px;
    background: #fff;
    cursor: pointer;
    font-size: 14px;
    transition: all 0.15s;
  }
  .suggestion-btn:hover {
    border-color: #4361ee;
    background: #f0f4ff;
  }
  .suggestion-btn .folder-name { font-weight: 500; }
  .suggestion-btn .score {
    font-size: 12px;
    color: #888;
    font-variant-numeric: tabular-nums;
  }
  .suggestion-btn.selected {
    border-color: #4361ee;
    background: #f0f4ff;
  }
  .suggestion-btn.disabled {
    opacity: 0.5;
    cursor: default;
    pointer-events: none;
  }

  .fuzzy-wrapper {
    position: relative;
    flex: 1;
  }
  .fuzzy-wrapper input {
    width: 100%;
    padding: 10px 12px;
    border: 2px solid #ddd;
    border-radius: 8px;
    font-size: 14px;
    background: #fff;
  }
  .fuzzy-wrapper input:focus {
    outline: none;
    border-color: #4361ee;
  }
  .fuzzy-dropdown {
    display: none;
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    max-height: 240px;
    overflow-y: auto;
    background: #fff;
    border: 2px solid #4361ee;
    border-top: none;
    border-radius: 0 0 8px 8px;
    z-index: 10;
  }
  .fuzzy-dropdown.open { display: block; }
  .fuzzy-option {
    padding: 8px 12px;
    font-size: 14px;
    cursor: pointer;
  }
  .fuzzy-option:hover, .fuzzy-option.highlighted {
    background: #f0f4ff;
  }

  .dropdown-row {
    display: flex;
    gap: 8px;
  }
  .dropdown-row button {
    padding: 10px 20px;
    border: none;
    border-radius: 8px;
    background: #4361ee;
    color: #fff;
    font-size: 14px;
    cursor: pointer;
    font-weight: 500;
    white-space: nowrap;
  }
  .dropdown-row button:hover { background: #3451d1; }
  .dropdown-row button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .rename-row {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .rename-row input {
    flex: 1;
    padding: 10px 12px;
    border: 2px solid #ddd;
    border-radius: 8px;
    font-size: 14px;
  }
  .rename-row input:focus {
    outline: none;
    border-color: #4361ee;
  }


  .folder-files-section {
    max-height: 200px;
    overflow-y: auto;
  }
  .folder-files-list {
    list-style: none;
    font-size: 12px;
    color: #666;
  }
  .folder-files-list li {
    padding: 3px 0;
    display: flex;
    justify-content: space-between;
    border-bottom: 1px solid #f0f0f0;
  }
  .folder-files-list .file-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    margin-right: 8px;
  }
  .folder-files-list .file-time {
    white-space: nowrap;
    color: #aaa;
    flex-shrink: 0;
  }

  .status-bar {
    padding: 10px 16px;
    border-radius: 8px;
    font-size: 13px;
    min-height: 40px;
    display: flex;
    align-items: center;
  }
  .status-bar.loading { background: #fff3cd; color: #856404; }
  .status-bar.success { background: #d4edda; color: #155724; }
  .status-bar.error { background: #f8d7da; color: #721c24; }
  .status-bar.idle { background: transparent; }

  .done-screen {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: 12px;
    color: #555;
  }
  .done-screen .big { font-size: 24px; font-weight: 600; color: #222; }

  .spinner {
    display: inline-block;
    width: 16px;
    height: 16px;
    border: 2px solid #856404;
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
    margin-right: 8px;
    vertical-align: middle;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .keyboard-hint {
    flex-shrink: 0;
    font-size: 11px;
    color: #aaa;
    text-align: center;
    line-height: 1.8;
    padding: 8px 16px;
    border-top: 1px solid #e0e0e0;
    background: #fafafa;
    min-height: 20px;
  }
  kbd {
    display: inline-block;
    padding: 2px 6px;
    font-size: 11px;
    background: #eee;
    border: 1px solid #ccc;
    border-radius: 3px;
    font-family: inherit;
  }

  .toast-container {
    position: fixed;
    top: 56px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 100;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    pointer-events: none;
  }
  .toast {
    padding: 8px 20px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
    opacity: 0;
    animation: toastIn 0.2s ease forwards, toastOut 0.3s ease 1.8s forwards;
    white-space: nowrap;
  }
  .toast.skip { background: #fff3cd; color: #856404; }
  .toast.moved { background: #d4edda; color: #155724; }
  @keyframes toastIn { to { opacity: 1; } }
  @keyframes toastOut { to { opacity: 0; } }
</style>
</head>
<body>

<header>
  <h1>docc</h1>
  <div class="progress" id="progress">
    <button class="nav-btn" id="btnBack" onclick="window._goBack()" disabled>&larr;</button>
    <span id="progressText"></span>
    <button class="nav-btn" id="btnSkip" onclick="window._skip()">&rarr;</button>
  </div>
</header>

<div class="toast-container" id="toastContainer"></div>

<div class="main" id="main">
  <div class="preview-pane" id="previewPane">
    <div class="preview-placeholder">Loading...</div>
  </div>
  <div class="right-side">
    <div class="control-pane" id="controlPane">
      <div class="status-bar loading"><span class="spinner"></span> Loading PDF list...</div>
    </div>
  </div>
</div>
<div class="keyboard-hint" id="keyboardHint"></div>

<script>
(function() {
  // ─── State ───
  let pdfs = [];
  let folders = [];
  let movedMap = new Map();     // filename -> { folder, finalName }
  let currentIdx = 0;
  let selectedSuggestion = 0;
  let currentResults = [];
  let folderFiles = [];
  let classifying = false;
  let moving = false;

  // Fuzzy dropdown state
  let fuzzyHighlight = -1;
  let fuzzyFiltered = [];
  let fuzzyOpen = false;
  let fuzzySelectedFolder = '';
  let showingFuzzy = false;    // true when "4. Specify folder" is active

  const previewPane = document.getElementById('previewPane');
  const controlPane = document.getElementById('controlPane');
  const progressTextEl = document.getElementById('progressText');
  const btnBack = document.getElementById('btnBack');
  const btnSkip = document.getElementById('btnSkip');

  // ─── Init ───
  async function init() {
    const [pdfRes, folderRes] = await Promise.all([
      fetch('/api/pdfs').then(r => r.json()),
      fetch('/api/folders').then(r => r.json()),
    ]);
    pdfs = pdfRes.pdfs;
    folders = folderRes.folders;
    currentIdx = 0;
    showCurrent();
  }

  // ─── Progress ───
  function updateProgress() {
    if (pdfs.length === 0) {
      progressTextEl.textContent = 'No PDFs found';
      btnBack.disabled = true;
      btnSkip.disabled = true;
      return;
    }
    var pos = currentIdx + 1;
    var total = pdfs.length;
    var movedCount = movedMap.size;
    progressTextEl.textContent = pos + ' of ' + total + (movedCount > 0 ? ' (' + movedCount + ' moved)' : '');
    btnBack.disabled = currentIdx <= 0;
    btnSkip.disabled = currentIdx >= pdfs.length - 1;
  }

  // ─── Relative time ───
  function relTime(mtimeMs) {
    var diff = Date.now() - mtimeMs;
    var secs = Math.floor(diff / 1000);
    if (secs < 60) return 'just now';
    var mins = Math.floor(secs / 60);
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    var days = Math.floor(hrs / 24);
    if (days < 30) return days + 'd ago';
    var months = Math.floor(days / 30);
    if (months < 12) return months + 'mo ago';
    return Math.floor(months / 12) + 'y ago';
  }

  // ─── Fuzzy match ───
  // Space-separated terms — all must appear (case-insensitive)
  function fuzzyMatch(query, text) {
    var t = text.toLowerCase();
    var terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    for (var i = 0; i < terms.length; i++) {
      if (t.indexOf(terms[i]) === -1) return false;
    }
    return true;
  }

  // ─── Show current PDF ───
  function showCurrent() {
    currentResults = [];
    selectedSuggestion = 0;
    folderFiles = [];
    fuzzySelectedFolder = '';
    showingFuzzy = false;
    updateProgress();

    if (pdfs.length === 0) {
      showDone();
      return;
    }

    // Clamp index
    if (currentIdx >= pdfs.length) currentIdx = pdfs.length - 1;
    if (currentIdx < 0) currentIdx = 0;

    var filename = pdfs[currentIdx];
    var isMoved = movedMap.has(filename);

    // PDF preview
    if (isMoved) {
      previewPane.innerHTML = '<div class="preview-placeholder">File was moved</div>';
    } else {
      previewPane.innerHTML = '<iframe src="/api/pdf/' + encodeURIComponent(filename) + '"></iframe>';
    }

    // Build controls
    var html =
      '<div class="filename">' + escHtml(filename) +
        (isMoved ? '<span class="moved-badge">Moved</span>' : '') +
      '</div>';

    if (isMoved) {
      var moveInfo = movedMap.get(filename);
      html +=
        '<div class="moved-info">' +
          '<div><span class="moved-label">Folder</span></div>' +
          '<div class="moved-value">' + escHtml(moveInfo.folder) + '</div>' +
          (moveInfo.finalName !== filename
            ? '<div><span class="moved-label">Renamed to</span></div><div class="moved-value">' + escHtml(moveInfo.finalName) + '</div>'
            : '') +
        '</div>';
    }

    if (!isMoved) {
      html +=
        '<div>' +
          '<div class="section-label">Suggestions</div>' +
          '<div class="suggestions" id="suggestions">' +
            '<div class="status-bar loading"><span class="spinner"></span> Classifying...</div>' +
          '</div>' +
        '</div>' +
        '<div id="fuzzySection" style="display:none">' +
          '<div class="section-label">Choose folder</div>' +
          '<div class="dropdown-row">' +
            '<div class="fuzzy-wrapper">' +
              '<input type="text" id="fuzzyInput" placeholder="Search folders..." autocomplete="off" />' +
              '<div class="fuzzy-dropdown" id="fuzzyDropdown"></div>' +
            '</div>' +
            '<button id="moveDropdownBtn" onclick="window._moveFromDropdown()">Move</button>' +
          '</div>' +
        '</div>' +
        '<div>' +
          '<div class="section-label">Rename (optional)</div>' +
          '<div class="rename-row">' +
            '<input type="text" id="renameInput" value="' + escAttr(filename) + '" />' +
          '</div>' +
        '</div>';
    }

    html +=
      '<div id="folderFilesSection"></div>' +
      '<div id="statusArea"></div>';

    controlPane.innerHTML = html;

    document.getElementById('keyboardHint').innerHTML =
      '<kbd>&uarr;</kbd><kbd>&darr;</kbd> select suggestion &nbsp; ' +
      '<kbd>1</kbd>-<kbd>3</kbd> pick &amp; move &nbsp; ' +
      '<kbd>4</kbd> specify folder &nbsp; ' +
      '<kbd>Enter</kbd> move to selection &nbsp; ' +
      '<kbd>&larr;</kbd><kbd>&rarr;</kbd> navigate &nbsp; ' +
      '<kbd>s</kbd> skip &nbsp; ' +
      '<kbd>o</kbd> open folder &nbsp; ' +
      '<kbd>Tab</kbd> rename field';

    // Wire up inputs
    if (!isMoved) {
      setupFuzzyDropdown();
      setupRenameInput();
      classify(filename);
    }
  }

  // ─── Rename input setup ───
  function setupRenameInput() {
    var input = document.getElementById('renameInput');
    if (!input) return;
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        // Ensure .pdf extension
        var val = input.value.trim();
        if (val && !val.toLowerCase().endsWith('.pdf')) {
          val = val + '.pdf';
          input.value = val;
        }
        input.blur();
        // Move to selected or fuzzy folder
        if (showingFuzzy) {
          window._moveFromDropdown();
        } else if (currentResults.length > 0) {
          window._moveTo(currentResults[selectedSuggestion].folder);
        }
      }
    });
  }

  // ─── Fuzzy dropdown setup ───
  function setupFuzzyDropdown() {
    var input = document.getElementById('fuzzyInput');
    var dropdown = document.getElementById('fuzzyDropdown');
    if (!input || !dropdown) return;

    input.addEventListener('focus', function() {
      updateFuzzyDropdown();
      openFuzzy();
    });

    input.addEventListener('input', function() {
      updateFuzzyDropdown();
      openFuzzy();
    });

    input.addEventListener('blur', function() {
      // Delay to allow click on option
      setTimeout(function() { closeFuzzy(); }, 150);
    });

    input.addEventListener('keydown', function(e) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!fuzzyOpen) { updateFuzzyDropdown(); openFuzzy(); }
        fuzzyHighlight = Math.min(fuzzyHighlight + 1, fuzzyFiltered.length - 1);
        renderFuzzyHighlight();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (!fuzzyOpen) { updateFuzzyDropdown(); openFuzzy(); }
        fuzzyHighlight = Math.max(fuzzyHighlight - 1, 0);
        renderFuzzyHighlight();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (fuzzyOpen && fuzzyHighlight >= 0 && fuzzyHighlight < fuzzyFiltered.length) {
          selectFuzzyOption(fuzzyFiltered[fuzzyHighlight]);
        } else if (fuzzySelectedFolder) {
          input.blur();
          window._moveFromDropdown();
        }
      } else if (e.key === 'Escape') {
        closeFuzzy();
        input.blur();
        if (showingFuzzy) window._toggleFuzzy();
      }
    });
  }

  function updateFuzzyDropdown() {
    var input = document.getElementById('fuzzyInput');
    if (!input) return;
    var query = input.value.trim();
    fuzzyFiltered = query ? folders.filter(function(f) { return fuzzyMatch(query, f); }) : folders.slice();
    fuzzyHighlight = fuzzyFiltered.length > 0 ? 0 : -1;
    renderFuzzyOptions();
  }

  function renderFuzzyOptions() {
    var dropdown = document.getElementById('fuzzyDropdown');
    if (!dropdown) return;
    dropdown.innerHTML = fuzzyFiltered.map(function(f, i) {
      var cls = i === fuzzyHighlight ? 'fuzzy-option highlighted' : 'fuzzy-option';
      return '<div class="' + cls + '" data-idx="' + i + '" onmousedown="window._selectFuzzy(' + i + ')">' + escHtml(f) + '</div>';
    }).join('');
  }

  function renderFuzzyHighlight() {
    var dropdown = document.getElementById('fuzzyDropdown');
    if (!dropdown) return;
    var options = dropdown.querySelectorAll('.fuzzy-option');
    options.forEach(function(el, i) {
      el.classList.toggle('highlighted', i === fuzzyHighlight);
    });
    // Scroll into view
    if (options[fuzzyHighlight]) {
      options[fuzzyHighlight].scrollIntoView({ block: 'nearest' });
    }
  }

  function openFuzzy() {
    fuzzyOpen = true;
    var dd = document.getElementById('fuzzyDropdown');
    if (dd) dd.classList.add('open');
  }

  function closeFuzzy() {
    fuzzyOpen = false;
    var dd = document.getElementById('fuzzyDropdown');
    if (dd) dd.classList.remove('open');
  }

  function selectFuzzyOption(folder) {
    var input = document.getElementById('fuzzyInput');
    if (input) input.value = folder;
    fuzzySelectedFolder = folder;
    closeFuzzy();
    input && input.blur();
    fetchFolderFiles(folder);
  }

  window._selectFuzzy = function(idx) {
    if (idx >= 0 && idx < fuzzyFiltered.length) {
      selectFuzzyOption(fuzzyFiltered[idx]);
    }
  };

  // ─── Classify ───
  async function classify(filename) {
    classifying = true;
    currentResults = [];
    selectedSuggestion = 0;

    try {
      var res = await fetch('/api/classify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: filename }),
      });
      var data = await res.json();

      if (!res.ok) {
        document.getElementById('suggestions').innerHTML =
          '<div class="status-bar error">' + escHtml(data.error || 'Classification failed') + '</div>';
        return;
      }

      currentResults = data.results;
      selectedSuggestion = 0;
      renderSuggestions();
      // Fetch folder files for top result
      if (currentResults.length > 0) {
        fetchFolderFiles(currentResults[0].folder);
      }
    } catch (err) {
      document.getElementById('suggestions').innerHTML =
        '<div class="status-bar error">Error: ' + escHtml(err.message) + '</div>';
    } finally {
      classifying = false;
    }
  }

  function renderSuggestions() {
    var el = document.getElementById('suggestions');
    if (!el) return;

    var top3 = currentResults.slice(0, 3);
    var html = top3.map(function(r, i) {
      var pct = (r.score * 100).toFixed(0) + '%';
      var cls = i === selectedSuggestion ? 'suggestion-btn selected' : 'suggestion-btn';
      return '<button class="' + cls + '" onclick="window._pickSuggestion(' + i + ')">' +
        '<span class="folder-name">' + (i+1) + '. ' + escHtml(r.folder) + '</span>' +
        '<span class="score">' + pct + '</span>' +
      '</button>';
    }).join('');

    // 4th option: specify folder
    html += '<button class="suggestion-btn" onclick="window._toggleFuzzy()">' +
      '<span class="folder-name">4. Specify folder\u2026</span>' +
      '<span class="score"></span>' +
    '</button>';

    el.innerHTML = html;
  }

  window._toggleFuzzy = function() {
    showingFuzzy = !showingFuzzy;
    var sugEl = document.getElementById('suggestions');
    var fuzzyEl = document.getElementById('fuzzySection');
    if (showingFuzzy) {
      if (sugEl) sugEl.style.display = 'none';
      if (fuzzyEl) fuzzyEl.style.display = '';
      var input = document.getElementById('fuzzyInput');
      if (input) { input.value = ''; input.focus(); }
      fuzzySelectedFolder = '';
      updateFuzzyDropdown();
      openFuzzy();
    } else {
      if (sugEl) sugEl.style.display = '';
      if (fuzzyEl) fuzzyEl.style.display = 'none';
    }
  };

  // ─── Folder files ───
  async function fetchFolderFiles(folder) {
    if (!folder) return;
    try {
      var res = await fetch('/api/folder-files?folder=' + encodeURIComponent(folder));
      var data = await res.json();
      folderFiles = data.files || [];
    } catch {
      folderFiles = [];
    }
    renderFolderFiles(folder);
  }

  function renderFolderFiles(folder) {
    var section = document.getElementById('folderFilesSection');
    if (!section) return;

    if (folderFiles.length === 0) {
      section.innerHTML = '';
      return;
    }

    var items = folderFiles.slice(0, 20).map(function(f) {
      return '<li><span class="file-name">' + escHtml(f.name) + '</span><span class="file-time">' + relTime(f.mtime) + '</span></li>';
    }).join('');

    section.innerHTML =
      '<div class="folder-files-section">' +
        '<div class="section-label">Files in ' + escHtml(folder) + ' (' + folderFiles.length + ')</div>' +
        '<ul class="folder-files-list">' + items + '</ul>' +
      '</div>';
  }

  // ─── Pick suggestion ───
  window._pickSuggestion = function(idx) {
    if (moving || movedMap.has(pdfs[currentIdx])) return;
    if (idx >= 0 && idx < Math.min(3, currentResults.length)) {
      window._moveTo(currentResults[idx].folder);
    }
  };

  function changeSelection(idx) {
    var maxIdx = Math.min(2, currentResults.length - 1);
    if (idx < 0 || idx > maxIdx) return;
    selectedSuggestion = idx;
    renderSuggestions();
    fetchFolderFiles(currentResults[idx].folder);
  }

  // ─── Move ───
  window._moveTo = async function(folder) {
    if (moving || currentIdx >= pdfs.length) return;
    var filename = pdfs[currentIdx];
    if (movedMap.has(filename)) return;

    moving = true;
    var renameInput = document.getElementById('renameInput');
    var newName = renameInput ? renameInput.value.trim() : '';
    if (newName && !newName.toLowerCase().endsWith('.pdf')) newName = newName + '.pdf';
    if (newName === filename) newName = '';

    setStatus('loading', 'Moving to ' + folder + '...');

    try {
      var body = { filename: filename, folder: folder };
      if (newName) body.newName = newName;

      var res = await fetch('/api/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      var data = await res.json();

      if (!res.ok) {
        setStatus('error', data.error || 'Move failed');
        moving = false;
        return;
      }

      var finalName = newName || filename;
      movedMap.set(filename, { folder: folder, finalName: finalName });
      showToast('moved', 'Moved to ' + folder);
      // Advance to next non-moved PDF
      advanceToNextUnmoved();
    } catch (err) {
      setStatus('error', 'Error: ' + err.message);
    } finally {
      moving = false;
    }
  };

  window._moveFromDropdown = function() {
    var input = document.getElementById('fuzzyInput');
    var folder = fuzzySelectedFolder || (input ? input.value.trim() : '');
    if (!folder) {
      setStatus('error', 'Select a folder first');
      return;
    }
    // Validate folder exists in known folders
    if (folders.indexOf(folder) === -1) {
      setStatus('error', 'Unknown folder: ' + folder);
      return;
    }
    window._moveTo(folder);
  };

  function advanceToNextUnmoved() {
    // Try forward from current position
    for (var i = currentIdx + 1; i < pdfs.length; i++) {
      if (!movedMap.has(pdfs[i])) {
        currentIdx = i;
        showCurrent();
        return;
      }
    }
    // Try from beginning
    for (var i = 0; i <= currentIdx; i++) {
      if (!movedMap.has(pdfs[i])) {
        currentIdx = i;
        showCurrent();
        return;
      }
    }
    // All moved
    showDone();
  }

  // ─── Navigation ───
  window._skip = function() {
    if (moving) return;
    if (currentIdx < pdfs.length - 1) {
      if (!movedMap.has(pdfs[currentIdx])) {
        showToast('skip', 'Skipped ' + pdfs[currentIdx]);
      }
      currentIdx++;
      showCurrent();
    }
  };

  window._goBack = function() {
    if (moving) return;
    if (currentIdx > 0) {
      currentIdx--;
      showCurrent();
    }
  };

  // ─── Open folder ───
  window._openFolder = async function() {
    var filename = pdfs[currentIdx];
    var folder = '';
    if (filename && movedMap.has(filename)) {
      folder = movedMap.get(filename).folder;
    } else if (currentResults.length > 0) {
      folder = currentResults[selectedSuggestion] ? currentResults[selectedSuggestion].folder : '';
    }
    if (!folder) return;
    try {
      await fetch('/api/open-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder: folder }),
      });
    } catch {}
  };

  // ─── Done screen ───
  function showDone() {
    previewPane.innerHTML = '';
    controlPane.innerHTML =
      '<div class="done-screen">' +
        '<div class="big">All done</div>' +
        '<div>' + movedMap.size + ' PDFs moved.</div>' +
      '</div>';
    document.getElementById('keyboardHint').innerHTML = '';
    updateProgress();
  }

  function setStatus(type, msg) {
    var el = document.getElementById('statusArea');
    if (!el) return;
    var prefix = type === 'loading' ? '<span class="spinner"></span> ' : '';
    el.innerHTML = '<div class="status-bar ' + type + '">' + prefix + escHtml(msg) + '</div>';
    if (type === 'success') {
      setTimeout(function() { if (el) el.innerHTML = ''; }, 2000);
    }
  }

  function showToast(type, msg) {
    var container = document.getElementById('toastContainer');
    if (!container) return;
    var el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 2200);
  }

  // ─── Escape helpers ───
  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function escAttr(s) {
    return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ─── Keyboard shortcuts ───
  document.addEventListener('keydown', function(e) {
    var inInput = e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA';

    // Tab toggles rename input focus
    if (e.key === 'Tab') {
      var renameInput = document.getElementById('renameInput');
      if (renameInput) {
        e.preventDefault();
        if (document.activeElement === renameInput) {
          renameInput.blur();
        } else if (!fuzzyOpen) {
          renameInput.focus();
          renameInput.select();
        }
      }
      return;
    }

    // If in fuzzy input, let its own handler deal with arrow/enter
    if (inInput) return;
    if (moving) return;

    var isMoved = pdfs[currentIdx] && movedMap.has(pdfs[currentIdx]);

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isMoved && currentResults.length > 0) {
        if (showingFuzzy) {
          // Go back from fuzzy to last suggestion
          window._toggleFuzzy();
          changeSelection(Math.min(2, currentResults.length - 1));
        } else {
          changeSelection(Math.max(0, selectedSuggestion - 1));
        }
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!isMoved && currentResults.length > 0) {
        var maxSugg = Math.min(2, currentResults.length - 1);
        if (!showingFuzzy && selectedSuggestion >= maxSugg) {
          // Past last suggestion — open fuzzy
          window._toggleFuzzy();
        } else if (!showingFuzzy) {
          changeSelection(selectedSuggestion + 1);
        }
      }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      window._goBack();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      window._skip();
    } else if (e.key >= '1' && e.key <= '3') {
      if (!isMoved && !classifying && !showingFuzzy) {
        var idx = parseInt(e.key) - 1;
        if (idx < Math.min(3, currentResults.length)) {
          window._moveTo(currentResults[idx].folder);
        }
      }
    } else if (e.key === '4') {
      if (!isMoved && !classifying) {
        window._toggleFuzzy();
      }
    } else if (e.key === 's' || e.key === 'S') {
      window._skip();
    } else if (e.key === 'Enter') {
      if (!isMoved && !classifying) {
        if (showingFuzzy) {
          window._moveFromDropdown();
        } else if (currentResults.length > 0) {
          window._moveTo(currentResults[selectedSuggestion].folder);
        }
      }
    } else if (e.key === 'o' || e.key === 'O') {
      window._openFolder();
    }
  });

  init();
})();
</script>

</body>
</html>`;
}
