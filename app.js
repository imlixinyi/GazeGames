/* Webcam gaze-selection experiment (BCI simulation):
 * camera → 9-point calibration → validation → trials → NASA-TLX/SUS → results dashboard + export.
 * Add ?sim=1 to the URL to drive the gaze cursor with the mouse (test mode, flagged in the data). */
(() => {
  'use strict';

  const SCHEMA_VERSION = '2.0';
  const params = new URLSearchParams(location.search);
  const SIM = params.has('sim');
  const SIM_NOISE_PX = Number(params.get('noise') ?? 35); // jitter that mimics webcam gaze noise
  const ROUND_S = clamp0(Number(params.get('round')) || 60, 5, 600); // game round length, ?round=30 for shorter demos
  function clamp0(v, a, b) { return Math.max(a, Math.min(b, v)); }

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const screens = $$('.screen');
  const statusChip = $('#status-chip');
  const targets = $$('.target');

  const state = {
    participantId: '', condition: 'both', taskType: 'choice', searchType: 'mixed', setSize: 'mixed',
    practiceCount: 4, fixationMs: 500, timeoutMs: 5000, dwellMs: 800, trialCount: 24,
    screen: 'start', cameraReady: false, previewStream: null, webgazerReady: false, webgazerStarting: false,
    webgazerInitPromise: null, cameraWaitingForGaze: false,
    gazeSamples: [], trials: [], calibration: [], calibrationCorrection: null, gazeFilter: null, smoothing: 'strong', game: null, gameResults: [], currentGame: null,
    validation: null, validationHistory: [], validationPointSamples: [], validationActivePoint: null,
    validationPointStartedAt: 0, validationTimer: null,
    trialPlan: [], currentTrial: 0, practice: false, resumeTrialsAfterValidation: false,
    trial: null, // live state of the running trial
    trialTimeoutTimer: null, trialAdvanceTimer: null, fixationTimer: null, hudTimer: null,
    questionnaire: null, startedAt: new Date().toISOString()
  };

  // Calibration and validation use exactly the same screen-relative positions (% of board).
  const gazeTestPositions = [[5, 8], [50, 8], [95, 8], [5, 50], [50, 50], [95, 50], [5, 92], [50, 92], [95, 92]];
  // Calibration adds 4 inner points (13 total): denser coverage of the vertical axis, which is the
  // weak axis for a webcam mounted above the screen (small vertical eye rotation, lids occlude the iris).
  const calibrationPositions = [...gazeTestPositions, [27.5, 29], [72.5, 29], [27.5, 71], [72.5, 71]];
  const DROP_TOLERANCE_MS = 120; // dwell survives brief gaze drop-outs shorter than this
  const VALIDATION_PASS = 55;

  /* ---------------- utilities ---------------- */
  const now = () => performance.now();
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const setMessage = (selector, message) => { const node = $(selector); if (node) node.textContent = message || ''; };
  const isFullscreen = () => Boolean(document.fullscreenElement);
  const waitForLayout = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const csvEscape = (value) => { const text = value == null ? '' : String(value); return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; };
  const timestamp = () => new Date().toISOString().replace(/[:.]/g, '-');
  const modeLabel = (mode) => (mode === 'gaze' ? 'Gaze' : 'Mouse');
  function median(values) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
  function shuffle(values) {
    const result = values.slice();
    for (let i = result.length - 1; i > 0; i -= 1) { const j = Math.floor(Math.random() * (i + 1)); [result[i], result[j]] = [result[j], result[i]]; }
    return result;
  }
  function download(filename, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement('a'); link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function rectOf(node) { const r = node.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) }; }

  function showScreen(name) {
    screens.forEach((screen) => screen.classList.toggle('screen-active', screen.id === `screen-${name}`));
    state.screen = name;
    const labels = { final: 'Questionnaire', hub: 'Choose a game', bye: 'Finished', game: 'Playing', start: 'Ready', camera: 'Camera', calibration: 'Calibrating', validation: 'Validating', trial: 'Trials running', questionnaire: 'Questionnaire', complete: 'Complete' };
    statusChip.textContent = labels[name] || '';
    document.body.dataset.screen = name;
    placeVideo(name);
  }

  /* ---------------- calibration correction (bounded affine residual fit) ---------------- */
  function solve3x3(input, right) {
    const m = input.map((row, i) => [...row, right[i]]);
    for (let c = 0; c < 3; c += 1) {
      let pivot = c;
      for (let r = c + 1; r < 3; r += 1) if (Math.abs(m[r][c]) > Math.abs(m[pivot][c])) pivot = r;
      if (Math.abs(m[pivot][c]) < 1e-8) return null;
      [m[c], m[pivot]] = [m[pivot], m[c]];
      const d = m[c][c];
      for (let k = c; k < 4; k += 1) m[c][k] /= d;
      for (let r = 0; r < 3; r += 1) { if (r === c) continue; const f = m[r][c]; for (let k = c; k < 4; k += 1) m[r][k] -= f * m[c][k]; }
    }
    return m.map((row) => row[3]);
  }
  const correctionFeatures = (x, y) => [1, (x / Math.max(1, innerWidth) - 0.5) * 2, (y / Math.max(1, innerHeight) - 0.5) * 2];
  function buildCalibrationCorrection() {
    const grouped = new Map();
    state.calibration.forEach((entry) => {
      if (!Number.isFinite(entry.predictedX) || !Number.isFinite(entry.predictedY)) return;
      if (!grouped.has(entry.point)) grouped.set(entry.point, []);
      grouped.get(entry.point).push(entry);
    });
    // Later clicks on a point reflect a better-trained model; use the last 3.
    const points = [...grouped.values()].map((entries) => {
      const recent = entries.slice(-3);
      const predictedX = median(recent.map((e) => e.predictedX)); const predictedY = median(recent.map((e) => e.predictedY));
      return { targetX: entries[0].x, targetY: entries[0].y, predictedX, predictedY, residualX: entries[0].x - predictedX, residualY: entries[0].y - predictedY };
    });
    if (points.length < 5) { state.calibrationCorrection = null; return; }
    const normal = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]; const rightX = [0, 0, 0]; const rightY = [0, 0, 0];
    points.forEach((p) => {
      const f = correctionFeatures(p.predictedX, p.predictedY);
      for (let r = 0; r < 3; r += 1) { for (let c = 0; c < 3; c += 1) normal[r][c] += f[r] * f[c]; rightX[r] += f[r] * p.residualX; rightY[r] += f[r] * p.residualY; }
    });
    for (let i = 0; i < 3; i += 1) normal[i][i] += 0.08; // ridge term for stability
    const xCoefficients = solve3x3(normal, rightX); const yCoefficients = solve3x3(normal, rightY);
    if (!xCoefficients || !yCoefficients) { state.calibrationCorrection = null; return; }
    state.calibrationCorrection = {
      enabled: true, gain: 0.5, maxPx: 120, sampleCount: points.length,
      medianResidualPx: Math.round(median(points.map((p) => Math.hypot(p.residualX, p.residualY))) || 0),
      xCoefficients, yCoefficients, t: Date.now()
    };
  }
  function applyGazeCorrection(x, y) {
    const c = state.calibrationCorrection;
    if (!c?.enabled) return { x, y };
    const f = correctionFeatures(x, y);
    const dot = (coeffs) => coeffs.reduce((sum, k, i) => sum + k * f[i], 0);
    const ox = clamp(c.gain * dot(c.xCoefficients), -c.maxPx, c.maxPx); const oy = clamp(c.gain * dot(c.yCoefficients), -c.maxPx, c.maxPx);
    return { x: clamp(x + ox, 0, innerWidth), y: clamp(y + oy, 0, innerHeight) };
  }

  /* ---------------- gaze stabilisation (gaze-filter.js) ----------------
   * strong = median spike removal + fixation lock + One Euro; light = One Euro only (original); off = raw. */
  function filterGaze(x, y, t) {
    if (!state.gazeFilter) state.gazeFilter = window.GazeFilter.create(state.smoothing);
    return state.gazeFilter.push(x, y, t);
  }
  const resetGazeFilter = () => { state.gazeFilter?.reset(); };
  function setSmoothing(level) {
    state.smoothing = window.GazeFilter.PRESETS[level] ? level : 'strong';
    if (state.gazeFilter) state.gazeFilter.setLevel(state.smoothing);
  }

  /* ---------------- gaze sample pipeline (shared by WebGazer and simulation) ---------------- */
  function onGazePrediction(rawX, rawY, t) {
    if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) return;
    const filtered = filterGaze(rawX, rawY, t);
    const corrected = applyGazeCorrection(filtered.x, filtered.y);
    const receivedAt = now();
    const sample = { x: Math.round(corrected.x), y: Math.round(corrected.y), filteredX: Math.round(filtered.x), filteredY: Math.round(filtered.y), rawX: Math.round(rawX), rawY: Math.round(rawY), t: Math.round(t), receivedAt, screen: state.screen, trial: state.currentTrial };
    state.gazeSamples.push(sample);
    if (state.gazeSamples.length > 12000) state.gazeSamples.splice(0, 2000); // amortised trimming
    if (state.screen === 'camera' && state.cameraWaitingForGaze) {
      state.cameraWaitingForGaze = false; state.cameraReady = true; $('#camera-next').disabled = false;
      setMessage('#camera-message', 'Camera and gaze coordinates are both live. You can start calibration.');
    }
    if (state.screen === 'trial') handleTrialGaze(sample);
    if (state.screen === 'game') state.game?.feed(sample.x, sample.y);
    if (state.screen === 'validation' && state.liveGaze) {
      const board = $('#validation-board').getBoundingClientRect(); const dot = $('#validation-live');
      if (dot) { dot.style.left = `${corrected.x - board.left}px`; dot.style.top = `${corrected.y - board.top}px`; }
    }
    if (state.screen === 'validation' && state.validationActivePoint !== null) {
      if (receivedAt - state.validationPointStartedAt < 400) return; // ignore the saccade toward the new dot + filter settling
      state.validationPointSamples[state.validationActivePoint]?.push({ x: corrected.x, y: corrected.y, rawX, rawY, t: receivedAt });
    }
  }

  /* ---------------- simulated gaze (mouse + noise) for testing without a webcam ---------------- */
  const sim = { x: innerWidth / 2, y: innerHeight / 2, timer: null };
  function gaussian() { let u = 0; let v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  function startSimulation() {
    if (sim.timer) return;
    addEventListener('pointermove', (e) => { sim.x = e.clientX; sim.y = e.clientY; }, { passive: true });
    sim.timer = setInterval(() => onGazePrediction(sim.x + gaussian() * SIM_NOISE_PX, sim.y + gaussian() * SIM_NOISE_PX, now()), 33);
    state.webgazerReady = true; state.cameraReady = true; state.cameraWaitingForGaze = false;
    $('#camera-preview').replaceChildren(Object.assign(document.createElement('span'), { className: 'preview-placeholder', textContent: 'Simulation mode: no camera used. The mouse pointer (plus Gaussian noise) acts as the gaze estimate.' }));
    $('#camera-next').disabled = false;
    setMessage('#camera-message', `Simulated gaze active (noise σ = ${SIM_NOISE_PX}px).`);
  }

  /* ---------------- camera + WebGazer ---------------- */
  function findWebgazerVideo() {
    const fromApi = typeof window.webgazer?.getVideoElement === 'function' ? window.webgazer.getVideoElement() : null;
    return fromApi || document.querySelector('#webgazerVideoFeed, #webgazerVideoContainer video');
  }
  function attachPreviewVideo(video) {
    if (!video) return false;
    state.videoEl = video;
    if (['calibration', 'validation', 'trial', 'game', 'hub'].includes(state.screen)) { placeVideo(state.screen); return true; }
    video.autoplay = true; video.muted = true; video.playsInline = true;
    video.style.display = 'block'; video.style.visibility = 'visible'; video.style.opacity = '1';
    const preview = $('#camera-preview');
    if (video.parentElement !== preview) preview.replaceChildren(video);
    video.play().catch(() => {});
    return true;
  }
  // The camera video stays visible (small, mirrored) during calibration, validation and trials:
  // it lets the participant keep the face inside the guide, and keeps the video element rendered,
  // because some browsers stop updating frames of a video inside a display:none screen.
  function placeVideo(screenName) {
    const video = state.videoEl; const thumb = $('#cam-thumb');
    if (!thumb) return;
    const inExperiment = ['calibration', 'validation', 'trial', 'game', 'hub'].includes(screenName);
    thumb.hidden = !inExperiment || SIM || !video;
    if (!video) return;
    if (inExperiment && !SIM) { if (video.parentElement !== thumb) thumb.prepend(video); }
    else if (screenName === 'camera' && video.parentElement !== $('#camera-preview')) $('#camera-preview').replaceChildren(video);
    video.play?.().catch(() => {});
  }
  async function attachNativePreviewFallback() {
    if (state.previewStream) return true;
    if (!navigator.mediaDevices?.getUserMedia) return false;
    try {
      state.previewStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
      const video = document.createElement('video'); video.srcObject = state.previewStream; attachPreviewVideo(video);
      return true;
    } catch (_) { return false; }
  }
  function initWebgazer() {
    if (!window.webgazer) { setMessage('#camera-message', 'WebGazer failed to load. Check the network (cdn.jsdelivr.net) and refresh.'); return Promise.reject(new Error('WebGazer unavailable')); }
    if (state.webgazerReady) return Promise.resolve();
    if (!window.isSecureContext) return Promise.reject(new Error('Camera needs http://localhost or HTTPS — do not open the file via file://.'));
    try {
      // Setters are called one by one (not chained): their return values differ between WebGazer builds.
      if (typeof window.webgazer.setGazeListener !== 'function') throw new Error('setGazeListener missing');
      window.webgazer.setGazeListener((data, elapsed) => { if (data) onGazePrediction(data.x, data.y, elapsed || now()); });
    } catch (error) { return Promise.reject(error); }
    const previewTimer = setInterval(() => attachPreviewVideo(findWebgazerVideo()), 150);
    let beginResult;
    try { beginResult = window.webgazer.begin(); } catch (error) { clearInterval(previewTimer); return Promise.reject(error); }
    return Promise.resolve(beginResult).then(async () => {
      clearInterval(previewTimer);
      state.webgazerReady = true;
      try {
        window.webgazer.showVideoPreview?.(false);
        window.webgazer.showPredictionPoints?.(false);
        // By default WebGazer also trains on every mouse move/click anywhere on the page, assuming the
        // eyes follow the cursor. In an experiment that is wrong (e.g. the cursor parked in a corner
        // pulls all predictions there). Only the explicit calibration points below are used for training.
        window.webgazer.removeMouseEventListeners?.();
      } catch (_) { /* optional helpers differ between builds */ }
      const hasVideo = attachPreviewVideo(findWebgazerVideo());
      if (!hasVideo) await attachNativePreviewFallback();
      // Calibration clicks are what train WebGazer, so calibration can start before the first prediction.
      state.cameraReady = true; state.cameraWaitingForGaze = true; $('#camera-next').disabled = false;
      setMessage('#camera-message', hasVideo || state.previewStream ? 'Camera and gaze model started. You can calibrate now; the model trains on your calibration clicks.' : 'Gaze model started but no video preview was found. Click “Reconnect” if the camera image stays blank.');
      setTimeout(() => {
        if (state.cameraWaitingForGaze && state.screen === 'camera') setMessage('#camera-message', 'Video is on, but no gaze coordinates arrived within 10 s. Face the camera with both eyes visible, then click “Reconnect”.');
      }, 10000);
    }).catch((error) => { clearInterval(previewTimer); throw error; });
  }
  const cameraErrors = { NotAllowedError: 'Camera permission denied. Click the camera icon in the address bar, allow access, then press “Reconnect”.', NotFoundError: 'No camera detected.', NotReadableError: 'The camera is in use by another app (WeChat, Zoom, Teams, another tab). Close it and retry.', SecurityError: 'The browser blocked the camera. Use http://localhost or HTTPS.' };
  async function startCamera() {
    if (SIM) { startSimulation(); return; }
    if (state.tracker === 'mediapipe') { startMediapipe(); return; }
    if (state.webgazerStarting) return;
    $('#camera-next').disabled = true;
    setMessage('#camera-message', 'Requesting camera permission…');
    state.webgazerStarting = true;
    try {
      if (!state.webgazerInitPromise) state.webgazerInitPromise = initWebgazer().finally(() => { state.webgazerInitPromise = null; });
      await Promise.race([state.webgazerInitPromise, new Promise((_, reject) => setTimeout(() => reject(new Error('Gaze model timed out loading. Check the network, then click “Reconnect”.')), 20000))]);
    } catch (error) {
      setMessage('#camera-message', `Camera start failed: ${cameraErrors[error?.name] || error?.message || 'check permissions and network'}`);
    } finally { state.webgazerStarting = false; }
  }

  /* ---------------- MediaPipe iris + head-pose tracker (tracker-mediapipe.js) ---------------- */
  async function startMediapipe() {
    if (state.webgazerStarting || state.mp) { if (state.mp) setMessage('#camera-message', 'Tracker already running.'); return; }
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) { setMessage('#camera-message', 'Camera needs http://localhost or HTTPS — use the launcher, not file://.'); return; }
    state.webgazerStarting = true; $('#camera-next').disabled = true;
    setMessage('#camera-message', 'Requesting camera and loading the MediaPipe face model (first load ≈ 5–10 MB)…');
    const mp = window.MPGaze.create({
      onGaze: (x, y, t) => onGazePrediction(x, y, t),
      onStatus: (st) => {
        const thumb = $('#cam-thumb'); thumb?.classList.toggle('face-ok', st.face && st.eyesOpen); thumb?.classList.toggle('face-bad', !st.face || !st.eyesOpen);
        if (state.screen === 'camera') setMessage('#camera-message', st.face ? `Face and irises detected (${st.fps} fps). Sit with your eyes level with the top of the screen, then start calibration.` : 'No face detected — face the camera, light from the front, remove anything covering the eyes.');
      },
      log: (m) => console.warn('[MPGaze]', m)
    });
    try {
      const video = await mp.start();
      state.mp = mp; state.webgazerReady = true; state.cameraReady = true;
      attachPreviewVideo(video);
      $('#camera-next').disabled = false;
    } catch (error) {
      try { mp.stop(); } catch (_) { /* ignore */ }
      setMessage('#camera-message', `MediaPipe tracker failed: ${cameraErrors[error?.name] || error?.message}. To use the original tracker instead, reload the page and choose “WebGazer” under Gaze tracker.`);
    } finally { state.webgazerStarting = false; }
  }

  /* ---------------- fullscreen ---------------- */
  async function ensureExperimentFullscreen() {
    if (isFullscreen()) return true;
    if (!document.documentElement.requestFullscreen) { if (SIM) return true; setMessage('#camera-message', 'This browser does not support fullscreen. Please use a recent Chrome or Edge.'); return false; }
    try {
      await document.documentElement.requestFullscreen();
      document.body.classList.add('experiment-fullscreen');
      await waitForLayout();
      return isFullscreen();
    } catch (error) {
      if (SIM) { document.body.classList.add('experiment-fullscreen'); await waitForLayout(); return true; }
      setMessage('#camera-message', `Could not enter fullscreen: ${error.message || 'allow fullscreen and retry'}`);
      return false;
    }
  }
  const inExperimentView = () => isFullscreen() || (SIM && document.body.classList.contains('experiment-fullscreen'));

  /* ---------------- calibration ---------------- */
  function buildCalibration() {
    const board = $('#calibration-board'); board.replaceChildren();
    const clicksPerPoint = 5; const total = calibrationPositions.length * clicksPerPoint;
    let positionIndex = 0; let clicksAtPosition = 0; let lastClickAt = 0;
    const dots = calibrationPositions.map(([left, top], index) => {
      const dot = document.createElement('button');
      dot.type = 'button'; dot.className = 'calibration-dot'; dot.style.left = `${left}%`; dot.style.top = `${top}%`;
      dot.setAttribute('aria-label', `Calibration point ${index + 1}`);
      dot.addEventListener('click', () => {
        const clickAt = now();
        if (index !== positionIndex || !inExperimentView() || clickAt - lastClickAt < 150) return;
        lastClickAt = clickAt;
        const rect = board.getBoundingClientRect();
        const x = rect.left + rect.width * left / 100; const y = rect.top + rect.height * top / 100;
        // Prediction just before the click = how well the model already tracks this point.
        const recent = state.gazeSamples.filter((s) => s.screen === 'calibration' && clickAt - s.receivedAt >= 0 && clickAt - s.receivedAt <= 350).slice(-5);
        if (state.mp) state.mp.addCalibrationPoint(x, y, index, clickAt);
        else if (!SIM) window.webgazer?.recordScreenPosition?.(x, y, 'click');
        clicksAtPosition += 1;
        state.calibration.push({ point: index + 1, x: Math.round(x), y: Math.round(y), predictedX: median(recent.map((s) => s.x)), predictedY: median(recent.map((s) => s.y)), click: clicksAtPosition, t: Date.now() });
        dot.style.setProperty('--progress', clicksAtPosition / clicksPerPoint);
        setMessage('#calibration-progress', `${positionIndex * clicksPerPoint + clicksAtPosition} / ${total}`);
        if (clicksAtPosition < clicksPerPoint) return;
        dot.classList.remove('active'); dot.classList.add('done');
        positionIndex += 1; clicksAtPosition = 0;
        if (positionIndex < dots.length) dots[positionIndex].classList.add('active');
        else {
          if (state.mp) {
            state.training = state.mp.train();
            if (!state.training.ok) setMessage('#calibration-progress', `Training failed: ${state.training.reason}`);
          }
          buildCalibrationCorrection(); setTimeout(startValidation, 450);
        }
      });
      board.appendChild(dot);
      return dot;
    });
    dots[0].classList.add('active');
    setMessage('#calibration-progress', `0 / ${total}`);
  }
  async function enterCalibration() {
    if (!state.cameraReady || !(await ensureExperimentFullscreen())) return;
    document.body.classList.add('experiment-fullscreen');
    await waitForLayout();
    // The viewport changed: drop old training data so a retry cannot mix geometries.
    try {
      if (state.mp) { state.mp.clear(); state.mp.resume(); }
      else if (!SIM) { window.webgazer?.clearData?.(); window.webgazer?.resume?.(); }
    } catch (_) { /* optional */ }
    state.training = null;
    state.calibration = []; state.calibrationCorrection = null; state.gazeSamples = [];
    resetGazeFilter();
    showScreen('calibration');
    buildCalibration();
  }

  /* ---------------- validation ---------------- */
  async function startValidation() {
    if (!(await ensureExperimentFullscreen())) return;
    resetGazeFilter();
    showScreen('validation');
    const board = $('#validation-board'); board.replaceChildren();
    clearTimeout(state.validationTimer);
    state.validationPointSamples = []; state.validationActivePoint = null; state.liveGaze = false;
    ['#validation-retry', '#validation-retry-test', '#validation-continue-low', '#validation-next', '#validation-live-toggle'].forEach((id) => { $(id).hidden = true; });
    $('#validation-live-toggle').textContent = 'Show live gaze';
    $('#validation-result').hidden = true; $('#validation-score').textContent = 'Measuring…';
    // A freshly trained model needs a moment before the first prediction arrives.
    for (let i = 0; i < 20 && state.webgazerReady && !state.gazeSamples.some((g) => g.screen === 'validation'); i += 1) await new Promise((r) => setTimeout(r, 100));
    if (!state.webgazerReady || state.gazeSamples.length === 0) {
      $('#validation-result').hidden = false;
      $('#validation-result').textContent = state.webgazerReady ? 'The gaze model has started but is not producing coordinates yet. Face the screen with your eyes unobstructed, wait a few seconds, then re-run validation.' : 'The gaze model is not ready. Check that WebGazer can load, then re-run validation.';
      $('#validation-retry-test').hidden = false;
      return;
    }
    let index = 0;
    const next = () => {
      if (index >= gazeTestPositions.length) { finishValidation(); return; }
      const [left, top] = gazeTestPositions[index];
      const dot = document.createElement('div'); dot.className = 'validation-dot'; dot.style.left = `${left}%`; dot.style.top = `${top}%`;
      board.replaceChildren(dot);
      state.validationPointSamples[index] = []; state.validationActivePoint = index; state.validationPointStartedAt = now();
      index += 1;
      state.validationTimer = setTimeout(next, 1400);
    };
    next();
  }
  function finishValidation() {
    clearTimeout(state.validationTimer);
    state.validationActivePoint = null;
    $('#validation-board').replaceChildren();
    const boardRect = $('#validation-board').getBoundingClientRect();
    const points = gazeTestPositions.map(([left, top], index) => {
      const expectedX = boardRect.left + boardRect.width * left / 100; const expectedY = boardRect.top + boardRect.height * top / 100;
      const samples = state.validationPointSamples[index] || [];
      const errors = samples.map((s) => Math.hypot(s.x - expectedX, s.y - expectedY));
      const mx = median(samples.map((s) => s.x)); const my = median(samples.map((s) => s.y));
      // Precision = RMS distance of samples from their own centroid (spread, independent of bias).
      const cx = samples.reduce((a, s) => a + s.x, 0) / (samples.length || 1); const cy = samples.reduce((a, s) => a + s.y, 0) / (samples.length || 1);
      const precision = samples.length ? Math.sqrt(samples.reduce((a, s) => a + (s.x - cx) ** 2 + (s.y - cy) ** 2, 0) / samples.length) : null;
      return { point: index + 1, expectedX: Math.round(expectedX), expectedY: Math.round(expectedY), sampleCount: samples.length, medianX: mx == null ? null : Math.round(mx), medianY: my == null ? null : Math.round(my), medianErrorPx: errors.length ? Math.round(median(errors)) : null, precisionPx: precision == null ? null : Math.round(precision) };
    });
    const usable = points.filter((p) => p.sampleCount >= 3 && p.medianErrorPx !== null);
    const base = { attempt: state.validationHistory.length + 1, sampleCount: points.reduce((s, p) => s + p.sampleCount, 0), points, usablePointCount: usable.length, viewport: { width: innerWidth, height: innerHeight }, board: rectOf($('#validation-board')), correctionApplied: Boolean(state.calibrationCorrection), t: Date.now() };
    const result = $('#validation-result'); result.hidden = false;
    $('#validation-retry-test').hidden = false;
    if (usable.length < 5) {
      state.validation = { ...base, medianErrorPx: null, accuracy: null, passed: false, reason: 'insufficient-gaze-data' };
      state.validationHistory.push(state.validation);
      $('#validation-score').textContent = 'No usable data';
      result.textContent = `Validation failed: only ${usable.length} of 9 points received enough gaze samples. A visible camera image does not mean the gaze model is running — keep your eyes unobstructed and face the screen, then retry.`;
      $('#validation-retry').hidden = false; $('#validation-continue-low').hidden = false; $('#validation-live-toggle').hidden = SIM;
      return;
    }
    // Sanity check: if the estimate hardly moves while the eyes visit all nine dots, the model is not
    // tracking the eyes at all (bad face/eye detection, lighting, head moved) — recalibrating won't help
    // until that is fixed.
    const xs = usable.map((p) => p.medianX); const ys = usable.map((p) => p.medianY);
    const spanX = (Math.max(...xs) - Math.min(...xs)) / innerWidth; const spanY = (Math.max(...ys) - Math.min(...ys)) / innerHeight;
    base.estimateSpan = { x: Math.round(spanX * 100) / 100, y: Math.round(spanY * 100) / 100 };
    base.notTracking = spanX < 0.3 || spanY < 0.3;
    const medianError = median(usable.map((p) => p.medianErrorPx));
    const accuracy = clamp(Math.round(100 * (1 - medianError / 500)), 0, 100);
    const diag = Math.hypot(innerWidth, innerHeight);
    state.validation = { ...base, medianErrorPx: Math.round(medianError), medianErrorPctDiag: Math.round(1000 * medianError / diag) / 10, medianPrecisionPx: Math.round(median(usable.map((p) => p.precisionPx))), accuracy, passed: accuracy >= VALIDATION_PASS };
    state.validationHistory.push(state.validation);
    $('#validation-score').textContent = `${accuracy}% · ${state.validation.medianErrorPx}px`;
    result.textContent = state.validation.passed
      ? `Validation passed. Median error ≈ ${state.validation.medianErrorPx}px (${state.validation.medianErrorPctDiag}% of the screen diagonal). You can start the trials.`
      : `Calibration finished, but the error is large (median ${state.validation.medianErrorPx}px). Re-run validation or recalibrate first. “Continue anyway” is only for checking the flow — the session will be flagged as low accuracy.`;
    if (state.validation.notTracking) {
      result.textContent += ` Warning: when you looked at the nine dots the estimate only moved across ${Math.round(spanX * 100)}% of the screen width and ${Math.round(spanY * 100)}% of its height (it should be ~90%). The tracker is not following your eyes — check the camera thumbnail: face centred inside the oval, light from the front (no window behind you), no glasses glare, eyes level with the top of the screen, then recalibrate without moving your head. Use “Show live gaze” to check.`;
    }
    $('#validation-live-toggle').hidden = SIM;
    $('#validation-retry').hidden = state.validation.passed;
    $('#validation-next').hidden = !state.validation.passed;
    $('#validation-continue-low').hidden = state.validation.passed;
    if (!SIM) renderValidationOverlay(state.validation);
  }
  // Brief visual feedback on the board: where gaze landed vs. where the dots were.
  function renderValidationOverlay(validation) {
    const board = $('#validation-board'); const rect = board.getBoundingClientRect();
    validation.points.forEach((p) => {
      const mark = document.createElement('div'); mark.className = 'validation-mark';
      mark.style.left = `${p.expectedX - rect.left}px`; mark.style.top = `${p.expectedY - rect.top}px`;
      board.appendChild(mark);
      if (p.medianX == null) return;
      const hit = document.createElement('div'); hit.className = 'validation-hit';
      hit.style.left = `${p.medianX - rect.left}px`; hit.style.top = `${p.medianY - rect.top}px`;
      hit.title = `${p.medianErrorPx}px`;
      board.appendChild(hit);
    });
  }

  /* ---------------- trial plan ---------------- */
  const pick = (value, options) => (value === 'mixed' ? options[Math.floor(Math.random() * options.length)] : value);
  function buildSearchItems(count, searchType, targetIndex) {
    // Conjunction distractors each share exactly one feature with the red circle;
    // both distractor types are present and their positions are shuffled.
    const distractorTypes = searchType === 'feature'
      ? Array(count - 1).fill({ shape: 'circle', color: 'green' })
      : shuffle(Array.from({ length: count - 1 }, (_, i) => (i % 2 ? { shape: 'circle', color: 'green' } : { shape: 'square', color: 'red' })));
    let d = 0;
    return Array.from({ length: count }, (_, i) => (i === targetIndex ? { shape: 'circle', color: 'red', target: true } : { ...distractorTypes[d++], target: false }));
  }
  function makeTrial(cell, positionQueue) {
    const setSize = cell.taskType === 'search' ? Number(pick(state.setSize, ['4', '8'])) : 4;
    const searchType = cell.taskType === 'search' ? pick(state.searchType, ['feature', 'conjunction']) : null;
    const key = `${cell.taskType}-${cell.mode}-${cell.targetSize}-${setSize}`;
    if (!positionQueue[key]?.length) positionQueue[key] = shuffle(Array.from({ length: setSize }, (_, i) => i));
    const correctIndex = positionQueue[key].pop(); // counterbalances target location within each cell
    return { ...cell, setSize, searchType, correctIndex, items: cell.taskType === 'search' ? buildSearchItems(setSize, searchType, correctIndex) : null };
  }
  function buildTrialPlan() {
    const modes = state.condition === 'both' ? ['gaze', 'mouse'] : [state.condition];
    const taskTypes = state.taskType === 'mixed' ? ['choice', 'search'] : [state.taskType];
    const cells = taskTypes.flatMap((taskType) => modes.flatMap((mode) => ['large', 'small'].map((targetSize) => ({ mode, targetSize, taskType }))));
    const queue = {};
    const main = [];
    // Shuffled blocks of all cells keep the design balanced even if the run is cut short.
    while (main.length < state.trialCount) main.push(...shuffle(cells));
    const mainTrials = main.slice(0, state.trialCount).map((cell) => ({ ...makeTrial(cell, queue), practice: false }));
    // Practice trials are generated independently (not copies of the first main trials).
    const practiceQueue = {};
    const practiceCells = shuffle(cells);
    const practice = Array.from({ length: state.practiceCount }, (_, i) => ({ ...makeTrial(practiceCells[i % practiceCells.length], practiceQueue), practice: true }));
    return [...practice, ...mainTrials];
  }

  /* ---------------- trials ---------------- */
  function clearTrialTimers() { [state.trialTimeoutTimer, state.trialAdvanceTimer, state.fixationTimer].forEach(clearTimeout); clearInterval(state.hudTimer); }
  function beginTrials() {
    resetGazeFilter();
    state.currentTrial = 0; state.trials = []; state.gazeSamples = []; state.trialPlan = buildTrialPlan();
    showScreen('trial');
    nextTrial();
  }
  function clearHover() { targets.forEach((t) => t.classList.remove('gaze-hover')); const ring = $('#dwell-ring'); ring.style.display = 'none'; ring.style.setProperty('--p', 0); }
  function nextTrial() {
    clearTrialTimers();
    if (state.currentTrial >= state.trialPlan.length) { finishTrials(); return; }
    state.currentTrial += 1;
    const plan = state.trialPlan[state.currentTrial - 1];
    state.practice = plan.practice;
    const count = plan.setSize;
    const board = $('#trial-board');
    board.classList.toggle('search-layout', plan.taskType === 'search' && count === 8);
    targets.forEach((target, index) => {
      target.className = `target target-${String.fromCharCode(97 + index)}`;
      target.hidden = index >= count;
      if (plan.targetSize === 'small') target.classList.add('target-small');
      target.dataset.correct = String(index === plan.correctIndex);
      if (plan.taskType === 'search' && index < count) {
        const item = plan.items[index];
        target.textContent = '';
        target.classList.add(`search-${item.shape}`, `search-${item.color}`);
        target.setAttribute('aria-label', `${item.color} ${item.shape}`);
      } else { target.textContent = String.fromCharCode(65 + index); target.setAttribute('aria-label', `Letter ${target.textContent}`); }
    });
    clearHover();
    const targetLabel = targets[plan.correctIndex].dataset.target;
    state.trial = { plan, targetLabel, onsetAt: 0, gaze: [], mouse: [], dwellTarget: null, dwellStartedAt: 0, dwellLastSeenAt: 0, timedOut: false, finished: false, maxDwellProgress: {} };
    const mainIndex = state.currentTrial - state.practiceCount;
    $('#trial-index').textContent = state.practice ? `Practice ${state.currentTrial} / ${state.practiceCount}` : `Trial ${mainIndex} / ${state.trialCount}`;
    $('#trial-mode').textContent = plan.mode === 'gaze' ? `Gaze · dwell ${state.dwellMs} ms` : 'Mouse click';
    $('#trial-mode').dataset.mode = plan.mode;
    $('#trial-size').textContent = plan.taskType === 'search' ? `${plan.searchType === 'feature' ? 'Feature' : 'Conjunction'} search · ${count} items · ${plan.targetSize}` : `${plan.targetSize === 'small' ? 'Small' : 'Large'} targets`;
    $('#trial-timer').textContent = '0.0 s';
    $('#trial-title').textContent = plan.taskType === 'search' ? 'Find the red circle' : `Select “${targetLabel}”`;
    $('#trial-instruction').textContent = plan.taskType === 'search' ? 'Find the only RED CIRCLE and select it.' : `Select the letter ${targetLabel}.`;
    $('#trial-message').className = 'trial-message feedback-neutral';
    const how = plan.mode === 'gaze' ? `Look at it for ${state.dwellMs} ms — the ring fills and the selection is made automatically.` : 'Click it with the mouse.';
    $('#trial-message-text').textContent = state.practice ? `Practice (not scored). ${how}` : how;
    $('#trial-skip').hidden = true;
    $('#gaze-dot').style.display = plan.mode === 'gaze' ? 'block' : 'none';
    $('#trial-fixation').hidden = false;
    board.classList.add('fixating');
    state.fixationTimer = setTimeout(() => {
      $('#trial-fixation').hidden = true; board.classList.remove('fixating');
      state.trial.onsetAt = now();
      state.trial.boardRect = rectOf(board);
      state.trial.targetBounds = Object.fromEntries(targets.filter((t) => !t.hidden).map((t) => [t.dataset.target, rectOf(t)]));
      state.hudTimer = setInterval(() => { if (state.trial && !state.trial.finished) $('#trial-timer').textContent = `${((now() - state.trial.onsetAt) / 1000).toFixed(1)} s`; }, 100);
      state.trialTimeoutTimer = setTimeout(markTrialTimedOut, state.timeoutMs);
    }, state.fixationMs);
  }
  const trialActive = () => state.trial && state.trial.onsetAt > 0 && !state.trial.finished;
  function markTrialTimedOut() {
    if (!trialActive() || state.trial.timedOut) return;
    state.trial.timedOut = true;
    $('#trial-message').className = 'trial-message feedback-timeout';
    $('#trial-message-text').textContent = 'Past the suggested time — you can keep trying, or skip if it is impossible.';
    $('#trial-skip').hidden = false;
  }
  function targetAt(x, y) {
    return targets.find((t) => { if (t.hidden) return false; const r = t.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; }) || null;
  }
  function handleTrialGaze(sample) {
    if (!trialActive()) return;
    const trial = state.trial; const at = now();
    trial.gaze.push({ x: sample.x, y: sample.y, rawX: sample.rawX, rawY: sample.rawY, t: Math.round(at - trial.onsetAt) });
    if (trial.plan.mode !== 'gaze') return; // gaze is recorded in mouse trials too, but never selects
    const board = $('#trial-board').getBoundingClientRect();
    const dot = $('#gaze-dot'); dot.style.left = `${sample.x - board.left}px`; dot.style.top = `${sample.y - board.top}px`;
    const target = targetAt(sample.x, sample.y);
    const ring = $('#dwell-ring');
    if (!target) {
      if (trial.dwellTarget && at - trial.dwellLastSeenAt <= DROP_TOLERANCE_MS) return; // brief drop-out
      trial.dwellTarget = null; clearHover();
      return;
    }
    if (trial.dwellTarget !== target) {
      targets.forEach((t) => t.classList.toggle('gaze-hover', t === target));
      trial.dwellTarget = target; trial.dwellStartedAt = at;
      const r = target.getBoundingClientRect();
      ring.style.left = `${r.left + r.width / 2 - board.left}px`; ring.style.top = `${r.top + r.height / 2 - board.top}px`;
      ring.style.display = 'block';
    }
    trial.dwellLastSeenAt = at;
    const progress = clamp((at - trial.dwellStartedAt) / state.dwellMs, 0, 1);
    ring.style.setProperty('--p', progress);
    const label = target.dataset.target; trial.maxDwellProgress[label] = Math.max(trial.maxDwellProgress[label] || 0, progress);
    if (progress >= 1) finishTrial(target, 'response');
  }
  function recordMouse(event) {
    if (!trialActive() || state.trial.plan.mode !== 'mouse') return;
    const last = state.trial.mouse[state.trial.mouse.length - 1]; const t = Math.round(now() - state.trial.onsetAt);
    if (last && t - last.t < 16) return;
    state.trial.mouse.push({ x: Math.round(event.clientX), y: Math.round(event.clientY), t });
  }
  function finishTrial(selectedTarget, outcome = 'response') {
    if (!trialActive()) return;
    const trial = state.trial; trial.finished = true;
    clearTrialTimers();
    const visible = targets.filter((t) => !t.hidden);
    const correct = Boolean(selectedTarget && selectedTarget.dataset.correct === 'true');
    const correctTarget = visible.find((t) => t.dataset.correct === 'true');
    const rtMs = selectedTarget ? Math.round(now() - trial.onsetAt) : null;
    if (selectedTarget) selectedTarget.classList.add('selected', correct ? 'feedback-correct' : 'feedback-incorrect');
    if (!correct && correctTarget && outcome === 'response') correctTarget.classList.add('feedback-correct');
    clearHover(); $('#gaze-dot').style.display = 'none';
    const durationS = Math.max(0.001, (now() - trial.onsetAt) / 1000);
    const inBoard = trial.gaze.filter((g) => g.x >= trial.boardRect.left && g.x <= trial.boardRect.right && g.y >= trial.boardRect.top && g.y <= trial.boardRect.bottom).length;
    const record = {
      participantId: state.participantId, trial: state.currentTrial - state.practiceCount, practice: trial.plan.practice,
      taskType: trial.plan.taskType, searchType: trial.plan.searchType || '', setSize: trial.plan.setSize, mode: trial.plan.mode, targetSize: trial.plan.targetSize,
      target: trial.targetLabel, correctIndex: trial.plan.correctIndex,
      selected: selectedTarget ? selectedTarget.dataset.target : '', selectedIndex: selectedTarget ? visible.indexOf(selectedTarget) : null,
      correct, outcome: outcome === 'skipped' ? 'skipped' : (correct ? 'correct' : 'incorrect'), timedOut: trial.timedOut, rtMs, durationMs: Math.round(durationS * 1000),
      dwellMs: state.dwellMs, fixationMs: state.fixationMs, timeoutMs: state.timeoutMs,
      validationPassed: state.validation?.passed ?? false, validationMedianErrorPx: state.validation?.medianErrorPx ?? null,
      gazeSampleCount: trial.gaze.length, gazeHz: Math.round(10 * trial.gaze.length / durationS) / 10, gazeOnBoardRate: trial.gaze.length ? Math.round(1000 * inBoard / trial.gaze.length) / 1000 : null,
      viewport: { width: innerWidth, height: innerHeight }, boardRect: trial.boardRect, targetBounds: trial.targetBounds, items: trial.plan.items,
      gaze: trial.gaze, mouse: trial.mouse, simulated: SIM, tracker: SIM ? 'simulated' : state.tracker, smoothing: state.smoothing
    };
    if (!trial.plan.practice) state.trials.push(record);
    $('#trial-message').className = `trial-message ${outcome === 'skipped' ? 'feedback-timeout' : (correct ? 'feedback-correct' : 'feedback-incorrect')}`;
    const tail = trial.plan.practice ? ' (practice — not scored)' : '';
    $('#trial-message-text').textContent = outcome === 'skipped' ? `Trial skipped.${tail}` : (correct ? `Correct · ${(rtMs / 1000).toFixed(2)} s${tail}` : `Wrong target. The correct one is outlined in green.${tail}`);
    $('#trial-skip').hidden = true;
    state.trialAdvanceTimer = setTimeout(nextTrial, trial.plan.practice ? 1500 : 1100);
  }
  async function finishTrials() {
    state.trial = null;
    if (state.expQuestionnaire === 'full') { showScreen('questionnaire'); buildQuestionnaire(); }
    else { state.questionnaire = null; showComplete(); }
    if (isFullscreen()) { try { await document.exitFullscreen(); } catch (_) { /* ignore */ } }
    document.body.classList.remove('experiment-fullscreen');
    try { if (state.mp) state.mp.pause(); else if (!SIM) window.webgazer?.pause?.(); } catch (_) { /* ignore */ }
    scrollTo(0, 0);
  }

  /* ---------------- questionnaire: raw NASA-TLX per mode + SUS ---------------- */
  const TLX_ITEMS = [
    ['mental', 'Mental demand', 'How mentally demanding was the task?', 'Very low', 'Very high'],
    ['physical', 'Physical demand', 'How physically demanding was the task (eyes, neck, hand)?', 'Very low', 'Very high'],
    ['temporal', 'Temporal demand', 'How hurried or rushed was the pace of the task?', 'Very low', 'Very high'],
    ['performance', 'Performance', 'How successful were you in accomplishing what you were asked to do?', 'Perfect', 'Failure'],
    ['effort', 'Effort', 'How hard did you have to work to accomplish your level of performance?', 'Very low', 'Very high'],
    ['frustration', 'Frustration', 'How insecure, discouraged, irritated, stressed and annoyed were you?', 'Very low', 'Very high']
  ];
  const SUS_ITEMS = [
    'I think that I would like to use this system frequently.',
    'I found the system unnecessarily complex.',
    'I thought the system was easy to use.',
    'I think that I would need the support of a technical person to be able to use this system.',
    'I found the various functions in this system were well integrated.',
    'I thought there was too much inconsistency in this system.',
    'I would imagine that most people would learn to use this system very quickly.',
    'I found the system very cumbersome to use.',
    'I felt very confident using the system.',
    'I needed to learn a lot of things before I could get going with this system.'
  ];
  const usedModes = () => [...new Set(state.trialPlan.map((t) => t.mode))].sort();
  function buildQuestionnaire() {
    const tlx = $('#tlx-container'); tlx.replaceChildren();
    usedModes().forEach((mode) => {
      const fs = document.createElement('fieldset'); fs.className = 'tlx-block';
      const legend = document.createElement('legend'); legend.textContent = `Workload (NASA-TLX) — ${modeLabel(mode)} selection`; fs.appendChild(legend);
      TLX_ITEMS.forEach(([key, title, question, lo, hi]) => {
        const row = document.createElement('div'); row.className = 'tlx-row';
        const id = `tlx-${mode}-${key}`;
        row.innerHTML = `<label for="${id}"><strong></strong><span></span></label><div class="tlx-slider"><input type="range" min="0" max="100" step="5" value="50" id="${id}" name="${id}" data-untouched="1" /><output for="${id}">–</output></div><div class="tlx-anchors"><span></span><span></span></div>`;
        row.querySelector('strong').textContent = title; row.querySelector('label span').textContent = question;
        const anchors = row.querySelectorAll('.tlx-anchors span'); anchors[0].textContent = lo; anchors[1].textContent = hi;
        const input = row.querySelector('input'); const out = row.querySelector('output');
        const mark = () => { input.dataset.untouched = ''; row.classList.add('touched'); out.textContent = input.value; };
        input.addEventListener('input', mark); input.addEventListener('pointerdown', mark); input.addEventListener('keydown', mark);
        fs.appendChild(row);
      });
      tlx.appendChild(fs);
    });
    const susMode = usedModes().includes('gaze') ? 'gaze' : usedModes()[0];
    const sus = $('#sus-container'); sus.replaceChildren();
    const fs = document.createElement('fieldset'); fs.className = 'sus-block'; fs.dataset.mode = susMode;
    const legend = document.createElement('legend'); legend.textContent = `Usability (SUS) — the ${modeLabel(susMode).toLowerCase()} selection system`; fs.appendChild(legend);
    const head = document.createElement('div'); head.className = 'sus-row sus-head'; head.innerHTML = '<span></span><span>Strongly disagree</span><span></span><span></span><span></span><span>Strongly agree</span>'; fs.appendChild(head);
    SUS_ITEMS.forEach((text, i) => {
      const row = document.createElement('div'); row.className = 'sus-row';
      const q = document.createElement('span'); q.textContent = `${i + 1}. ${text}`; row.appendChild(q);
      for (let v = 1; v <= 5; v += 1) { const l = document.createElement('label'); l.innerHTML = `<input type="radio" name="sus-${i + 1}" value="${v}" /><span class="sr">${v}</span>`; row.appendChild(l); }
      fs.appendChild(row);
    });
    sus.appendChild(fs);
    $('#preference-fieldset').hidden = usedModes().length < 2;
  }
  function susScore(answers) { return answers.reduce((sum, v, i) => sum + (i % 2 === 0 ? v - 1 : 5 - v), 0) * 2.5; }
  $('#questionnaire-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget; const data = new FormData(form);
    const untouched = $$('#tlx-container input[data-untouched="1"]');
    const susAnswers = SUS_ITEMS.map((_, i) => Number(data.get(`sus-${i + 1}`)) || null);
    if (untouched.length || susAnswers.some((v) => v == null)) {
      setMessage('#questionnaire-error', `Please answer every item (${untouched.length} workload slider(s) not moved, ${susAnswers.filter((v) => v == null).length} SUS item(s) missing).`);
      (untouched[0] || form.querySelector('.sus-block'))?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    setMessage('#questionnaire-error', '');
    const tlx = {};
    usedModes().forEach((mode) => {
      const scales = Object.fromEntries(TLX_ITEMS.map(([key]) => [key, Number(data.get(`tlx-${mode}-${key}`))]));
      tlx[mode] = { ...scales, rawTlx: Math.round(10 * Object.values(scales).reduce((a, b) => a + b, 0) / 6) / 10 };
    });
    state.questionnaire = { tlx, sus: { mode: $('.sus-block').dataset.mode, answers: susAnswers, score: susScore(susAnswers) }, preference: data.get('preference') || null, comment: String(data.get('comment') || '').trim(), t: Date.now() };
    showComplete();
  });

  /* ---------------- results + export ---------------- */
  function payload() {
    return {
      schemaVersion: SCHEMA_VERSION, participantId: state.participantId, simulated: SIM, startedAt: state.startedAt, exportedAt: new Date().toISOString(),
      tracker: SIM ? 'simulated' : state.tracker, trackerSource: state.mp?.source || null, training: state.training || null,
      settings: { tracker: state.tracker, smoothing: state.smoothing, condition: state.condition, taskType: state.taskType, searchType: state.searchType, setSize: state.setSize, practiceCount: state.practiceCount, fixationMs: state.fixationMs, timeoutMs: state.timeoutMs, dwellMs: state.dwellMs, trialCount: state.trialCount },
      screen: { width: screen.width, height: screen.height, viewportWidth: innerWidth, viewportHeight: innerHeight, devicePixelRatio: devicePixelRatio },
      userAgent: navigator.userAgent,
      trialPlan: state.trialPlan, calibration: state.calibration, calibrationCorrection: state.calibrationCorrection,
      validation: state.validation, validationHistory: state.validationHistory, trials: state.trials, questionnaire: state.questionnaire,
      gameResults: state.gameResults, finalQuestionnaire: state.finalQuestionnaire || null
    };
  }
  function showComplete() {
    showScreen('complete'); scrollTo(0, 0);
    const data = payload();
    const m = window.GazeViz.computeMetrics(data);
    $('#complete-summary').textContent = `${state.participantId}${SIM ? ' (simulated gaze)' : ''} completed ${state.trials.length} trials · overall accuracy ${m.overall.accuracyPct ?? '–'}%. Download the JSON before closing this tab — it is the input for the analysis page and the Python script.`;
    window.GazeViz.renderDashboard($('#results-dashboard'), data);
  }
  const baseName = () => `gaze-${state.participantId || 'participant'}-${timestamp()}`;
  $('#download-json').addEventListener('click', () => download(`${baseName()}.json`, JSON.stringify(payload(), null, 1), 'application/json;charset=utf-8'));
  $('#download-trials').addEventListener('click', () => {
    const columns = ['participantId', 'trial', 'taskType', 'searchType', 'setSize', 'mode', 'targetSize', 'target', 'correctIndex', 'selected', 'selectedIndex', 'correct', 'outcome', 'timedOut', 'rtMs', 'durationMs', 'dwellMs', 'fixationMs', 'timeoutMs', 'validationPassed', 'validationMedianErrorPx', 'gazeSampleCount', 'gazeHz', 'gazeOnBoardRate', 'simulated'];
    const rows = [columns.join(','), ...state.trials.map((t) => columns.map((k) => csvEscape(t[k])).join(','))];
    download(`${baseName()}-trials.csv`, rows.join('\n'), 'text/csv;charset=utf-8');
  });
  $('#download-gaze').addEventListener('click', () => {
    const rows = ['participantId,phase,trial,mode,targetSize,source,x,y,rawX,rawY,tMs,target,selected,correct'];
    state.trials.forEach((t) => {
      t.gaze.forEach((s) => rows.push([state.participantId, 'trial', t.trial, t.mode, t.targetSize, 'gaze', s.x, s.y, s.rawX, s.rawY, s.t, t.target, t.selected, t.correct].map(csvEscape).join(',')));
      t.mouse.forEach((s) => rows.push([state.participantId, 'trial', t.trial, t.mode, t.targetSize, 'mouse', s.x, s.y, '', '', s.t, t.target, t.selected, t.correct].map(csvEscape).join(',')));
    });
    download(`${baseName()}-gaze.csv`, rows.join('\n'), 'text/csv;charset=utf-8');
  });

  /* ---------------- wiring ---------------- */
  targets.forEach((target) => target.addEventListener('click', () => { if (state.screen === 'trial' && state.trial?.plan.mode === 'mouse') finishTrial(target); }));
  $('#trial-board').addEventListener('pointermove', recordMouse, { passive: true });
  $('#trial-skip').addEventListener('click', () => { if (state.screen === 'trial') finishTrial(null, 'skipped'); });
  $('#setup-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    state.participantId = String(data.get('participantId')).trim();
    if (!state.participantId) { setMessage('#setup-error', 'Please enter your name or a participant ID.'); return; }
    state.tracker = String(data.get('tracker') || 'mediapipe');
    setSmoothing(String(data.get('smoothing') || 'strong'));
    showScreen('camera');
    startCamera();
  });
  $('#camera-retry').addEventListener('click', startCamera);
  $('#camera-next').addEventListener('click', enterCalibration);
  $('#validation-retry').addEventListener('click', enterCalibration);
  $('#validation-retry-test').addEventListener('click', startValidation);
  $('#validation-live-toggle').addEventListener('click', () => {
    state.liveGaze = !state.liveGaze;
    const board = $('#validation-board');
    let dot = $('#validation-live');
    if (state.liveGaze && !dot) { dot = document.createElement('div'); dot.id = 'validation-live'; dot.className = 'gaze-dot live'; board.appendChild(dot); }
    if (dot) dot.style.display = state.liveGaze ? 'block' : 'none';
    $('#validation-live-toggle').textContent = state.liveGaze ? 'Hide live gaze' : 'Show live gaze';
  });
  function afterValidation() {
    // A trial run interrupted by leaving fullscreen resumes right where it stopped.
    if (state.resumeTrialsAfterValidation) { state.resumeTrialsAfterValidation = false; resetGazeFilter(); showScreen('trial'); nextTrial(); return; }
    goHub();
  }
  $('#validation-next').addEventListener('click', afterValidation);
  $('#validation-continue-low').addEventListener('click', afterValidation);

  /* ---------------- game hub ---------------- */
  const GAME_TEXT = {
    bubbles: { unit: 'balls', text: 'A blue ball follows your eyes. Touch the orange balls to pop them — contact counts immediately and a new ball appears elsewhere. You have 60 seconds.' },
    moles: { unit: 'moles', text: 'Moles pop out of the nine holes for a short time. Look at a mole’s square (the whole square counts) to whack it before it hides. It gets faster as you score.' },
    pong: { unit: 'returns', text: 'Just watch the ball. The paddle follows where you look — left and right only — so following the ball with your eyes keeps it in play. You have 3 lives; each return speeds the ball up.' }
  };
  const SMOOTH_LABEL = { off: 'Smoothing: off', light: 'Smoothing: light', strong: 'Smoothing: strong' };
  const bestScore = (id) => Math.max(-1, ...state.gameResults.filter((r) => r.game === id && r.mode === 'gaze').map((r) => r.score));
  function resumeTracker() { try { if (state.mp) state.mp.resume(); else if (!SIM) window.webgazer?.resume?.(); } catch (_) { /* ignore */ } }
  async function goHub() {
    state.game?.stop();
    resumeTracker();
    await ensureExperimentFullscreen();
    renderHub();
  }
  function renderHub() {
    showScreen('hub');
    $('#hub-title').textContent = `Choose a game, ${state.participantId}`;
    const v = state.validation;
    $('#hub-quality').textContent = v?.medianErrorPx != null ? `GAZE ERROR ≈ ${v.medianErrorPx}px${v.passed ? '' : ' (LOW ACCURACY)'}` : (SIM ? 'SIMULATED GAZE' : 'NOT VALIDATED');
    $$('.best').forEach((el) => { const b = bestScore(el.dataset.best); el.textContent = b >= 0 ? `Your best: ${b}` : ''; });
    const fsOk = isFullscreen() || SIM;
    $('#hub-fullscreen').hidden = fsOk; $('#hub-notice').hidden = fsOk;
    $('#experiment-sheet').hidden = true;
  }
  $$('.game-card').forEach((card) => {
    const open = () => { const id = card.dataset.game; if (id === 'selection') { $('#experiment-sheet').hidden = false; $('#condition').focus(); } else openGame(id); };
    card.querySelector('.card-play').addEventListener('click', open);
    card.querySelector('.card-art').addEventListener('click', open);
  });
  $('#hub-recalibrate').addEventListener('click', enterCalibration);
  $('#hub-exit').addEventListener('click', showFinal);
  $('#hub-fullscreen').addEventListener('click', async () => { await ensureExperimentFullscreen(); $('#hub-fullscreen').hidden = isFullscreen(); $('#hub-notice').hidden = isFullscreen(); });
  $('#experiment-cancel').addEventListener('click', () => { $('#experiment-sheet').hidden = true; });
  $('#experiment-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    state.condition = String(data.get('condition')); state.taskType = String(data.get('taskType'));
    state.searchType = String(data.get('searchType')); state.setSize = String(data.get('setSize'));
    state.practiceCount = clamp(Number(data.get('practiceCount')) || 0, 0, 8);
    state.fixationMs = Number(data.get('fixationMs')) || 500; state.timeoutMs = Number(data.get('timeoutMs')) || 5000;
    state.dwellMs = Number(data.get('dwellMs')) || 800; state.trialCount = clamp(Number(data.get('trialCount')) || 24, 4, 48);
    state.expQuestionnaire = String(data.get('expQuestionnaire') || 'none');
    $('#experiment-sheet').hidden = true;
    state.questionnaire = null;
    await ensureExperimentFullscreen();
    beginTrials();
  });

  /* ---------------- games (game.js) ---------------- */
  function ensureGames() {
    if (state.game) return state.game;
    state.game = window.GazeGames.create({
      canvas: $('#game-canvas'),
      roundMs: ROUND_S * 1000,
      onSmoothing: (level) => { setSmoothing(level); $('#game-smooth').textContent = SMOOTH_LABEL[state.smoothing]; },
      onHud: ({ title, score, secondsLeft, elapsedS, timed, lives, mode }) => {
        if (title) $('#game-title').textContent = title;
        $('#game-score').textContent = String(score);
        if (timed === false) { $('#game-time-label').textContent = 'Time'; $('#game-time').textContent = `${elapsedS} s`; }
        else if (secondsLeft != null) { $('#game-time-label').textContent = 'Time left'; $('#game-time').textContent = `${secondsLeft} s`; }
        $('#game-lives').hidden = lives == null;
        if (lives != null) $('#game-lives-val').textContent = '♥'.repeat(Math.max(0, lives)) + '♡'.repeat(Math.max(0, window.GazeGames.PONG_LIVES - lives));
        $('#game-mode').textContent = mode === 'gaze' ? 'Eye control' : 'Mouse control';
        $('#game-mode').dataset.mode = mode;
        $('#game-smooth').textContent = SMOOTH_LABEL[state.smoothing];
      },
      onEnd: (result) => showGameResult(result)
    });
    return state.game;
  }
  async function openGame(id) {
    state.currentGame = id;
    await ensureExperimentFullscreen();
    showScreen('game');
    await waitForLayout();
    const g = ensureGames(); g.stop();
    const card = document.querySelector(`.game-card[data-game="${id}"]`);
    $('#intro-art').replaceChildren(card.querySelector('.card-art svg').cloneNode(true));
    $('#intro-title').textContent = card.querySelector('h3').textContent;
    $('#game-title').textContent = card.querySelector('h3').textContent;
    $('#intro-text').textContent = GAME_TEXT[id].text;
    const timed = id !== 'pong';
    $('#duration-switch').hidden = !timed; $('#lives-note').hidden = timed; $('#game-lives').hidden = timed;
    $$('input[name="game-duration"]').forEach((r) => { r.checked = Number(r.value) === (state.gameDuration || ROUND_S); });
    $$('input[name="game-mode"]').forEach((r) => { r.checked = r.value === g.mode; });
    $('#game-score').textContent = '0'; $('#game-time').textContent = timed ? `${state.gameDuration || ROUND_S} s` : '0 s'; $('#game-lives-val').textContent = '♥'.repeat(window.GazeGames.PONG_LIVES); $('#game-smooth').textContent = SMOOTH_LABEL[state.smoothing];
    $('#game-result').hidden = true; $('#game-intro').hidden = false;
    const ctx = $('#game-canvas').getContext('2d'); ctx.clearRect(0, 0, 99999, 99999);
  }
  function startGame() {
    const g = ensureGames();
    g.setMode(document.querySelector('input[name="game-mode"]:checked')?.value || 'gaze');
    $('#game-intro').hidden = true; $('#game-result').hidden = true;
    resetGazeFilter();
    const dur = Number(document.querySelector('input[name="game-duration"]:checked')?.value) || ROUND_S;
    state.gameDuration = dur;
    g.start(state.currentGame, { durationS: state.currentGame === 'pong' ? null : dur });
  }
  function showGameResult(result) {
    const prevBest = Math.max(-1, ...state.gameResults.filter((r) => r.game === result.game && r.mode === result.mode).map((r) => r.score));
    const record = { ...result, smoothing: state.smoothing, tracker: SIM ? 'simulated' : state.tracker, validationMedianErrorPx: state.validation?.medianErrorPx ?? null };
    delete record.stats; record.statsText = Object.fromEntries(result.stats);
    state.gameResults.push(record);
    $('#result-eyebrow').textContent = `${result.mode === 'gaze' ? 'EYE CONTROL' : 'MOUSE CONTROL'} · ${result.timed === false ? `${window.GazeGames.PONG_LIVES} LIVES · ${result.roundS} S PLAYED` : `${result.roundS} SECONDS`}`;
    $('#result-title').textContent = result.title;
    $('#result-score').textContent = String(result.score);
    $('#result-unit').textContent = GAME_TEXT[result.game].unit;
    const other = state.gameResults.filter((r) => r.game === result.game && r.mode !== result.mode).pop();
    const notes = [];
    if (prevBest >= 0) notes.push(result.score > prevBest ? `New personal best (previous ${prevBest}).` : `Your best so far: ${prevBest}.`);
    if (other) notes.push(`With ${other.mode === 'gaze' ? 'your eyes' : 'the mouse'} you scored ${other.score}.`);
    else notes.push(`Try it with ${result.mode === 'gaze' ? 'the mouse' : 'your eyes'} to compare.`);
    $('#result-note').textContent = notes.join(' ');
    $('#result-stats').replaceChildren(...result.stats.map(([label, value]) => { const d = document.createElement('div'); d.className = 'result-stat'; const b = document.createElement('strong'); b.textContent = value; const sp = document.createElement('span'); sp.textContent = label; d.append(b, sp); return d; }));
    // exportable result figure
    try {
      state.resultCanvas = window.ResultImage.render(record, { player: state.participantId });
      $('#result-image').src = state.resultCanvas.toDataURL('image/png');
      $('#result-image').parentElement.hidden = false;
    } catch (error) { console.warn('result image failed', error); $('#result-image').parentElement.hidden = true; }
    $('#game-result').hidden = false;
  }
  $('#result-download').addEventListener('click', () => {
    const c = state.resultCanvas; if (!c) return;
    const last = state.gameResults[state.gameResults.length - 1];
    c.toBlob((blob) => { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `${baseName()}-${last?.game || 'game'}-${last?.mode || ''}.png`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }, 'image/png');
  });
  $('#intro-start').addEventListener('click', startGame);
  $('#intro-back').addEventListener('click', goHub);
  $('#result-again').addEventListener('click', () => { $('#game-result').hidden = true; $('#game-intro').hidden = false; });
  $('#result-hub').addEventListener('click', goHub);
  $('#result-exit').addEventListener('click', showFinal);
  $('#game-quit').addEventListener('click', goHub);

  /* ---------------- end of session ---------------- */
  /* short end-of-session questionnaire: ease of use, workload, satisfaction (1–5 Likert) */
  const FINAL_ITEMS = [
    ['ease1', 'ease', 'Controlling things with my eyes was easy.'],
    ['ease2', 'ease', 'The eye control went where I was looking.'],
    ['load1', 'workload', 'Using my eyes as a controller was tiring.'],
    ['load2', 'workload', 'It took a lot of concentration.'],
    ['sat1', 'satisfaction', 'I enjoyed using eye control.'],
    ['sat2', 'satisfaction', 'I would like to use eye control again.']
  ];
  function buildFinal() {
    const host = $('#final-items'); host.replaceChildren();
    const fs = document.createElement('fieldset'); fs.className = 'sus-block';
    const head = document.createElement('div'); head.className = 'sus-row sus-head'; head.innerHTML = '<span></span><span>Strongly disagree</span><span></span><span></span><span></span><span>Strongly agree</span>'; fs.appendChild(head);
    FINAL_ITEMS.forEach(([key, , textLabel], i) => {
      const row = document.createElement('div'); row.className = 'sus-row';
      const q = document.createElement('span'); q.textContent = `${i + 1}. ${textLabel}`; row.appendChild(q);
      for (let v = 1; v <= 5; v += 1) { const l = document.createElement('label'); l.innerHTML = `<input type="radio" name="${key}" value="${v}" /><span class="sr">${v}</span>`; row.appendChild(l); }
      fs.appendChild(row);
    });
    host.appendChild(fs);
    const usedMouse = state.gameResults.some((r) => r.mode === 'mouse') || state.trials.some((t) => t.mode === 'mouse');
    $('#final-pref-fieldset').hidden = !usedMouse;
  }
  async function showFinal() {
    state.game?.stop();
    try { if (state.mp) state.mp.pause(); else if (!SIM) window.webgazer?.pause?.(); } catch (_) { /* ignore */ }
    if (isFullscreen()) { try { await document.exitFullscreen(); } catch (_) { /* ignore */ } }
    document.body.classList.remove('experiment-fullscreen');
    if (state.finalQuestionnaire) { showBye(); return; }
    buildFinal(); showScreen('final'); scrollTo(0, 0);
  }
  $('#final-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const answers = Object.fromEntries(FINAL_ITEMS.map(([key]) => [key, Number(data.get(key)) || null]));
    const missing = Object.values(answers).filter((v) => v == null).length;
    if (missing) { setMessage('#final-error', `Please answer all six statements (${missing} missing), or press Skip.`); return; }
    const avg = (dim) => { const v = FINAL_ITEMS.filter((it) => it[1] === dim).map(([key]) => answers[key]); return Math.round(10 * v.reduce((a, b) => a + b, 0) / v.length) / 10; };
    state.finalQuestionnaire = { scale: '1-5 Likert', answers, scores: { easeOfUse: avg('ease'), workload: avg('workload'), satisfaction: avg('satisfaction') }, preference: data.get('preference') || null, comment: String(data.get('comment') || '').trim(), t: Date.now() };
    showBye();
  });
  $('#final-skip').addEventListener('click', () => { state.finalQuestionnaire = { skipped: true, t: Date.now() }; showBye(); });
  async function showBye() {
    state.game?.stop();
    if (isFullscreen()) { try { await document.exitFullscreen(); } catch (_) { /* ignore */ } }
    document.body.classList.remove('experiment-fullscreen');
    showScreen('bye'); scrollTo(0, 0);
    $('#bye-title').textContent = `Thanks for playing, ${state.participantId}`;
    const n = state.gameResults.length;
    $('#bye-summary').textContent = n || state.trials.length ? `You played ${n} game round${n === 1 ? '' : 's'}${state.trials.length ? ` and completed ${state.trials.length} experiment trials` : ''}.` : 'No games were played in this session.';
    const host = $('#bye-table'); host.replaceChildren();
    if (n) {
      const table = document.createElement('table'); table.className = 'gv-table bye-table';
      const head = table.createTHead().insertRow(); ['Game', 'Control', 'Score', 'Details'].forEach((h) => { const th = document.createElement('th'); th.textContent = h; head.appendChild(th); });
      const body = table.createTBody();
      state.gameResults.forEach((r) => { const row = body.insertRow(); [r.title, r.mode === 'gaze' ? 'Eyes' : 'Mouse', String(r.score), Object.entries(r.statsText).slice(1).map(([k, v]) => `${k}: ${v}`).join(' · ')].forEach((v) => { row.insertCell().textContent = v; }); });
      host.appendChild(table);
    }
    const fb = $('#bye-feedback'); fb.replaceChildren();
    const sc = state.finalQuestionnaire?.scores;
    if (sc) {
      const row = document.createElement('div'); row.className = 'result-stats bye-scores';
      [['Ease of use', sc.easeOfUse], ['Workload', sc.workload], ['Satisfaction', sc.satisfaction]].forEach(([label, v]) => { const d = document.createElement('div'); d.className = 'result-stat'; const b = document.createElement('strong'); b.textContent = `${v} / 5`; const sp = document.createElement('span'); sp.textContent = label; d.append(b, sp); row.appendChild(d); });
      fb.appendChild(row);
    }
  }
  $('#complete-hub').addEventListener('click', goHub);
  $('#complete-exit').addEventListener('click', showFinal);
  $('#bye-download').addEventListener('click', () => download(`${baseName()}-session.json`, JSON.stringify(payload(), null, 1), 'application/json;charset=utf-8'));
  $('#restart').addEventListener('click', () => location.reload());

  document.addEventListener('fullscreenchange', () => {
    if (isFullscreen()) { document.body.classList.add('experiment-fullscreen'); return; }
    if (state.screen === 'game' || state.screen === 'hub') {
      // Calibration was done in fullscreen: offer a way back instead of discarding it.
      document.body.classList.remove('experiment-fullscreen');
      state.game?.stop();
      renderHub();
      return;
    }
    if (!['trial', 'calibration', 'validation'].includes(state.screen)) return;
    state.mp?.resume();
    document.body.classList.remove('experiment-fullscreen');
    if (state.screen === 'trial') {
      // Pause: an unfinished trial is repeated after recalibration; finished trials are kept.
      const unfinished = state.trial && !state.trial.finished;
      clearTrialTimers();
      if (unfinished) state.currentTrial = Math.max(0, state.currentTrial - 1);
      state.trial = null; state.resumeTrialsAfterValidation = true;
      state.calibration = []; state.calibrationCorrection = null; state.validation = null;
      showScreen('camera');
      setMessage('#camera-message', 'You left fullscreen during the trials. The unfinished trial was discarded; completed trials are kept. Recalibrate and validate to continue.');
      return;
    }
    clearTimeout(state.validationTimer);
    state.validationActivePoint = null; state.calibration = []; state.calibrationCorrection = null; state.validation = null;
    showScreen('camera');
    setMessage('#camera-message', 'You left fullscreen, so this calibration/validation was discarded. Click “Go fullscreen & calibrate” again.');
  });

  if (SIM) { $('#sim-banner').hidden = false; document.body.classList.add('sim-mode'); }
  // Debug/test hook (used by automated checks; harmless otherwise).
  window.__gazeExperiment = { state, payload };
})();
