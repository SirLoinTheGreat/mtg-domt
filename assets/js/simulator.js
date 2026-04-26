// Playtest Simulator — core state machine + draw orchestration.
// Phase 3: cards appear/disappear instantly. Phase 4 will add choreography.
// Phase 5 will wire reshuffle / reset / discard modal. Phase 6 adds URL state.

import { mulberry32, freshSeed, shuffle } from './seeded-rng.js';

const CACHE_BUST = String(Date.now());
const ALL_SETS = ['original', 'expansion', 'harrow', 'wonder'];
const CARD_BACK_SRC = 'assets/cards/original/Card%20Back.png';
const MIN_DRAW = 1;
const MAX_DRAW = 13;

const state = {
  allCards: [],            // raw cards.json entries
  totalForActive: 0,       // for "X / Y" display
  activeSets: new Set(ALL_SETS),
  seed: 0,
  rng: () => 0.5,
  deck: [],
  spread: [],
  discard: [],
  lastDrawN: null,
  isAnimating: false,      // always false in Phase 3; Phase 4 will gate animations
};

// --- Bootstrap ---
async function init() {
  let cardsData, history;
  try {
    [cardsData, history] = await Promise.all([
      fetch('data/cards.json?' + CACHE_BUST).then(r => r.json()),
      fetch('data/card_history.json?' + CACHE_BUST).then(r => r.json()).catch(() => ({})),
    ]);
  } catch (err) {
    console.error('[simulator] failed to load card data', err);
    showToast('Failed to load card data. Reload the page to try again.', 6000);
    return;
  }

  state.allCards = cardsData.cards || cardsData || [];
  state.seed = freshSeed();
  state.rng = mulberry32(state.seed);

  // Init the lightbox module with the same data the gallery uses.
  // simulator.html script-tag-imports card-lightbox.js, which exposes
  // window.__initLightbox once its module evaluates. We may race that, so retry.
  const handoff = () => window.__initLightbox({
    cards: state.allCards,
    history: history || {},
    cacheBust: CACHE_BUST,
  });
  if (window.__initLightbox) {
    handoff();
  } else {
    const tryInit = () => {
      if (window.__initLightbox) {
        handoff();
      } else {
        setTimeout(tryInit, 50);
      }
    };
    tryInit();
  }

  rebuildDeck();
  renderAll();
  wireControls();
}

// --- Deck management ---
function rebuildDeck() {
  const eligible = state.allCards.filter(c =>
    state.activeSets.has(c.set) && !c.is_reference
  );
  state.totalForActive = eligible.length;
  state.deck = shuffle(eligible, state.rng);
  state.spread = [];
  state.discard = [];
}

// --- Drawing ---
function draw(n) {
  if (state.isAnimating) return;
  if (!Number.isFinite(n) || n < MIN_DRAW || n > MAX_DRAW) {
    showToast(`Draw count must be between ${MIN_DRAW} and ${MAX_DRAW}.`);
    return;
  }
  if (n > state.deck.length) {
    if (state.deck.length === 0) {
      showToast('The Deck is empty. Reshuffle to refill.');
    } else {
      showToast(`Only ${state.deck.length} card${state.deck.length === 1 ? '' : 's'} remain. Reshuffle to refill.`);
    }
    return;
  }
  // Move current spread to discard (in Phase 3, instantly; Phase 4 will animate).
  for (const card of state.spread) state.discard.push(card);
  state.spread = [];
  // Draw N from top of deck.
  for (let i = 0; i < n; i++) {
    state.spread.push(state.deck.shift());
  }
  state.lastDrawN = n;
  renderAll();
}

// --- Set toggles ---
function toggleSet(setKey) {
  if (state.isAnimating) return;
  const newActive = new Set(state.activeSets);
  if (newActive.has(setKey)) {
    if (newActive.size === 1) {
      // Snap-back: shake the pill, show a toast.
      const pill = document.querySelector(`.set-toggle[data-set="${setKey}"]`);
      if (pill) {
        pill.classList.remove('shake');
        void pill.offsetWidth;  // restart animation
        pill.classList.add('shake');
        setTimeout(() => pill.classList.remove('shake'), 500);
      }
      showToast('At least one sub-deck must be active.');
      return;
    }
    newActive.delete(setKey);
  } else {
    newActive.add(setKey);
  }
  state.activeSets = newActive;
  // Fresh seed on set change so the new shuffle isn't biased by the old stream.
  state.seed = freshSeed();
  state.rng = mulberry32(state.seed);
  rebuildDeck();
  renderAll();
}

