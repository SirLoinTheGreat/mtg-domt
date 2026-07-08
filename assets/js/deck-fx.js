// deck-fx.js — canvas spark effects for The Deck. No dependencies.
// Pre-rendered sprites blitted with additive blending; the rAF loop only runs
// while particles are alive, so an idle deck costs nothing (the table phone
// holds a wake lock — battery matters).
const canvas = document.getElementById('fx');
const ctx = canvas.getContext('2d');
let parts = [];
let running = false;
let last = 0;
let dpr = 1;

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
}
addEventListener('resize', resize);
resize();

function sprite(size, paint) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  paint(c.getContext('2d'), size);
  return c;
}
const DOT = sprite(32, (g, s) => {
  const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  r.addColorStop(0, 'rgba(255,246,220,1)');
  r.addColorStop(.3, 'rgba(244,210,122,.85)');
  r.addColorStop(.65, 'rgba(212,175,60,.28)');
  r.addColorStop(1, 'rgba(212,175,60,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, s, s);
});
const EMBER = sprite(32, (g, s) => {
  const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  r.addColorStop(0, 'rgba(255,224,196,1)');
  r.addColorStop(.35, 'rgba(217,119,66,.8)');
  r.addColorStop(1, 'rgba(217,119,66,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, s, s);
});
const STAR = sprite(64, (g, s) => {
  const c = s / 2;
  const r = g.createRadialGradient(c, c, 0, c, c, c);
  r.addColorStop(0, 'rgba(255,250,230,1)');
  r.addColorStop(.4, 'rgba(244,210,122,.55)');
  r.addColorStop(1, 'rgba(244,210,122,0)');
  g.fillStyle = r;
  g.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4;
    const rad = i % 2 ? c * .14 : c;
    g[i ? 'lineTo' : 'moveTo'](c + Math.cos(a) * rad, c + Math.sin(a) * rad);
  }
  g.closePath();
  g.fill();
});

function loop(now) {
  const dt = Math.min((now - last) / 1000, .05);
  last = now;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  ctx.globalCompositeOperation = 'lighter';
  parts = parts.filter(p => (p.life += dt) < p.ttl);
  for (const p of parts) {
    if (p.life < 0) continue;                     // staggered birth
    p.vx *= 1 - p.drag * dt;
    p.vy = p.vy * (1 - p.drag * dt) + p.grav * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    const t = p.life / p.ttl;
    ctx.globalAlpha = (t < .15 ? t / .15 : (1 - t) / .85) * p.alpha;
    const sz = p.size * (1 - t * p.shrink);
    if (p.spin) {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot += p.spin * dt);
      ctx.drawImage(p.img, -sz / 2, -sz / 2, sz, sz);
      ctx.restore();
    } else {
      ctx.drawImage(p.img, p.x - sz / 2, p.y - sz / 2, sz, sz);
    }
  }
  ctx.globalAlpha = 1;
  if (parts.length) requestAnimationFrame(loop);
  else { running = false; ctx.clearRect(0, 0, innerWidth, innerHeight); }
}

function add(p) {
  parts.push(Object.assign(
    { life: 0, ttl: 1, size: 8, vx: 0, vy: 0, drag: 0, grav: 0,
      spin: 0, rot: 0, shrink: .5, alpha: 1, img: DOT }, p));
  if (!running) {
    running = true;
    last = performance.now();
    requestAnimationFrame(loop);
  }
}
const rand = (a, b) => a + Math.random() * (b - a);

// sparks kicked loose as the card lifts off the deck. w = card width, so the
// effect scales from phone hero card to desktop pile.
export function burst(x, y, w = 140) {
  for (let i = 0; i < 14; i++) {
    const a = rand(0, Math.PI * 2);
    const sp = w * rand(.4, 1.6);
    add({
      x, y,
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - w * .3,
      ttl: rand(.35, .7), size: rand(3, 9),
      drag: 3, grav: 340,
      img: Math.random() < .25 ? EMBER : DOT,
    });
  }
}

// a single mote shed along the card's flight path
export function trail(x, y) {
  add({
    x, y,
    vx: rand(-25, 25), vy: rand(-15, 40),
    ttl: rand(.4, .8), size: rand(3, 8),
    drag: 1.5, grav: 90,
    img: Math.random() < .3 ? EMBER : DOT,
  });
}

// the reveal — a soft flash, a ring of sparks, and a few slow star glints
export function reveal(x, y, w) {
  add({ x, y, ttl: .5, size: w * 1.5, shrink: -.4, alpha: .85 });
  const n = 26;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rand(-.2, .2);
    const sp = w * rand(.9, 2.2);
    add({
      x, y,
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      ttl: rand(.5, 1), size: rand(3, 10),
      drag: 3.2, grav: 190,
      img: Math.random() < .2 ? EMBER : DOT,
    });
  }
  for (let i = 0; i < 4; i++) {
    add({
      x: x + rand(-.4, .4) * w, y: y + rand(-.5, .3) * w,
      vx: rand(-12, 12), vy: rand(-45, -15),
      life: -i * .07,
      ttl: rand(.55, .85), size: rand(16, 30),
      spin: rand(-2.5, 2.5), rot: rand(0, Math.PI),
      shrink: .25, img: STAR,
    });
  }
}

// shed trail motes from an element while it animates; returns a stop function
export function follow(el) {
  let on = true;
  (function tick() {
    if (!on || !el.isConnected) return;
    const r = el.getBoundingClientRect();
    trail(r.left + Math.random() * r.width, r.top + Math.random() * r.height);
    requestAnimationFrame(tick);
  })();
  return () => { on = false; };
}
