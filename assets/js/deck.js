// The Deck — a digital stand-in for the physical Deck of Many Things at the table.
// One phone in the middle of the table. Tap the deck to draw; tap a drawn card to
// discard it. Shuffle the remainder, or sweep the discard back in and shuffle all.
// No fate points, no dice — the table handles those. This is just the stack.
import { shuffle } from './seeded-rng.js';
import * as fx from './deck-fx.js';

const PROJECT_BASE = new URL('../../', import.meta.url).href;
const projectUrl = p => new URL(p, PROJECT_BASE).href;
const CARD_BACK = projectUrl('assets/cards/original/thumbs/Card%20Back.jpg');
const CARD_BACK_FULL = projectUrl('assets/cards/original/Card%20Back.png');
const ALL_SETS = ['original', 'expansion', 'harrow', 'wonder'];
const STORE_KEY = 'domt-deck-v1';
const SET_INITIALS = { o: 'original', e: 'expansion', h: 'harrow', w: 'wonder' };

const state = {
  byName: {},               // name -> card
  activeSets: new Set(ALL_SETS),
  deck: [],                 // names, index 0 = top
  drawn: [],                // names face-up on the table
  drawSeq: [],              // parallel to drawn: each card's draw number this spread
  discard: [],              // names, index 0 = most recent
  history: [],              // {type:'draw'|'discard', name} — for undo
  busy: false,              // animation gate
};

const $ = id => document.getElementById(id);
const els = {};
['deck-stack', 'discard-pile', 'dp-card', 'dp-count', 'drawn-row', 'drawn-hint', 'drawn-dots',
 'count-deck', 'count-discard', 'wake-dot', 'sheet-backdrop', 'discard-sheet',
 'menu-sheet', 'discard-grid', 'discard-empty', 'ds-count', 'set-chips',
 'btn-shuffle', 'btn-shuffle-all', 'btn-undo', 'btn-menu', 'btn-new-deck',
 'pager-prev', 'pager-next',
 'zoom-overlay', 'zoom-img', 'toast', 'draw-label'].forEach(id => {
  els[id.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = $(id);
});

function thumbUrl(name) {
  const card = state.byName[name];
  if (!card) return '';
  const parts = (card.image_file || '').split('/');
  const file = parts.pop().replace(/\.png$/, '.jpg');
  return projectUrl([...parts, 'thumbs', file].map(encodeURIComponent).join('/'));
}
function fullUrl(name) {
  const card = state.byName[name];
  if (!card) return '';
  return projectUrl((card.image_file || '').split('/').map(encodeURIComponent).join('/'));
}
// Progressive immersion: paint the fast thumb, then swap in the print-resolution
// PNG once it's cached. decode() rasterizes off the main thread BEFORE the swap
// so the repaint is one clean frame — swapping on bare onload flickers, because
// the browser still has to decode a 2010×2814 PNG at paint time.
function upgradeBg(el, url) {
  const img = new Image();
  img.src = url;
  const apply = () => { if (el.isConnected) el.style.backgroundImage = `url("${url}")`; };
  if (img.decode) img.decode().then(apply, () => {});   // rejected decode: keep the thumb
  else img.onload = apply;
}

// ---------- persistence ----------
function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      sets: [...state.activeSets],
      deck: state.deck, drawn: state.drawn, discard: state.discard,
      seq: state.drawSeq,
    }));
  } catch (e) { /* private mode etc. — the deck still works, it just forgets */ }
}
function restore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return false;
    const s = JSON.parse(raw);
    const known = n => state.byName[n];
    if (!Array.isArray(s.deck)) return false;
    state.activeSets = new Set((s.sets || ALL_SETS).filter(x => ALL_SETS.includes(x)));
    state.deck = s.deck.filter(known);
    state.drawn = (s.drawn || []).filter(known);
    state.discard = (s.discard || []).filter(known);
    state.drawSeq = Array.isArray(s.seq) && s.seq.length === state.drawn.length
      ? s.seq : state.drawn.map((_, i) => i + 1);
    // Stale saves (from before a card was renamed/added) may not cover the full
    // eligible pool — that's fine; "Forge new deck" rebuilds from scratch.
    return state.deck.length + state.drawn.length + state.discard.length > 0;
  } catch (e) { return false; }
}

// ---------- deck building ----------
// draw numbers run 1,2,3… while cards sit on the table and reset once it clears
function nextDrawNo() {
  return state.drawSeq.length ? Math.max(...state.drawSeq) + 1 : 1;
}

