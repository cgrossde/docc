(function() {
  // ─── Config ───
  var NUM_SUGGESTIONS = 4;
  var FUZZY_KEY = String(NUM_SUGGESTIONS + 1);

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

  // Duplicate detection state
  let currentDuplicates = [];
  let deletedSet = new Set();
  let compareMode = false;
  let compareSimilarity = null; // cosine similarity shown in compare view (hold i)

  // Detail view state (hold "i" to show per-method scores)
  let showDetail = false;

  // Name suggestion state
  let nameSuggestions = [];
  let nameHighlight = -1;
  let nameDropdownOpen = false;
  let nameAbort = null; // AbortController for in-flight requests

  // Fuzzy dropdown state
  let fuzzyHighlight = -1;
  let fuzzyFiltered = [];
  let fuzzyOpen = false;
  let fuzzySelectedFolder = '';
  let showingFuzzy = false;    // true when "4. Specify folder" is active

  let previewPane = document.getElementById('previewPane');
  let controlPane = document.getElementById('controlPane');
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
    var delCount = deletedSet.size;
    var parts = [];
    if (movedCount > 0) parts.push(movedCount + ' moved');
    if (delCount > 0) parts.push(delCount + ' deleted');
    progressTextEl.textContent = pos + ' of ' + total + (parts.length > 0 ? ' (' + parts.join(', ') + ')' : '');
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
  // Space-separated terms — all must appear as substrings (case-insensitive)
  // Normalizes to NFC to handle macOS NFD folder paths
  function fuzzyMatch(query, text) {
    var t = text.normalize('NFC').toLowerCase();
    var terms = query.normalize('NFC').toLowerCase().split(/\s+/).filter(Boolean);
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
    currentDuplicates = [];
    nameSuggestions = [];
    nameHighlight = -1;
    nameDropdownOpen = false;
    if (nameAbort) { nameAbort.abort(); nameAbort = null; }
    if (compareMode) exitCompare();
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
    var isDeleted = deletedSet.has(filename);

    // PDF preview
    if (isMoved) {
      previewPane.innerHTML = '<div class="preview-placeholder">File was moved</div>';
    } else if (isDeleted) {
      previewPane.innerHTML = '<div class="preview-placeholder">File was deleted</div>';
    } else {
      previewPane.innerHTML = '<iframe src="/api/pdf/' + encodeURIComponent(filename) + '"></iframe>';
    }

    // Build controls
    var badge = '';
    if (isMoved) badge = '<span class="moved-badge">Moved</span>';
    else if (isDeleted) badge = '<span class="deleted-badge">Deleted</span>';
    var deleteBtn = (!isMoved && !isDeleted)
      ? '<button class="delete-btn" onclick="window._confirmDelete()" title="Delete (d)">&#128465;</button>'
      : '';
    var html =
      '<div class="filename-row"><div class="filename">' + escHtml(filename) + badge + '</div>' + deleteBtn + '</div>';

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

    if (!isMoved && !isDeleted) {
      html +=
        '<div id="dupWarning"></div>' +
        '<div>' +
          '<div class="section-label">Suggestions <span class="name-loading" id="classifyLoading"></span></div>' +
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
          '<div class="section-label">Rename (optional) <span class="name-loading" id="nameLoading"></span></div>' +
          '<div class="rename-row">' +
            '<div class="rename-wrapper">' +
              '<input type="text" id="renameInput" value="' + escAttr(filename) + '" />' +
              '<div class="name-dropdown" id="nameDropdown"></div>' +
            '</div>' +
          '</div>' +
        '</div>';
    }

    html +=
      '<div id="folderFilesSection"></div>' +
      '<div id="statusArea"></div>';

    controlPane.innerHTML = html;

    document.getElementById('keyboardHint').innerHTML =
      '<kbd>&uarr;</kbd><kbd>&darr;</kbd> select suggestion &nbsp; ' +
      '<kbd>1</kbd>-<kbd>' + NUM_SUGGESTIONS + '</kbd> pick &amp; move &nbsp; ' +
      '<kbd>' + FUZZY_KEY + '</kbd> specify folder &nbsp; ' +
      '<kbd>Enter</kbd> move to selection &nbsp; ' +
      '<kbd>&larr;</kbd><kbd>&rarr;</kbd> navigate &nbsp; ' +
      '<kbd>s</kbd> skip &nbsp; ' +
      '<kbd>d</kbd> delete &nbsp; ' +
      '<kbd>o</kbd> open folder &nbsp; ' +
      '<kbd>Tab</kbd> rename field &nbsp; ' +
      'hold <kbd>i</kbd> details';

    // Wire up inputs
    if (!isMoved && !isDeleted) {
      setupFuzzyDropdown();
      setupRenameInput();
      classify(filename);
    }
  }

  // ─── Rename input setup ───
  function setupRenameInput() {
    var input = document.getElementById('renameInput');
    if (!input) return;

    input.addEventListener('focus', function() {
      openNameDropdown();
    });

    input.addEventListener('blur', function() {
      setTimeout(function() { closeNameDropdown(); }, 150);
    });

    input.addEventListener('input', function() {
      // User is typing a custom name — close dropdown
      closeNameDropdown();
    });

    input.addEventListener('keydown', function(e) {
      if (nameDropdownOpen && nameSuggestions.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          nameHighlight = Math.min(nameHighlight + 1, nameSuggestions.length - 1);
          renderNameDropdown();
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          nameHighlight = Math.max(nameHighlight - 1, 0);
          renderNameDropdown();
          return;
        }
        if (e.key === 'Enter' && nameHighlight >= 0) {
          e.preventDefault();
          window._pickName(nameHighlight);
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

      if (e.key === 'Escape') {
        e.preventDefault();
        input.blur();
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
    fetchNameSuggestions(pdfs[currentIdx], folder);
  }

  window._selectFuzzy = function(idx) {
    if (idx >= 0 && idx < fuzzyFiltered.length) {
      selectFuzzyOption(fuzzyFiltered[idx]);
    }
  };

  // ─── Name suggestions ───
  async function fetchNameSuggestions(filename, folder) {
    // Abort any in-flight request
    if (nameAbort) nameAbort.abort();
    nameAbort = new AbortController();

    nameSuggestions = [];
    nameHighlight = -1;
    var loadingEl = document.getElementById('nameLoading');
    if (loadingEl) loadingEl.textContent = 'suggesting names...';

    try {
      var res = await fetch('/api/suggest-names', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, folder }),
        signal: nameAbort.signal,
      });
      var data = await res.json();
      if (data.suggestions && data.suggestions.length > 0) {
        nameSuggestions = data.suggestions;
        var renameInput = document.getElementById('renameInput');
        var isInRenameField = renameInput && document.activeElement === renameInput;
        if (isInRenameField) {
          // User is already in the field — show dropdown, don't replace
          openNameDropdown();
        } else if (renameInput) {
          // Auto-populate with first suggestion
          renameInput.value = nameSuggestions[0].name;
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      // Silently fail — name suggestions are non-blocking
    } finally {
      if (loadingEl) loadingEl.textContent = '';
      nameAbort = null;
    }
  }

  function renderNameDropdown() {
    var dd = document.getElementById('nameDropdown');
    if (!dd || nameSuggestions.length === 0) return;
    dd.innerHTML = nameSuggestions.map(function(s, i) {
      var cls = i === nameHighlight ? 'name-option highlighted' : 'name-option';
      var badgeCls = 'name-badge ' + s.strategy;
      var badge = '<span class="' + badgeCls + '">' + s.strategy +
        (s.similarity ? ' ' + (s.similarity * 100).toFixed(1) + '%' : '') + '</span>';
      return '<div class="' + cls + '" onmousedown="window._pickName(' + i + ')">' +
        '<span class="name-text">' + escHtml(s.name) + '</span>' + badge + '</div>';
    }).join('');
  }

  function openNameDropdown() {
    if (nameSuggestions.length === 0) return;
    nameDropdownOpen = true;
    nameHighlight = -1;
    renderNameDropdown();
    var dd = document.getElementById('nameDropdown');
    if (dd) dd.classList.add('open');
  }

  function closeNameDropdown() {
    nameDropdownOpen = false;
    var dd = document.getElementById('nameDropdown');
    if (dd) dd.classList.remove('open');
  }

  window._pickName = function(idx) {
    if (idx < 0 || idx >= nameSuggestions.length) return;
    var renameInput = document.getElementById('renameInput');
    if (renameInput) renameInput.value = nameSuggestions[idx].name;
    closeNameDropdown();
  };

  // ─── Classify ───
  async function classify(filename) {
    classifying = true;
    currentResults = [];
    selectedSuggestion = 0;

    var classifyLoadingEl = document.getElementById('classifyLoading');
    if (classifyLoadingEl) classifyLoadingEl.innerHTML = '<span class="spinner"></span> classifying...';

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
      currentDuplicates = data.duplicates || [];
      selectedSuggestion = 0;

      if (currentDuplicates.length > 0) {
        renderDuplicateWarning();
      }
      renderSuggestions();
      if (currentResults.length > 0) {
        fetchFolderFiles(currentResults[0].folder);
        // Fire name suggestions immediately — don't await, runs in parallel
        fetchNameSuggestions(filename, currentResults[0].folder);
      }
    } catch (err) {
      document.getElementById('suggestions').innerHTML =
        '<div class="status-bar error">Error: ' + escHtml(err.message) + '</div>';
    } finally {
      classifying = false;
      classifyLoadingEl = document.getElementById('classifyLoading');
      if (classifyLoadingEl) classifyLoadingEl.innerHTML = '';
    }
  }

  function renderSuggestions() {
    var el = document.getElementById('suggestions');
    if (!el) return;

    var topN = currentResults.slice(0, NUM_SUGGESTIONS);
    var html = topN.map(function(r, i) {
      var scoreText;
      if (showDetail) {
        scoreText = 'emb ' + (r.centroidScore != null ? r.centroidScore.toFixed(2) : '?') +
          ' E#' + (r.centroidRank || '?') +
          ' B#' + (r.bayesRank || '?');
      } else {
        scoreText = (r.score * 100).toFixed(0) + '%';
      }
      var cls = i === selectedSuggestion ? 'suggestion-btn selected' : 'suggestion-btn';
      return '<button class="' + cls + '" onclick="window._pickSuggestion(' + i + ')">' +
        '<span class="folder-name">' + (i+1) + '. ' + escHtml(r.folder) + '</span>' +
        '<span class="score">' + scoreText + '</span>' +
      '</button>';
    }).join('');

    // Specify folder option
    html += '<button class="suggestion-btn" onclick="window._toggleFuzzy()">' +
      '<span class="folder-name">' + FUZZY_KEY + '. Specify folder\u2026</span>' +
      '<span class="score"></span>' +
    '</button>';

    el.innerHTML = html;
  }

  // ─── Duplicate warning ───
  function renderDuplicateWarning() {
    var el = document.getElementById('dupWarning');
    if (!el) return;

    var html = '<div class="duplicate-warning">' +
      '<div class="dup-header">Possible duplicate detected</div>';

    currentDuplicates.forEach(function(d) {
      var pct = (d.similarity * 100).toFixed(1) + '%';
      html += '<div class="dup-match">' +
        '<span class="dup-folder">' + escHtml(d.folder) + '</span> / ' +
        escHtml(d.filename) +
        ' <span class="dup-sim">' + pct + ' match</span>' +
      '</div>';
    });

    html += '<div class="dup-actions">' +
      '<button class="dup-btn-compare" onclick="window._compareDuplicate()"><kbd>c</kbd> Compare</button>' +
      '<button class="dup-btn-delete" onclick="window._confirmDelete()"><kbd>d</kbd> Delete from inbox</button>' +
    '</div></div>';

    el.innerHTML = html;
  }

  window._compareDuplicate = function() {
    if (currentDuplicates.length === 0) return;
    compareMode = true;
    var dup = currentDuplicates[0];
    var filename = pdfs[currentIdx];
    compareSimilarity = dup.similarity != null ? dup.similarity : null;

    renderCompareView(filename, 'Already in: ' + escHtml(dup.folder) + ' / ' + escHtml(dup.filename), dup.relativePath);
  };

  function renderCompareView(filename, rightLabel, rightPath) {
    var simLabel = '';
    if (showDetail && compareSimilarity != null) {
      simLabel = ' <span style="font-size:11px;opacity:0.7">(' + (compareSimilarity * 100).toFixed(1) + '% similar)</span>';
    }

    var mainEl = document.getElementById('main');
    mainEl.innerHTML =
      '<div class="compare-view">' +
        '<div class="compare-pane">' +
          '<div class="compare-pane-label" id="compareLeftLabel">Inbox: ' + escHtml(filename) + '</div>' +
          '<iframe src="/api/pdf/' + encodeURIComponent(filename) + '"></iframe>' +
        '</div>' +
        '<div class="compare-pane">' +
          '<div class="compare-pane-label" id="compareRightLabel">' + rightLabel + simLabel + '</div>' +
          '<iframe src="/api/doc-pdf?path=' + encodeURIComponent(rightPath) + '"></iframe>' +
        '</div>' +
      '</div>';

    // Store for re-rendering on i toggle
    window._compareRightLabel = rightLabel;
    window._compareRightPath = rightPath;

    document.getElementById('keyboardHint').innerHTML =
      '<kbd>Esc</kbd> exit compare &nbsp; ' +
      '<kbd>d</kbd> delete from inbox &nbsp; ' +
      '<kbd>&larr;</kbd><kbd>&rarr;</kbd> navigate &nbsp; ' +
      'hold <kbd>i</kbd> similarity';
  }

  function exitCompare() {
    if (!compareMode) return;
    compareMode = false;
    // Rebuild normal layout and re-bind references
    var mainEl = document.getElementById('main');
    mainEl.innerHTML =
      '<div class="preview-pane" id="previewPane"></div>' +
      '<div class="right-side">' +
        '<div class="control-pane" id="controlPane"></div>' +
      '</div>';
    previewPane = document.getElementById('previewPane');
    controlPane = document.getElementById('controlPane');
  }

  window._exitCompare = function() {
    exitCompare();
    showCurrent();
  };

  window._confirmDelete = function() {
    if (moving) return;
    var filename = pdfs[currentIdx];
    if (movedMap.has(filename) || deletedSet.has(filename)) return;

    var overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML =
      '<div class="confirm-dialog">' +
        '<h3>Delete scan?</h3>' +
        '<p>This will permanently delete<br><strong>' + escHtml(filename) + '</strong></p>' +
        '<div class="confirm-actions">' +
          '<button class="confirm-cancel" id="confirmCancel">Cancel</button>' +
          '<button class="confirm-delete" id="confirmDelete">Delete</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    overlay.querySelector('#confirmCancel').focus();
    overlay.querySelector('#confirmCancel').addEventListener('click', function() {
      document.body.removeChild(overlay);
    });
    overlay.querySelector('#confirmDelete').addEventListener('click', function() {
      document.body.removeChild(overlay);
      window._deleteCurrent();
    });
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) document.body.removeChild(overlay);
    });
    overlay.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') { document.body.removeChild(overlay); e.stopPropagation(); }
      if (e.key === 'Enter') { document.body.removeChild(overlay); window._deleteCurrent(); e.stopPropagation(); }
    });
  };

  window._deleteCurrent = async function() {
    if (moving) return;
    var filename = pdfs[currentIdx];
    if (movedMap.has(filename) || deletedSet.has(filename)) return;

    try {
      var res = await fetch('/api/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: filename }),
      });
      var data = await res.json();
      if (!res.ok) {
        setStatus('error', data.error || 'Delete failed');
        return;
      }
      deletedSet.add(filename);
      showToast('deleted', 'Deleted ' + filename);
      if (compareMode) exitCompare();
      advanceToNextUnmoved();
    } catch (err) {
      setStatus('error', 'Error: ' + err.message);
    }
  };

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
      var qp = 'folder=' + encodeURIComponent(folder);
      if (pdfs[currentIdx]) qp += '&filename=' + encodeURIComponent(pdfs[currentIdx]);
      var res = await fetch('/api/folder-files?' + qp);
      var data = await res.json();
      folderFiles = data.files || [];
    } catch {
      folderFiles = [];
    }
    renderFolderFiles(folder);
  }

  var currentFilesFolder = '';

  function renderFolderFiles(folder) {
    var section = document.getElementById('folderFilesSection');
    if (!section) return;
    currentFilesFolder = folder;

    if (folderFiles.length === 0) {
      section.innerHTML = '';
      return;
    }

    var items = folderFiles.slice(0, 20).map(function(f, i) {
      return '<li onclick="window._compareFile(' + i + ')">' +
        '<span class="file-name">' + escHtml(f.name) + '</span>' +
        '<span class="file-compare">compare</span>' +
        '<span class="file-time">' + relTime(f.mtime) + '</span>' +
      '</li>';
    }).join('');

    section.innerHTML =
      '<div class="section-label">Files in ' + escHtml(folder) + ' (' + folderFiles.length + ')</div>' +
      '<div class="folder-files-section">' +
        '<ul class="folder-files-list">' + items + '</ul>' +
      '</div>';
  }

  window._compareFile = function(idx) {
    if (idx < 0 || idx >= folderFiles.length) return;
    var f = folderFiles[idx];
    var relPath = currentFilesFolder + '/' + f.name;
    var filename = pdfs[currentIdx];
    compareMode = true;
    compareSimilarity = f.similarity != null ? f.similarity : null;

    renderCompareView(filename, escHtml(currentFilesFolder) + ' / ' + escHtml(f.name), relPath);
  };

  // ─── Pick suggestion ───
  window._pickSuggestion = function(idx) {
    if (moving || movedMap.has(pdfs[currentIdx])) return;
    if (idx >= 0 && idx < Math.min(NUM_SUGGESTIONS, currentResults.length)) {
      window._moveTo(currentResults[idx].folder);
    }
  };

  function changeSelection(idx) {
    var maxIdx = Math.min(NUM_SUGGESTIONS - 1, currentResults.length - 1);
    if (idx < 0 || idx > maxIdx) return;
    selectedSuggestion = idx;
    renderSuggestions();
    fetchFolderFiles(currentResults[idx].folder);
    fetchNameSuggestions(pdfs[currentIdx], currentResults[idx].folder);
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

  function isHandled(f) { return movedMap.has(f) || deletedSet.has(f); }

  function advanceToNextUnmoved() {
    // Try forward from current position
    for (var i = currentIdx + 1; i < pdfs.length; i++) {
      if (!isHandled(pdfs[i])) {
        currentIdx = i;
        showCurrent();
        return;
      }
    }
    // Try from beginning
    for (var i = 0; i <= currentIdx; i++) {
      if (!isHandled(pdfs[i])) {
        currentIdx = i;
        showCurrent();
        return;
      }
    }
    // All handled
    showDone();
  }

  // ─── Navigation ───
  window._skip = function() {
    if (moving) return;
    if (currentIdx < pdfs.length - 1) {
      if (!isHandled(pdfs[currentIdx])) {
        showToast('skip', 'Skipped ' + pdfs[currentIdx]);
        fetch('/api/log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'skip', filename: pdfs[currentIdx] }),
        }).catch(function() {});
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
    if (compareMode) exitCompare();
    var pp = document.getElementById('previewPane');
    var cp = document.getElementById('controlPane');
    if (pp) pp.innerHTML = '';
    var parts = [];
    if (movedMap.size > 0) parts.push(movedMap.size + ' moved');
    if (deletedSet.size > 0) parts.push(deletedSet.size + ' deleted');
    var summary = parts.length > 0 ? parts.join(', ') : '0 PDFs processed';
    if (cp) cp.innerHTML =
      '<div class="done-screen">' +
        '<div class="big">All done</div>' +
        '<div>' + summary + '</div>' +
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

  // ─── Detail view (hold i) ───
  function updateCompareLabel() {
    var label = document.getElementById('compareRightLabel');
    if (!label || !window._compareRightLabel) return;
    var simLabel = '';
    if (showDetail && compareSimilarity != null) {
      simLabel = ' <span style="font-size:11px;opacity:0.7">(' + (compareSimilarity * 100).toFixed(1) + '% similar)</span>';
    }
    label.innerHTML = window._compareRightLabel + simLabel;
  }

  document.addEventListener('keydown', function(e) {
    if ((e.key === 'i' || e.key === 'I') && !showDetail) {
      var inInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';
      if (inInput) return;
      showDetail = true;
      if (compareMode) { updateCompareLabel(); }
      else if (currentResults.length > 0) { renderSuggestions(); }
    }
  });
  document.addEventListener('keyup', function(e) {
    if ((e.key === 'i' || e.key === 'I') && showDetail) {
      showDetail = false;
      if (compareMode) { updateCompareLabel(); }
      else if (currentResults.length > 0) { renderSuggestions(); }
    }
  });

  // ─── Keyboard shortcuts ───
  document.addEventListener('keydown', function(e) {
    var inInput = e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA';

    // Compare mode shortcuts
    if (compareMode) {
      if (e.key === 'Escape') { e.preventDefault(); window._exitCompare(); return; }
      if (inInput) return;
      if (e.key === 'd' || e.key === 'D') { window._confirmDelete(); return; }
      if (e.key === 'ArrowLeft') { e.preventDefault(); window._exitCompare(); window._goBack(); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); window._exitCompare(); window._skip(); return; }
      return;
    }

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
    var hasDup = currentDuplicates.length > 0 && !isMoved && !deletedSet.has(pdfs[currentIdx]);

    // Duplicate compare shortcut
    if (hasDup && !classifying) {
      if (e.key === 'c' || e.key === 'C') { window._compareDuplicate(); return; }
    }

    // Delete shortcut — always available for unhandled files
    if ((e.key === 'd' || e.key === 'D') && !isMoved && !deletedSet.has(pdfs[currentIdx]) && !classifying) {
      window._confirmDelete();
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isMoved && currentResults.length > 0) {
        if (showingFuzzy) {
          // Go back from fuzzy to last suggestion
          window._toggleFuzzy();
          changeSelection(Math.min(NUM_SUGGESTIONS - 1, currentResults.length - 1));
        } else {
          changeSelection(Math.max(0, selectedSuggestion - 1));
        }
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!isMoved && currentResults.length > 0) {
        var maxSugg = Math.min(NUM_SUGGESTIONS - 1, currentResults.length - 1);
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
    } else if (e.key >= '1' && e.key <= String(NUM_SUGGESTIONS)) {
      if (!isMoved && !classifying && !showingFuzzy) {
        var idx = parseInt(e.key) - 1;
        if (idx < Math.min(NUM_SUGGESTIONS, currentResults.length)) {
          window._moveTo(currentResults[idx].folder);
        }
      }
    } else if (e.key === FUZZY_KEY) {
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
