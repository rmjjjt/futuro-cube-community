// Cube simulator: runs a compiled script (.amx) in the browser.
// The Pawn abstract machine (lib/amxsim.*, built from the open-source Pawn sources) runs
// the script; this file implements the cube's API (its native functions) on a virtual
// cube: 54 LEDs, an orientation (for gravity and the cursor), taps, timers and sounds.
// Behaviour follows the API notes in futurocube.inc; it's close, not cycle-exact.
import createAmxSim from "../lib/amxsim.mjs";
import * as G from "./geometry.js";

const ERR_SLEEP = 12, ERR_NATIVE = 10, ERR_EXIT = 1;
const AMX_ERRORS = ["", "forced exit", "assertion failed", "stack/heap collision", "index out of bounds",
  "invalid memory access", "invalid instruction", "stack underflow", "heap underflow", "no callback",
  "native function failed", "divide by zero", "sleep", "invalid state", "", "", "out of memory",
  "invalid file format", "file is for a newer version", "function not found", "invalid entry point"];
export const TICK_MS = 8;           // the cube reads its accelerometer at 125 Hz
const TAP_BIT = { 0: 13, 1: 14, 2: 10, 3: 9, 4: 11, 5: 12 };   // side -> TAP_ZPLUS etc.
const SIDE_OF_BIT = Object.fromEntries(Object.entries(TAP_BIT).map(([s, b]) => [b, +s]));
const TAP_GENERIC = 5, SHAKING = 8, TAP_DOUBLE = 15;

// 3x3 digits for DrawDigit, rows top to bottom
const FONT = ["111101111", "010010010", "110010011", "111011111", "101111001", "011010110", "100111111", "111001001", "011111110", "111111001"];

let enginePromise;
function engine() {
  enginePromise ??= (async () => {
    let target = null;   // the running CubeSim
    const M = await createAmxSim({ onNative: (i, p) => target.native(i, p) });
    M.use = (sim) => (target = sim);
    return M;
  })();
  return enginePromise;
}

