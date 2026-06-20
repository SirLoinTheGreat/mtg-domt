// Card Lightbox — shared module used by gallery (index.html) and simulator (simulator.html).
// Exposes a small public API and a backward-compat window.openLightbox shim
// so existing inline onclick="openLightbox(this)" handlers in the gallery's
// rendered card-tile HTML continue to work.

let allCards = [];
let cardHistory = {};
let CACHE_BUST = 'v=' + Date.now();
let lightbox = null;
const lbNavStack = [];
const ORIGINAL_TITLE = document.title;
let isClosing = false;

// Anchor data + asset URLs to this script's location (not the page's URL).
// Required because pages may be served at /simulator/ via nginx URL rewrites,
// where relative URLs would resolve against the wrong directory and 404.
const PROJECT_BASE = new URL('../../', import.meta.url).href;
function projectUrl(path) {
  return new URL(path, PROJECT_BASE).href;
}

const EXTENDED_RULES_MAP = {
  'Game Master': { url: 'data/game_master_rules.html', title: 'Game Master Mode: Full Rules' },
};

const LIGHTBOX_HTML = `
<div class="lightbox" id="lightbox">
  <button class="lightbox-close" title="Close">&times;</button>
  <div class="lightbox-content">
    <div class="lightbox-card-col">
      <button class="lb-back" id="lb-back"></button>
      <div class="sigil-wrap">
        <div class="card-bloom" aria-hidden="true"></div>
        <img id="lb-img" src="" alt="">
        <div class="sigil-pulse" aria-hidden="true"></div>
      </div>
      <div class="lb-set-info" id="lb-set-info"></div>
      <div class="lb-actions">
        <button class="lb-action" id="lb-share" type="button">✦ Share Card</button>
        <a class="lb-action" id="lb-fullsize-btn" href="#" target="_blank" rel="noopener">⤢ Full Size</a>
      </div>
      <div class="lb-keyboard-hint" aria-hidden="true">← → browse · Esc close</div>
    </div>
    <div class="lightbox-detail-col">
      <div class="lb-section">
        <div class="lb-name" id="lb-name"></div>
        <div class="lb-type" id="lb-type"></div>
        <div class="lb-badges" id="lb-badges"></div>
      </div>
      <div class="lb-section">
        <div class="lb-section-title">Rules Text</div>
        <div class="lb-rules" id="lb-rules"></div>
        <div class="lb-flavor" id="lb-flavor"></div>
      </div>
      <div class="lb-section" id="lb-extended-section" style="display:none">
        <div class="lb-section-title" id="lb-extended-title">Full Rules</div>
        <div class="lb-extended" id="lb-extended"></div>
      </div>
      <div class="lb-section" id="lb-related-section" style="display:none">
        <div class="lb-section-title">Related Cards</div>
        <div class="related-cards-grid" id="lb-related"></div>
      </div>
      <div class="lb-section" id="lb-changelog-section" style="display:none">
        <div class="lb-section-title">Changelog</div>
        <div id="lb-changelog"></div>
      </div>
    </div>
  </div>
</div>
`.trim();

