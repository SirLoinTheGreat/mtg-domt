// Bulk Card Download — client-side ZIP bundling
// Spec: docs/superpowers/specs/2026-04-26-bulk-card-download-design.md

import { downloadZip } from '../vendor/client-zip-2.x.js';

const SET_LABELS = {
  all: 'All Cards',
  original: 'Original',
  expansion: 'Expansion',
  harrow: 'Harrow',
  wonder: 'Wonder',
};

let _libraryReady = false;
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

// Library import succeeded (we got here without throwing)
_libraryReady = typeof downloadZip === 'function';

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireButtons);
} else {
  wireButtons();
}

// Re-wire after the gallery finishes rendering (cards.json arrives async)
window.addEventListener('gallery:ready', wireButtons);
