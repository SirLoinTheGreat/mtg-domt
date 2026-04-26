// Bulk Card Download — client-side ZIP bundling
// Spec: docs/superpowers/specs/2026-04-26-bulk-card-download-design.md

import { downloadZip } from '../vendor/client-zip-2.x.js';

// Library is ready iff the import resolved and exported the expected function.
// Hoisted to top so it's set before any consumer (e.g. wireButtons) reads it.
const _libraryReady = typeof downloadZip === 'function';

const SET_LABELS = {
  all: 'All Cards',
  original: 'Original',
  expansion: 'Expansion',
  harrow: 'Harrow',
  wonder: 'Wonder',
};

// Build the {url, zipPath, displayName} list for a given scope.
// Note: card.image_file is a full relative path like "assets/cards/original/Card Back.png".
// We URL-encode each segment to match how the rest of the gallery references images.
function buildFileList(scope) {
  const cards = window.__galleryCards || [];
  const targetSets = scope === 'all'
    ? ['original', 'expansion', 'harrow', 'wonder']
    : [scope];

  const entries = [];
  for (const card of cards) {
    if (!targetSets.includes(card.set)) continue;
    if (!card.image_file) continue;
    const url = card.image_file.split('/').map(encodeURIComponent).join('/');
    const filename = card.image_file.split('/').pop();
    const zipPath = scope === 'all'
      ? `${card.set}/${filename}`
      : filename;
    entries.push({ url, zipPath, displayName: card.name });
  }
  return entries;
}

// Fetch a single card PNG with one retry. Returns Response on success, null on permanent failure.
async function fetchCardWithRetry(url, signal) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      const resp = await fetch(url, { signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return resp;
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      if (attempt === 0) {
        await new Promise((res, rej) => {
          const t = setTimeout(res, 500);
          signal.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('Aborted', 'AbortError')); }, { once: true });
        });
        continue;
      }
      console.warn('[bulk-download] fetch failed, skipping:', url, err.message);
      return null;
    }
  }
  return null;
}

// --- Progress modal helpers ---

let _previouslyFocused = null;
let _escListener = null;

function modalEl() {
  return document.getElementById('dl-modal');
}

function openModal(title) {
  const root = modalEl();
  if (!root) return;
  const inner = root.querySelector('.dl-modal');
  inner.dataset.state = 'progress';
  root.querySelector('#dl-modal-title').textContent = title;
  const fill = root.querySelector('.dl-modal-bar-fill');
  fill.style.setProperty('--dl-progress', '0%');
  const bar = root.querySelector('.dl-modal-bar');
  bar.setAttribute('aria-valuemax', '0');
  bar.setAttribute('aria-valuenow', '0');
  root.querySelector('.dl-modal-progress-text').textContent = '0 of 0';
  root.querySelector('.current-card').textContent = 'Preparing…';
  const details = root.querySelector('.dl-modal-details');
  details.hidden = true;
  details.querySelector('pre').textContent = '';
  const cancelBtn = root.querySelector('#dl-modal-cancel');
  cancelBtn.textContent = 'Cancel';
  root.setAttribute('data-open', 'true');
  root.setAttribute('aria-hidden', 'false');

  // Focus management
  _previouslyFocused = document.activeElement;
  cancelBtn.focus();

  // Escape-to-cancel + focus trap (single focusable element makes the trap trivial)
  _escListener = (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      cancelBtn.click();
    } else if (ev.key === 'Tab') {
      // Only one focusable element — keep it focused
      ev.preventDefault();
      cancelBtn.focus();
    }
  };
  document.addEventListener('keydown', _escListener);
}

function updateModal({ index, total, currentName }) {
  const root = modalEl();
  if (!root) return;
  const pct = total === 0 ? 0 : Math.round((index / total) * 100);
  root.querySelector('.dl-modal-bar-fill').style.setProperty('--dl-progress', pct + '%');
  const bar = root.querySelector('.dl-modal-bar');
  bar.setAttribute('aria-valuemax', String(total));
  bar.setAttribute('aria-valuenow', String(index));
  root.querySelector('.dl-modal-progress-text').textContent = `${index} of ${total}`;
  root.querySelector('.current-card').textContent = currentName;
}

function closeModal() {
  const root = modalEl();
  if (!root) return;
  root.setAttribute('data-open', 'false');
  root.setAttribute('aria-hidden', 'true');
  if (_escListener) {
    document.removeEventListener('keydown', _escListener);
    _escListener = null;
  }
  if (_previouslyFocused && typeof _previouslyFocused.focus === 'function') {
    _previouslyFocused.focus();
  }
  _previouslyFocused = null;
}

