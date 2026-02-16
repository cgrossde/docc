// ─── Imports ───
import { escHtml, fuzzyMatch, debounce } from './helpers.js';
import * as api from './api.js';
import * as T from './templates.js';
import { enterCompare, exitCompare, isCompareActive, updateCompareLabel, handleCompareKeydown } from './compare.js';

// ─── Config ───
const NUM_SUGGESTIONS = 4;
const FUZZY_KEY = String(NUM_SUGGESTIONS + 1);

// ─── State ───
export const state = {
  pdfs: [],
  folders: [],
  currentIdx: 0,
  movedMap: new Map(),
  deletedSet: new Set(),
  results: [],
  duplicates: [],
  selected: 0,
  classifying: false,
  moving: false,
  nameSuggestions: [],
  nameHighlight: -1,
  nameDropdownOpen: false,
  nameAbort: null,
  llmPrompt: null,
  fuzzyHighlight: -1,
  fuzzyFiltered: [],
  fuzzyOpen: false,
  fuzzySelectedFolder: '',
  showingFuzzy: false,
  folderFiles: [],
  currentFilesFolder: '',
  showDetail: false,
  prefetched: new Set(),
  currentView: 'classify',
  menuOpen: false,
};

// ─── DOM refs (re-grabbed after compare exit) ───
let previewPane = document.getElementById('previewPane');
let controlPane = document.getElementById('controlPane');
const progressTextEl = document.getElementById('progressText');
const btnBack = document.getElementById('btnBack');
const btnSkip = document.getElementById('btnSkip');

// ─── Init ───
async function init() {
  const [{ data: pdfData }, { data: folderData }] = await Promise.all([
    api.listPdfs(),
    api.listFolders(),
  ]);
  state.pdfs = pdfData.pdfs;
  state.folders = folderData.folders;
  state.currentIdx = 0;
  showCurrent();
}

// ─── Menu & Navigation ───
function toggleMenu() {
  state.menuOpen = !state.menuOpen;
  const menu = document.getElementById('burgerMenu');
  if (menu) menu.classList.toggle('open', state.menuOpen);
}

function closeMenu() {
  state.menuOpen = false;
  const menu = document.getElementById('burgerMenu');
  if (menu) menu.classList.remove('open');
}

async function showView(view) {
  closeMenu();
  if (view === state.currentView) return;
  state.currentView = view;

  const main = document.getElementById('main');
  const progress = document.getElementById('progress');
  const keyboardHint = document.getElementById('keyboardHint');

  if (view === 'stats') {
    if (progress) progress.style.display = 'none';
    if (keyboardHint) keyboardHint.style.display = 'none';
    main.innerHTML = '<div class="stats-view"><div class="stats-empty"><span class="spinner"></span> Loading stats...</div></div>';
    const { ok, data } = await api.fetchStats();
    main.innerHTML = T.statsView({ stats: ok ? data.stats : [] });
  } else {
    if (progress) progress.style.display = '';
    if (keyboardHint) keyboardHint.style.display = '';
    main.innerHTML =
      '<div class="preview-pane" id="previewPane"><div class="preview-placeholder">Loading...</div></div>' +
      '<div class="right-side"><div class="control-pane" id="controlPane"><div class="status-bar loading"><span class="spinner"></span> Loading...</div></div></div>';
    previewPane = document.getElementById('previewPane');
    controlPane = document.getElementById('controlPane');
    attachControlPaneListeners();
    showCurrent();
  }
}

// Close menu on outside click
document.addEventListener('click', (e) => {
  if (!state.menuOpen) return;
  const menu = document.getElementById('burgerMenu');
  const btn = e.target.closest('.burger-btn');
  if (!btn && menu && !menu.contains(e.target)) closeMenu();
});