function eligible() {
  return Object.values(state.byName).filter(c =>
    state.activeSets.has(c.set) && !c.is_reference && !c.is_token);
}
function forgeNewDeck() {
  state.deck = shuffle(eligible().map(c => c.name), Math.random);
  state.drawn = [];
  state.drawSeq = [];
  state.discard = [];
  state.history = [];
  save();
  renderAll();
}

// ---------- rendering ----------
function renderCounts() {
  els.countDeck.textContent = state.deck.length;
  els.countDiscard.textContent = state.discard.length;
  els.dpCount.textContent = state.discard.length;
  els.deckStack.classList.toggle('empty', state.deck.length === 0);
  els.deckStack.classList.toggle('glow', state.deck.length > 0);
  els.deckStack.setAttribute('aria-label',
    state.deck.length ? 'Draw a card' : 'The Deck is spent — tap Restart to shuffle everything back in');
  els.discardPile.classList.toggle('has-cards', state.discard.length > 0);
  // phones collapse the pile to a corner chip that only exists once it holds cards
  els.discardPile.parentElement.classList.toggle('has-cards', state.discard.length > 0);
  els.dpCard.style.backgroundImage = state.discard.length
    ? `url("${thumbUrl(state.discard[0])}")` : 'none';
  // deck backs — thumb immediately, print-resolution once cached
  els.deckStack.querySelectorAll('.layer').forEach(l => {
    if (state.deck.length) {
      l.style.backgroundImage = `url("${CARD_BACK}")`;
      upgradeBg(l, CARD_BACK_FULL);
    } else {
      l.style.backgroundImage = 'none';
    }
  });
  // preload the next few faces so draws reveal instantly
  state.deck.slice(0, 4).forEach(n => { const i = new Image(); i.src = thumbUrl(n); });
}

// upgrade=false defers the hi-res swap (drawOne runs it after the card lands,
// so heavy decodes never repaint mid-flight or mid-scroll). no = the card's
// draw number, shown as a caption on tablet/desktop.
function makeDrawnCard(name, upgrade = true, no) {
  const b = document.createElement('button');
  b.className = 'drawn-card';
  b.dataset.name = name;
  if (no) b.dataset.no = no;
  b.setAttribute('aria-label', (no ? 'Draw ' + no + ': ' : '') + name + ' — tap to discard, hold to read');
  b.style.backgroundImage = `url("${thumbUrl(name)}")`;
  if (upgrade) upgradeBg(b, fullUrl(name));
  // tap = discard; long-press = zoom to read; a real swipe (pager scroll) is
  // neither — track movement so paging through drawn cards never discards one
  let pressTimer = null, longPressed = false, pressing = false, moved = false, sx = 0, sy = 0;
  b.addEventListener('pointerdown', e => {
    pressing = true; moved = false; longPressed = false;
    sx = e.clientX; sy = e.clientY;
    pressTimer = setTimeout(() => {
      longPressed = true;
      els.zoomImg.src = thumbUrl(name);           // instant
      const hi = new Image();                      // then print resolution
      hi.onload = () => { if (els.zoomOverlay.classList.contains('open')) els.zoomImg.src = hi.src; };
      hi.src = fullUrl(name);
      els.zoomOverlay.classList.add('open');
    }, 420);
  });
  b.addEventListener('pointermove', e => {
    if (!pressing || moved) return;
    if (Math.hypot(e.clientX - sx, e.clientY - sy) > 10) {
      moved = true;
      clearTimeout(pressTimer);
    }
  });
  const cancel = () => { pressing = false; clearTimeout(pressTimer); };
  b.addEventListener('pointerleave', cancel);
  b.addEventListener('pointercancel', cancel);
  b.addEventListener('pointerup', () => {
    const wasMoved = moved;
    cancel();
    if (!longPressed && !wasMoved) discardCard(b);
  });
  // keyboard: Enter/Space fire a click with detail 0 (no pointerup precedes it)
  b.addEventListener('click', e => { if (e.detail === 0) discardCard(b); });
  return b;
}

function renderDrawn() {
  els.drawnRow.querySelectorAll('.drawn-card').forEach(n => n.remove());
  state.drawn.forEach((name, i) => els.drawnRow.appendChild(makeDrawnCard(name, true, state.drawSeq[i])));
  els.drawnRow.classList.toggle('has-cards', state.drawn.length > 0);
  els.drawnHint.style.display = state.drawn.length ? 'none' : '';
  renderDots();
  // reading order: rest on the first drawn card, the oldest unresolved one
  const first = els.drawnRow.querySelector('.drawn-card');
  if (first) first.scrollIntoView({ block: 'nearest', inline: 'center' });
}

