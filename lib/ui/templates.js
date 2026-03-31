// ─── Pure HTML template functions ───
// No DOM access — take data, return HTML strings.

import { escHtml, relTime, fmtDuration } from './helpers.js';

export function previewContent({ filename, isMoved, isDeleted }) {
  if (isMoved) return '<div class="preview-placeholder">File was moved</div>';
  if (isDeleted) return '<div class="preview-placeholder">File was deleted</div>';
  return `<iframe src="/api/pdf/${encodeURIComponent(filename)}"></iframe>`;
}

export function filenameRow({ filename, isMoved, isDeleted }) {
  let badge = '';
  if (isMoved) badge = '<span class="moved-badge">Moved</span>';
  else if (isDeleted) badge = '<span class="deleted-badge">Deleted</span>';
  const deleteBtn = (!isMoved && !isDeleted)
    ? `<button class="delete-btn" data-action="confirm-delete" title="Delete (d)">&#128465;</button>`
    : '';
  return `<div class="filename-row"><div class="filename">${escHtml(filename)}${badge}</div>${deleteBtn}</div>`;
}

export function movedInfo({ folder, finalName, filename }) {
  return `<div class="moved-info">` +
    `<div><span class="moved-label">Folder</span></div>` +
    `<div class="moved-value">${escHtml(folder)}</div>` +
    (finalName !== filename
      ? `<div><span class="moved-label">Renamed to</span></div><div class="moved-value">${escHtml(finalName)}</div>`
      : '') +
    `</div>`;
}

export function controlShell({ filename }) {
  return `<div id="dupWarning"></div>` +
    `<div>` +
      `<div class="section-label">Suggestions <span class="name-loading" id="classifyLoading"></span></div>` +
      `<div class="suggestions" id="suggestions">` +
        `<div class="status-bar loading"><span class="spinner"></span> Classifying...</div>` +
      `</div>` +
    `</div>` +
    `<div id="fuzzySection" style="display:none">` +
      `<div class="section-label">Choose folder</div>` +
      `<div class="dropdown-row">` +
        `<div class="fuzzy-wrapper">` +
          `<input type="text" id="fuzzyInput" placeholder="Search folders..." autocomplete="off" />` +
          `<div class="fuzzy-dropdown" id="fuzzyDropdown"></div>` +
        `</div>` +
        `<button data-action="move-dropdown">Move</button>` +
      `</div>` +
    `</div>` +
    `<div>` +
      `<div class="section-label">Rename (optional) <span class="name-loading" id="nameLoading"></span></div>` +
      `<div class="rename-row">` +
        `<div class="rename-wrapper">` +
          `<input type="text" id="renameInput" value="${escHtml(filename)}" />` +
          `<div class="name-dropdown" id="nameDropdown"></div>` +
        `</div>` +
      `</div>` +
    `</div>`;
}

export function keyboardHints({ numSuggestions, fuzzyKey }) {
  return `<kbd>&uarr;</kbd><kbd>&darr;</kbd> select suggestion &nbsp; ` +
    `<kbd>1</kbd>-<kbd>${numSuggestions}</kbd> pick &amp; move &nbsp; ` +
    `<kbd>${fuzzyKey}</kbd> specify folder &nbsp; ` +
    `<kbd>Enter</kbd> move to selection &nbsp; ` +
    `<kbd>&larr;</kbd><kbd>&rarr;</kbd> navigate &nbsp; ` +
    `<kbd>s</kbd> skip &nbsp; ` +
    `<kbd>d</kbd> delete &nbsp; ` +
    `<kbd>o</kbd> open folder &nbsp; ` +
    `<kbd>Tab</kbd> rename field &nbsp; ` +
    `hold <kbd>i</kbd> details`;
}