// ─── Progress ───
function updateProgress() {
  if (state.pdfs.length === 0) {
    progressTextEl.textContent = 'No PDFs found';
    btnBack.disabled = true;
    btnSkip.disabled = true;
    return;
  }
  const pos = state.currentIdx + 1;
  const total = state.pdfs.length;
  const parts = [];
  if (state.movedMap.size > 0) parts.push(state.movedMap.size + ' moved');
  if (state.deletedSet.size > 0) parts.push(state.deletedSet.size + ' deleted');
  progressTextEl.textContent = pos + ' of ' + total + (parts.length > 0 ? ' (' + parts.join(', ') + ')' : '');
  btnBack.disabled = state.currentIdx <= 0;
  btnSkip.disabled = state.currentIdx >= state.pdfs.length - 1;
}

// ─── Show current PDF ───
function showCurrent() {
  state.results = [];
  state.selected = 0;
  state.folderFiles = [];
  state.fuzzySelectedFolder = '';
  state.showingFuzzy = false;
  state.duplicates = [];
  state.nameSuggestions = [];
  state.nameHighlight = -1;
  state.nameDropdownOpen = false;
  state.llmPrompt = null;
  if (state.nameAbort) { state.nameAbort.abort(); state.nameAbort = null; }
  if (isCompareActive()) {
    const refs = exitCompare();
    if (refs) { previewPane = refs.previewPane; controlPane = refs.controlPane; attachControlPaneListeners(); }
  }
  updateProgress();

  if (state.pdfs.length === 0) {
    showDone();
    return;
  }

  // Clamp index
  if (state.currentIdx >= state.pdfs.length) state.currentIdx = state.pdfs.length - 1;
  if (state.currentIdx < 0) state.currentIdx = 0;

  const filename = state.pdfs[state.currentIdx];
  const isMoved = state.movedMap.has(filename);
  const isDeleted = state.deletedSet.has(filename);

  // PDF preview
  previewPane.innerHTML = T.previewContent({ filename, isMoved, isDeleted });

  // Build controls
  let html = T.filenameRow({ filename, isMoved, isDeleted });

  if (isMoved) {
    const moveInfo = state.movedMap.get(filename);
    html += T.movedInfo({ folder: moveInfo.folder, finalName: moveInfo.finalName, filename });
  }

  if (!isMoved && !isDeleted) {
    html += T.controlShell({ filename });
  }

  html +=
    `<div id="folderFilesSection"></div>` +
    `<div id="statusArea"></div>`;

  controlPane.innerHTML = html;

  document.getElementById('keyboardHint').innerHTML =
    T.keyboardHints({ numSuggestions: NUM_SUGGESTIONS, fuzzyKey: FUZZY_KEY });

  // Wire up input-specific listeners
  if (!isMoved && !isDeleted) {
    setupFuzzyDropdown();
    setupRenameInput();
    classifyCurrentPdf(filename);
  }
}

// ─── Rename input setup ───
function setupRenameInput() {
  const input = document.getElementById('renameInput');
  if (!input) return;

  input.addEventListener('focus', () => { openNameDropdown(); });
  input.addEventListener('blur', () => { setTimeout(() => { closeNameDropdown(); }, 150); });
  input.addEventListener('input', () => { closeNameDropdown(); });

  input.addEventListener('keydown', (e) => {
    if (state.nameDropdownOpen && state.nameSuggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        state.nameHighlight = Math.min(state.nameHighlight + 1, state.nameSuggestions.length - 1);
        renderNameDropdown();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        state.nameHighlight = Math.max(state.nameHighlight - 1, 0);
        renderNameDropdown();
        return;
      }
      if (e.key === 'Enter' && state.nameHighlight >= 0) {
        e.preventDefault();
        pickName(state.nameHighlight);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeNameDropdown();
        return;
      }
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      let val = input.value.trim();
      if (val && !val.toLowerCase().endsWith('.pdf')) {
        val = val + '.pdf';
        input.value = val;
      }
      input.blur();
      if (state.showingFuzzy) {
        moveFromDropdown();
      } else if (state.results.length > 0) {
        moveTo(state.results[state.selected].folder);
      }
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      input.blur();
    }
  });
}

