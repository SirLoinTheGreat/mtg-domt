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
const ALL_SETS = ['original', 'expansion', 'harrow', 'wonder', 'fates'];
const STORE_KEY = 'domt-deck-v1';
const SET_INITIALS = { o: 'original', e: 'expansion', h: 'harrow', w: 'wonder', f: 'fates' };

// Cards whose own text removes them from the game ("Exile The Fool.") —
// detected from cards.json at load, so future self-exiling cards just work.
const SELF_EXILE = new Set();

const state = {
  byName: {},               // name -> card
  activeSets: new Set(ALL_SETS),
  deck: [],                 // names, index 0 = top
  drawn: [],                // names face-up on the table
  drawSeq: [],              // parallel to drawn: each card's draw number this spread
  discard: [],              // names, index 0 = most recent
  exiled: [],               // names out of the game — only Restart returns them
  history: [],              // {type:'draw'|'discard', name} — for undo
  busy: false,              // animation gate
};

const $ = id => document.getElementById(id);
const els = {};
['deck-stack', 'discard-pile', 'dp-card', 'dp-count', 'drawn-row', 'drawn-hint', 'drawn-dots',
 'count-deck', 'count-discard', 'wake-dot', 'sheet-backdrop', 'discard-sheet',
 'menu-sheet', 'discard-grid', 'discard-empty', 'ds-count', 'set-chips',
 'exile-group', 'exile-grid',
 'za-deck', 'za-exile', 'peek-sheet', 'peek-row', 'peek-n', 'peek-apply', 'peek-reset',
 'peek-less', 'peek-more', 'btn-peek', 'btn-mute',
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
// stable per-card angle in [-max,max] degrees — cards placed by a hand rest
// slightly askew, and the same card always rests at the same angle (so
// re-renders never make the table twitch)
function jitter(name, max) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
  return (h / 0xffff * 2 - 1) * max;
}

// ---------- persistence ----------
function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      sets: [...state.activeSets],
      deck: state.deck, drawn: state.drawn, discard: state.discard,
      seq: state.drawSeq, ex: state.exiled,
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
    state.exiled = (s.ex || []).filter(known);
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
  state.exiled = [];
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
  // phones collapse the pile to a corner chip that only exists once it holds
  // cards — exiled cards count too, so the browser stays reachable
  els.discardPile.parentElement.classList.toggle('has-cards', state.discard.length + state.exiled.length > 0);
  els.dpCard.style.backgroundImage = state.discard.length
    ? `url("${thumbUrl(state.discard[0])}")` : 'none';
  els.dpCard.style.transform = state.discard.length
    ? `rotate(${jitter(state.discard[0], 4).toFixed(2)}deg)` : '';
  // the stack visibly thins as it's spent
  els.deckStack.classList.toggle('low', state.deck.length > 0 && state.deck.length <= 40);
  els.deckStack.classList.toggle('last', state.deck.length > 0 && state.deck.length <= 12);
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

// tap vs hold vs swipe discrimination, shared by drawn cards and peek cards.
// A real swipe (pager/row scroll) is neither tap nor hold — track movement so
// scrolling never triggers the tap action.
function pressable(el, { onTap, onHold }) {
  let timer = null, held = false, pressing = false, moved = false, sx = 0, sy = 0;
  el.addEventListener('pointerdown', e => {
    pressing = true; moved = false; held = false;
    sx = e.clientX; sy = e.clientY;
    timer = setTimeout(() => { held = true; onHold(); }, 420);
  });
  el.addEventListener('pointermove', e => {
    if (!pressing || moved) return;
    if (Math.hypot(e.clientX - sx, e.clientY - sy) > 10) { moved = true; clearTimeout(timer); }
  });
  const cancel = () => { pressing = false; clearTimeout(timer); };
  el.addEventListener('pointerleave', cancel);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('pointerup', () => {
    const wasMoved = moved;
    cancel();
    if (!held && !wasMoved) onTap();
  });
  // keyboard: Enter/Space fire a click with detail 0 (no pointerup precedes it)
  el.addEventListener('click', e => { if (e.detail === 0) onTap(); });
}

