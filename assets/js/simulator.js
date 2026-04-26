// Playtest Simulator — core state machine + draw orchestration.
// Phase 4: cards animate (lift, slide, flip, resolution beat).
// Phase 5: reshuffle / reset session / discard history modal wired up.
// Phase 6 adds URL state.

import { mulberry32, freshSeed, shuffle } from './seeded-rng.js';

const CACHE_BUST = String(Date.now());
const ALL_SETS = ['original', 'expansion', 'harrow', 'wonder'];
const CARD_BACK_SRC = 'assets/cards/original/Card%20Back.png';
const MIN_DRAW = 1;
const MAX_DRAW = 13;

// --- Animation tuning ---
const ANIM = {
  liftMs: 200,
  slideMs: 300,
  flipMs: 300,
  beatMs: 500,
  cascadeStaggerMs: 100,    // for Draw 4+ flip cascade
  perCardSequentialMs: 1300, // total per-card budget for Draw 1-3
  discardSlideMs: 400,
};

const SENTIMENT_LUM = {
  positive: 'rgba(125, 186, 138, .85)',  // warm gold-green
  negative: 'rgba(217, 119, 66, .85)',   // ember red
  mixed:    'rgba(180, 140, 220, .85)',  // cool violet
  neutral:  'rgba(244, 210, 122, .85)',  // pure gold
};

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
  isAnimating: false,      // Phase 4: gates controls during choreography
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
async function draw(n) {
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

  state.isAnimating = true;
  renderControls();

  const spreadArea = document.getElementById('spread-area');
  const deckEl = document.getElementById('deck-stack');
  const discardEl = document.getElementById('discard-stack');

  // Move previous spread to discard model (instantly in state) then animate the visuals.
  for (const card of state.spread) state.discard.push(card);
  state.spread = [];

  // Kick off the discard slide-out, but DON'T await it — overlap with the new lift.
  const discardPromise = animateSpreadToDiscard(spreadArea, discardEl);

  // Update the empty-prompt visibility immediately for the new spread (will become hidden once cards arrive)
  const emptyPrompt = document.getElementById('empty-prompt');
  if (emptyPrompt) emptyPrompt.style.display = 'none';

  // Draw N from top of deck.
  const drawnCards = [];
  for (let i = 0; i < n; i++) drawnCards.push(state.deck.shift());
  state.spread = drawnCards.slice();
  state.lastDrawN = n;

  // Build invisible spread slots for layout positioning.
  const slots = buildSpreadSlots(n, spreadArea);

  // Wait briefly for slot layout to settle before measuring.
  // (Ensures getBoundingClientRect on the slots returns final positions.)
  await sleep(0);

  // Animate cards arriving — adaptive per spec.
  if (n >= 4) {
    // Cascading: lift + slide all together, then flip in cascade.
    await Promise.all(drawnCards.map((card, i) =>
      animateCardArrival(card, slots[i], deckEl, spreadArea, {
        delay: 0,
        flipDelay: i * ANIM.cascadeStaggerMs,
      })
    ));
  } else {
    // Sequential: one full sequence per card before starting the next.
    for (let i = 0; i < drawnCards.length; i++) {
      await animateCardArrival(drawnCards[i], slots[i], deckEl, spreadArea);
    }
  }

  // Make sure the discard slide-out finished (usually well before the arrivals).
  await discardPromise;

  // Update deck stack visual (now thinner) and discard stack (now fatter).
  renderDeck();
  renderDiscard();

  state.isAnimating = false;
  renderControls();
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
  // Phase 4: clear any anim-cards in the spread (instant — set rebuild has no animation).
  const spreadArea = document.getElementById('spread-area');
  if (spreadArea) spreadArea.innerHTML = '';
  const emptyPrompt = document.getElementById('empty-prompt');
  if (emptyPrompt) emptyPrompt.style.display = state.spread.length === 0 ? '' : 'none';
  renderDeck();
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
  // Update set-toggle active states + disabled-during-anim.
  document.querySelectorAll('.set-toggle').forEach(pill => {
    if (state.activeSets.has(pill.dataset.set)) pill.classList.add('active');
    else pill.classList.remove('active');
    pill.disabled = state.isAnimating;
  });
  document.querySelectorAll('.draw-preset').forEach(b => {
    b.disabled = state.isAnimating;
  });
  const drawNBtn = document.getElementById('draw-n-btn');
  if (drawNBtn) drawNBtn.disabled = state.isAnimating;
  const drawNInput = document.getElementById('draw-n');
  if (drawNInput) drawNInput.disabled = state.isAnimating;
  // Reshuffle is enabled when there's something to fold back in.
  const reshuffle = document.getElementById('reshuffle-btn');
  if (reshuffle) {
    reshuffle.disabled = state.isAnimating || (state.discard.length === 0 && state.spread.length === 0);
  }
  const reset = document.getElementById('reset-btn');
  if (reset) reset.disabled = state.isAnimating;
  const share = document.getElementById('share-btn');
  if (share) share.disabled = state.isAnimating;
}

