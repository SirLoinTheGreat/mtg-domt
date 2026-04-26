// Playtest Simulator — core state machine + draw orchestration.
// Phase 4: cards animate (lift, slide, flip, resolution beat).
// Phase 5: reshuffle / reset session / discard history modal wired up.
// Phase 6 adds URL state.

import { mulberry32, freshSeed, shuffle } from './seeded-rng.js';

const CACHE_BUST = String(Date.now());
const ALL_SETS = ['original', 'expansion', 'harrow', 'wonder'];

// Anchor data + asset URLs to this SCRIPT's location, not the page's.
// When the page is served at /simulator/ (nginx URL rewrite) instead of
// /simulator.html, relative URLs like 'data/cards.json' resolve to
// /simulator/data/cards.json and 404 — which silently kills the preload.
// import.meta.url always points to /assets/js/simulator.js, so '../../'
// resolves to the project root regardless of how the page was reached.
const PROJECT_BASE = new URL('../../', import.meta.url).href;
function projectUrl(path) {
  return new URL(path, PROJECT_BASE).href;
}

const CARD_BACK_SRC = projectUrl('assets/cards/original/Card%20Back.png');
const MIN_DRAW = 1;
const MAX_DRAW = 13;

const SET_INITIALS = { o: 'original', e: 'expansion', h: 'harrow', w: 'wonder' };
const SET_TO_INITIAL = { original: 'o', expansion: 'e', harrow: 'h', wonder: 'w' };

// --- Animation tuning ---
const ANIM = {
  liftMs: 200,
  slideMs: 300,
  flipMs: 300,
  beatMs: 500,
  cascadeStaggerMs: 100,    // for Draw 4+ flip cascade
  perCardSequentialMs: 1300, // total per-card budget for Draw 1-3
  discardSlideMs: 550,
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
  useFatePoints: true,     // default ON — drawing costs 1 FP
  accumulateFP: false,     // default OFF — canonical max-1 cap
  fatePoints: 1,           // initial; persists across reshuffles, resets to 1 on Reset Session
};

// --- URL state ---
function readURLState() {
  const params = new URLSearchParams(window.location.search);
  const result = { sets: null, seed: null, n: null, fp: null, acc: null };

  if (params.has('sets')) {
    const raw = (params.get('sets') || '').toLowerCase();
    const parsed = new Set();
    for (const ch of raw) {
      if (SET_INITIALS[ch]) parsed.add(SET_INITIALS[ch]);
    }
    if (parsed.size > 0) result.sets = parsed;
  }

  if (params.has('seed')) {
    const raw = parseInt(params.get('seed'), 10);
    if (Number.isFinite(raw) && raw >= 0) result.seed = raw >>> 0;  // coerce to uint32
  }

  if (params.has('n')) {
    const raw = parseInt(params.get('n'), 10);
    if (Number.isFinite(raw) && raw >= MIN_DRAW && raw <= MAX_DRAW) result.n = raw;
  }

  if (params.has('fp')) {
    result.fp = params.get('fp') !== 'off';  // 'off' = false, anything else = true
  }
  if (params.has('acc')) {
    result.acc = params.get('acc') === 'on';  // 'on' = true, anything else = false
  }

  return result;
}

function writeURLState({ includeSeed = false } = {}) {
  const params = new URLSearchParams();
  // sets — only write if not all four (default is clean URL)
  const sortedSets = ALL_SETS.filter(s => state.activeSets.has(s));
  if (sortedSets.length < 4) {
    params.set('sets', sortedSets.map(s => SET_TO_INITIAL[s]).join(''));
  }
  // Persist non-default rule toggles
  if (!state.useFatePoints) params.set('fp', 'off');  // default is ON, so only write when OFF
  if (state.accumulateFP) params.set('acc', 'on');    // default is OFF, so only write when ON
  if (includeSeed && state.seed != null && state.lastDrawN != null) {
    params.set('seed', String(state.seed >>> 0));
    params.set('n', String(state.lastDrawN));
  }
  const qs = params.toString();
  const newURL = window.location.pathname + (qs ? '?' + qs : '');
  window.history.replaceState(null, '', newURL);
}