// URL slug for a card name (used in share links: #card/the-talons)
function slugify(name) {
  return name.toLowerCase()
    .replace(/[‘’']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function findCardBySlug(slug) {
  return allCards.find(c => slugify(c.name) === slug);
}

function ensureMarkup() {
  let el = document.getElementById('lightbox');
  if (!el) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = LIGHTBOX_HTML;
    el = wrapper.firstElementChild;
    document.body.appendChild(el);
  }
  return el;
}

function showCard(card) {
  document.title = card.name + ' · The Deck of Many Things';
  const imgPath = (card.image_file || '').split('/').map(p => encodeURIComponent(p)).join('/');
  document.getElementById('lb-img').src = projectUrl(imgPath) + '?' + CACHE_BUST;

  // Card name (serif)
  document.getElementById('lb-name').textContent = card.name +
    (card.dnd_card_name && card.dnd_card_name !== card.name
      ? ' / ' + card.dnd_card_name : '');

  // Type line (serif italic)
  document.getElementById('lb-type').textContent = card.type_line || '';

  // Badges
  const badgesEl = document.getElementById('lb-badges');
  let badges = '';
  if (card.mana_cost) {
    badges += '<span class="lb-badge lb-badge-mana">' + card.mana_cost + '</span>';
  }
  const sentiment = card.sentiment || 'neutral';
  const sentLabel = sentiment.charAt(0).toUpperCase() + sentiment.slice(1);
  badges += '<span class="lb-badge lb-badge-' + sentiment + '">' + sentLabel + '</span>';
  badgesEl.innerHTML = badges;

  // Set info under card image (full-size + share moved to button row)
  const fullImgUrl = (card.image_file || '').split('/').map(p => encodeURIComponent(p)).join('/');
  document.getElementById('lb-set-info').innerHTML =
    card.set_code + ' &bull; #' + (card.collector_number || 'TOKEN') +
    '<br>Art by ' + (card.artist || 'Unknown');
  document.getElementById('lb-fullsize-btn').href = projectUrl(fullImgUrl);

  // Sync URL hash for shareable deep link (without triggering hashchange)
  const slug = slugify(card.name);
  const newHash = '#card/' + slug;
  if (location.hash !== newHash) {
    history.replaceState(null, '', newHash);
  }

  // Replay sigil pulse — force restart the CSS animation
  const pulse = document.querySelector('.lightbox-card-col .sigil-pulse');
  if (pulse) {
    pulse.style.animation = 'none';
    void pulse.offsetWidth;
    pulse.style.animation = '';
  }

  // Back button
  const backBtn = document.getElementById('lb-back');
  if (lbNavStack.length > 0) {
    backBtn.textContent = '← Back';
    backBtn.onclick = function() {
      const prev = lbNavStack.pop();
      showCard(prev);
    };
  } else {
    backBtn.textContent = '';
    backBtn.onclick = null;
  }

  // Rules text (sans-serif)
  document.getElementById('lb-rules').textContent = card.rules_text || '';

  // Flavor text (serif italic)
  const flavorEl = document.getElementById('lb-flavor');
  if (card.flavor_text) {
    flavorEl.textContent = card.flavor_text;
    flavorEl.style.display = '';
  } else {
    flavorEl.style.display = 'none';
  }

  // Extended rules — for cards that have a longer rules companion (e.g. Game Master)
  const extSection = document.getElementById('lb-extended-section');
  const extDiv = document.getElementById('lb-extended');
  const extTitle = document.getElementById('lb-extended-title');
  const extConfig = EXTENDED_RULES_MAP[card.name];
  if (extConfig) {
    extSection.style.display = '';
    extTitle.textContent = extConfig.title;
    const loadExtended = () => {
      extDiv.innerHTML = '<div class="ext-loading">Loading rules…</div>';
      fetch(projectUrl(extConfig.url) + '?' + CACHE_BUST)
        .then(r => r.ok ? r.text() : Promise.reject(r.status))
        .then(html => { extDiv.innerHTML = html; })
        .catch(err => {
          extDiv.innerHTML = '<div class="ext-error">Couldn\'t load extended rules. <button type="button" class="ext-retry">Try again</button></div>';
          extDiv.querySelector('.ext-retry').addEventListener('click', loadExtended);
        });
    };
    loadExtended();
  } else {
    extSection.style.display = 'none';
    extDiv.innerHTML = '';
  }

  // Related cards
  const relSection = document.getElementById('lb-related-section');
  const relGrid = document.getElementById('lb-related');
  const related = (card.related_cards || [])
    .map(name => allCards.find(c => c.name === name))
    .filter(Boolean);

  if (related.length > 0) {
    relSection.style.display = '';
    relGrid.innerHTML = related.map(rc => {
      const parts = (rc.image_file || '').split('/');
      const fileName = parts.pop().replace(/\.png$/, '.jpg');
      const thumbPath = [...parts, 'thumbs', fileName].map(p => encodeURIComponent(p)).join('/');
      return '<button type="button" class="related-card-thumb" onclick="navigateToCard(\'' + rc.name.replace(/'/g, "\\'") + '\')" aria-label="' + rc.name + '">' +
        '<img src="' + projectUrl(thumbPath) + '?' + CACHE_BUST + '" alt="" loading="lazy">' +
        '<div class="related-card-name">' + rc.name + '</div>' +
      '</button>';
    }).join('');
  } else {
    relSection.style.display = 'none';
  }

  // Changelog
  const clSection = document.getElementById('lb-changelog-section');
  const clDiv = document.getElementById('lb-changelog');
  const entries = cardHistory[card.name] || [];

  if (entries.length > 0) {
    clSection.style.display = '';
    clDiv.innerHTML = entries.map(e => {
      let details = [];
      if (e.type === 'added') {
        details.push('<div class="changelog-detail">Card added to the set</div>');
      } else if (e.changes && e.changes.length > 0) {
        e.changes.forEach(c => {
          const esc = s => (s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          if (c.field === 'rules_text') {
            const oldLines = (c.old || '').split('\n');
            const newLines = (c.new || '').split('\n');
            // Collect all changed lines
            const diffs = [];
            const maxLen = Math.max(oldLines.length, newLines.length);
            for (let i = 0; i < maxLen; i++) {
              if (oldLines[i] !== newLines[i]) {
                if (!oldLines[i] && newLines[i]) {
                  diffs.push('<span style="color:#7dba8a">+ ' + esc(newLines[i]) + '</span>');
                } else if (oldLines[i] && !newLines[i]) {
                  diffs.push('<span style="color:#c86060;text-decoration:line-through">' + esc(oldLines[i]) + '</span>');
                } else {
                  diffs.push('<span style="color:#c86060;text-decoration:line-through">' + esc(oldLines[i]) + '</span>');
                  diffs.push('<span style="color:#7dba8a">+ ' + esc(newLines[i]) + '</span>');
                }
              }
            }
            if (diffs.length > 0) {
              details.push('<div class="changelog-detail" style="margin-top:4px"><strong>Rules text:</strong></div>');
              diffs.forEach(d => details.push('<div class="changelog-detail" style="font-size:.68rem;line-height:1.4;padding-left:8px">' + d + '</div>'));
            }
          } else if (c.field === 'flavor_text') {
            if (c.old) details.push('<div class="changelog-detail"><strong>Flavor:</strong> <span style="color:#c86060;text-decoration:line-through">"' + esc(c.old) + '"</span></div>');
            if (c.new) details.push('<div class="changelog-detail"><strong>Flavor:</strong> <span style="color:#7dba8a">"' + esc(c.new) + '"</span></div>');
          } else if (c.field === 'mana_cost') {
            details.push('<div class="changelog-detail"><strong>Mana cost:</strong> ' + esc(c.old || 'none') + ' → ' + esc(c.new || 'none') + '</div>');
          } else if (c.field === 'type_line') {
            details.push('<div class="changelog-detail"><strong>Type:</strong> ' + esc(c.old) + ' → ' + esc(c.new) + '</div>');
          } else if (c.field === 'power' || c.field === 'toughness') {
            details.push('<div class="changelog-detail"><strong>' + c.field + ':</strong> ' + (c.old || '(none)') + ' → ' + (c.new || '(none)') + '</div>');
          } else if (c.field === 'name') {
            details.push('<div class="changelog-detail"><strong>Renamed:</strong> ' + esc(c.old) + ' → ' + esc(c.new) + '</div>');
          } else {
            const fieldLabel = c.field.replace(/_/g, ' ');
            details.push('<div class="changelog-detail"><strong>' + fieldLabel + ':</strong> ' + esc(String(c.old || '')) + ' → ' + esc(String(c.new || '')) + '</div>');
          }
        });
      }
      return '<div class="changelog-entry">' +
        '<span class="changelog-date">' + e.date + '</span>' +
        '<div class="changelog-body">' +
          details.join('') +
        '</div>' +
      '</div>';
    }).join('');
  } else {
    clSection.style.display = 'none';
  }

  // Scroll detail panel to top
  const detailCol = document.querySelector('.lightbox-detail-col');
  detailCol.scrollTop = 0;

  // Stagger index for the open "settle in" — only the sections actually shown.
  // Set before the .open class triggers the entrance (openLightbox calls
  // showCard first). On in-modal navigation the entrance has already run, so
  // re-indexing here is a harmless no-op.
  let secIdx = 0;
  detailCol.querySelectorAll('.lb-section').forEach(sec => {
    if (sec.style.display !== 'none') sec.style.setProperty('--i', secIdx++);
  });
}

function openLightbox(card) {
  if (!card) return;
  isClosing = false;
  lbNavStack.length = 0;
  showCard(card);
  // Restart the entrance cleanly even if a previous close was mid-flight.
  lightbox.classList.remove('closing', 'open');
  void lightbox.offsetWidth;
  lightbox.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function openLightboxByName(name) {
  const card = allCards.find(c => c.name === name);
  if (card) openLightbox(card);
}

function navigateToCard(name) {
  const card = allCards.find(c => c.name === name);
  if (!card) return;
  // Push current card onto nav stack
  const currentName = document.getElementById('lb-name').textContent.split(' / ')[0];
  const currentCard = allCards.find(c => c.name === currentName);
  if (currentCard) lbNavStack.push(currentCard);
  showCard(card);
}

function closeLightbox() {
  if (isClosing || !lightbox.classList.contains('open')) return;
  isClosing = true;
  const content = lightbox.querySelector('.lightbox-content');
  lightbox.classList.add('closing');

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    content.removeEventListener('animationend', onEnd);
    instantClose();
  };
  const onEnd = e => { if (e.target === content) finish(); };
  content.addEventListener('animationend', onEnd);
  // Fallback: reduced-motion (~instant) or an interrupted animation may not
  // deliver animationend; close anyway shortly after the exit duration.
  setTimeout(finish, 360);
}

function instantClose() {
  lightbox.classList.remove('open');
  lightbox.classList.remove('closing');
  isClosing = false;
  document.body.style.overflow = '';
  document.title = ORIGINAL_TITLE;
  // Clear the card hash, but keep other hashes (none currently)
  if ((location.hash || '').match(/^#card\//)) {
    history.replaceState(null, '', location.pathname + location.search);
  }
}

function handleHashRoute() {
  const m = (location.hash || '').match(/^#card\/(.+)$/);
  if (!m) return;
  const card = findCardBySlug(decodeURIComponent(m[1]));
  if (card) openLightbox(card);
}

let _wired = false;
function wireHandlers() {
  if (_wired) return;
  _wired = true;

  // Click-outside-to-close + close-button
  lightbox.addEventListener('click', e => {
    if (e.target === lightbox || e.target.classList.contains('lightbox-close')) {
      closeLightbox();
    }
  });

  // Escape + arrow-nav
  document.addEventListener('keydown', e => {
    if (!lightbox.classList.contains('open')) return;
    if (e.key === 'Escape') {
      closeLightbox();
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const delta = e.key === 'ArrowRight' ? 1 : -1;
      const currentName = document.getElementById('lb-name').textContent.split(' / ')[0];
      const tiles = Array.from(document.querySelectorAll('.card-tile'));
      const idx = tiles.findIndex(t => t.dataset.rawname === currentName);
      if (idx === -1) return;
      const next = tiles[idx + delta];
      if (!next) return;
      const card = allCards.find(c => c.name === next.dataset.rawname);
      if (card) { lbNavStack.length = 0; showCard(card); }
      e.preventDefault();
    }
  });

  // Share button — copies deep link, flashes sealed-confirmation
  document.getElementById('lb-share').addEventListener('click', () => {
    const url = location.origin + location.pathname + location.hash;
    const btn = document.getElementById('lb-share');
    const original = btn.textContent;
    const writeFallback = () => {
      const ta = document.createElement('textarea');
      ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (_) {}
      document.body.removeChild(ta);
    };
    const onCopied = () => {
      btn.textContent = '✦ Sealed to your clipboard ✦';
      btn.classList.add('flash');
      setTimeout(() => {
        btn.textContent = original;
        btn.classList.remove('flash');
      }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(onCopied).catch(() => { writeFallback(); onCopied(); });
    } else {
      writeFallback(); onCopied();
    }
  });

  // Hash-route changes (deep link, browser back/forward)
  window.addEventListener('hashchange', handleHashRoute);
}

// Public API ----------------------------------------------------------------

export function init({ cards, history, cacheBust } = {}) {
  if (cards) allCards = cards;
  if (history) cardHistory = history;
  if (cacheBust) CACHE_BUST = cacheBust;
  lightbox = ensureMarkup();
  wireHandlers();

  // Backward-compat shims for inline handlers in gallery-rendered HTML.
  // - openLightbox(tile): existing card-tile onclick="openLightbox(this)"
  // - navigateToCard(name): related-card-thumb onclick (rendered by showCard)
  window.openLightbox = function(tileOrCard) {
    if (!tileOrCard) return;
    // Tile element from the gallery grid (onclick="openLightbox(this)")
    if (tileOrCard.nodeType === 1 && tileOrCard.dataset && tileOrCard.dataset.rawname) {
      const card = allCards.find(c => c.name === tileOrCard.dataset.rawname);
      if (card) openLightbox(card);
      return;
    }
    // Otherwise assume it's a card object (e.g. the simulator's Draw a Card)
    openLightbox(tileOrCard);
  };
  window.navigateToCard = navigateToCard;

  // Auto-open card from URL hash (e.g. #card/the-talons)
  handleHashRoute();
}

export function setCards(cards) { allCards = cards || []; }
export function setHistory(history) { cardHistory = history || {}; }
export { openLightbox, openLightboxByName };