function openCardLightbox(card) {
  if (typeof window.openLightbox === 'function') {
    window.openLightbox(card);  // shim accepts a card object directly
  } else {
    console.warn('[simulator] lightbox not available');
  }
}

// --- Animation helpers ---
function sentimentColor(card) {
  return SENTIMENT_LUM[card.sentiment || 'neutral'] || SENTIMENT_LUM.neutral;
}

// Get pixel position of an element relative to the spread-area container
function getRelativePos(el, container) {
  const r = el.getBoundingClientRect();
  const cr = container.getBoundingClientRect();
  return { x: r.left - cr.left, y: r.top - cr.top };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildSpreadSlots(n, spreadArea) {
  spreadArea.innerHTML = '';
  const slots = [];
  for (let i = 0; i < n; i++) {
    const slot = document.createElement('div');
    slot.className = 'spread-slot';
    slot.style.width = '200px';
    slot.style.height = '280px';
    slot.style.flex = '0 0 auto';
    slot.style.visibility = 'hidden';
    slots.push(slot);
    spreadArea.appendChild(slot);
  }
  return slots;
}

function createAnimCard(card, startX, startY, targetX, targetY) {
  const wrap = document.createElement('div');
  wrap.className = 'anim-card';
  wrap.dataset.cardname = card.name;
  wrap.style.setProperty('--start-x', startX + 'px');
  wrap.style.setProperty('--start-y', startY + 'px');
  wrap.style.setProperty('--target-x', targetX + 'px');
  wrap.style.setProperty('--target-y', targetY + 'px');
  // Initial transform must match the --start vars (otherwise no transition baseline).
  wrap.style.transform = `translate(${startX}px, ${startY}px)`;

  const inner = document.createElement('div');
  inner.className = 'anim-card-inner';

  const back = document.createElement('img');
  back.className = 'anim-face anim-face-back';
  back.src = CARD_BACK_SRC;
  back.alt = '';

  const front = document.createElement('img');
  front.className = 'anim-face anim-face-front';
  front.src = imgUrl(card);
  front.alt = card.name;

  inner.appendChild(back);
  inner.appendChild(front);

  const bloom = document.createElement('div');
  bloom.className = 'anim-bloom';

  wrap.appendChild(inner);
  wrap.appendChild(bloom);

  // Click-to-lightbox once settled
  wrap.addEventListener('click', () => {
    if (wrap.classList.contains('settled')) openCardLightbox(card);
  });

  return wrap;
}

function spawnBloom(card, bloomEl) {
  const colors = (card.color_identity && card.color_identity.length > 0) ? card.color_identity : ['C'];
  const particleCount = 3 + Math.floor(Math.random() * 5);  // 3-7 particles
  for (let i = 0; i < particleCount; i++) {
    const p = document.createElement('div');
    p.className = 'bloom-particle';
    const c = colors[Math.floor(Math.random() * colors.length)];
    p.dataset.c = c;
    // Random target offset within a ring around the card center
    const angle = Math.random() * Math.PI * 2;
    const dist = 60 + Math.random() * 80;
    const tx = Math.cos(angle) * dist;
    const ty = Math.sin(angle) * dist;
    p.style.setProperty('--tx', tx + 'px');
    p.style.setProperty('--ty', ty + 'px');
    p.style.setProperty('--p-duration', (600 + Math.random() * 300) + 'ms');
    bloomEl.appendChild(p);
    // Auto-remove after animation completes
    setTimeout(() => p.remove(), 1100);
  }
}

// Animate one card from deck position to its spread slot.
async function animateCardArrival(card, slotEl, deckEl, spreadArea, opts = {}) {
  const { delay = 0, flipDelay = 0 } = opts;
  if (delay > 0) await sleep(delay);

  // Compute positions relative to spread-area
  const deckPos = getRelativePos(deckEl, spreadArea);
  const slotPos = getRelativePos(slotEl, spreadArea);

  const animCard = createAnimCard(card, deckPos.x, deckPos.y, slotPos.x, slotPos.y);
  animCard.style.setProperty('--lum-color', sentimentColor(card));
  spreadArea.appendChild(animCard);

  // Force layout, then start lift on the next frame so the initial transform is committed.
  void animCard.offsetWidth;
  await new Promise(r => requestAnimationFrame(r));
  animCard.classList.add('lifting');
  await sleep(ANIM.liftMs);

  // Slide to target
  animCard.classList.remove('lifting');
  animCard.classList.add('sliding');
  await sleep(ANIM.slideMs);

  // Optional cascade-only delay before flip
  if (flipDelay > 0) await sleep(flipDelay);

  // Flip
  animCard.classList.add('flipped');
  await sleep(ANIM.flipMs);

  // Resolution beat: luminescence + bloom in parallel
  animCard.classList.add('beating');
  spawnBloom(card, animCard.querySelector('.anim-bloom'));
  await sleep(ANIM.beatMs);

  // Settle: clear transient classes, mark interactable.
  animCard.classList.remove('lifting', 'sliding', 'beating');
  animCard.classList.add('settled');
  return animCard;
}

// Animate the previous spread sliding into the discard pile.
// Resolves when the slide finishes; safe to run in parallel with the next arrival.
async function animateSpreadToDiscard(spreadArea, discardEl) {
  const oldCards = Array.from(spreadArea.querySelectorAll('.anim-card.settled'));
  if (oldCards.length === 0) return;

  const targetPos = getRelativePos(discardEl, spreadArea);
  oldCards.forEach((c, i) => {
    c.classList.remove('settled');
    c.classList.add('discarding');
    // Override transform inline so the discard motion takes precedence over CSS class transforms.
    c.style.transform = `translate(${targetPos.x}px, ${targetPos.y}px) rotate(${(i % 2 === 0 ? -1 : 1) * 8}deg)`;
    c.style.opacity = '0';
  });
  await sleep(ANIM.discardSlideMs);
  oldCards.forEach(c => c.remove());
}

// --- Phase 5: Reshuffle / Reset / Discard history ---

async function reshuffle() {
  if (state.isAnimating) return;
  if (state.discard.length === 0 && state.spread.length === 0) return;

  state.isAnimating = true;
  renderControls();

  // Visually animate spread + discard images flying / fading back to the deck.
  await animateReturnToDeck();

  // Combine spread + discard back into the deck and reshuffle the entire pile.
  const returning = [...state.spread, ...state.discard];
  state.spread = [];
  state.discard = [];
  state.deck = state.deck.concat(returning);
  state.seed = freshSeed();
  state.rng = mulberry32(state.seed);
  state.deck = shuffle(state.deck, state.rng);
  state.lastDrawN = null;

  // Clear visuals and re-render piles.
  const spreadArea = document.getElementById('spread-area');
  if (spreadArea) spreadArea.innerHTML = '';
  renderDeck();
  renderDiscard();

  state.isAnimating = false;
  renderControls();

  const emptyPrompt = document.getElementById('empty-prompt');
  if (emptyPrompt) emptyPrompt.style.display = '';
}

async function animateReturnToDeck() {
  const spreadArea = document.getElementById('spread-area');
  const deckEl = document.getElementById('deck-stack');
  const discardEl = document.getElementById('discard-stack');
  if (!spreadArea || !deckEl) return;

  // Settled spread cards fly back to the deck position.
  const spreadCards = Array.from(spreadArea.querySelectorAll('.anim-card.settled'));
  const deckPos = getRelativePos(deckEl, spreadArea);
  spreadCards.forEach((c, i) => {
    c.classList.remove('settled');
    c.classList.add('discarding');  // reuse the discarding transition envelope
    c.style.setProperty('--target-x', deckPos.x + 'px');
    c.style.setProperty('--target-y', deckPos.y + 'px');
    c.style.transform = `translate(${deckPos.x}px, ${deckPos.y}px) rotate(0deg) scale(0.92)`;
    c.style.opacity = '0';
    c.style.transitionDelay = (i * 60) + 'ms';
  });

  // Discard images fade + shrink in place (simpler + reads as the pile collapsing back into the deck).
  const discardImgs = discardEl ? Array.from(discardEl.querySelectorAll('.discard-card')) : [];
  discardImgs.forEach(img => {
    img.style.transition = 'opacity .4s ease-out, transform .4s ease-out';
    img.style.opacity = '0';
    const prior = img.style.transform || '';
    img.style.transform = prior + ' scale(.85)';
  });

  await sleep(ANIM.discardSlideMs + (spreadCards.length * 60));

  spreadCards.forEach(c => c.remove());
}

function resetSession() {
  if (state.isAnimating) return;
  // Instant wipe — no animation per spec.
  const spreadArea = document.getElementById('spread-area');
  if (spreadArea) spreadArea.innerHTML = '';
  state.seed = freshSeed();
  state.rng = mulberry32(state.seed);
  state.lastDrawN = null;
  rebuildDeck();  // already clears spread + discard
  renderAll();
  showToast('Session reset.', 1500);
}

function openDiscardModal() {
  if (state.discard.length === 0) return;  // nothing to show
  const modal = document.getElementById('discard-modal');
  const list = document.getElementById('discard-list');
  if (!modal || !list) return;
  list.innerHTML = '';
  // Spec: oldest first (chronological draw order).
  state.discard.forEach((card, idx) => {
    const wrap = document.createElement('div');
    wrap.className = 'discard-list-item';

    const thumb = document.createElement('img');
    thumb.src = thumbUrl(card);
    thumb.alt = card.name;
    thumb.title = `#${idx + 1}: ${card.name}`;
    thumb.addEventListener('click', () => openCardLightbox(card));

    const label = document.createElement('div');
    label.className = 'discard-list-label';
    label.textContent = `${idx + 1}. ${card.name}`;

    wrap.appendChild(thumb);
    wrap.appendChild(label);
    list.appendChild(wrap);
  });
  modal.setAttribute('data-open', 'true');
  modal.setAttribute('aria-hidden', 'false');
}

function closeDiscardModal() {
  const modal = document.getElementById('discard-modal');
  if (!modal) return;
  modal.setAttribute('data-open', 'false');
  modal.setAttribute('aria-hidden', 'true');
}

function thumbUrl(card) {
  // Use the JPG thumbnail (~30KB) instead of the full PNG (~7MB).
  // image_file format: assets/cards/<set>/<file>.png  →  assets/cards/<set>/thumbs/<file>.jpg
  const path = card.image_file || '';
  const parts = path.split('/');
  const fileName = parts.pop().replace(/\.png$/, '.jpg');
  const thumbPath = [...parts, 'thumbs', fileName].map(encodeURIComponent).join('/');
  return thumbPath + '?' + CACHE_BUST;
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

  // Phase 5: session controls.
  const reshuffleBtn = document.getElementById('reshuffle-btn');
  if (reshuffleBtn) reshuffleBtn.addEventListener('click', reshuffle);
  const resetBtn = document.getElementById('reset-btn');
  if (resetBtn) resetBtn.addEventListener('click', resetSession);

  // Discard zone click — open the history modal.
  const discardZone = document.querySelector('.discard-zone');
  if (discardZone) {
    discardZone.addEventListener('click', (e) => {
      // Don't open the modal if the click was on a visible top-card image (that opens the lightbox).
      if (e.target.classList && e.target.classList.contains('discard-card')) return;
      openDiscardModal();
    });
    // Keyboard accessibility — Enter/Space on the zone (it has tabindex=0, role=button).
    discardZone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openDiscardModal();
      }
    });
  }

  // Discard modal close handlers (scrim click + × button).
  const discardModal = document.getElementById('discard-modal');
  if (discardModal) {
    discardModal.addEventListener('click', (e) => {
      if (e.target === discardModal || (e.target.classList && e.target.classList.contains('sim-modal-close'))) {
        closeDiscardModal();
      }
    });
  }
  // Escape closes the discard modal.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const modal = document.getElementById('discard-modal');
      if (modal && modal.getAttribute('data-open') === 'true') closeDiscardModal();
    }
  });

  // Phase 6 will wire share button + URL state.
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