// --- Rendering ---
function renderAll() {
  renderDeck();
  renderSpread();
  renderDiscard();
  renderControls();
}

function renderDeck() {
  const stack = document.getElementById('deck-stack');
  const count = document.getElementById('deck-count');
  if (count) count.textContent = `${state.deck.length} / ${state.totalForActive}`;
  if (!stack) return;
  stack.innerHTML = '';
  if (state.deck.length === 0) return;
  // Render up to ~5 layered card-backs for depth illusion.
  const layers = Math.min(5, state.deck.length);
  for (let i = 0; i < layers; i++) {
    const img = document.createElement('img');
    img.className = 'deck-back';
    img.src = CARD_BACK_SRC;
    img.alt = '';
    img.style.transform = `translate(${i * 1.5}px, ${-i * 1.5}px)`;
    img.style.zIndex = String(layers - i);
    stack.appendChild(img);
  }
}

function renderSpread() {
  const area = document.getElementById('spread-area');
  if (!area) return;
  area.innerHTML = '';
  for (const card of state.spread) {
    const img = document.createElement('img');
    img.className = 'spread-card';
    img.src = imgUrl(card);
    img.alt = card.name;
    img.dataset.cardname = card.name;
    img.title = card.name;
    img.addEventListener('click', () => openCardLightbox(card));
    area.appendChild(img);
  }
  // The empty-prompt below the spread auto-hides via CSS (`.spread-area:not(:empty) ~ .empty-prompt`).
}

function renderDiscard() {
  const stack = document.getElementById('discard-stack');
  const count = document.getElementById('discard-count');
  const zone = document.querySelector('.discard-zone');
  if (count) count.textContent = String(state.discard.length);
  if (!stack || !zone) return;
  stack.innerHTML = '';
  if (state.discard.length === 0) {
    zone.dataset.empty = 'true';
    return;
  }
  zone.removeAttribute('data-empty');
  // Show top 3 discarded cards with slight offset (newest = front, on top).
  const visibleCount = Math.min(3, state.discard.length);
  for (let i = 0; i < visibleCount; i++) {
    const card = state.discard[state.discard.length - 1 - i];
    const img = document.createElement('img');
    img.className = 'discard-card';
    img.src = imgUrl(card);
    img.alt = card.name;
    img.dataset.cardname = card.name;
    img.title = card.name;
    img.style.transform = `translate(${i * 4}px, ${-i * 4}px) rotate(${(i % 2 === 0 ? -1 : 1) * 2}deg)`;
    img.style.zIndex = String(visibleCount - i);
    img.addEventListener('click', (e) => {
      e.stopPropagation();
      openCardLightbox(card);
    });
    stack.appendChild(img);
  }
}

function renderControls() {
  // Update set-toggle active states.
  document.querySelectorAll('.set-toggle').forEach(pill => {
    if (state.activeSets.has(pill.dataset.set)) pill.classList.add('active');
    else pill.classList.remove('active');
  });
  // Reshuffle is enabled when there's something to fold back in (Phase 5 wires the click).
  const reshuffle = document.getElementById('reshuffle-btn');
  if (reshuffle) {
    reshuffle.disabled = (state.discard.length === 0 && state.spread.length === 0);
  }
}

function openCardLightbox(card) {
  if (typeof window.openLightbox === 'function') {
    window.openLightbox(card);  // shim accepts a card object directly
  } else {
    console.warn('[simulator] lightbox not available');
  }
}

// --- Helpers ---
function imgUrl(card) {
  return (card.image_file || '').split('/').map(encodeURIComponent).join('/') + '?' + CACHE_BUST;
}

function showToast(message, durationMs = 2400) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-10px)';
    setTimeout(() => toast.remove(), 300);
  }, durationMs);
}

// --- Wiring ---
function wireControls() {
  document.querySelectorAll('.set-toggle').forEach(pill => {
    pill.addEventListener('click', () => toggleSet(pill.dataset.set));
  });
  document.querySelectorAll('.draw-preset').forEach(btn => {
    btn.addEventListener('click', () => draw(parseInt(btn.dataset.draw, 10)));
  });
  const drawNInput = document.getElementById('draw-n');
  const drawNBtn = document.getElementById('draw-n-btn');
  if (drawNBtn && drawNInput) {
    drawNBtn.addEventListener('click', () => {
      const n = parseInt(drawNInput.value, 10);
      if (Number.isFinite(n)) draw(n);
    });
    drawNInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') drawNBtn.click();
    });
  }
  // Phase 5 will wire reshuffle, reset, discard-modal-open.
  // Phase 6 will wire share button + URL state.
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
