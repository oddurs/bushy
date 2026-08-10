// Small deterministic PRNG, shared by the brow and the warp so a single shot
// seed drives every random choice in a photo. Same seed in, same face out --
// which is what keeps the reveal animation from reshuffling on every frame.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const shotSeed = () => (Math.random() * 4294967296) >>> 0;