// pager position (portrait phones) — dots per drawn card plus edge arrows
function currentIndex() {
  const cards = els.drawnRow.querySelectorAll('.drawn-card');
  if (!cards.length) return -1;
  const mid = els.drawnRow.getBoundingClientRect().left + els.drawnRow.clientWidth / 2;
  let best = 0, bd = Infinity;
  cards.forEach((c, i) => {
    const d = Math.abs(c.getBoundingClientRect().left + c.offsetWidth / 2 - mid);
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}
function renderDots() {
  els.drawnDots.innerHTML = state.drawn.length > 1 ? '<i></i>'.repeat(state.drawn.length) : '';
  updateDots();
}
function updateDots() {
  const n = state.drawn.length;
  const cur = currentIndex();
  [...els.drawnDots.children].forEach((d, i) => d.classList.toggle('on', i === cur));
  els.pagerPrev.classList.toggle('show', n > 1 && cur > 0);
  els.pagerNext.classList.toggle('show', n > 1 && cur < n - 1);
  els.drawLabel.textContent = cur >= 0 ? 'Draw ' + (state.drawSeq[cur] || cur + 1) : '';
  els.drawLabel.classList.toggle('show', cur >= 0);
}
function pageBy(dir) {
  const cards = els.drawnRow.querySelectorAll('.drawn-card');
  if (!cards.length) return;
  const target = cards[Math.max(0, Math.min(cards.length - 1, currentIndex() + dir))];
  target.scrollIntoView({
    behavior: REDUCED_MOTION.matches ? 'auto' : 'smooth',
    block: 'nearest', inline: 'center',
  });
}

function renderDiscardSheet() {
  const n = state.discard.length;
  els.dsCount.textContent = n + (n === 1 ? ' card' : ' cards');
  els.discardEmpty.style.display = state.discard.length ? 'none' : '';
  els.discardGrid.innerHTML = state.discard.map(name =>
    `<div class="dg-item"><img src="${thumbUrl(name)}" alt="" loading="lazy">
     <div class="dg-name">${name.replace(/</g, '&lt;')}</div></div>`).join('');
}

function renderChips() {
  els.setChips.querySelectorAll('.set-chip').forEach(ch =>
    ch.classList.toggle('on', state.activeSets.has(ch.dataset.set)));
}

function renderAll() { renderCounts(); renderDrawn(); renderChips(); }

// ---------- animations ----------
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)');

// Fly a card between two rects, optionally flipping from back to face.
// A draw is the whole show: the card lifts off the deck in an arc, sheds gold
// sparks in flight, and erupts the moment the face turns over. Under
// prefers-reduced-motion the card simply appears in place (no particles).
function flyCard({ from, to, name, flip }, done) {
  if (REDUCED_MOTION.matches) { done && done(); return; }
  const fly = document.createElement('div');
  fly.className = 'fly';
  fly.style.cssText = `left:${from.left}px;top:${from.top}px;width:${from.width}px;height:${from.height}px`;
  const inner = document.createElement('div');
  inner.className = 'fly-inner';
  inner.innerHTML =
    `<div class="back" style="background-image:url('${CARD_BACK}')"></div>` +
    `<div class="face" style="background-image:url('${thumbUrl(name)}')"></div>`;
  if (!flip) inner.style.transform = 'rotateY(180deg)';  // already face-up
  fly.appendChild(inner);
  document.body.appendChild(fly);

  const dx = to.left - from.left, dy = to.top - from.top, s = to.width / from.width;
  const lift = flip ? Math.min(90, 40 + Math.hypot(dx, dy) * .12) : 20;
  const dur = flip ? 620 : 420;
  const move = fly.animate(
    [{ transform: 'translate(0,0) scale(1)' },
     { transform: `translate(${dx * .5}px,${dy * .5 - lift}px) scale(${(1 + s) / 2 * 1.05})`, offset: .55 },
     { transform: `translate(${dx}px,${dy}px) scale(${s})` }],
    { duration: dur, easing: 'cubic-bezier(.3,.7,.25,1)', fill: 'forwards' });

  let stopTrail = null;
  if (flip) {
    inner.animate(
      [{ transform: 'rotateY(0deg)' }, { transform: 'rotateY(180deg)' }],
      { duration: dur * .75, delay: dur * .2, easing: 'cubic-bezier(.45,.05,.3,1)', fill: 'forwards' });
    fx.burst(from.left + from.width / 2, from.top + from.height / 2, from.width);
    stopTrail = fx.follow(fly);
    setTimeout(() => {                             // the face turns over about now
      const r = fly.getBoundingClientRect();
      fx.reveal(r.left + r.width / 2, r.top + r.height / 2, r.width);
      if (navigator.vibrate) navigator.vibrate(12);
    }, dur * .55);
  }
  move.onfinish = () => {
    if (stopTrail) stopTrail();
    fly.remove();
    done && done();
  };
}

function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.remove('show'), 1900);
}

