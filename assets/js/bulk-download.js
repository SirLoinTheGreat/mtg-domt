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