// ─── Fuzzy dropdown setup ───
function setupFuzzyDropdown() {
  const input = document.getElementById('fuzzyInput');
  const dropdown = document.getElementById('fuzzyDropdown');
  if (!input || !dropdown) return;

  const debouncedUpdate = debounce(() => { updateFuzzyDropdown(); openFuzzy(); }, 80);
  input.addEventListener('focus', () => { updateFuzzyDropdown(); openFuzzy(); });
  input.addEventListener('input', debouncedUpdate);
  input.addEventListener('blur', () => { setTimeout(() => { closeFuzzy(); }, 150); });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!state.fuzzyOpen) { updateFuzzyDropdown(); openFuzzy(); }
      state.fuzzyHighlight = Math.min(state.fuzzyHighlight + 1, state.fuzzyFiltered.length - 1);
      renderFuzzyHighlight();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!state.fuzzyOpen) { updateFuzzyDropdown(); openFuzzy(); }
      state.fuzzyHighlight = Math.max(state.fuzzyHighlight - 1, 0);
      renderFuzzyHighlight();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (state.fuzzyOpen && state.fuzzyHighlight >= 0 && state.fuzzyHighlight < state.fuzzyFiltered.length) {
        selectFuzzyOption(state.fuzzyFiltered[state.fuzzyHighlight]);
      } else if (state.fuzzySelectedFolder) {
        input.blur();
        moveFromDropdown();
      }
    } else if (e.key === 'Escape') {
      closeFuzzy();
      input.blur();
      if (state.showingFuzzy) toggleFuzzy();
    }
  });
}

function updateFuzzyDropdown() {
  const input = document.getElementById('fuzzyInput');
  if (!input) return;
  const query = input.value.trim();
  state.fuzzyFiltered = query ? state.folders.filter(f => fuzzyMatch(query, f)) : state.folders.slice();
  state.fuzzyHighlight = state.fuzzyFiltered.length > 0 ? 0 : -1;
  renderFuzzyOptions();
}

function renderFuzzyOptions() {
  const dropdown = document.getElementById('fuzzyDropdown');
  if (!dropdown) return;
  dropdown.innerHTML = T.fuzzyOptions({ filtered: state.fuzzyFiltered, highlight: state.fuzzyHighlight });
}

function renderFuzzyHighlight() {
  const dropdown = document.getElementById('fuzzyDropdown');
  if (!dropdown) return;
  const options = dropdown.querySelectorAll('.fuzzy-option');
  options.forEach((el, i) => { el.classList.toggle('highlighted', i === state.fuzzyHighlight); });
  if (options[state.fuzzyHighlight]) {
    options[state.fuzzyHighlight].scrollIntoView({ block: 'nearest' });
  }
}

function openFuzzy() {
  state.fuzzyOpen = true;
  const dd = document.getElementById('fuzzyDropdown');
  if (dd) dd.classList.add('open');
}

function closeFuzzy() {
  state.fuzzyOpen = false;
  const dd = document.getElementById('fuzzyDropdown');
  if (dd) dd.classList.remove('open');
}

function selectFuzzyOption(folder) {
  const input = document.getElementById('fuzzyInput');
  if (input) input.value = folder;
  state.fuzzySelectedFolder = folder;
  closeFuzzy();
  if (input) input.blur();
  fetchFolderFiles(folder);
  fetchNameSuggestions(state.pdfs[state.currentIdx], folder);
}