function showCompletion({ scope, missing }) {
  const root = modalEl();
  if (!root) return;
  const inner = root.querySelector('.dl-modal');
  inner.dataset.state = 'progress';
  const title = missing.length === 0 ? 'Bundle ready — opening…' : 'Bundle ready';
  root.querySelector('#dl-modal-title').textContent = title;
  if (missing.length > 0) {
    root.querySelector('.dl-modal-status').innerHTML =
      `${missing.length} card${missing.length === 1 ? '' : 's'} couldn't be fetched.`;
    const details = root.querySelector('.dl-modal-details');
    details.hidden = false;
    details.querySelector('pre').textContent = missing.join('\n');
    root.querySelector('#dl-modal-cancel').textContent = 'Close';
    return; // do not auto-dismiss; user closes manually
  }
  // Full success: auto-dismiss after 1s
  setTimeout(closeModal, 1000);
}

function showError(err) {
  const root = modalEl();
  if (!root) return;
  const inner = root.querySelector('.dl-modal');
  inner.dataset.state = 'error';
  root.querySelector('#dl-modal-title').textContent = 'Bundle failed — try again';
  root.querySelector('.dl-modal-status').textContent = '';
  const details = root.querySelector('.dl-modal-details');
  details.hidden = false;
  details.querySelector('pre').textContent = String(err && err.stack || err || 'Unknown error');
  root.querySelector('#dl-modal-cancel').textContent = 'Close';
}

let _activeAbortController = null;

function todayStamp() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 1000);
}

// --- Public surface ---

export function bulkDownloadAvailable() {
  return _libraryReady && Array.isArray(window.__galleryCards);
}

export async function startBulkDownload(scope) {
  if (!bulkDownloadAvailable()) {
    console.warn('[bulk-download] not available');
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(SET_LABELS, scope)) {
    console.warn('[bulk-download] unknown scope:', scope);
    return;
  }
  if (_activeAbortController) {
    console.warn('[bulk-download] download already in progress');
    return;
  }

  const entries = buildFileList(scope);
  if (entries.length === 0) {
    console.warn('[bulk-download] no cards for scope', scope);
    return;
  }

  const label = SET_LABELS[scope] || scope;
  const ctrl = new AbortController();
  _activeAbortController = ctrl;
  const missing = [];

  openModal(`Bundling ${label}…`);
  updateModal({ index: 0, total: entries.length, currentName: 'Preparing…' });

  // Build an async iterable of zip-input objects, fetched sequentially.
  async function* zipInputs() {
    for (let i = 0; i < entries.length; i++) {
      if (ctrl.signal.aborted) return;
      const entry = entries[i];
      updateModal({ index: i, total: entries.length, currentName: entry.displayName });
      const resp = await fetchCardWithRetry(entry.url, ctrl.signal);
      if (resp === null) {
        missing.push(entry.displayName);
        continue;
      }
      yield {
        name: entry.zipPath,
        lastModified: new Date(),
        input: resp,
      };
    }
    updateModal({ index: entries.length, total: entries.length, currentName: 'Sealing archive…' });
  }

  try {
    const zipResponse = downloadZip(zipInputs());
    const blob = await zipResponse.blob();
    if (ctrl.signal.aborted) return; // user cancelled while sealing
    const filename = `domt-${scope}-${todayStamp()}.zip`;
    triggerDownload(blob, filename);
    showCompletion({ scope, missing });
  } catch (err) {
    if (err.name === 'AbortError' || ctrl.signal.aborted) {
      closeModal();
      return;
    }
    console.error('[bulk-download] failed:', err);
    showError(err);
  } finally {
    if (_activeAbortController === ctrl) _activeAbortController = null;
  }
}

// --- Wiring ---

function wireButtons() {
  const available = bulkDownloadAvailable();
  const buttons = document.querySelectorAll('[data-download-scope]');
  buttons.forEach(btn => {
    if (btn.dataset.dlWired !== '1') {
      btn.dataset.dlWired = '1';
      btn.addEventListener('click', () => {
        const scope = btn.dataset.downloadScope;
        startBulkDownload(scope);
      });
    }
    // Re-evaluate disabled state on every call — both directions.
    // gallery:ready re-fires after cards data loads; without this, buttons
    // that started disabled in markup would never re-enable.
    btn.disabled = !available;
  });

  const cancel = document.getElementById('dl-modal-cancel');
  if (cancel && !cancel.dataset.dlWired) {
    cancel.dataset.dlWired = '1';
    cancel.addEventListener('click', () => {
      if (_activeAbortController) _activeAbortController.abort();
      // closeModal handles aria-hidden, focus restore, and removes the keydown listener
      closeModal();
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireButtons);
} else {
  wireButtons();
}

// Re-wire after the gallery finishes rendering (cards.json arrives async)
window.addEventListener('gallery:ready', wireButtons);
