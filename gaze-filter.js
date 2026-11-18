/* GazeFilter — stabilises a noisy webcam gaze stream.
 *
 * Pipeline (strong mode):  raw → median-of-3 spike removal → fixation lock → One Euro filter
 *
 * 1. Median of the last 3 samples removes single-frame spikes (blinks, landmark glitches) that a
 *    low-pass filter would only smear out.
 * 2. Fixation lock (dispersion-threshold idea, cf. I-DT, Salvucci & Goldberg 2000): while new samples
 *    stay within `radius` px of the current fixation centre, output the running mean of the fixation
 *    (the eyes are physically still, so the jitter is pure noise). A sample outside the radius is
 *    ignored unless `confirm` consecutive samples land outside AND close to each other — then it is
 *    a real saccade and the cursor jumps there at once (no slow drift behind the eyes).
 * 3. One Euro filter (Casiez et al. 2012) smooths what is left: strong smoothing when slow,
 *    little lag when fast.
 *
 * Smoothing reduces jitter (precision). It cannot remove a constant offset (accuracy) — that needs
 * better calibration.
 */
(function (global) {
  'use strict';

  const PRESETS = {
    off: { median: 1, lock: false, euro: false },
    light: { median: 1, lock: false, euro: true, minCutoff: 1.2, beta: 0.015 },
    strong: { median: 3, lock: true, euro: true, minCutoff: 0.8, beta: 0.02, radius: 70, confirm: 3, window: 20 }
  };

  const lowPass = (prev, value, alpha) => prev + alpha * (value - prev);
  const alphaFor = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff) / dt);
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); const k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };

  function create(level = 'strong', overrides = {}) {
    let cfg = { ...PRESETS[level] || PRESETS.strong, ...overrides };
    let hist = []; let fix = null; let cand = []; let euro = null;

    function reset() { hist = []; fix = null; cand = []; euro = null; }

    function medianStage(x, y) {
      hist.push([x, y]); if (hist.length > cfg.median) hist.shift();
      if (cfg.median <= 1 || hist.length < 3) return [x, y];
      return [med(hist.map((p) => p[0])), med(hist.map((p) => p[1]))];
    }

    function lockStage(x, y) {
      if (!cfg.lock) return [x, y];
      if (!fix) { fix = { pts: [[x, y]], cx: x, cy: y }; return [x, y]; }
      const inside = Math.hypot(x - fix.cx, y - fix.cy) <= cfg.radius;
      if (inside) {
        cand = [];
        fix.pts.push([x, y]); if (fix.pts.length > cfg.window) fix.pts.shift();
        fix.cx = fix.pts.reduce((a, p) => a + p[0], 0) / fix.pts.length;
        fix.cy = fix.pts.reduce((a, p) => a + p[1], 0) / fix.pts.length;
        return [fix.cx, fix.cy];
      }
      // Outside: candidate saccade. Need `confirm` samples that agree with each other.
      cand.push([x, y]);
      const mx = cand.reduce((a, p) => a + p[0], 0) / cand.length; const my = cand.reduce((a, p) => a + p[1], 0) / cand.length;
      const coherent = cand.every((p) => Math.hypot(p[0] - mx, p[1] - my) <= cfg.radius);
      if (!coherent) cand = [[x, y]];
      if (cand.length >= cfg.confirm) { fix = { pts: cand.slice(), cx: mx, cy: my }; cand = []; euro = null; return [mx, my]; }
      return [fix.cx, fix.cy]; // hold until the saccade is confirmed
    }

    function euroStage(x, y, t) {
      if (!cfg.euro) return [x, y];
      if (!euro || t <= euro.t || t - euro.t > 250) { euro = { x, y, rx: x, ry: y, dx: 0, dy: 0, t }; return [x, y]; }
      const dt = (t - euro.t) / 1000; const da = alphaFor(1, dt);
      euro.dx = lowPass(euro.dx, (x - euro.rx) / dt, da); euro.dy = lowPass(euro.dy, (y - euro.ry) / dt, da);
      euro.x = lowPass(euro.x, x, alphaFor(cfg.minCutoff + cfg.beta * Math.abs(euro.dx), dt));
      euro.y = lowPass(euro.y, y, alphaFor(cfg.minCutoff + cfg.beta * Math.abs(euro.dy), dt));
      euro.rx = x; euro.ry = y; euro.t = t;
      return [euro.x, euro.y];
    }

    return {
      get level() { return level; },
      setLevel(next) { level = PRESETS[next] ? next : 'strong'; cfg = { ...PRESETS[level], ...overrides }; reset(); },
      reset,
      /** t in ms. Returns { x, y }. */
      push(x, y, t) {
        let [px, py] = medianStage(x, y);
        [px, py] = lockStage(px, py);
        [px, py] = euroStage(px, py, t);
        return { x: px, y: py };
      }
    };
  }

  global.GazeFilter = { create, PRESETS };
})(typeof window !== 'undefined' ? window : globalThis);