// ─── Name suggestions ───
async function fetchNameSuggestions(filename, folder, { prefetchAfter = false } = {}) {
  if (state.nameAbort) state.nameAbort.abort();
  const nameAbort = state.nameAbort = new AbortController();

  state.nameSuggestions = [];
  state.nameHighlight = -1;
  const loadingEl = document.getElementById('nameLoading');
  if (loadingEl) loadingEl.textContent = 'suggesting names...';

  try {
    const { ok, data } = await api.suggestNames(filename, folder, nameAbort.signal);
    if (data.llmPrompt) state.llmPrompt = data.llmPrompt;
    if (data.suggestions && data.suggestions.length > 0) {
      state.nameSuggestions = data.suggestions;
      const renameInput = document.getElementById('renameInput');
      const isInRenameField = renameInput && document.activeElement === renameInput;
      if (isInRenameField) {
        openNameDropdown();
      } else if (renameInput) {
        renameInput.value = state.nameSuggestions[0].name;
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
  } finally {
    const wasAborted = state.nameAbort !== nameAbort;
    if (loadingEl) loadingEl.textContent = '';
    state.nameAbort = null;
    if (prefetchAfter && !wasAborted) prefetchNextPdf();
  }
}

function prefetchNextPdf() {
  // Find next unhandled PDF (forward then wrap)
  let next = null;
  for (let i = state.currentIdx + 1; i < state.pdfs.length; i++) {
    if (!isHandled(state.pdfs[i])) { next = state.pdfs[i]; break; }
  }
  if (!next) {
    for (let i = 0; i < state.currentIdx; i++) {
      if (!isHandled(state.pdfs[i])) { next = state.pdfs[i]; break; }
    }
  }
  if (!next || state.prefetched.has(next)) return;
  state.prefetched.add(next);
  const link = document.createElement('link');
  link.rel = 'prefetch';
  link.href = '/api/pdf/' + encodeURIComponent(next);
  document.head.appendChild(link);
}

function renderNameDropdown() {
  const dd = document.getElementById('nameDropdown');
  if (!dd || state.nameSuggestions.length === 0) return;
  dd.innerHTML = T.nameOptions({ nameSuggestions: state.nameSuggestions, nameHighlight: state.nameHighlight });
}

function openNameDropdown() {
  if (state.nameSuggestions.length === 0) return;
  state.nameDropdownOpen = true;
  state.nameHighlight = -1;
  renderNameDropdown();
  const dd = document.getElementById('nameDropdown');
  if (dd) dd.classList.add('open');
}

function closeNameDropdown() {
  state.nameDropdownOpen = false;
  const dd = document.getElementById('nameDropdown');
  if (dd) dd.classList.remove('open');
}

function pickName(idx) {
  if (idx < 0 || idx >= state.nameSuggestions.length) return;
  const renameInput = document.getElementById('renameInput');
  if (renameInput) renameInput.value = state.nameSuggestions[idx].name;
  closeNameDropdown();
}

// ─── Classify ───
async function classifyCurrentPdf(filename) {
  state.classifying = true;
  state.results = [];
  state.selected = 0;

  const classifyLoadingEl = document.getElementById('classifyLoading');
  if (classifyLoadingEl) classifyLoadingEl.innerHTML = '<span class="spinner"></span> classifying...';

  try {
    const { ok, data } = await api.classify(filename);

    if (!ok) {
      document.getElementById('suggestions').innerHTML =
        T.classifyError({ message: data.error || 'Classification failed' });
      return;
    }

    state.results = data.results;
    state.duplicates = data.duplicates || [];
    state.selected = 0;

    if (state.duplicates.length > 0) {
      renderDuplicateWarning();
    }
    renderSuggestions();
    if (state.results.length > 0) {
      fetchFolderFiles(state.results[0].folder);
      fetchNameSuggestions(filename, state.results[0].folder, { prefetchAfter: true });
    }
  } catch (err) {
    document.getElementById('suggestions').innerHTML =
      T.classifyError({ message: 'Error: ' + err.message });
  } finally {
    state.classifying = false;
    const el = document.getElementById('classifyLoading');
    if (el) el.innerHTML = '';
  }
}

function renderSuggestions() {
  const el = document.getElementById('suggestions');
  if (!el) return;
  el.innerHTML = T.suggestions({
    results: state.results, numSuggestions: NUM_SUGGESTIONS,
    selected: state.selected, showDetail: state.showDetail, fuzzyKey: FUZZY_KEY,
  });
}

// ─── Duplicate warning ───
function renderDuplicateWarning() {
  const el = document.getElementById('dupWarning');
  if (!el) return;
  el.innerHTML = T.duplicateWarning({ duplicates: state.duplicates });
}

function compareDuplicate() {
  if (state.duplicates.length === 0) return;
  const dup = state.duplicates[0];
  const filename = state.pdfs[state.currentIdx];
  const sim = dup.similarity != null ? dup.similarity : null;
  enterCompare(filename, 'Already in: ' + escHtml(dup.folder) + ' / ' + escHtml(dup.filename), dup.relativePath, sim, state.showDetail);
}

function compareFile(idx) {
  if (idx < 0 || idx >= state.folderFiles.length) return;
  const f = state.folderFiles[idx];
  const relPath = state.currentFilesFolder + '/' + f.name;
  const filename = state.pdfs[state.currentIdx];
  const sim = f.similarity != null ? f.similarity : null;
  enterCompare(filename, escHtml(state.currentFilesFolder) + ' / ' + escHtml(f.name), relPath, sim, state.showDetail);
}

function doExitCompare() {
  const refs = exitCompare();
  if (refs) { previewPane = refs.previewPane; controlPane = refs.controlPane; attachControlPaneListeners(); }
  showCurrent();
}

// ─── Confirm delete dialog ───
function confirmDelete() {
  if (state.moving) return;
  const filename = state.pdfs[state.currentIdx];
  if (state.movedMap.has(filename) || state.deletedSet.has(filename)) return;

  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay';
  overlay.innerHTML = T.confirmDialog({ filename });
  document.body.appendChild(overlay);

  const remove = () => { if (overlay.parentNode) document.body.removeChild(overlay); };
  overlay.querySelector('#confirmCancel').focus();
  overlay.querySelector('#confirmCancel').addEventListener('click', remove);
  overlay.querySelector('#confirmDelete').addEventListener('click', () => { remove(); deleteCurrent(); });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) remove(); });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { remove(); e.stopPropagation(); }
    if (e.key === 'Enter') { remove(); deleteCurrent(); e.stopPropagation(); }
  });
}