export function suggestions({ results, numSuggestions, selected, showDetail, fuzzyKey }) {
  const topN = results.slice(0, numSuggestions);
  let html = topN.map((r, i) => {
    let scoreText;
    if (showDetail) {
      scoreText = `emb ${r.centroidScore != null ? r.centroidScore.toFixed(2) : '?'} E#${r.centroidRank || '?'} B#${r.bayesRank || '?'}`;
    } else {
      scoreText = (r.score * 100).toFixed(0) + '%';
    }
    const cls = i === selected ? 'suggestion-btn selected' : 'suggestion-btn';
    const pathHtml = escHtml(r.folder).replace(/\//g, '/<wbr>');
    return `<button class="${cls}" data-action="pick" data-index="${i}" title="${escHtml(r.folder)}">` +
      `<span class="suggestion-num">${i + 1}.</span>` +
      `<span class="folder-name">${pathHtml}</span>` +
      `<span class="score">${scoreText}</span>` +
    `</button>`;
  }).join('');

  html += `<button class="suggestion-btn" data-action="toggle-fuzzy">` +
    `<span class="suggestion-num">${fuzzyKey}.</span>` +
    `<span class="folder-name">Specify folder\u2026</span>` +
    `<span class="score"></span>` +
  `</button>`;

  return html;
}

export function duplicateWarning({ duplicates }) {
  let html = `<div class="duplicate-warning"><div class="dup-header">Possible duplicate detected</div>`;

  duplicates.forEach(d => {
    const pct = (d.similarity * 100).toFixed(1) + '%';
    html += `<div class="dup-match">` +
      `<span class="dup-folder">${escHtml(d.folder)}</span> / ${escHtml(d.filename)} ` +
      `<span class="dup-sim">${pct} match</span>` +
    `</div>`;
  });

  html += `<div class="dup-actions">` +
    `<button class="dup-btn-compare" data-action="compare-duplicate"><kbd>c</kbd> Compare</button>` +
    `<button class="dup-btn-delete" data-action="confirm-delete"><kbd>d</kbd> Delete from inbox</button>` +
  `</div></div>`;

  return html;
}

export function fuzzyOptions({ filtered, highlight }) {
  return filtered.map((f, i) => {
    const cls = i === highlight ? 'fuzzy-option highlighted' : 'fuzzy-option';
    return `<div class="${cls}" data-action="select-fuzzy" data-index="${i}">${escHtml(f)}</div>`;
  }).join('');
}

export function nameOptions({ nameSuggestions, nameHighlight }) {
  return nameSuggestions.map((s, i) => {
    const cls = i === nameHighlight ? 'name-option highlighted' : 'name-option';
    const badge = `<span class="name-badge ${s.strategy}">${s.strategy}${s.similarity ? ' ' + (s.similarity * 100).toFixed(1) + '%' : ''}</span>`;
    return `<div class="${cls}" data-action="pick-name" data-index="${i}"><span class="name-text">${escHtml(s.name)}</span>${badge}</div>`;
  }).join('');
}

export function confirmDialog({ filename }) {
  return `<div class="confirm-dialog">` +
    `<h3>Delete scan?</h3>` +
    `<p>This will permanently delete<br><strong>${escHtml(filename)}</strong></p>` +
    `<div class="confirm-actions">` +
      `<button class="confirm-cancel" id="confirmCancel">Cancel</button>` +
      `<button class="confirm-delete" id="confirmDelete">Delete</button>` +
    `</div>` +
  `</div>`;
}

export function doneScreen({ movedCount, deletedCount }) {
  const parts = [];
  if (movedCount > 0) parts.push(movedCount + ' moved');
  if (deletedCount > 0) parts.push(deletedCount + ' deleted');
  const summary = parts.length > 0 ? parts.join(', ') : '0 PDFs processed';
  return `<div class="done-screen">` +
    `<div class="big">All done</div>` +
    `<div>${summary}</div>` +
  `</div>`;
}

export function statsView({ stats }) {
  if (!stats || stats.length === 0) {
    return '<div class="stats-view"><div class="stats-empty">No stats recorded yet.</div></div>';
  }

  const byEvent = {};
  for (const s of stats) {
    (byEvent[s.event] || (byEvent[s.event] = [])).push(s);
  }
  const learns = byEvent['learn'] || [];
  const classifies = byEvent['classify'] || [];
  const names = byEvent['suggest-names'] || [];
  const moves = byEvent['move'] || [];
  const skips = byEvent['skip'] || [];
  const deletes = byEvent['delete'] || [];

  let html = '<div class="stats-view">';

  // Learn
  if (learns.length > 0) {
    html += '<div class="stats-section"><h2>Learn</h2><div class="stats-grid">';
    const initials = learns.filter(l => l.data.type === 'initial');
    const updates = learns.filter(l => l.data.type === 'update');
    for (const l of initials) {
      html += card(l.data.totalDocs, 'docs') + card(l.data.folders, 'folders') + card(fmtDuration(l.data.durationMs), 'initial learn');
    }
    if (updates.length > 0) {
      const avgMs = updates.reduce((s, l) => s + l.data.durationMs, 0) / updates.length;
      const totalNew = updates.reduce((s, l) => s + (l.data.newDocs || 0), 0);
      html += card(updates.length, 'update runs') + card(totalNew, 'new docs') + card(fmtDuration(avgMs), 'avg update');
    }
    html += '</div></div>';
  }

  // Classification
  if (classifies.length > 0) {
    const avgClassify = classifies.reduce((s, c) => s + c.data.durationMs, 0) / classifies.length;
    const avgEmbed = classifies.reduce((s, c) => s + (c.data.embedDurationMs || 0), 0) / classifies.length;
    html += '<div class="stats-section"><h2>Classification</h2><div class="stats-grid">';
    html += card(classifies.length, 'classified');
    html += card(fmtDuration(avgClassify), 'avg classify');
    html += card(fmtDuration(avgEmbed), 'avg embed');
    html += '</div></div>';
  }

  // Name Suggestions
  if (names.length > 0) {
    const avgName = names.reduce((s, n) => s + n.data.durationMs, 0) / names.length;
    html += '<div class="stats-section"><h2>Name Suggestions</h2><div class="stats-grid">';
    html += card(names.length, 'total');
    html += card(fmtDuration(avgName), 'avg time');
    html += '</div></div>';
  }

  // Inbox Outcomes
  const totalOutcomes = moves.length + skips.length + deletes.length;
  if (totalOutcomes > 0) {
    const pct = (n) => (100 * n / totalOutcomes).toFixed(0);
    html += '<div class="stats-section"><h2>Inbox Outcomes</h2><div class="stats-grid">';
    html += card(totalOutcomes, 'total');
    html += card(moves.length + ' (' + pct(moves.length) + '%)', 'moved');
    html += card(skips.length + ' (' + pct(skips.length) + '%)', 'skipped');
    html += card(deletes.length + ' (' + pct(deletes.length) + '%)', 'deleted');
    html += '</div></div>';
  }

  // Suggestion Accuracy
  const rankedMoves = moves.filter(m => m.data.chosenRank != null || m.data.wasManual);
  if (rankedMoves.length > 0) {
    const byRank = {};
    let manualCount = 0;
    for (const m of rankedMoves) {
      if (m.data.wasManual) manualCount++;
      else { const r = m.data.chosenRank; byRank[r] = (byRank[r] || 0) + 1; }
    }
    const total = rankedMoves.length;
    const ranks = Object.keys(byRank).map(Number).sort((a, b) => a - b);
    html += '<div class="stats-section"><h2>Suggestion Accuracy</h2>';
    for (const r of ranks) {
      const count = byRank[r];
      const pct = (100 * count / total).toFixed(0);
      html += barRow('#' + r, count, pct, total);
    }
    if (manualCount > 0) {
      const pct = (100 * manualCount / total).toFixed(0);
      html += barRow('Manual', manualCount, pct, total);
    }
    html += '</div>';
  }

  // Method Effectiveness
  const methodMoves = moves.filter(m => m.data.centroidRank != null && m.data.bayesRank != null);
  if (methodMoves.length > 0) {
    let embBetter = 0, bayesBetter = 0, tied = 0;
    for (const m of methodMoves) {
      if (m.data.centroidRank < m.data.bayesRank) embBetter++;
      else if (m.data.bayesRank < m.data.centroidRank) bayesBetter++;
      else tied++;
    }
    const total = methodMoves.length;
    const pct = (n) => (100 * n / total).toFixed(0);
    html += '<div class="stats-section"><h2>Method Effectiveness</h2><div class="stats-grid">';
    html += card(embBetter + ' (' + pct(embBetter) + '%)', 'embedding higher');
    html += card(bayesBetter + ' (' + pct(bayesBetter) + '%)', 'bayes higher');
    html += card(tied + ' (' + pct(tied) + '%)', 'tied');
    html += '</div></div>';
  }

  // Duplicates
  const dupMoves = moves.filter(m => m.data.hadDuplicate);
  const dupDeletes = deletes.filter(d => d.data.hadDuplicate);
  const dupSkips = skips.filter(s => s.data.hadDuplicate);
  const totalDup = dupMoves.length + dupDeletes.length + dupSkips.length;
  if (totalDup > 0) {
    const pct = (n) => (100 * n / totalDup).toFixed(0);
    html += '<div class="stats-section"><h2>Duplicates</h2><div class="stats-grid">';
    html += card(totalDup, 'detected');
    html += card(dupDeletes.length + ' (' + pct(dupDeletes.length) + '%)', 'deleted');
    html += card(dupMoves.length + ' (' + pct(dupMoves.length) + '%)', 'moved');
    html += card(dupSkips.length + ' (' + pct(dupSkips.length) + '%)', 'skipped');
    html += '</div></div>';
  }

  html += '</div>';
  return html;
}

function card(value, label) {
  return '<div class="stat-card"><div class="stat-value">' + value + '</div><div class="stat-label">' + escHtml(label) + '</div></div>';
}

function barRow(label, count, pct, total) {
  const widthPct = (100 * count / total).toFixed(1);
  return '<div class="stats-bar-row"><span class="stats-bar-label">' + escHtml(label) + '</span>' +
    '<div class="stats-bar-track"><div class="stats-bar" style="width:' + widthPct + '%"></div></div>' +
    '<span class="stats-bar-value">' + count + ' (' + pct + '%)</span></div>';
}

export function statusBar({ type, msg }) {
  const prefix = type === 'loading' ? '<span class="spinner"></span> ' : '';
  return `<div class="status-bar ${type}">${prefix}${escHtml(msg)}</div>`;
}

export function classifyError({ message }) {
  return `<div class="status-bar error">${escHtml(message)}</div>`;
}

export function folderFilesList({ folder, files }) {
  if (files.length === 0) return '';

  const items = files.slice(0, 20).map((f, i) =>
    `<li data-action="compare-file" data-index="${i}">` +
      `<span class="file-name">${escHtml(f.name)}</span>` +
      `<span class="file-compare">compare</span>` +
      `<span class="file-time">${relTime(f.mtime)}</span>` +
    `</li>`
  ).join('');

  return `<div class="section-label">Files in ${escHtml(folder)} (${files.length})</div>` +
    `<div class="folder-files-section">` +
      `<ul class="folder-files-list">${items}</ul>` +
    `</div>`;
}
