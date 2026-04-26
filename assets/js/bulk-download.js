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

let _activeAbortController = null;

// --- Public surface ---

export function bulkDownloadAvailable() {
  return _libraryReady && Array.isArray(window.__galleryCards);
}

export async function startBulkDownload(scope) {
  console.log('[bulk-download] starting', scope);
  // Implementation in later tasks
}

// --- Wiring ---

function wireButtons() {
  const buttons = document.querySelectorAll('[data-download-scope]');
  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      const scope = btn.dataset.downloadScope;
      startBulkDownload(scope);
    });
    if (!bulkDownloadAvailable()) btn.disabled = true;
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireButtons);
} else {
  wireButtons();
}

// Re-wire after the gallery finishes rendering (cards.json arrives async)
window.addEventListener('gallery:ready', wireButtons);