async function deleteCurrent() {
  if (state.moving) return;
  const filename = state.pdfs[state.currentIdx];
  if (state.movedMap.has(filename) || state.deletedSet.has(filename)) return;

  try {
    const body = { filename };
    if (state.duplicates.length > 0) body.hadDuplicate = true;
    const { ok, data } = await api.deletePdf(body);
    if (!ok) {
      setStatus('error', data.error || 'Delete failed');
      return;
    }
    state.deletedSet.add(filename);
    showToast('deleted', 'Deleted ' + filename);
    if (isCompareActive()) {
      const refs = exitCompare();
      if (refs) { previewPane = refs.previewPane; controlPane = refs.controlPane; attachControlPaneListeners(); }
    }
    advanceToNextUnmoved();
  } catch (err) {
    setStatus('error', 'Error: ' + err.message);
  }
}

// ─── Toggle fuzzy ───
function toggleFuzzy() {
  state.showingFuzzy = !state.showingFuzzy;
  const sugEl = document.getElementById('suggestions');
  const fuzzyEl = document.getElementById('fuzzySection');
  if (state.showingFuzzy) {
    if (sugEl) sugEl.style.display = 'none';
    if (fuzzyEl) fuzzyEl.style.display = '';
    const input = document.getElementById('fuzzyInput');
    if (input) { input.value = ''; input.focus(); }
    state.fuzzySelectedFolder = '';
    updateFuzzyDropdown();
    openFuzzy();
  } else {
    if (sugEl) sugEl.style.display = '';
    if (fuzzyEl) fuzzyEl.style.display = 'none';
  }
}