// --- Bootstrap ---
async function init() {
  let cardsData, history;
  try {
    [cardsData, history] = await Promise.all([
      fetch(projectUrl('data/cards.json') + '?' + CACHE_BUST).then(r => r.json()),
      fetch(projectUrl('data/card_history.json') + '?' + CACHE_BUST).then(r => r.json()).catch(() => ({})),
    ]);
  } catch (err) {
    console.error('[simulator] failed to load card data', err);
    showToast('Failed to load card data. Reload the page to try again.', 6000);
    return;
  }

  state.allCards = cardsData.cards || cardsData || [];

  // Read URL state for replay/config.
  const urlState = readURLState();
  if (urlState.sets) state.activeSets = urlState.sets;
  if (urlState.fp !== null) state.useFatePoints = urlState.fp;
  if (urlState.acc !== null) state.accumulateFP = urlState.acc;
  state.seed = urlState.seed != null ? urlState.seed : freshSeed();
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
  renderFateDisplay();
  preloadDeckImages();

  // Replay mode: if seed AND n were both in URL, auto-draw n cards.
  if (urlState.seed != null && urlState.n != null) {
    const replayN = Math.min(urlState.n, state.deck.length);
    if (replayN > 0) {
      // Slight delay so the user sees the deck before the draw fires.
      await sleep(400);
      await draw(replayN);
    }
  }
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

  // Fate Point consumption (if rule is active)
  if (state.useFatePoints) {
    if (state.fatePoints < 1) {
      showToast('No Fate Points. Roll a d6 — on a 6, gain one.');
      return;
    }
    state.fatePoints -= 1;
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
  renderFateDisplay();

  state.isAnimating = false;
  renderControls();

  // Capture seed + n in URL so the user can share / replay this draw.
  // Note: state.seed is the seed that produced the current deck order, and
  // state.lastDrawN is the count we just drew — together they reproduce
  // the LAST draw on a fresh load (subsequent draws within a session shift
  // cards but don't change the seed, so only the most recent draw replays).
  writeURLState({ includeSeed: true });
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
  preloadDeckImages();  // eligible card set changed — restart preload

  // Clear any lingering spread visuals (sub-deck change wipes the spread).
  const spreadArea = document.getElementById('spread-area');
  if (spreadArea) spreadArea.innerHTML = '';

  writeURLState();  // sets only — no seed (no draw to replay)
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
    img.src = thumbUrl(card);
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
  // Rule-toggle visual state
  const fpToggle = document.getElementById('toggle-fp');
  if (fpToggle) {
    fpToggle.classList.toggle('active', state.useFatePoints);
    fpToggle.disabled = state.isAnimating;
  }
  const accToggle = document.getElementById('toggle-acc');
  if (accToggle) {
    accToggle.classList.toggle('active', state.accumulateFP);
    accToggle.disabled = state.isAnimating;
  }
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
  const viewDiscard = document.getElementById('view-discard-btn');
  const viewDiscardCount = document.getElementById('view-discard-count');
  if (viewDiscard) viewDiscard.disabled = state.isAnimating || state.discard.length === 0;
  if (viewDiscardCount) viewDiscardCount.textContent = String(state.discard.length);
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
  // No inline transform — the base .anim-card CSS rule reads --start-x/y to position the
  // card at the deck. Setting an inline transform here would override ALL class-based
  // transforms (inline beats class specificity), pinning the card at the deck forever.

  const inner = document.createElement('div');
  inner.className = 'anim-card-inner';

  const back = document.createElement('img');
  back.className = 'anim-face anim-face-back';
  back.src = CARD_BACK_SRC;
  back.alt = '';

  const front = document.createElement('img');
  front.className = 'anim-face anim-face-front';
  front.src = thumbUrl(card);  // 400px JPG — fast preload, crisp at 280px display
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
    // Atomic swap: classList.replace avoids any intermediate frame where neither class is set
    // (which would snap to the base .anim-card transform = deck position via --start-x/y).
    c.classList.replace('settled', 'discarding');
    // Force layout so the .discarding class's default transform (settled position) commits
    // before we override it inline — guarantees the transition starts from the spread, not the deck.
    void c.offsetWidth;
    // Slide toward the discard pile, rotating slightly and shrinking to merge with the pile.
    c.style.transform = `translate(${targetPos.x}px, ${targetPos.y}px) rotate(${(i % 2 === 0 ? -1 : 1) * 8}deg) scale(0.6)`;
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

  writeURLState();  // sets only — no draw to replay after reshuffle
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
  state.fatePoints = 1;  // fresh session
  rebuildDeck();  // already clears spread + discard
  renderAll();
  renderFateDisplay();
  showToast('Session reset.', 1500);

  writeURLState();  // sets only — fresh session, no draw to replay
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

// --- Share link ---
function shareLink() {
  const params = new URLSearchParams();
  // Always include sets in shared URL (explicit is friendlier than implicit default).
  const sortedSets = ALL_SETS.filter(s => state.activeSets.has(s));
  params.set('sets', sortedSets.map(s => SET_TO_INITIAL[s]).join(''));
  if (state.lastDrawN != null) {
    params.set('seed', String(state.seed >>> 0));
    params.set('n', String(state.lastDrawN));
  }
  const url = window.location.origin + window.location.pathname + '?' + params.toString();

  // Try clipboard API; fall back to modal if it rejects (e.g. non-secure context).
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(
      () => showToast('Share link copied to clipboard.', 1800),
      () => openShareFallback(url)
    );
  } else {
    openShareFallback(url);
  }
}

function openShareFallback(url) {
  const modal = document.getElementById('share-modal');
  const input = document.getElementById('share-url');
  if (!modal || !input) return;
  input.value = url;
  modal.setAttribute('data-open', 'true');
  modal.setAttribute('aria-hidden', 'false');
  // Auto-select for easy manual copy.
  setTimeout(() => { input.focus(); input.select(); }, 50);
}

function closeShareModal() {
  const modal = document.getElementById('share-modal');
  if (!modal) return;
  modal.setAttribute('data-open', 'false');
  modal.setAttribute('aria-hidden', 'true');
}

function thumbUrl(card) {
  // Use the 400px JPG thumbnail (~30-65KB) instead of the full 2010×2814 PNG (~7MB).
  // image_file format: assets/cards/<set>/<file>.png  →  assets/cards/<set>/thumbs/<file>.jpg
  const path = card.image_file || '';
  const parts = path.split('/');
  const fileName = parts.pop().replace(/\.png$/, '.jpg');
  const thumbPath = [...parts, 'thumbs', fileName].map(encodeURIComponent).join('/');
  return projectUrl(thumbPath) + '?' + CACHE_BUST;
}

// --- Helpers ---
function imgUrl(card) {
  const path = (card.image_file || '').split('/').map(encodeURIComponent).join('/');
  return projectUrl(path) + '?' + CACHE_BUST;
}

// --- Image preloading ---
// Browsers cache by full URL, so the preload URL must match the runtime URL
// exactly (CACHE_BUST and all). We reuse imgUrl() above to guarantee that.
let _preloadCancelled = false;

function preloadDeckImages() {
  // Cancel any in-flight preload (e.g., user toggled sub-decks mid-preload).
  _preloadCancelled = true;
  // Kick a new attempt on next microtask so callbacks from the cancelled run drop out first.
  setTimeout(() => { _preloadCancelled = false; preloadInner(); }, 0);
}

function preloadInner() {
  const indicator = document.getElementById('preload-indicator');
  const counter = document.getElementById('preload-counter');
  // Build the unique URL list for the active deck (dedupe just in case).
  // Preload thumbnails (~50KB each, 7MB total for full deck) — same URLs the
  // spread + discard render uses. Full PNGs (~7MB each) only load on demand
  // when the user opens the lightbox.
  const urls = Array.from(new Set(state.deck.map(thumbUrl)));
  const total = urls.length;
  if (total === 0) {
    if (indicator) indicator.style.display = 'none';
    return;
  }
  if (indicator) {
    indicator.style.display = '';
    indicator.style.opacity = '1';
  }
  if (counter) counter.textContent = `0 / ${total}`;

  let done = 0;
  const onSettle = () => {
    if (_preloadCancelled) return;
    done++;
    if (counter) counter.textContent = `${done} / ${total}`;
    if (done === total && indicator) {
      indicator.style.opacity = '0';
      setTimeout(() => { indicator.style.display = 'none'; }, 500);
    }
  };
  urls.forEach(url => {
    const img = new Image();
    img.onload = onSettle;
    img.onerror = onSettle;  // count errors too — don't hang on broken paths
    img.src = url;
  });
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

// --- Fate Points ---
function rollD6() {
  if (state.isAnimating) return;
  if (!state.useFatePoints) return;  // shouldn't happen — button hidden
  // Canonical: can only roll when at 0
  if (!state.accumulateFP && state.fatePoints >= 1) {
    showToast('You already have a Fate Point. Spend it before rolling.');
    return;
  }
  const btn = document.getElementById('fate-roll-btn');
  if (btn) {
    btn.classList.remove('rolling');
    void btn.offsetWidth;
    btn.classList.add('rolling');
    setTimeout(() => btn.classList.remove('rolling'), 400);
  }
  const result = 1 + Math.floor(Math.random() * 6);
  if (result === 6) {
    state.fatePoints += 1;
    showToast(`\u{1F3B2} Rolled 6 — gained a Fate Point. (Now: ${state.fatePoints})`, 2400);
  } else {
    showToast(`\u{1F3B2} Rolled ${result} — no change.`, 1800);
  }
  renderFateDisplay();
  renderControls();
}

function renderFateDisplay() {
  const display = document.getElementById('fate-display');
  const count = document.getElementById('fate-count');
  const rollBtn = document.getElementById('fate-roll-btn');
  if (!display) return;
  count.textContent = String(state.fatePoints);
  if (state.useFatePoints) {
    display.removeAttribute('data-disabled');
    // Roll button enabled iff we CAN roll
    // - Always rollable in accumulation mode
    // - In canonical mode, rollable only when FP=0
    if (state.accumulateFP) {
      rollBtn.disabled = false;
    } else {
      rollBtn.disabled = (state.fatePoints >= 1);
    }
  } else {
    display.setAttribute('data-disabled', 'true');
    rollBtn.disabled = true;
  }
}

function toggleRule(ruleName) {
  if (state.isAnimating) return;
  if (ruleName === 'useFatePoints') {
    state.useFatePoints = !state.useFatePoints;
  } else if (ruleName === 'accumulateFP') {
    state.accumulateFP = !state.accumulateFP;
    // If switching back to canonical and FP > 1, cap to 1
    if (!state.accumulateFP && state.fatePoints > 1) {
      state.fatePoints = 1;
      showToast('Switched to canonical rules — Fate Points capped at 1.');
    }
  }
  renderFateDisplay();
  renderControls();
  writeURLState();  // persist toggle state
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
  // View Discard button — additional affordance alongside the right-rail discard zone click.
  const viewDiscardBtn = document.getElementById('view-discard-btn');
  if (viewDiscardBtn) viewDiscardBtn.addEventListener('click', openDiscardModal);

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

  // Phase 6: Share button + share-modal handlers.
  const shareBtn = document.getElementById('share-btn');
  if (shareBtn) shareBtn.addEventListener('click', shareLink);

  const shareModal = document.getElementById('share-modal');
  if (shareModal) {
    shareModal.addEventListener('click', (e) => {
      if (e.target === shareModal || (e.target.classList && e.target.classList.contains('sim-modal-close'))) {
        closeShareModal();
      }
    });
  }
  const shareCopyBtn = document.getElementById('share-copy-btn');
  if (shareCopyBtn) {
    shareCopyBtn.addEventListener('click', () => {
      const input = document.getElementById('share-url');
      if (!input) return;
      input.select();
      try {
        document.execCommand('copy');
        showToast('Copied to clipboard.', 1500);
      } catch (_) {
        showToast('Press Ctrl/Cmd+C to copy.', 2400);
      }
    });
  }

  // Escape closes either modal.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const dm = document.getElementById('discard-modal');
    if (dm && dm.getAttribute('data-open') === 'true') closeDiscardModal();
    const sm = document.getElementById('share-modal');
    if (sm && sm.getAttribute('data-open') === 'true') closeShareModal();
  });

  // Fate Point rule toggles
  document.querySelectorAll('.rule-toggle').forEach(btn => {
    btn.addEventListener('click', () => toggleRule(btn.dataset.rule));
  });

  // Roll d6 button
  const rollBtn = document.getElementById('fate-roll-btn');
  if (rollBtn) rollBtn.addEventListener('click', rollD6);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
