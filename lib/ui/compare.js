// ─── Compare view — side-by-side PDF comparison ───

import { escHtml } from './helpers.js';

// Compare-specific state
let active = false;
let similarity = null;
let rightLabel = '';
let rightPath = '';

export function isCompareActive() { return active; }

/**
 * Enter compare mode — replaces #main innerHTML with side-by-side PDFs.
 * @param {string} filename - inbox PDF filename
 * @param {string} label - right pane label (already HTML-safe)
 * @param {string} path - relative path to the right-side PDF
 * @param {number|null} sim - cosine similarity (or null)
 * @param {boolean} showDetail - whether to show similarity percentage
 */
export function enterCompare(filename, label, path, sim, showDetail) {
  active = true;
  similarity = sim;
  rightLabel = label;
  rightPath = path;

  const simLabel = showDetail && similarity != null
    ? ` <span style="font-size:11px;opacity:0.7">(${(similarity * 100).toFixed(1)}% similar)</span>`
    : '';

  const mainEl = document.getElementById('main');
  mainEl.innerHTML =
    `<div class="compare-view">` +
      `<div class="compare-pane">` +
        `<div class="compare-pane-label">Inbox: ${escHtml(filename)}</div>` +
        `<iframe src="/api/pdf/${encodeURIComponent(filename)}"></iframe>` +
      `</div>` +
      `<div class="compare-pane">` +
        `<div class="compare-pane-label" id="compareRightLabel">${rightLabel}${simLabel}</div>` +
        `<iframe src="/api/doc-pdf?path=${encodeURIComponent(rightPath)}"></iframe>` +
      `</div>` +
    `</div>`;

  document.getElementById('keyboardHint').innerHTML =
    `<kbd>Esc</kbd> exit compare &nbsp; ` +
    `<kbd>d</kbd> delete from inbox &nbsp; ` +
    `<kbd>&larr;</kbd><kbd>&rarr;</kbd> navigate &nbsp; ` +
    `hold <kbd>i</kbd> similarity`;
}

/**
 * Exit compare mode — rebuilds the normal layout shell.
 * Returns { previewPane, controlPane } element references.
 */
export function exitCompare() {
  if (!active) return null;
  active = false;

  const mainEl = document.getElementById('main');
  mainEl.innerHTML =
    `<div class="preview-pane" id="previewPane"></div>` +
    `<div class="right-side">` +
      `<div class="control-pane" id="controlPane"></div>` +
    `</div>`;

  return {
    previewPane: document.getElementById('previewPane'),
    controlPane: document.getElementById('controlPane'),
  };
}

/**
 * Re-render the right-side label (for hold-i detail toggle).
 * @param {boolean} showDetail - whether to show similarity percentage
 */
export function updateCompareLabel(showDetail) {
  const label = document.getElementById('compareRightLabel');
  if (!label) return;
  const simLabel = showDetail && similarity != null
    ? ` <span style="font-size:11px;opacity:0.7">(${(similarity * 100).toFixed(1)}% similar)</span>`
    : '';
  label.innerHTML = rightLabel + simLabel;
}

/**
 * Handle keydown events during compare mode.
 * Returns true if the event was handled.
 * @param {KeyboardEvent} e
 * @param {{ exitAndShow: Function, goBack: Function, skip: Function, confirmDelete: Function }} actions
 */
export function handleCompareKeydown(e, actions) {
  if (!active) return false;
  const inInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';

  if (e.key === 'Escape') {
    e.preventDefault();
    actions.exitAndShow();
    return true;
  }
  if (inInput) return true; // swallow but don't act
  if (e.key === 'd' || e.key === 'D') {
    actions.confirmDelete();
    return true;
  }
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    actions.exitAndShow();
    actions.goBack();
    return true;
  }
  if (e.key === 'ArrowRight') {
    e.preventDefault();
    actions.exitAndShow();
    actions.skip();
    return true;
  }
  return true; // compare mode swallows all other keys
}