// ─── Folder files ───
async function fetchFolderFiles(folder) {
  if (!folder) return;
  try {
    const { data } = await api.folderFiles(folder, state.pdfs[state.currentIdx]);
    state.folderFiles = data.files || [];
  } catch {
    state.folderFiles = [];
  }
  renderFolderFiles(folder);
}

function renderFolderFiles(folder) {
  const section = document.getElementById('folderFilesSection');
  if (!section) return;
  state.currentFilesFolder = folder;
  section.innerHTML = T.folderFilesList({ folder, files: state.folderFiles });
}

// ─── Pick suggestion ───
function pickSuggestion(idx) {
  if (state.moving || state.movedMap.has(state.pdfs[state.currentIdx])) return;
  if (idx >= 0 && idx < Math.min(NUM_SUGGESTIONS, state.results.length)) {
    moveTo(state.results[idx].folder);
  }
}

function changeSelection(idx) {
  const maxIdx = Math.min(NUM_SUGGESTIONS - 1, state.results.length - 1);
  if (idx < 0 || idx > maxIdx) return;
  state.selected = idx;
  renderSuggestions();
  fetchFolderFiles(state.results[idx].folder);
  fetchNameSuggestions(state.pdfs[state.currentIdx], state.results[idx].folder);
}

// ─── Move ───
async function moveTo(folder) {
  if (state.moving || state.currentIdx >= state.pdfs.length) return;
  const filename = state.pdfs[state.currentIdx];
  if (state.movedMap.has(filename)) return;

  state.moving = true;
  const renameInput = document.getElementById('renameInput');
  let newName = renameInput ? renameInput.value.trim() : '';
  if (newName && !newName.toLowerCase().endsWith('.pdf')) newName = newName + '.pdf';
  if (newName === filename) newName = '';

  setStatus('loading', 'Moving to ' + folder + '...');

  try {
    const body = { filename, folder };
    if (newName) body.newName = newName;

    if (state.showingFuzzy) {
      body.wasManual = true;
      body.chosenRank = null;
    } else {
      body.wasManual = false;
      const matchIdx = state.results.findIndex(r => r.folder === folder);
      body.chosenRank = matchIdx >= 0 ? matchIdx + 1 : null;
    }
    const chosenResult = state.results.find(r => r.folder === folder);
    if (chosenResult) {
      body.centroidRank = chosenResult.centroidRank || null;
      body.bayesRank = chosenResult.bayesRank || null;
      body.score = chosenResult.score != null ? +chosenResult.score.toFixed(3) : null;
    }
    if (state.duplicates.length > 0) body.hadDuplicate = true;

    const { ok, data } = await api.move(body);

    if (!ok) {
      setStatus('error', data.error || 'Move failed');
      state.moving = false;
      return;
    }

    const finalName = newName || filename;
    state.movedMap.set(filename, { folder, finalName });
    showToast('moved', 'Moved to ' + folder);
    advanceToNextUnmoved();
  } catch (err) {
    setStatus('error', 'Error: ' + err.message);
  } finally {
    state.moving = false;
  }
}

function moveFromDropdown() {
  const input = document.getElementById('fuzzyInput');
  const folder = state.fuzzySelectedFolder || (input ? input.value.trim() : '');
  if (!folder) {
    setStatus('error', 'Select a folder first');
    return;
  }
  if (state.folders.indexOf(folder) === -1) {
    setStatus('error', 'Unknown folder: ' + folder);
    return;
  }
  moveTo(folder);
}

function isHandled(f) { return state.movedMap.has(f) || state.deletedSet.has(f); }

function advanceToNextUnmoved() {
  for (let i = state.currentIdx + 1; i < state.pdfs.length; i++) {
    if (!isHandled(state.pdfs[i])) { state.currentIdx = i; showCurrent(); return; }
  }
  for (let i = 0; i <= state.currentIdx; i++) {
    if (!isHandled(state.pdfs[i])) { state.currentIdx = i; showCurrent(); return; }
  }
  showDone();
}