// ---------- actions ----------
// follow=true centers the pager on the incoming card. In a multi-draw only the
// FIRST card gets it: it stays put over the deck (cards resolve in draw order)
// while the rest visibly tuck away to the side, one arrow-tap or swipe away.
function drawOne(done, follow = true) {
  if (!state.deck.length) {
    els.deckStack.classList.add('shaking');
    setTimeout(() => els.deckStack.classList.remove('shaking'), 500);
    toast('The Deck is spent — tap Restart to shuffle everything back in.');
    done && done(false);
    return;
  }
  const name = state.deck.shift();
  state.drawn.push(name);
  state.drawSeq.push(nextDrawNo());
  state.history.push({ type: 'draw', name });

  // placeholder slot so the row lays out its final geometry first
  const slot = makeDrawnCard(name, false, state.drawSeq[state.drawSeq.length - 1]);
  slot.style.visibility = 'hidden';
  els.drawnRow.appendChild(slot);
  els.drawnRow.classList.add('has-cards');
  els.drawnHint.style.display = 'none';
  renderDots();
  if (follow) slot.scrollIntoView({ block: 'nearest', inline: 'center' });

  flyCard({
    from: els.deckStack.getBoundingClientRect(),
    to: slot.getBoundingClientRect(),
    name, flip: true,
  }, () => {
    slot.style.visibility = '';
    upgradeBg(slot, fullUrl(name));   // hi-res only after landing — no mid-flight repaints
    updateDots();
    done && done(true);
  });
  renderCounts();
  save();
}

function draw(n) {
  if (state.busy) return;
  state.busy = true;
  let i = 0;
  const step = ok => {
    if (ok === false || ++i >= n) { state.busy = false; return; }
    setTimeout(() => drawOne(step, false), 90);   // later cards land to the side
  };
  drawOne(step, true);
}

function discardCard(cardEl) {
  if (state.busy) return;
  const name = cardEl.dataset.name;
  const idx = state.drawn.indexOf(name);
  if (idx === -1) return;
  state.busy = true;
  state.drawn.splice(idx, 1);
  const [no] = state.drawSeq.splice(idx, 1);
  state.history.push({ type: 'discard', name, idx, no });   // idx+no: undo restores draw order

  const from = cardEl.getBoundingClientRect();
  cardEl.remove();
  els.drawnRow.classList.toggle('has-cards', state.drawn.length > 0);
  els.drawnHint.style.display = state.drawn.length ? 'none' : '';
  renderDots();
  // count the card into the pile first so the corner chip (hidden while the
  // discard is empty on phones) exists and gives the animation a real target
  state.discard.unshift(name);
  renderCounts();
  flyCard({
    from,
    to: els.discardPile.getBoundingClientRect(),
    name, flip: false,
  }, () => {
    els.dpCount.classList.add('pulse');   // the pile visibly receives the card
    els.dpCount.addEventListener('animationend', () => els.dpCount.classList.remove('pulse'), { once: true });
    save();
    state.busy = false;
  });
}

function doShuffle(includeDiscard) {
  if (state.busy) return;
  if (includeDiscard) {
    // sweep the table: discard AND drawn cards return to the deck
    state.deck = state.deck.concat(state.discard, state.drawn);
    state.discard = [];
    state.drawn = [];
    state.drawSeq = [];
    state.history = [];
  }
  state.deck = shuffle(state.deck, Math.random);
  els.deckStack.classList.add('shaking');
  setTimeout(() => els.deckStack.classList.remove('shaking'), 500);
  renderAll();
  save();
  toast(includeDiscard ? 'All cards returned — the Deck is whole again.' : 'The remaining cards are shuffled.');
}

function undo() {
  if (state.busy) return;
  const last = state.history.pop();
  if (!last) { toast('Nothing to undo.'); return; }
  if (last.type === 'draw') {
    const i = state.drawn.lastIndexOf(last.name);
    if (i !== -1) {
      state.drawn.splice(i, 1);
      state.drawSeq.splice(i, 1);
      state.deck.unshift(last.name);
      toast(last.name + ' returns to the top of the Deck.');
    }
  } else {
    const i = state.discard.indexOf(last.name);
    if (i !== -1) {
      state.discard.splice(i, 1);
      const at = Math.min(last.idx ?? state.drawn.length, state.drawn.length);
      state.drawn.splice(at, 0, last.name);
      state.drawSeq.splice(at, 0, last.no ?? nextDrawNo());
      toast(last.name + ' returns from the discard.');
    }
  }
  renderAll();
  save();
}

