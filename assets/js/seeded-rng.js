// Mulberry32 — small fast 32-bit PRNG. Reproducible given a seed.
// Returns a function that returns floats in [0, 1).
export function mulberry32(seed) {
  let s = seed >>> 0;  // coerce to uint32
  return function() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Convenience: a fresh seed from current time + a small random salt
export function freshSeed() {
  return ((Date.now() & 0xFFFFFFFF) ^ ((Math.random() * 0xFFFFFFFF) >>> 0)) >>> 0;
}

// Fisher-Yates shuffle using a provided rng (returns new array, doesn't mutate)
export function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