// ─── Navigation ───
function skip() {
  if (state.moving) return;
  if (state.currentIdx < state.pdfs.length - 1) {
    if (!isHandled(state.pdfs[state.currentIdx])) {
      showToast('skip', 'Skipped ' + state.pdfs[state.currentIdx]);
      const skipBody = { action: 'skip', filename: state.pdfs[state.currentIdx] };
      if (state.duplicates.length > 0) skipBody.hadDuplicate = true;
      api.log(skipBody).catch(() => {});
    }
    state.currentIdx++;
    showCurrent();
  }
}

function goBack() {
  if (state.moving) return;
  if (state.currentIdx > 0) {
    state.currentIdx--;
    showCurrent();
  }
}

// ─── Open folder ───
async function openFolder() {
  const filename = state.pdfs[state.currentIdx];
  let folder = '';
  if (filename && state.movedMap.has(filename)) {
    folder = state.movedMap.get(filename).folder;
  } else if (state.results.length > 0) {
    folder = state.results[state.selected] ? state.results[state.selected].folder : '';
  }
  if (!folder) return;
  try { await api.openFolder(folder); } catch {}
}

// ─── Done screen ───
function showDone() {
  if (isCompareActive()) {
    const refs = exitCompare();
    if (refs) { previewPane = refs.previewPane; controlPane = refs.controlPane; attachControlPaneListeners(); }
  }
  if (previewPane) previewPane.innerHTML = '';
  if (controlPane) controlPane.innerHTML =
    T.doneScreen({ movedCount: state.movedMap.size, deletedCount: state.deletedSet.size });
  document.getElementById('keyboardHint').innerHTML = '';
  updateProgress();
}

function setStatus(type, msg) {
  const el = document.getElementById('statusArea');
  if (!el) return;
  el.innerHTML = T.statusBar({ type, msg });
  if (type === 'success') {
    setTimeout(() => { if (el) el.innerHTML = ''; }, 2000);
  }
}

function showToast(type, msg) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 2200);
}

// ─── Event delegation on #controlPane ───
// Extracted so listeners can be re-attached after exitCompare() replaces the DOM element.
function attachControlPaneListeners() {
  controlPane.addEventListener('mousedown', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;

    // mousedown for fuzzy/name options (fires before blur)
    if (action === 'select-fuzzy') {
      e.preventDefault();
      const idx = +target.dataset.index;
      if (idx >= 0 && idx < state.fuzzyFiltered.length) selectFuzzyOption(state.fuzzyFiltered[idx]);
    } else if (action === 'pick-name') {
      e.preventDefault();
      pickName(+target.dataset.index);
    }
  });

  controlPane.addEventListener('click', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;

    if (action === 'pick') pickSuggestion(+target.dataset.index);
    else if (action === 'toggle-fuzzy') toggleFuzzy();
    else if (action === 'move-dropdown') moveFromDropdown();
    else if (action === 'confirm-delete') confirmDelete();
    else if (action === 'compare-duplicate') compareDuplicate();
    else if (action === 'compare-file') compareFile(+target.dataset.index);
  });
}
attachControlPaneListeners();

// ─── Event delegation on <header> ───
document.querySelector('header').addEventListener('click', (e) => {
  const target = e.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  if (action === 'go-back') goBack();
  else if (action === 'skip') skip();
  else if (action === 'toggle-menu') toggleMenu();
  else if (action === 'nav-classify') showView('classify');
  else if (action === 'nav-stats') showView('stats');
});

// ─── Detail view (hold i) ───
function showLlmTooltip() {
  if (!state.llmPrompt) return;
  let tooltip = document.getElementById('llmTooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.id = 'llmTooltip';
    tooltip.className = 'llm-tooltip';
    document.body.appendChild(tooltip);
  }
  tooltip.textContent = state.llmPrompt;
  tooltip.classList.add('visible');
}

