// Futuro Cube geometry: where each of the 54 squares sits in 3D.
// Coordinates are integers: a face's centre is 3 along its normal and squares are 2 apart,
// so square centres look like (±3, -2..2, -2..2). Axes follow the cube's accelerometer:
// X+ is side 3, X- side 2, Y+ side 4 (top), Y- side 5, Z+ side 0 (front), Z- side 1.
// Each face lists its normal N, then u (towards higher columns) and v (towards higher
// rows) as drawn in the manual's unfolded net (side 0 in the middle, 4 above, 5 below,
// 2 left, 3 and then 1 to the right).

export const FACES = [
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, -1, 0] },   // 0 front
  { n: [0, 0, -1], u: [-1, 0, 0], v: [0, -1, 0] }, // 1 back
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, -1, 0] },  // 2 left
  { n: [1, 0, 0], u: [0, 0, -1], v: [0, -1, 0] },  // 3 right
  { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1] },    // 4 top
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, -1] },  // 5 bottom
];

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

export const POS = [];            // index -> integer centre
const byPos = new Map();
for (let i = 0; i < 54; i++) {
  const f = FACES[(i / 9) | 0], s = i % 9, r = (s / 3) | 0, c = s % 3;
  const p = add(add(mul(f.n, 3), mul(f.u, 2 * (c - 1))), mul(f.v, 2 * (r - 1)));
  POS.push(p);
  byPos.set(p.join(), i);
}
export const indexAt = (p) => byPos.get(p.join());
export const sideOfNormal = (n) => FACES.findIndex((f) => same(f.n, n));

// ---------- walkers ----------
// A walker packs the square index in its low byte (as the cube's _i() expects) and a
// direction in bits 8-9: 0 = up the face (-v, the default), 1 = +u, 2 = +v, 3 = -u.
const dirVectors = (f) => [mul(f.v, -1), f.u, f.v, mul(f.u, -1)];
export const walker = (index, dir = 0) => (index & 0xff) | ((dir & 3) << 8);
export const wIndex = (w) => w & 0xff;
export function wDir(w) {
  const i = wIndex(w);
  return dirVectors(FACES[(i / 9) | 0])[(w >> 8) & 3];
}
export function makeWalker(index, d) {
  const f = FACES[(index / 9) | 0];
  const k = dirVectors(f).findIndex((x) => same(x, d));
  return walker(index, k < 0 ? 0 : k);
}

export const STEP = { NOTHING: 0, FIRST: 1, FORWARD: 2, BACKWARDS: 3, RIGHT: 4, LEFT: 5, UPRIGHT: 6, UPLEFT: 7, DOWNRIGHT: 8, DOWNLEFT: 9, HEAD: 10 };

// one move along unit vector m; returns { p, d, crossed }
function moveOnce(p, d, m) {
  const n = FACES[sideOfNormal(normalOf(p))].n;
  let q = add(p, mul(m, 2));
  if (Math.max(...q.map(Math.abs)) <= 3) return { p: q, d, crossed: false };
  // went over the edge: the old normal becomes -m, m becomes the new normal
  q = q.map((x, k) => (Math.abs(x) === 4 ? Math.sign(x) * 3 : x));
  q = sub(q, mul(n, 1));
  const rot = (x) => add(sub(sub(x, mul(n, dot(x, n))), mul(m, dot(x, m))), sub(mul(m, dot(x, n)), mul(n, dot(x, m))));
  return { p: q, d: rot(d), crossed: true };
}
export function normalOf(p) {
  const k = p.findIndex((x) => Math.abs(x) === 3);
  const n = [0, 0, 0];
  n[k] = Math.sign(p[k]);
  return n;
}

// right-hand side of a walker, seen from outside the cube
export const rightOf = (d, n) => cross(d, n);

export function stepWalker(w, step) {
  const i = wIndex(w);
  let p = POS[i], d = wDir(w), crossed = false;
  const n = normalOf(p);
  const r = rightOf(d, n);
  const moves = {
    [STEP.FORWARD]: [d], [STEP.BACKWARDS]: [mul(d, -1)], [STEP.RIGHT]: [r], [STEP.LEFT]: [mul(r, -1)],
    [STEP.UPRIGHT]: [d, r], [STEP.UPLEFT]: [d, mul(r, -1)], [STEP.DOWNRIGHT]: [mul(d, -1), r], [STEP.DOWNLEFT]: [mul(d, -1), mul(r, -1)],
  }[step] ?? [];
  // later moves of a diagonal follow the walker's turned frame
  let base = { d, r, n };
  for (const m0 of moves) {
    const m = same(m0, base.d) ? d : same(m0, mul(base.d, -1)) ? mul(d, -1) : same(m0, base.r) ? rightOf(d, normalOf(p)) : mul(rightOf(d, normalOf(p)), -1);
    const res = moveOnce(p, d, m);
    p = res.p; d = res.d; crossed ||= res.crossed;
  }
  return { w: makeWalker(indexAt(p), d), crossed };
}

export function turnWalker(w, left) {
  const i = wIndex(w), d = wDir(w), n = normalOf(POS[i]);
  return makeWalker(i, left ? cross(n, d) : cross(d, n));
}

export const OPPOSITE_STEP = { 2: 3, 3: 2, 4: 5, 5: 4, 6: 9, 9: 6, 7: 8, 8: 7 };

// the step (forward/back/right/left) that brings walker a closest to square b
export function bestStep(w, target) {
  const a = wIndex(w);
  if (a === target) return STEP.NOTHING;
  if (((a / 9) | 0) === 5 - ((target / 9) | 0)) return STEP.NOTHING;
  const goal = POS[target];
  let best = STEP.NOTHING, bestDist = Infinity;
  for (const s of [STEP.FORWARD, STEP.BACKWARDS, STEP.RIGHT, STEP.LEFT]) {
    const q = POS[wIndex(stepWalker(w, s).w)];
    const dd = dot(sub(q, goal), sub(q, goal));
    if (dd < bestDist) { bestDist = dd; best = s; }
  }
  return best;
}