// ---------- sheets ----------
function openSheet(sheet) {
  if (sheet === els.discardSheet) renderDiscardSheet();
  els.sheetBackdrop.classList.add('open');
  sheet.classList.add('open');
}
function closeSheets() {
  els.sheetBackdrop.classList.remove('open');
  document.querySelectorAll('.sheet.open').forEach(s => s.classList.remove('open'));
}

// ---------- wake lock ----------
let wakeLock = null;
async function acquireWakeLock() {
  try {
    if (!('wakeLock' in navigator)) return;
    wakeLock = await navigator.wakeLock.request('screen');
    els.wakeDot.classList.add('on');
    wakeLock.addEventListener('release', () => els.wakeDot.classList.remove('on'));
  } catch (e) { /* denied (battery saver etc.) — non-fatal */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') acquireWakeLock();
});

// ---------- init ----------
async function init() {
  const resp = await fetch(projectUrl('data/cards.json') + '?' + Date.now());
  const data = await resp.json();
  const cards = Array.isArray(data) ? data : data.cards;
  cards.forEach(c => { state.byName[c.name] = c; });

  // ?sets=oehw overrides any saved state and forges fresh
  const params = new URLSearchParams(location.search);
  let forcedSets = null;
  if (params.has('sets')) {
    const parsed = new Set([...(params.get('sets') || '').toLowerCase()]
      .map(ch => SET_INITIALS[ch]).filter(Boolean));
    if (parsed.size) forcedSets = parsed;
  }

  if (forcedSets) {
    state.activeSets = forcedSets;
    forgeNewDeck();
  } else if (!restore()) {
    forgeNewDeck();
  } else {
    renderAll();
  }

  // wire controls
  els.deckStack.addEventListener('click', () => draw(1));
  document.querySelectorAll('[data-draw]').forEach(b =>
    b.addEventListener('click', () => draw(parseInt(b.dataset.draw, 10))));
  els.btnShuffle.addEventListener('click', () => doShuffle(false));
  els.btnShuffleAll.addEventListener('click', () => doShuffle(true));
  els.btnUndo.addEventListener('click', undo);
  els.btnMenu.addEventListener('click', () => openSheet(els.menuSheet));
  els.discardPile.addEventListener('click', () => openSheet(els.discardSheet));
  els.sheetBackdrop.addEventListener('click', closeSheets);
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeSheets));
  els.setChips.querySelectorAll('.set-chip').forEach(ch =>
    ch.addEventListener('click', () => {
      const s = ch.dataset.set;
      if (state.activeSets.has(s)) {
        if (state.activeSets.size === 1) { toast('At least one sub-deck must remain.'); return; }
        state.activeSets.delete(s);
      } else {
        state.activeSets.add(s);
      }
      renderChips();
    }));
  els.btnNewDeck.addEventListener('click', () => {
    forgeNewDeck();
    closeSheets();
    toast('A new Deck is forged — ' + state.deck.length + ' cards.');
  });
  els.zoomOverlay.addEventListener('click', () => els.zoomOverlay.classList.remove('open'));

  // pager arrows step one card per tap
  els.pagerPrev.addEventListener('click', () => pageBy(-1));
  els.pagerNext.addEventListener('click', () => pageBy(1));

  // keep the pager dots and arrows tracking the swiped-to card
  let dotTick = false;
  els.drawnRow.addEventListener('scroll', () => {
    if (dotTick) return;
    dotTick = true;
    requestAnimationFrame(() => { dotTick = false; updateDots(); });
  }, { passive: true });

  // fullscreen immersion — Android/desktop; iOS via Add to Home Screen
  // (the manifest + apple metas make that launch truly fullscreen)
  const fsBtn = $('btn-fullscreen');
  if (document.documentElement.requestFullscreen) {
    fsBtn.addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
    });
    document.addEventListener('fullscreenchange', () =>
      fsBtn.classList.toggle('active', !!document.fullscreenElement));
    // fullscreen by default: browsers demand a user gesture, so the first tap
    // supplies it. One shot — if the player backs out, we don't fight them.
    if (!matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches) {
      const autoFS = e => {
        if (e.target.closest('.fs-btn')) return;   // the toggle owns its own tap
        document.removeEventListener('click', autoFS, true);
        if (!document.fullscreenElement)
          document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
      };
      document.addEventListener('click', autoFS, true);
    }
  } else {
    fsBtn.style.display = 'none';   // iOS Safari: no element fullscreen API
  }

  acquireWakeLock();
}

init();