function hideLlmTooltip() {
  const tooltip = document.getElementById('llmTooltip');
  if (tooltip) tooltip.classList.remove('visible');
}

document.addEventListener('keydown', (e) => {
  if ((e.key === 'i' || e.key === 'I') && !state.showDetail) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    state.showDetail = true;
    showLlmTooltip();
    if (isCompareActive()) { updateCompareLabel(state.showDetail); }
    else if (state.results.length > 0) { renderSuggestions(); }
  }
});
document.addEventListener('keyup', (e) => {
  if ((e.key === 'i' || e.key === 'I') && state.showDetail) {
    state.showDetail = false;
    hideLlmTooltip();
    if (isCompareActive()) { updateCompareLabel(state.showDetail); }
    else if (state.results.length > 0) { renderSuggestions(); }
  }
});

// ─── Keyboard shortcuts ───
document.addEventListener('keydown', (e) => {
  if (state.currentView !== 'classify') return;

  // Compare mode — delegate to compare.js
  if (isCompareActive()) {
    handleCompareKeydown(e, {
      exitAndShow: doExitCompare,
      goBack,
      skip,
      confirmDelete,
    });
    return;
  }

  const inInput = e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA';

  // Tab toggles rename input focus
  if (e.key === 'Tab') {
    const renameInput = document.getElementById('renameInput');
    if (renameInput) {
      e.preventDefault();
      if (document.activeElement === renameInput) {
        renameInput.blur();
      } else if (!state.fuzzyOpen) {
        renameInput.focus();
        renameInput.select();
      }
    }
    return;
  }

  // If in fuzzy/rename input, let its own handler deal with events
  if (inInput) return;
  if (state.moving) return;

  const isMoved = state.pdfs[state.currentIdx] && state.movedMap.has(state.pdfs[state.currentIdx]);
  const hasDup = state.duplicates.length > 0 && !isMoved && !state.deletedSet.has(state.pdfs[state.currentIdx]);

  if (hasDup && !state.classifying && (e.key === 'c' || e.key === 'C')) {
    compareDuplicate();
    return;
  }

  if ((e.key === 'd' || e.key === 'D') && !isMoved && !state.deletedSet.has(state.pdfs[state.currentIdx]) && !state.classifying) {
    confirmDelete();
    return;
  }

  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (!isMoved && state.results.length > 0) {
      if (state.showingFuzzy) {
        toggleFuzzy();
        changeSelection(Math.min(NUM_SUGGESTIONS - 1, state.results.length - 1));
      } else {
        changeSelection(Math.max(0, state.selected - 1));
      }
    }
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (!isMoved && state.results.length > 0) {
      const maxSugg = Math.min(NUM_SUGGESTIONS - 1, state.results.length - 1);
      if (!state.showingFuzzy && state.selected >= maxSugg) {
        toggleFuzzy();
      } else if (!state.showingFuzzy) {
        changeSelection(state.selected + 1);
      }
    }
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    goBack();
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    skip();
  } else if (e.key >= '1' && e.key <= String(NUM_SUGGESTIONS)) {
    if (!isMoved && !state.classifying && !state.showingFuzzy) {
      const idx = parseInt(e.key) - 1;
      if (idx < Math.min(NUM_SUGGESTIONS, state.results.length)) {
        moveTo(state.results[idx].folder);
      }
    }
  } else if (e.key === FUZZY_KEY) {
    if (!isMoved && !state.classifying) toggleFuzzy();
  } else if (e.key === 's' || e.key === 'S') {
    skip();
  } else if (e.key === 'Enter') {
    if (!isMoved && !state.classifying) {
      if (state.showingFuzzy) {
        moveFromDropdown();
      } else if (state.results.length > 0) {
        moveTo(state.results[state.selected].folder);
      }
    }
  } else if (e.key === 'o' || e.key === 'O') {
    openFolder();
  }
});

init();