export class CubeSim extends EventTarget {
  constructor() {
    super();
    this.leds = new Uint32Array(54);
    this.up = [0, 1, 0];           // which way is up, in cube coordinates
    this.running = false;
    this.variables = new Map();
    this.soundOver = () => true;   // set by the UI: is the last Play() finished?
    this.reset();
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  reset() {
    this.canvas = new Uint32Array(54);
    this.leds.fill(0);
    this.palette = new Uint32Array(256);
    this.color = 0x80340000; this.intensity = 128; this.style = 0; this.blend = 50;
    this.timers = Array.from({ length: 10 }, () => ({ end: 0, paused: null }));
    this.incTimers = new Array(10).fill(0);
    this.registered = 0; this.pending = 0; this.lastTapSide = -1; this.lastTapAt = -1e9; this.doubleTapMs = 700;
    this.stacks = [];
    this.fade = null;
    this.frame = 0;
    this.now = 0; this.appStart = 0;
    this.seed = 0x2545f491;
    this.wake = 0; this.waitFor = null; this.resumeValue = null;
    this.nativeCalls = 0;
    this.shakeLevel = 0;
  }

  async load(amx) {
    this.M = await engine();
    this.amx = amx;
  }

  start() {
    const M = this.M;
    M.use(this);
    this.reset();
    const p = M._malloc(this.amx.length);
    M.HEAPU8.set(this.amx, p);
    const err = M._sim_load(p, this.amx.length);
    M._free(p);
    if (err) throw new Error("Can't load this script: " + (AMX_ERRORS[err] || err));
    this.started = false;
    this.running = true;
    this.emit("state", "running");
  }

  stop(reason = "stopped") {
    if (!this.running) return;
    this.running = false;
    this.emit("state", reason);
  }

  // Advance simulated time by ms, running the script whenever it's due.
  advance(ms) {
    const end = this.now + ms;
    while (this.running && this.now < end) {
      this.now = Math.min(end, this.now + TICK_MS);
      this.frame++;
      this.shakeLevel = Math.max(0, this.shakeLevel - 1);
      if (this.fade && this.frame % this.fade.step === 0) {
        for (let i = 0; i < 54; i++) this.leds[i] = scaleSub(this.leds[i], this.fade.diff);
      }
      if (this.waitFor?.() === false || this.now < this.wake) continue;
      this.waitFor = null;
      if (this.resumeValue) { this.M._sim_set_pri(this.resumeValue()); this.resumeValue = null; }
      this.runScript();
    }
  }

  runScript() {
    const M = this.M;
    M.use(this);
    this.nativeCalls = 0;
    this.error = null;
    let err;
    try { err = M._sim_exec(this.started ? 1 : 0); }
    catch (e) { this.emit("log", `Script crashed: ${e.message}\n`); return this.stop("error"); }
    this.started = true;
    if (err === ERR_SLEEP) return;
    if (this.restartRequested) { this.restartRequested = false; return this.start(); }
    if (!this.running) return;
    if (err === 0) return this.stop("ended");
    this.emit("log", `Script stopped: ${this.error || AMX_ERRORS[err] || "error " + err}\n`);
    this.stop("error");
  }

  // ---------- input from the UI ----------
  tap(side) {
    let bits = 1 << TAP_GENERIC | 1 << TAP_BIT[side];
    if (this.now - this.lastTapAt < this.doubleTapMs) bits |= 1 << TAP_DOUBLE;
    this.lastTapAt = this.now;
    this.lastTapSide = side;
    this.pending |= bits;
    this.emit("tap", { side, double: !!(bits & 1 << TAP_DOUBLE) });
  }
  shake() { this.shakeLevel = 60; this.pending |= 1 << SHAKING; }
  setUp(v) { this.up = v; }

  // ---------- helpers ----------
  get H() { return this.M.HEAP32; }
  cell(addr) { return this.H[addr >> 2]; }
  setCell(addr, v) { this.H[addr >> 2] = v; }
  cells(addr, n) { return Array.from(this.H.subarray(addr >> 2, (addr >> 2) + n)); }
  str(addr) {
    const H = this.H;
    let i = addr >> 2, s = "";
    if ((H[i] >>> 0) > 0xffffff) {      // packed string: 4 chars per cell, first in the high byte
      for (;; i++) {
        const c = H[i] >>> 0;
        for (const sh of [24, 16, 8, 0]) { const ch = (c >>> sh) & 0xff; if (!ch) return s; s += String.fromCharCode(ch); }
      }
    }
    for (; H[i]; i++) s += String.fromCharCode(H[i] & 0xffff);
    return s;
  }
  writeStr(addr, size, s) {
    const n = Math.min(s.length, size - 1);
    for (let k = 0; k < n; k++) this.setCell(addr + 4 * k, s.charCodeAt(k));
    if (size > 0) this.setCell(addr + 4 * n, 0);
  }
  format(fmt, argAddrs) {
    let k = 0;
    return fmt.replace(/%(-?\d*)([dixXcsfq%])/g, (m, width, t) => {
      if (t === "%") return "%";
      const a = argAddrs[k++];
      if (a === undefined) return m;
      let out;
      if (t === "s") out = this.str(a);
      else {
        const v = this.cell(a);
        out = t === "c" ? String.fromCharCode(v) : t === "x" ? (v >>> 0).toString(16) : t === "X" ? (v >>> 0).toString(16).toUpperCase()
          : t === "f" || t === "q" ? (v / 1000).toFixed(3) : String(v);
      }
      const w = parseInt(width || "0");
      return w < 0 ? out.padEnd(-w) : out.padStart(w);
    });
  }
  rnd() { let x = this.seed; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.seed = x >>> 0; return this.seed; }
  colorOf(v) { v >>>= 0; return v < 256 ? this.palette[v] : v; }
  sleepUntil(t) { this.wake = t; this.M._sim_raise(ERR_SLEEP); }
  waitUntil(cond) { this.waitFor = cond; this.M._sim_raise(ERR_SLEEP); }
  fail(msg) { this.error = msg; this.M._sim_raise(ERR_NATIVE); return 0; }
  idx(wi) { const i = G.wIndex(wi); return i < 54 ? i : -1; }
  cursorIndex() {
    let best = 0, bv = -Infinity;
    const u = this.up;
    for (let i = 0; i < 54; i++) {
      const p = G.POS[i], l = Math.hypot(...p);
      const v = (p[0] * u[0] + p[1] * u[1] + p[2] * u[2]) / l;
      if (v > bv) { bv = v; best = i; }
    }
    return best;
  }
  topSide() { return (this.cursorIndex() / 9) | 0; }
  pendingSide() {
    const m = this.pending & this.registered;
    for (const b of [9, 10, 11, 12, 13, 14]) if (m & (1 << b)) return SIDE_OF_BIT[b];
    return -1;
  }

  // ---------- drawing ----------
  paint(i, col, intensity = this.intensity) {
    if (i < 0 || i >= 54) return;
    const c = scale(this.colorOf(col), intensity);
    const old = this.canvas[i];
    switch (this.style) {
      case 1: case 5: this.canvas[i] = mix(old, c, (a, b) => Math.min(255, a + b)); break;   // ADD
      case 2: this.canvas[i] = mix(old, c, (a, b) => Math.max(0, a - b)); break;            // SUB
      case 3: if (old) this.canvas[i] = c; break;                                           // masks
      case 4: if (!old) this.canvas[i] = c; break;
      case 6: this.canvas[i] = mix(old, c, (a, b) => Math.round(a + (b - a) * this.blend / 100)); break; // BLD
      default: this.canvas[i] = c;
    }
  }
  around(wi, fn) {
    const w = G.wIndex(wi) === wi ? G.walker(wi) : wi;
    fn(G.wIndex(w));
    for (const s of [2, 3, 4, 5, 6, 7, 8, 9]) fn(G.wIndex(G.stepWalker(w, s).w));
  }

  // ---------- natives ----------
  native(index, params) {
    const H = this.M.HEAP32, p = params >> 2, n = H[p] >> 2;
    const a = (k) => H[p + 1 + k];
    const argc = n;
    if (++this.nativeCalls > 500000) return this.fail("the script never calls Sleep(), so the cube would freeze");
    switch (index) {
      // drawing
      case -1: this.canvas.fill(0); return 0;                                      // ClearCanvas
      case -2: this.leds.set(this.canvas); this.fade = null; this.emit("frame"); return 0;       // PrintCanvas
      case -19: this.emit("log", Array.from(this.canvas, (c) => c.toString(16)).join(" ") + "\n"); return 0; // PrintCnv
      case -7: this.intensity = Math.max(0, Math.min(256, a(0))); return 0;        // SetIntensity
      case -8: this.color = argc ? a(0) >>> 0 : 0xffffff00; return 0;              // SetColor
      case -11: this.color = ((a(0) & 255) << 24 | (a(1) & 255) << 16 | (a(2) & 255) << 8) >>> 0; return 0; // SetRgbColor
      case -9: this.paint(this.idx(a(0)), this.color); return 0;                   // DrawPoint
      case -32: this.paint(this.idx(a(0)), a(1), argc > 2 ? a(2) : 128); return 0; // DrawPC
      case -10: for (let i = 0; i < 9; i++) this.paint(a(0) * 9 + i, this.color); return 0;  // DrawSide
      case -12: this.around(a(0), (i) => this.paint(i, this.color)); return 0;     // DrawSquare
      case -25: for (let i = 0; i < 54; i++) this.paint(i, this.color); return 0;  // DrawCube
      case -13: {                                                                    // DrawCross
        const w0 = G.wIndex(a(0)) === a(0) ? G.walker(a(0)) : a(0);
        this.paint(G.wIndex(w0), this.color);
        for (const s of [2, 3, 4, 5]) { let w = w0; for (let k = 0; k < (argc > 1 ? a(1) : 1); k++) { w = G.stepWalker(w, s).w; this.paint(G.wIndex(w), this.color); } }
        return 0;
      }
      case -14: return this.push(this.canvas, argc ? a(0) : 0);                     // PushCanvas
      case -15: { const r = this.pop(54, argc ? a(0) : 0); if (r) this.canvas.set(r.map((x) => x >>> 0)); return r ? 1 : 0; } // PopCanvas
      case -16: for (let i = 0; i < Math.min(54, a(1)); i++) this.setCell(a(0) + 4 * i, this.canvas[i]); return 0; // CanvasToArray
      case -17: this.cells(a(0), Math.min(54, a(1))).forEach((c, i) => (this.canvas[i] = c >>> 0)); return 0;     // ArrayToCanvas
      case -18: this.cells(a(0), Math.min(54, a(1))).forEach((c, i) => this.paint(i, c)); return 0;              // DrawArray
      case -20: this.intensity = 128; this.color = 0x80340000; this.blend = 50; this.style = 0; return 0;         // SetDrawDefaults
      case -21: this.style = a(0); if (argc > 1) this.blend = a(1); return 0;      // SetDrawStyle
      case -22: if (a(0) > 0 && a(0) < 256) this.palette[a(0)] = a(1) >>> 0; return 0; // SetPalette
      case -33: this.cells(a(0), Math.min(255, a(1))).forEach((c, i) => (this.palette[i + 1] = c >>> 0)); return 0; // PaletteFromArray
      case -23: {                                                                    // FlashCanvas
        const excl = argc > 2 && a(2);
        for (let i = 0; i < 54; i++) if (this.canvas[i] && (!excl || bright(this.canvas[i]) > bright(this.leds[i]))) this.leds[i] = this.canvas[i];
        this.fade = { step: Math.max(1, argc ? a(0) : 1), diff: argc > 1 ? a(1) : 3 };
        this.emit("frame");
        return 0;
      }
      case -24: {                                                                    // DrawFlicker
        const speed = argc > 1 ? a(1) : 20, type = argc > 2 ? a(2) : 0, phase = argc > 3 ? a(3) : 0;
        const t = ((this.frame * speed / 4 + phase * 2) % 512 + 512) % 512;
        const k = type === 1 ? t / 512 : t < 256 ? t / 256 : (512 - t) / 256;
        this.paint(this.idx(a(0)), this.color, Math.round(this.intensity * (0.15 + 0.85 * k)));
        return 0;
      }
      case -26: { const i = this.idx(a(0)); if (i >= 0) this.canvas[i] = adj(this.canvas[i], a(1)); return 0; } // AdjCanvasPoint
      case -27: for (let i = 0; i < 54; i++) this.canvas[i] = adj(this.canvas[i], a(0)); return 0;               // AdjCanvas
      case -28: {                                                                    // AdjArray
        const size = a(4), start = a(2), count = Math.min(a(3), size - start);
        for (let i = start; i < start + count; i++) this.setCell(a(0) + 4 * i, adj(this.cell(a(0) + 4 * i) >>> 0, a(1)));
        return 0;
      }
      case -29: return this.canvas[Math.max(0, this.idx(a(0)))] | 0;               // ReadCanvas
      case -30: return this.leds[Math.max(0, this.idx(a(0)))] | 0;                 // ReadRGBLed
      case -31: this.leds.fill(0); this.fade = null; this.emit("frame"); return 0; // ClearCube
      case -34: {                                                                    // DrawTail
        this.paint(G.wIndex(a(0)), this.color);
        this.paint(G.wIndex(G.stepWalker(a(0), 3).w), this.color, this.intensity >> 2);
        return 0;
      }
      case -35: return 0;                                                            // RotateCanvasRGB
      case -242: {                                                                   // DrawDigit
        const glyph = FONT[a(1)] ?? FONT[0];
        let row = a(0);
        for (let r = 0; r < 3; r++) {
          let w = row;
          for (let c = 0; c < 3; c++) { if (glyph[r * 3 + c] === "1") this.paint(G.wIndex(w), this.color); w = G.stepWalker(w, 4).w; }
          row = G.stepWalker(row, 3).w;
        }
        return 0;
      }

      // motion
      case -50: this.registered |= 1 << a(0); return 0;                            // RegMotion
      case -66: this.doubleTapMs = argc ? a(0) : 700; return 0;                    // SetDoubleTapLength
      case -51: return this.pending & this.registered;                             // Motion
      case -52: this.pending = 0; return 0;                                        // AckMotion
      case -53: for (const b of [9, 10, 11, 12, 13, 14]) this.registered |= 1 << b; return 0; // RegAllSideTaps
      case -60: for (const b of [5, 9, 10, 11, 12, 13, 14]) this.registered |= 1 << b; return 0; // RegAllTaps
      case -54: this.registered &= argc && a(0) ? ~(1 << a(0)) : 0; return 0;     // UnregMotion
      case -55: this.registered = 0; return 0;                                     // UnregAllMotion
      case -56: { const s = this.pendingSide(); if (s < 0) return 0; this.setCell(a(0), s); return 1; } // GetTapSide
      case -57: {                                                                    // GetTapType
        const s = this.pendingSide();
        if (s < 0) return 0;
        const top = (G.wIndex(a(0)) / 9) | 0;
        return s === top ? 2 : s === 5 - top ? 3 : 1;
      }
      case -61: case -62: case -63: {                                               // eTapToSide/Top/Bot
        const s = this.lastTapSide, top = this.topSide();
        const type = s < 0 ? 0 : s === top ? -62 : s === 5 - top ? -63 : -61;
        return type === index ? 1 : 0;
      }
      case -64: return this.pendingSide() >= 0 ? this.pendingSide() : this.lastTapSide;   // eTapSide
      case -65: return this.pendingSide() >= 0 ? 1 : 0;                              // eTapSideOK
      case -58: return this.shakeLevel > 0 || performance.now() - (this.movedAt ?? -1e9) < 300 ? 1 : 0; // IsStill
      case -59: return Math.min(100, this.shakeLevel * 2);                           // GetShake
      case -215: {                                                                   // ReadAcc
        const jitter = () => (this.shakeLevel ? (this.rnd() % 120) - 60 : 0);
        for (let k = 0; k < 3; k++) this.setCell(a(0) + 4 * k, Math.round(-this.up[k] * 256) + jitter());
        return 0;
      }
      case -216: return G.walker(this.cursorIndex());                               // GetCursor

      // time
      case -200: if (argc && a(0) > 0) this.sleepUntil(this.now + a(0)); else this.sleepUntil(this.now + 1); return 0; // Sleep
      case -201: this.sleepUntil(this.now + (argc ? a(0) : 1000)); return 0;        // Delay
      case -202: this.timers[argc ? a(0) : 0] = { end: this.now + (argc > 1 ? a(1) : 1000), paused: null }; return 0; // SetTimer
      case -203: { const t = this.timers[argc ? a(0) : 0]; return Math.max(0, t.paused ?? t.end - this.now) | 0; }   // GetTimer
      case -217: { const t = this.timers[argc ? a(0) : 0]; if (t.paused == null) t.paused = Math.max(0, t.end - this.now); return 0; }
      case -218: { const t = this.timers[argc ? a(0) : 0]; if (t.paused != null) { t.end = this.now + t.paused; t.paused = null; } return 0; }
      case -141: this.incTimers[a(0)] = this.now - a(1); return 0;                  // SetIncTimer
      case -142: return (this.now - this.incTimers[argc ? a(0) : 0]) | 0;            // GetIncTimer
      case -230: return (this.now + 60000) | 0;                                       // GetMsecs (cube uptime)
      case -231: return (this.now - this.appStart) | 0;                              // GetAppMsecs
      case -143: this.appStart = this.now - a(0); return 0;                          // SetAppMsecs
      case -140: return 0;                                                           // EnablePreciseTiming

      // text and memory
      case -204: { const s = this.format(this.str(a(0)), Array.from({ length: argc - 1 }, (_, k) => a(k + 1))); this.emit("log", s); return s.length; } // printf
      case -205: { const s = this.format(this.str(a(2)), Array.from({ length: argc - 3 }, (_, k) => a(k + 3))); this.writeStr(a(0), a(1), s); return s.length; } // snprintf
      case -244: this.emit("log", this.cells(a(0), a(1)).join(" ") + "\n"); return 0; // PrintArray
      case -207: for (let i = 0; i < a(2); i++) this.setCell(a(0) + 4 * i, a(1)); return 0; // cellset
      case -208: {                                                                   // cellcopy
        const num = Math.min(a(3), a(4));
        const src = this.cells(a(1) + 4 * a(2), num);
        src.forEach((v, i) => this.setCell(a(0) + 4 * i, v));
        return num;
      }
      case -209: this.stacks[argc > 1 ? a(1) : 0] = { cap: a(2), data: [] }; return 0;  // PushPopInit
      case -210: return this.push(this.cells(a(0), a(2)), argc > 1 ? a(1) : 0);         // Push
      case -211: { const r = this.pop(a(2), argc > 1 ? a(1) : 0); if (!r) return 0; r.forEach((v, i) => this.setCell(a(0) + 4 * i, v)); return 1; } // Pop
      case -212: return this.stacks[argc ? a(0) : 0]?.data.length ?? 0;             // PPReady
      case -213: { const s = this.stacks[argc ? a(0) : 0]; return s ? s.cap - s.data.length : 0; } // PPFree
      case -221: {                                                                   // CollisionTest
        const n1 = a(4), n2 = a(5), nd = a(6), m = Math.min(n1, n2);
        let hits = 0;
        for (let i = 0; i < m; i++) if (this.cell(a(0) + 4 * i) && this.cell(a(1) + 4 * i)) { hits++; if (nd > i) this.setCell(a(2) + 4 * i, a(3)); }
        return hits;
      }

      // walkers
      case -118: return argc > 1 && a(1) >= 0 ? G.walker(a(0) * 9 + a(1)) : G.walker(a(0)); // _w
      case -101: { const r = G.stepWalker(this.cell(a(0)), argc > 1 ? a(1) : 2); this.setCell(a(0), r.w); return r.crossed ? 1 : 0; } // WalkerMove
      case -102: this.setCell(a(0), G.turnWalker(this.cell(a(0)), argc > 1 && a(1) === 1)); return 0; // WalkerTurn
      case -103: {                                                                   // WalkerDiff
        const w = a(0), i = G.wIndex(w), j = G.wIndex(a(1));
        const d = G.wDir(w), r = G.rightOf(d, G.normalOf(G.POS[i]));
        const diff = G.sub(G.POS[j], G.POS[i]);
        this.setCell(a(2), Math.round(G.dot(diff, r) / 2));
        this.setCell(a(3), Math.round(G.dot(diff, d) / 2));
        return G.bestStep(w, j);
      }
      case -108: {                                                                   // WalkerStepTo
        const w = this.cell(a(0)), step = G.bestStep(w, G.wIndex(a(1)));
        if (step) this.setCell(a(0), G.stepWalker(w, step).w);
        return step;
      }
      case -105: return G.OPPOSITE_STEP[a(0)] ?? a(0);                               // OppositeStep
      case -106: { const p = G.POS[G.wIndex(a(0))]; return G.walker(G.indexAt(G.mul(p, -1))); } // GetSymmetrySquare
      case -107: {                                                                   // WalkerTap
        const s = this.pendingSide();
        if (s < 0) { this.setCell(a(1), 0); return 0; }
        const w = this.cell(a(0)), side = (G.wIndex(w) / 9) | 0;
        if (s === side) { this.setCell(a(1), 1); return 0; }
        if (s === 5 - side) { this.setCell(a(1), -1); return 0; }
        this.setCell(a(1), 0);
        const turned = G.makeWalker(G.wIndex(w), G.FACES[s].n);
        const r = G.stepWalker(turned, 2);
        this.setCell(a(0), r.w);
        return r.crossed ? 2 : 1;
      }
      case -111: G.wDir(a(0)).forEach((v, k) => this.setCell(a(1) + 4 * k, v)); return 0;    // WalkerGetDir
      case -113: G.normalOf(G.POS[G.wIndex(a(0))]).forEach((v, k) => this.setCell(a(1) + 4 * k, v)); return 0; // WalkerGetNorm
      case -112: {                                                                   // WalkerSetDir
        const w = this.cell(a(0)), v = this.cells(a(1), 3).map(Math.sign);
        const n = G.normalOf(G.POS[G.wIndex(w)]);
        if (G.dot(v, n) !== 0 || G.dot(v, v) !== 1) return 0;
        this.setCell(a(0), G.makeWalker(G.wIndex(w), v));
        return 1;
      }
      case -116: {                                                                   // WalkerDirUp
        const w = this.cell(a(0)), i = G.wIndex(w), n = G.normalOf(G.POS[i]);
        const up = this.up, inPlane = G.sub(up, G.mul(n, G.dot(up, n)));
        if (Math.hypot(...inPlane) * 256 < (argc > 2 ? a(2) : 50)) return 0;
        const f = G.FACES[(i / 9) | 0];
        const cands = [G.mul(f.v, -1), f.u, f.v, G.mul(f.u, -1)];
        const best = cands.reduce((b, c) => (G.dot(c, inPlane) > G.dot(b, inPlane) ? c : b));
        const nw = G.makeWalker(i, best);
        this.setCell(a(0), nw);
        return nw === w ? 2 : 1;
      }
      case -117: { const d = G.dot(G.wDir(a(0)), G.wDir(a(1))); return d; }          // WalkerCompareDir
      case -114: {                                                                   // WalkerBuddy
        const w = a(0), j = G.wIndex(a(1));
        for (const s of [2, 3, 4, 5]) if (G.wIndex(G.stepWalker(w, s).w) === j) { this.setCell(a(2), s); return 1; }
        return 0;
      }

      // sound
      case -150: case -153: case -159: {                                            // Play, Melody, PlayAtCh
        const name = this.str(index === -159 ? a(1) : a(0));
        this.emit("sound", { name, melody: index === -153 });
        return 0;
      }
      case -165: this.emit("sound", { name: `file ${a(1)}` }); return 0;
      case -151: case -152: case -160: case -162: case -163: return 0;
      case -164: return 0;
      case -154: case -155: this.waitUntil(() => this.soundOver()); return 0;       // WaitPlayOver, WaitMelodyOver
      case -157: case -158: case -161: return this.soundOver() ? 1 : 0;              // IsPlayOver etc.
      case -156: this.emit("quiet"); return 0;                                       // Quiet

      // system
      case -233: this.seed = (a(0) >>> 0) || 1; return 0;                            // SetRndSeed
      case -234: return a(0) > 0 ? this.rnd() % a(0) : 0;                            // GetRnd
      case -235: case -237: case -238: return 0;
      case -220: this.emit("vibrate", argc ? a(0) : 100); return 0;                 // Vibrate
      case -243: return 0;                                                           // ICON
      case -250: return 4;                                                           // ApiVer
      case -219: return 0;                                                           // IsGameResetRequest
      case -232: case -225: this.stop("ended"); this.M._sim_raise(ERR_EXIT); return 0; // StartGameMenu, StartApp
      case -229: this.restartRequested = true; this.M._sim_raise(ERR_EXIT); return 0; // Restart
      case -240: {                                                                   // Score
        const score = a(0), flag = argc > 1 ? a(1) : 0, voice = argc > 2 ? a(2) : 1, dbl = argc > 3 ? a(3) : 1;
        this.showScore(score, flag);
        this.emit("score", { score, flag, voice: !!voice });
        if (dbl) {
          const since = this.now;
          this.waitUntil(() => this.lastTapAt > since && (this.pending & (1 << TAP_DOUBLE)) !== 0);
          this.registered |= 1 << TAP_DOUBLE | 1 << TAP_GENERIC;
          this.pending = 0;
        }
        return 0;
      }
      case -239: {                                                                   // ModeSelect
        const max = Math.max(1, Math.min(6, a(0)));
        this.leds.fill(0);
        for (let s = 0; s < max; s++) for (let q = 0; q < 9; q++) if (FONT[s + 1][q] === "1") this.leds[s * 9 + q] = 0x00406000;
        this.emit("frame");
        this.emit("log", `ModeSelect: tap a lit side (1 to ${max})\n`);
        this.pending = 0;
        this.modeResult = 0;
        this.waitUntil(() => { const s = this.lastTapSide; if (this.pending && s >= 0 && s < max) { this.modeResult = s + 1; return true; } this.pending = 0; return false; });
        this.resumeValue = () => this.modeResult;
        return 0;
      }
      case -245: return 0;                                                           // RegisterVariable
      case -246: this.variables.set(this.str(a(0)), this.cells(a(1), a(2))); this.emit("variables"); return 1; // StoreVariable
      case -247: {                                                                   // LoadVariable
        const v = this.variables.get(this.str(a(0)));
        if (!v) return 0;
        v.slice(0, a(2)).forEach((x, i) => this.setCell(a(1) + 4 * i, x));
        return 1;
      }
      case -248: this.emit("log", `shell: ${this.str(a(0))}\n`); return 0;          // shell
      case -222: case -223: return 0;                                                // sscanf, GetShellMsg
      case -224: return 0;                                                           // GetChargingState
      case -226: return 3900;                                                        // GetSystemVoltage
      case -227: return 1;                                                           // IsUsbConnected
      case -130: case -132: case -133: case -134: case -135: return 0;               // scores and profiles
      default:
        if (index <= -180 && index >= -190) return 0;                                // radio
        return this.fail(`the simulator doesn't support native ${index} yet`);
    }
  }

  push(values, pp) {
    const s = this.stacks[pp];
    if (!s) return this.fail(`Push Pop array ${pp} is not initialised (call PushPopInit)`);
    if (s.data.length + values.length > s.cap) return this.fail(`Push Pop array ${pp} is full`);
    s.data.push(...Array.from(values, (v) => v | 0));
    return 1;
  }
  pop(n, pp) {
    const s = this.stacks[pp];
    if (!s) { this.fail(`Push Pop array ${pp} is not initialised (call PushPopInit)`); return null; }
    if (s.data.length < n) { this.fail(`Push Pop array ${pp} is empty`); return null; }
    return s.data.splice(s.data.length - n, n);
  }

  showScore(score, flag) {
    // three digits on the three sides facing the viewer: hundreds, tens, units
    const colors = [0x0040ff00, 0xffc00000, 0xff000000];
    const digits = String(Math.max(0, Math.min(999, score))).padStart(3, " ");
    this.leds.fill(0);
    [2, 0, 3].forEach((side, k) => {
      const d = digits[k];
      if (d === " ") return;
      for (let q = 0; q < 9; q++) if (FONT[+d][q] === "1") this.leds[side * 9 + q] = flag === 1 ? [0xff000000, 0x00ff0000, 0x0000ff00][k] : colors[flag] ?? colors[0];
    });
    this.emit("frame");
  }
}

// ---------- colour maths (colours are 0xRRGGBB00) ----------
const parts = (c) => [(c >>> 24) & 255, (c >>> 16) & 255, (c >>> 8) & 255];
const join = ([r, g, b]) => ((r << 24) | (g << 16) | (b << 8)) >>> 0;
function scale(c, k) { return join(parts(c).map((x) => Math.min(255, (x * k) >> 8))); }
function mix(a, b, f) { const pa = parts(a), pb = parts(b); return join(pa.map((x, i) => f(x, pb[i]))); }
function scaleSub(c, d) { return join(parts(c).map((x) => Math.max(0, x - d))); }
function adj(c, pint) { return join(parts(c).map((x) => Math.max(0, Math.min(255, Math.round(x * (100 + pint) / 100))))); }
function bright(c) { const [r, g, b] = parts(c); return r + g + b; }

// What an LED of this value looks like on screen (the cube's LEDs are bright even at low values).
export function ledCss(c) {
  const [r, g, b] = parts(c).map((x) => Math.round(255 * Math.min(1, Math.pow(x / 160, 0.6))));
  return `rgb(${r},${g},${b})`;
}
