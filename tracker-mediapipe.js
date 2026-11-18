/* MPGaze — alternative gaze tracker: MediaPipe Face Landmarker (478 landmarks incl. irises + head pose)
 * → hand-crafted, head-pose-aware eye features → ridge regression fitted on the calibration clicks.
 *
 * Why: WebGazer regresses raw eye-patch pixels and has no explicit head-pose input, so a small head
 * movement or the eyelid drooping when looking down (webcam ABOVE the screen) shifts every prediction.
 * Here the regression sees, per eye:
 *   u, v   iris centre relative to the eye corners (normalised by eye width, roll-invariant)
 *   open   eyelid aperture (upper–lower lid / eye width) — the lid drops when looking at the bottom of
 *          the screen, so this carries vertical gaze information the occluded iris loses
 *   vlid   iris centre relative to the upper lid
 * plus head rotation/translation (facial transformation matrix), face position/size in the image and,
 * if available, MediaPipe's eye blendshapes (eyeLookUp/Down/In/Out, eyeBlink).
 * Feature design follows the common landmark-based approach (iris offset to eye corners, normalised by
 * eye size, head pose as extra regressors); ridge regression as in WebGazer / Gudi et al. (2020).
 */
(function (global) {
  'use strict';

  const VERSION = '0.10.3';
  const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
  const SOURCES = [
    // Local copies first (run tools/download_models.py once) — works offline / where Google is blocked.
    { module: './vendor/tasks-vision/vision_bundle.mjs', wasm: './vendor/tasks-vision/wasm', model: './vendor/face_landmarker.task' },
    { module: [CDN, `${CDN}/vision_bundle.mjs`, `${CDN}/vision_bundle.js`], wasm: `${CDN}/wasm`, model: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task' }
  ];
  // Face-mesh indices (google-ai-edge/mediapipe face_mesh_connections.py).
  // "R"/"L" are the subject's right/left eye. a → b runs image-left → image-right for both eyes.
  const EYES = {
    R: { a: 33, b: 133, upper: 159, lower: 145, iris: [469, 470, 471, 472] },
    L: { a: 362, b: 263, upper: 386, lower: 374, iris: [474, 475, 476, 477] }
  };
  const NOSE = 1;
  const BLENDS = ['eyeLookUpLeft', 'eyeLookUpRight', 'eyeLookDownLeft', 'eyeLookDownRight', 'eyeLookInLeft', 'eyeLookInRight', 'eyeLookOutLeft', 'eyeLookOutRight', 'eyeBlinkLeft', 'eyeBlinkRight'];
  const BLINK_OPEN = 0.13; // eyelid aperture below this = blink / eyes closed → frame ignored

  /* ---------------- feature extraction (pure; unit-testable) ---------------- */
  function eyeFeatures(lm, e, vw, vh) {
    const P = (i) => [lm[i].x * vw, lm[i].y * vh];
    const a = P(e.a); const b = P(e.b);
    const w = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const ex = [(b[0] - a[0]) / w, (b[1] - a[1]) / w]; const ey = [-ex[1], ex[0]];
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const ring = e.iris.map(P); const c = [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
    const up = P(e.upper); const lo = P(e.lower);
    const dot = (p, q) => p[0] * q[0] + p[1] * q[1];
    const d = [c[0] - mid[0], c[1] - mid[1]];
    return {
      u: dot(d, ex) / w, v: dot(d, ey) / w,
      open: Math.hypot(up[0] - lo[0], up[1] - lo[1]) / w,
      vlid: dot([c[0] - up[0], c[1] - up[1]], ey) / w,
      width: w
    };
  }
  function matrixFeatures(m) {
    const d = m && (m.data || m);
    if (!d || d.length < 16) return new Array(12).fill(0);
    // Rotation entries are the same 9 slots whether the 4x4 is row- or column-major;
    // translation sits in 3/7/11 (row-major) or 12/13/14 (column-major) — take the larger.
    const rot = [0, 1, 2, 4, 5, 6, 8, 9, 10].map((i) => d[i]);
    const tA = [d[3], d[7], d[11]]; const tB = [d[12], d[13], d[14]];
    const t = Math.hypot(...tA) > Math.hypot(...tB) ? tA : tB;
    return [...rot, t[0] / 10, t[1] / 10, t[2] / 50];
  }
  function blendFeatures(blendshapes) {
    const cats = blendshapes?.categories || blendshapes || [];
    const map = Object.fromEntries((Array.isArray(cats) ? cats : []).map((c) => [c.categoryName || c.category_name, c.score]));
    return BLENDS.map((n) => (typeof map[n] === 'number' ? map[n] : 0));
  }
  /** Returns { f: number[], open, ok } or null if no face. */
  function extractFeatures(lm, matrix, blendshapes, vw, vh) {
    if (!lm || lm.length < 478) return null;
    const R = eyeFeatures(lm, EYES.R, vw, vh); const L = eyeFeatures(lm, EYES.L, vw, vh);
    const open = (R.open + L.open) / 2;
    const u = (R.u + L.u) / 2; const v = (R.v + L.v) / 2;
    const f = [
      R.u, R.v, R.open, R.vlid, L.u, L.v, L.open, L.vlid,
      ...matrixFeatures(matrix),
      lm[NOSE].x - 0.5, lm[NOSE].y - 0.5, (R.width + L.width) / vw,
      ...blendFeatures(blendshapes),
      u * u, v * v, u * v, open * open, v * open, u * open
    ];
    return { f, open, ok: open > BLINK_OPEN };
  }

  /* ---------------- ridge regression (standardised features, closed form) ---------------- */
  function solve(A, b) { // Gaussian elimination with partial pivoting, A is n×n
    const n = A.length; const M = A.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < n; c += 1) {
      let p = c; for (let r = c + 1; r < n; r += 1) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (Math.abs(M[p][c]) < 1e-12) return null;
      [M[c], M[p]] = [M[p], M[c]];
      for (let r = c + 1; r < n; r += 1) { const k = M[r][c] / M[c][c]; if (k) for (let j = c; j <= n; j += 1) M[r][j] -= k * M[c][j]; }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r -= 1) { let s = M[r][n]; for (let j = r + 1; j < n; j += 1) s -= M[r][j] * x[j]; x[r] = s / M[r][r]; }
    return x;
  }
  function fitRidge(X, Y, lambda) {
    const n = X.length; const d = X[0].length;
    const mean = new Array(d).fill(0); const std = new Array(d).fill(0);
    X.forEach((r) => r.forEach((v, j) => { mean[j] += v / n; }));
    X.forEach((r) => r.forEach((v, j) => { std[j] += (v - mean[j]) ** 2 / n; }));
    for (let j = 0; j < d; j += 1) std[j] = Math.sqrt(std[j]) || 1;
    const Z = X.map((r) => r.map((v, j) => (v - mean[j]) / std[j]));
    const ym = Y.reduce((a, b) => a + b, 0) / n;
    const A = Array.from({ length: d }, () => new Array(d).fill(0)); const b = new Array(d).fill(0);
    Z.forEach((z, i) => { const y = Y[i] - ym; for (let p = 0; p < d; p += 1) { b[p] += z[p] * y; for (let q = p; q < d; q += 1) A[p][q] += z[p] * z[q]; } });
    for (let p = 0; p < d; p += 1) { for (let q = 0; q < p; q += 1) A[p][q] = A[q][p]; A[p][p] += lambda; }
    const w = solve(A, b);
    return w ? { w, mean, std, ym } : null;
  }
  const predictRidge = (m, f) => m.ym + f.reduce((s, v, j) => s + m.w[j] * (v - m.mean[j]) / m.std[j], 0);
  function median(a) { const s = a.filter(Number.isFinite).sort((x, y) => x - y); if (!s.length) return null; const k = Math.floor(s.length / 2); return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; }

  /** Leave-one-calibration-point-out CV over lambda; then fit on all data. */
  function train(samples, lambdas = [0.3, 1, 3, 10, 30, 100, 300, 1000]) {
    const groups = [...new Set(samples.map((s) => s.group))];
    if (groups.length < 5 || samples.length < 20) return { ok: false, reason: 'not enough calibration samples with a detected face', n: samples.length };
    let best = null;
    lambdas.forEach((lambda) => {
      const errs = [];
      groups.forEach((g) => {
        const tr = samples.filter((s) => s.group !== g); const te = samples.filter((s) => s.group === g);
        const mx = fitRidge(tr.map((s) => s.f), tr.map((s) => s.x), lambda); const my = fitRidge(tr.map((s) => s.f), tr.map((s) => s.y), lambda);
        if (!mx || !my) return;
        const px = median(te.map((s) => predictRidge(mx, s.f))); const py = median(te.map((s) => predictRidge(my, s.f)));
        errs.push(Math.hypot(px - te[0].x, py - te[0].y));
      });
      const e = median(errs);
      if (e != null && (!best || e < best.cvErrorPx)) best = { lambda, cvErrorPx: e };
    });
    if (!best) return { ok: false, reason: 'regression failed', n: samples.length };
    const mx = fitRidge(samples.map((s) => s.f), samples.map((s) => s.x), best.lambda);
    const my = fitRidge(samples.map((s) => s.f), samples.map((s) => s.y), best.lambda);
    return { ok: Boolean(mx && my), mx, my, lambda: best.lambda, cvErrorPx: Math.round(best.cvErrorPx), n: samples.length, points: groups.length };
  }

  /* ---------------- live tracker ---------------- */
  async function loadLandmarker(log) {
    let lastError = null;
    for (const src of SOURCES) {
      try {
        if (src.model.startsWith('./')) { const head = await fetch(src.model, { method: 'HEAD' }); if (!head.ok) continue; }
        let api = null;
        for (const url of [].concat(src.module)) {
          try { const mod = await import(url); api = mod.FaceLandmarker ? mod : mod.default; if (api?.FaceLandmarker) break; api = null; } catch (e) { lastError = e; }
        }
        if (!api) throw lastError || new Error('module did not export FaceLandmarker');
        const fileset = await api.FilesetResolver.forVisionTasks(src.wasm);
        const opts = (delegate) => ({ baseOptions: { modelAssetPath: src.model, delegate }, runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true });
        try { return { lm: await api.FaceLandmarker.createFromOptions(fileset, opts('GPU')), source: [].concat(src.module)[0] }; } catch (gpuError) {
          log?.(`GPU delegate failed (${gpuError.message}); using CPU.`);
          return { lm: await api.FaceLandmarker.createFromOptions(fileset, opts('CPU')), source: [].concat(src.module)[0] };
        }
      } catch (error) { lastError = error; log?.(`Could not load MediaPipe from ${[].concat(src.module)[0]}: ${error.message}`); }
    }
    throw new Error(`MediaPipe Face Landmarker could not be loaded (${lastError?.message || 'no source'}). Run tools/download_models.py once, or check that cdn.jsdelivr.net and storage.googleapis.com are reachable`);
  }

  function create({ onGaze, onStatus, log } = {}) {
    const st = { video: null, stream: null, landmarker: null, running: false, buffer: [], samples: [], model: null, lastTs: 0, fps: 0, frames: 0, fpsAt: 0, face: false, eyesOpen: false, source: '' };
    async function start() {
      st.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      const video = document.createElement('video'); video.autoplay = true; video.muted = true; video.playsInline = true; video.srcObject = st.stream;
      st.video = video; await video.play().catch(() => {});
      const loaded = await loadLandmarker(log); st.landmarker = loaded.lm; st.source = loaded.source;
      st.running = true; loop();
      return video;
    }
    function loop() {
      if (!st.running) return;
      const v = st.video;
      const schedule = () => (v.requestVideoFrameCallback ? v.requestVideoFrameCallback(loop) : requestAnimationFrame(loop));
      if (v.readyState >= 2 && v.videoWidth) {
        let ts = performance.now(); if (ts <= st.lastTs) ts = st.lastTs + 1; st.lastTs = ts;
        let res = null; try { res = st.landmarker.detectForVideo(v, ts); } catch (_) { res = null; }
        const lm = res?.faceLandmarks?.[0] || res?.face_landmarks?.[0];
        const mat = res?.facialTransformationMatrixes?.[0] || res?.facial_transformation_matrixes?.[0];
        const bs = res?.faceBlendshapes?.[0] || res?.face_blendshapes?.[0];
        const feat = lm ? extractFeatures(lm, mat, bs, v.videoWidth, v.videoHeight) : null;
        st.face = Boolean(feat); st.eyesOpen = Boolean(feat?.ok);
        st.frames += 1; if (ts - st.fpsAt > 1000) { st.fps = Math.round(1000 * st.frames / (ts - st.fpsAt)); st.frames = 0; st.fpsAt = ts; onStatus?.({ face: st.face, eyesOpen: st.eyesOpen, fps: st.fps }); }
        if (feat?.ok) {
          st.buffer.push({ t: ts, f: feat.f }); while (st.buffer.length && ts - st.buffer[0].t > 2000) st.buffer.shift();
          if (st.model) {
            const x = predictRidge(st.model.mx, feat.f); const y = predictRidge(st.model.my, feat.f);
            const W = innerWidth; const H = innerHeight;
            onGaze?.(Math.max(-0.1 * W, Math.min(1.1 * W, x)), Math.max(-0.1 * H, Math.min(1.1 * H, y)), ts);
          }
        }
      }
      schedule();
    }
    return {
      start,
      get video() { return st.video; },
      get source() { return st.source; },
      status: () => ({ face: st.face, eyesOpen: st.eyesOpen, fps: st.fps }),
      /** Use frames from the 500 ms before the click (the eyes are on the dot by then). */
      addCalibrationPoint(x, y, group, clickAt = performance.now()) {
        const frames = st.buffer.filter((b) => clickAt - b.t >= 30 && clickAt - b.t <= 500);
        frames.forEach((b) => st.samples.push({ f: b.f, x, y, group }));
        return frames.length;
      },
      train() { const r = train(st.samples); if (r.ok) st.model = { mx: r.mx, my: r.my }; return { ok: r.ok, reason: r.reason, lambda: r.lambda, cvErrorPx: r.cvErrorPx, samples: r.n, points: r.points }; },
      clear() { st.samples = []; st.model = null; },
      pause() { st.running = false; },
      resume() { if (!st.running && st.landmarker) { st.running = true; loop(); } },
      stop() { st.running = false; st.stream?.getTracks().forEach((t) => t.stop()); }
    };
  }

  global.MPGaze = { create, extractFeatures, fitRidge, predictRidge, train, EYES };
})(typeof window !== 'undefined' ? window : globalThis);