// card zoom — read the card, and act on it (into the Deck / exile).
// zone = where the card currently lives: 'drawn' | 'discard' | 'exiled' | 'deck'
let zoomCtx = null;
function openZoom(name, zone) {
  zoomCtx = { name, zone };
  els.zoomImg.src = thumbUrl(name);              // instant
  const hi = new Image();                        // then print resolution
  hi.onload = () => { if (els.zoomOverlay.classList.contains('open')) els.zoomImg.src = hi.src; };
  hi.src = fullUrl(name);
  els.zaExile.hidden = zone === 'exiled';
  els.zoomOverlay.classList.add('open');
}
function closeZoom() {
  zoomCtx = null;
  els.zoomOverlay.classList.remove('open');
}

// upgrade=false defers the hi-res swap (drawOne runs it after the card lands,
// so heavy decodes never repaint mid-flight or mid-scroll). no = the card's
// draw number, shown as a caption on tablet/desktop.
function makeDrawnCard(name, upgrade = true, no) {
  const b = document.createElement('button');
  b.className = 'drawn-card';
  b.dataset.name = name;
  b.style.setProperty('--tilt', jitter(name, 1.6).toFixed(2) + 'deg');
  if (no) b.dataset.no = no;
  b.setAttribute('aria-label', (no ? 'Draw ' + no + ': ' : '') + name + ' — tap to discard, hold to read');
  b.style.backgroundImage = `url("${thumbUrl(name)}")`;
  if (upgrade) upgradeBg(b, fullUrl(name));
  pressable(b, {
    onTap: () => discardCard(b),
    onHold: () => openZoom(name, 'drawn'),
  });
  hoverSfx(b);
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

function gridItem(name) {
  return `<div class="dg-item" data-name="${name.replace(/"/g, '&quot;')}" role="button" tabindex="0">
     <img src="${thumbUrl(name)}" alt="" loading="lazy">
     <div class="dg-name">${name.replace(/</g, '&lt;')}</div></div>`;
}
function renderDiscardSheet() {
  const n = state.discard.length;
  els.dsCount.textContent = n + (n === 1 ? ' card' : ' cards');
  els.discardEmpty.style.display = state.discard.length ? 'none' : '';
  els.discardGrid.innerHTML = state.discard.map(gridItem).join('');
  els.exileGroup.hidden = !state.exiled.length;
  els.exileGrid.innerHTML = state.exiled.map(gridItem).join('');
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
function flyCard({ from, to, name, flip, rot = 0 }, done) {
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
    [{ transform: 'translate(0,0) scale(1) rotate(0deg)' },
     { transform: `translate(${dx * .5}px,${dy * .5 - lift}px) scale(${(1 + s) / 2 * 1.05}) rotate(${rot * .5}deg)`, offset: .55 },
     { transform: `translate(${dx}px,${dy}px) scale(${s}) rotate(${rot}deg)` }],
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
// follow=true centers the pager on the incoming card. Only the first card of a
// FRESH spread gets it (empty table): it stays put over the deck while every
// later card — same batch or stacked extra clicks — tucks away to the side,
// one arrow-tap or swipe away, without yanking the view around.
// nth = position within a multi-draw: sounds rotate draw1→draw2→draw3→draw1…
function drawOne(done, follow = true, nth = 0) {
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
  playSfx('draw' + (nth % 3 + 1));

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
    name, flip: true, rot: jitter(name, 1.6),   // land at the card's resting tilt
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
  const fresh = state.drawn.length === 0;   // drawing onto cards? don't move the view
  let i = 0;
  const step = ok => {
    if (ok === false || ++i >= n) { state.busy = false; return; }
    setTimeout(() => drawOne(step, false, i), 90);   // later cards land to the side
  };
  drawOne(step, fresh, 0);
}

// Exile: the card burns out in place instead of flying to the pile — it is
// leaving the game, not resting in the discard.
function dissolveCard(from, name, done) {
  if (REDUCED_MOTION.matches) { done && done(); return; }
  const el = document.createElement('div');
  el.className = 'fly';
  el.style.cssText = `left:${from.left}px;top:${from.top}px;width:${from.width}px;height:${from.height}px`;
  el.innerHTML = `<div class="face" style="transform:none;background-image:url('${thumbUrl(name)}')"></div>`;
  document.body.appendChild(el);
  fx.burst(from.left + from.width / 2, from.top + from.height / 2, from.width);
  const a = el.animate(
    [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.86)' }],
    { duration: 480, easing: 'cubic-bezier(.4,0,.6,1)', fill: 'forwards' });
  a.onfinish = () => { el.remove(); done && done(); };
}

function discardCard(cardEl) {
  if (state.busy) return;
  const name = cardEl.dataset.name;
  const idx = state.drawn.indexOf(name);
  if (idx === -1) return;
  state.busy = true;
  state.drawn.splice(idx, 1);
  const [no] = state.drawSeq.splice(idx, 1);
  const exiling = SELF_EXILE.has(name);   // "Exile The Fool." — it never returns
  state.history.push({ type: exiling ? 'exile' : 'discard', name, idx, no });

  const from = cardEl.getBoundingClientRect();
  cardEl.remove();
  els.drawnRow.classList.toggle('has-cards', state.drawn.length > 0);
  els.drawnHint.style.display = state.drawn.length ? 'none' : '';
  renderDots();

  if (exiling) {
    state.exiled.unshift(name);
    renderCounts();
    playSfx('exile');
    toast(name + ' is exiled — it leaves the game.');
    dissolveCard(from, name, () => { save(); state.busy = false; });
    return;
  }
  // count the card into the pile first so the corner chip (hidden while the
  // discard is empty on phones) exists and gives the animation a real target
  state.discard.unshift(name);
  renderCounts();
  playSfx('discard');
  flyCard({
    from,
    to: els.discardPile.getBoundingClientRect(),
    name, flip: false, rot: jitter(name, 4),   // tossed onto the pile, lands askew
  }, () => {
    els.dpCount.classList.add('pulse');   // the pile visibly receives the card
    els.dpCount.addEventListener('animationend', () => els.dpCount.classList.remove('pulse'), { once: true });
    save();
    state.busy = false;
  });
}

// Move a card between zones: from 'drawn'|'discard'|'exiled'|'deck' to
// 'deck' (shuffled in) or 'exiled'. prevDeck snapshots the deck for undo,
// since a shuffle can't be reversed any other way.
function moveCard(name, from, to) {
  if (state.busy) return false;
  const entry = { type: 'move', name, from, to, prevDeck: [...state.deck] };
  if (from === 'drawn') {
    const i = state.drawn.indexOf(name);
    if (i === -1) return false;
    entry.idx = i;
    entry.no = state.drawSeq[i];
    state.drawn.splice(i, 1);
    state.drawSeq.splice(i, 1);
  } else if (from === 'discard' || from === 'exiled') {
    const zone = from === 'discard' ? state.discard : state.exiled;
    const i = zone.indexOf(name);
    if (i === -1) return false;
    entry.idx = i;
    zone.splice(i, 1);
  } else if (from === 'deck') {
    const i = state.deck.indexOf(name);
    if (i === -1) return false;
    state.deck.splice(i, 1);
  }
  if (to === 'deck') {
    state.deck.push(name);
    state.deck = shuffle(state.deck, Math.random);
    shuffleAnim();
  } else if (to === 'exiled') {
    state.exiled.unshift(name);
  }
  state.history.push(entry);
  renderAll();
  save();
  return true;
}

// Shuffle: a real riffle worked by an unseen hand — and the Deck's own magic.
// It lifts off the table inside an arcane aura, splits into two packets, cards
// flick one-by-one from alternating packets into the middle (each snap shedding
// gold and nether glints), the packets square up, and the deck settles back
// down. ~1.3s. The real layers hide while the overlay performs.
function shuffleAnim(done) {
  if (REDUCED_MOTION.matches) { done && done(); return; }
  const stack = els.deckStack;
  const r = stack.getBoundingClientRect();
  stack.classList.add('riffling');
  const holder = document.createElement('div');
  holder.className = 'riffle';
  holder.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
  const aura = document.createElement('div');   // first child — paints behind the cards
  aura.className = 'aura';
  holder.appendChild(aura);
  const mk = () => {
    const d = document.createElement('div');
    d.className = 'rf';
    d.style.backgroundImage = `url("${CARD_BACK}")`;
    holder.appendChild(d);
    return d;
  };
  const halves = [mk(), mk()];
  document.body.appendChild(holder);

  // lift and shrink enough that both packets fit on screen at any card size
  // (the phone hero card is 88vw — shuffled full-size it would spill off both edges)
  const scale = Math.min(.72, (innerWidth - 24) / (2.3 * r.width));
  const EASE = 'cubic-bezier(.25,1,.5,1)';
  const splitT = dir => `translateX(${dir * 55}%) rotate(${dir * 7}deg)`;
  holder.animate(
    [{ transform: 'translateY(0) scale(1)' },
     { transform: `translateY(-4%) scale(${scale})` }],
    { duration: 170, easing: EASE, fill: 'forwards' });
  halves.forEach((el, i) => el.animate(
    [{ transform: 'none' }, { transform: splitT(i ? 1 : -1) }],
    { duration: 190, delay: 170, easing: EASE, fill: 'forwards' }));

  // the interleave — each card waits on its packet (backwards fill), flicks in
  // and kicks up a pinch of gold and nether light as it snaps home
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2 - r.height * .04;
  const N = 12;
  for (let i = 0; i < N; i++) {
    const dir = i % 2 ? 1 : -1;
    mk().animate(
      [{ transform: splitT(dir) },
       { transform: `translateX(0) rotate(${(Math.random() * 4 - 2).toFixed(1)}deg)` }],
      { duration: 150, delay: 380 + i * 34, easing: 'cubic-bezier(.3,.7,.3,1)', fill: 'both' });
    setTimeout(() => fx.flick(cx, cy, r.width * scale), 380 + i * 34 + 130);
  }
  const riffleEnd = 380 + N * 34 + 150;
  // the aura breathes in while the Deck is airborne, out as it settles
  aura.animate(
    [{ opacity: 0 }, { opacity: 1, offset: .22 }, { opacity: .85, offset: .78 }, { opacity: 0 }],
    { duration: riffleEnd + 350, easing: 'ease-in-out', fill: 'forwards' });

  // square up (packets slide back UNDER the merged pile), put the deck down
  halves.forEach((el, i) => el.animate(
    [{ transform: splitT(i ? 1 : -1) }, { transform: 'none' }],
    { duration: 170, delay: riffleEnd - 30, easing: EASE, fill: 'forwards' }));
  holder.animate(
    [{ transform: `translateY(-4%) scale(${scale})` }, { transform: 'translateY(0) scale(1)' }],
    { duration: 200, delay: riffleEnd + 150, easing: EASE, fill: 'forwards' })
    .onfinish = () => {
      holder.remove();
      stack.classList.remove('riffling');
      stack.animate([{ transform: 'scale(.965)' }, { transform: 'scale(1)' }],
        { duration: 180, easing: 'ease-out' });
      if (navigator.vibrate) navigator.vibrate([8, 60, 8]);
      done && done();
    };
}

// Restart ceremony, act one: the Deck calls its cards home. Every card flips
// face-down and flies to the stack — drawn cards from their real positions, the
// discard pile as a quick packet, exiled cards returning from beyond the
// table's edge — each landing slightly askew, piling up the way a hand squares
// cards, while the nether opens beneath them: a blue-violet storm of motes
// spiraling into the stack. Reduced motion skips straight to the result.
function restartGather(done) {
  if (REDUCED_MOTION.matches) { done(); return; }
  const deckRect = els.deckStack.getBoundingClientRect();

  const sources = [];
  els.drawnRow.querySelectorAll('.drawn-card').forEach(el =>
    sources.push({ r: el.getBoundingClientRect(), name: el.dataset.name }));
  if (state.discard.length) {
    const dp = els.discardPile.getBoundingClientRect();
    for (let i = 0; i < Math.min(3, state.discard.length); i++) sources.push({ r: dp });
  }
  for (let i = 0; i < Math.min(2, state.exiled.length); i++) {
    const w = deckRect.width * .8, h = w * 1.4;
    sources.push({ r: { left: i % 2 ? innerWidth + 20 : -w - 20,
      top: innerHeight * (.25 + Math.random() * .4), width: w, height: h } });
  }
  if (!sources.length) { done(); return; }   // nothing on the table — straight to the riffle

  const app = document.querySelector('.app');
  app.classList.add('vortexing');
  const stag = Math.min(80, 600 / sources.length);
  const DUR = 430;
  const total = (sources.length - 1) * stag + DUR + 120;
  fx.vortex(deckRect.left + deckRect.width / 2, deckRect.top + deckRect.height / 2,
    total, Math.hypot(innerWidth, innerHeight) / 2.1);
  const flyers = [];
  sources.forEach((s, i) => {
    const { r } = s;
    const fly = document.createElement('div');
    fly.className = 'fly';
    fly.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
    const inner = document.createElement('div');
    inner.className = 'fly-inner';
    inner.innerHTML = `<div class="back" style="background-image:url('${CARD_BACK}')"></div>` +
      (s.name ? `<div class="face" style="background-image:url('${thumbUrl(s.name)}')"></div>` : '');
    if (s.name) inner.style.transform = 'rotateY(180deg)';   // currently face up
    fly.appendChild(inner);
    document.body.appendChild(fly);
    flyers.push(fly);

    const dx = deckRect.left - r.left, dy = deckRect.top - r.top;
    const sc = deckRect.width / r.width;
    const delay = i * stag;
    const rot = Math.random() * 8 - 4;   // lands askew on the growing pile
    fly.animate(
      [{ transform: 'translate(0,0) scale(1) rotate(0deg)' },
       { transform: `translate(${dx * .5}px,${dy * .5 - 36}px) scale(${(1 + sc) / 2}) rotate(${rot * .5}deg)`, offset: .5 },
       { transform: `translate(${dx}px,${dy}px) scale(${sc}) rotate(${rot}deg)` }],
      { duration: DUR, delay, easing: 'cubic-bezier(.3,.7,.25,1)', fill: 'forwards' });
    if (s.name) inner.animate(               // flip face-down in flight
      [{ transform: 'rotateY(180deg)' }, { transform: 'rotateY(360deg)' }],
      { duration: DUR * .7, delay, easing: 'cubic-bezier(.45,.05,.3,1)', fill: 'forwards' });
    if (i % 3 === 0) {                       // a little gold dust in the wake
      const stop = fx.follow(fly);
      setTimeout(stop, delay + DUR);
    }
  });

  setTimeout(() => {
    flyers.forEach(f => f.remove());
    app.classList.remove('vortexing');
    if (navigator.vibrate) navigator.vibrate(20);
    done();
  }, total);
}

function doShuffle(includeDiscard) {
  if (state.busy) return;
  if (!includeDiscard && !state.deck.length) {
    els.deckStack.classList.add('shaking');
    setTimeout(() => els.deckStack.classList.remove('shaking'), 500);
    toast('The Deck is spent — Restart shuffles everything back in.');
    return;
  }
  state.busy = true;
  if (includeDiscard) {
    playSfx('restart');
    restartGather(() => {
      // sweep the table: discard, drawn, AND exiled cards return to the deck
      state.deck = state.deck.concat(state.discard, state.drawn, state.exiled);
      state.discard = [];
      state.drawn = [];
      state.drawSeq = [];
      state.exiled = [];
      state.history = [];
      state.deck = shuffle(state.deck, Math.random);
      renderAll();
      save();
      // act two: the whole deck riffles, then seals — gold burst wrapped
      // in a ring of nether light
      shuffleAnim(() => {
        if (!REDUCED_MOTION.matches) {
          const r = els.deckStack.getBoundingClientRect();
          fx.seal(r.left + r.width / 2, r.top + r.height / 2, r.width * .8);
        }
        state.busy = false;
        toast('All cards returned — the Deck is whole again.');
      });
    });
    return;
  }
  state.deck = shuffle(state.deck, Math.random);
  playSfx('shuffle');
  renderAll();
  save();
  shuffleAnim(() => {
    state.busy = false;
    toast('The remaining cards are shuffled.');
  });
}

function undo() {
  if (state.busy) return;
  const last = state.history.pop();
  if (!last) { toast('Nothing to undo.'); return; }
  playSfx('undo');
  if (last.type === 'draw') {
    const i = state.drawn.lastIndexOf(last.name);
    if (i !== -1) {
      state.drawn.splice(i, 1);
      state.drawSeq.splice(i, 1);
      state.deck.unshift(last.name);
      toast(last.name + ' returns to the top of the Deck.');
    }
  } else if (last.type === 'move') {
    if (last.to === 'exiled') {
      const i = state.exiled.indexOf(last.name);
      if (i !== -1) state.exiled.splice(i, 1);
    }
    state.deck = last.prevDeck;              // deck exactly as before the move
    if (last.from === 'drawn') {
      const at = Math.min(last.idx, state.drawn.length);
      state.drawn.splice(at, 0, last.name);
      state.drawSeq.splice(at, 0, last.no ?? nextDrawNo());
    } else if (last.from === 'discard') {
      state.discard.splice(Math.min(last.idx, state.discard.length), 0, last.name);
    } else if (last.from === 'exiled') {
      state.exiled.splice(Math.min(last.idx, state.exiled.length), 0, last.name);
    } // from 'deck': restoring prevDeck already put it back
    toast(last.name + ' returns.');
  } else if (last.type === 'peekOrder') {
    state.deck = last.prevDeck;
    toast('The top of the Deck is restored.');
  } else {
    const zone = last.type === 'exile' ? state.exiled : state.discard;
    const i = zone.indexOf(last.name);
    if (i !== -1) {
      zone.splice(i, 1);
      const at = Math.min(last.idx ?? state.drawn.length, state.drawn.length);
      state.drawn.splice(at, 0, last.name);
      state.drawSeq.splice(at, 0, last.no ?? nextDrawNo());
      toast(last.name + (last.type === 'exile' ? ' returns from exile.' : ' returns from the discard.'));
    }
  }
  renderAll();
  save();
}

// ---------- peek: look at the top of the Deck ----------
// For The Locksmith / The Fates / The Unicorn — with printed cards you'd just
// pick them up. Tap the cards in the desired new order, Apply sets the top.
const peek = { n: 3, order: [] };   // order = names tapped, first tap = new top

function renderPeek() {
  els.peekApply.disabled = true;
  if (!state.deck.length) {
    els.peekN.textContent = '0 cards';
    els.peekRow.innerHTML = '<div class="discard-empty">The Deck is spent.</div>';
    return;
  }
  peek.n = Math.max(1, Math.min(peek.n, 9, state.deck.length));
  const top = state.deck.slice(0, peek.n);
  peek.order = peek.order.filter(n => top.includes(n));
  els.peekN.textContent = peek.n + (peek.n === 1 ? ' card' : ' cards');
  els.peekRow.innerHTML = '';
  top.forEach((name, i) => {
    const b = document.createElement('button');
    const picked = peek.order.indexOf(name);
    b.className = 'peek-card' + (picked !== -1 ? ' picked' : '');
    b.dataset.name = name;
    b.setAttribute('aria-label', name + ' — position ' + (i + 1) + ' from the top');
    b.style.backgroundImage = `url("${thumbUrl(name)}")`;
    b.innerHTML = `<span class="pk-pos">${i + 1}</span>` +
      (picked !== -1 ? `<span class="pk-new">${picked + 1}</span>` : '');
    pressable(b, {
      onTap: () => {
        const j = peek.order.indexOf(name);
        if (j === -1) peek.order.push(name); else peek.order.splice(j, 1);
        renderPeek();
      },
      onHold: () => openZoom(name, 'deck'),
    });
    hoverSfx(b);
    els.peekRow.appendChild(b);
  });
  els.peekApply.disabled = peek.order.length !== peek.n;
}

// ---------- sound (Howler, vendored) ----------
// Real CC0 recordings in assets/sfx/. Howler handles the mobile audio unlock
// on first gesture. The draw flick is timed so its snap sits near the reveal.
const SOUND_KEY = 'domt-deck-sound';
let soundOn = localStorage.getItem(SOUND_KEY) !== 'off';
const sfx = {};
if (window.Howl) {
  const VOL = { draw1: 0.7, draw2: 0.7, draw3: 0.7, undo: 0.5, shuffle: 0.6, restart: 0.65,
                hover: 0.28, unhover: 0.24, click: 0.5, intodeck: 0.65, exile: 0.65, discard: 0.6 };
  Object.keys(VOL).forEach(n => {
    sfx[n] = new Howl({ src: [projectUrl('assets/sfx/' + n + '.mp3')], volume: VOL[n] });
  });
}
function playSfx(name) {
  if (soundOn && sfx[name]) sfx[name].play();
}
// hover in/out sounds for card-like elements — gated on the event's actual
// pointer type, so a mouse whispers and a finger stays silent (on touch,
// pointerenter fires on tap and would double every tap with noise)
function hoverSfx(el) {
  el.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') playSfx('hover'); });
  el.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') playSfx('unhover'); });
}

// ---------- two-tap confirm ----------
// First tap arms the button (label turns red "Confirm?"), second tap within
// 3s executes. Width locks while armed so the bar can't shift mid-gesture.
let disarmCurrent = null;
function armable(btn, label, action) {
  let timer = null, armed = false;
  const disarm = () => {
    clearTimeout(timer);
    armed = false;
    btn.classList.remove('armed');
    btn.textContent = label;
    btn.style.minWidth = '';
    if (disarmCurrent === disarm) disarmCurrent = null;
  };
  btn.addEventListener('click', () => {
    if (armed) { disarm(); action(); return; }
    if (disarmCurrent) disarmCurrent();
    disarmCurrent = disarm;
    armed = true;
    btn.style.minWidth = btn.offsetWidth + 'px';
    btn.classList.add('armed');
    btn.textContent = 'Confirm?';
    timer = setTimeout(disarm, 3000);
  });
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
  cards.forEach(c => {
    state.byName[c.name] = c;
    if ((c.rules_text || '').includes('Exile ' + c.name)) SELF_EXILE.add(c.name);
  });

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

  // every chrome button clicks — the cards keep their own foley instead
  // (mute is excluded here: its handler plays the click outside the mute gate)
  document.addEventListener('click', e => {
    const btn = e.target.closest('.ctl, .fs-btn, .sheet-close, .set-chip');
    if (btn && btn.id !== 'btn-mute') playSfx('click');
  }, true);

  // wire controls
  hoverSfx(els.deckStack);
  hoverSfx(els.discardPile);
  els.deckStack.addEventListener('click', () => draw(1));
  document.querySelectorAll('[data-draw]').forEach(b =>
    b.addEventListener('click', () => draw(parseInt(b.dataset.draw, 10))));
  armable(els.btnShuffle, 'Shuffle', () => doShuffle(false));
  armable(els.btnShuffleAll, 'Restart', () => doShuffle(true));

  // mute toggle — persisted; Howler unlocks audio on the first gesture
  const syncMute = () => {
    els.btnMute.classList.toggle('muted', !soundOn);
    els.btnMute.setAttribute('aria-pressed', String(!soundOn));
    const label = soundOn ? 'Mute sound effects' : 'Unmute sound effects';
    els.btnMute.setAttribute('aria-label', label);
    els.btnMute.title = label;
  };
  syncMute();
  els.btnMute.addEventListener('click', () => {
    soundOn = !soundOn;
    localStorage.setItem(SOUND_KEY, soundOn ? 'on' : 'off');
    syncMute();
    // the mute control's own click plays BOTH ways — deliberately outside the
    // soundOn gate, so muting still gives one last audible acknowledgment
    if (sfx.click) sfx.click.play();
  });
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
  els.zoomOverlay.addEventListener('click', closeZoom);

  // zoom actions — send the zoomed card into the Deck (shuffled) or to exile
  const refreshOpenSheets = () => {
    if (els.discardSheet.classList.contains('open')) renderDiscardSheet();
    if (els.peekSheet.classList.contains('open')) renderPeek();
  };
  els.zaDeck.addEventListener('click', e => {
    e.stopPropagation();
    if (!zoomCtx) return;
    const { name, zone } = zoomCtx;
    closeZoom();
    if (moveCard(name, zone, 'deck')) {
      playSfx('intodeck');
      toast(name + ' is shuffled into the Deck.');
      refreshOpenSheets();
    }
  });
  els.zaExile.addEventListener('click', e => {
    e.stopPropagation();
    if (!zoomCtx) return;
    const { name, zone } = zoomCtx;
    closeZoom();
    if (moveCard(name, zone, 'exiled')) {
      playSfx('exile');
      toast(name + ' is exiled — it leaves the game.');
      refreshOpenSheets();
    }
  });

  // discard / exile browser: tap a card to read it and act on it
  const gridZoom = zone => e => {
    const item = e.target.closest('.dg-item');
    if (item) openZoom(item.dataset.name, zone);
  };
  const gridKey = zone => e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); gridZoom(zone)(e); }
  };
  els.discardGrid.addEventListener('click', gridZoom('discard'));
  els.discardGrid.addEventListener('keydown', gridKey('discard'));
  els.exileGrid.addEventListener('click', gridZoom('exiled'));
  els.exileGrid.addEventListener('keydown', gridKey('exiled'));

  // peek at the top of the Deck
  els.btnPeek.addEventListener('click', () => {
    closeSheets();
    if (!state.deck.length) { toast('The Deck is spent — nothing to peek at.'); return; }
    peek.order = [];
    renderPeek();
    openSheet(els.peekSheet);
  });
  els.peekLess.addEventListener('click', () => { peek.n = Math.max(1, peek.n - 1); peek.order = []; renderPeek(); });
  els.peekMore.addEventListener('click', () => { peek.n = Math.min(9, peek.n + 1, state.deck.length); peek.order = []; renderPeek(); });
  els.peekReset.addEventListener('click', () => { peek.order = []; renderPeek(); });
  els.peekApply.addEventListener('click', () => {
    if (peek.order.length !== peek.n) return;
    state.history.push({ type: 'peekOrder', prevDeck: [...state.deck] });
    state.deck = peek.order.concat(state.deck.slice(peek.n));
    peek.order = [];
    renderPeek();
    renderCounts();
    save();
    toast('The top of the Deck is set.');
  });

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
