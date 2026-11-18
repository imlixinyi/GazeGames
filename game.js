/* GazeGames — three short gaze-controlled games that tolerate an imprecise webcam tracker.
 *
 *   bubbles  Touch the orange balls with your gaze ball (contact counts at once).
 *   moles    Whack-a-mole on a 3×3 grid: the whole grid cell is the hit area, so a 100–150 px
 *            gaze error still lands in the right cell.
 *   pong     Only the horizontal gaze position moves the paddle — the vertical axis, which is the
 *            weak one for a webcam above the screen, is not used at all. Just watch the ball.
 *
 * Round: 3-2-1 countdown → timed games run for the chosen duration, pong runs until all lives are lost
 * → onEnd(result incl. event log + pointer trace for the result image). M switches gaze/mouse, 1/2/3 smoothing.
 * Coordinates fed in are viewport (client) coordinates.
 */
(function (global) {
  'use strict';

  const ROUND_MS = 60000;
  const COUNTDOWN_MS = 3000;
  const TOP = 64; // space reserved for the HUD bar
  // Gaze pong tuning
  const PONG_LIVES = 3;
  const PONG_START_SPEED = 520; // px/s (was 360)
  const PONG_SPEEDUP = 1.07;    // ×1.07 per return (was ×1.05)
  const PONG_MAX_SPEED = 1100;  // px/s cap (was 820)
  const C = { gaze: '#2a78d6', mouse: '#c4501f', orange: '#eb6834', good: '#0ca30c', bad: '#d03b3b', ink: '#172027', muted: '#66727a', line: '#e3e8e8', surface: '#ffffff', soil: '#8a6a4f', soilDark: '#5e4733', grass: '#eef6ea', moleFur: '#9b7653', moleNose: '#e87ba4' };
  const rnd = (a, b) => a + Math.random() * (b - a);

  /* ---------------- bubbles ---------------- */
  function bubbles() {
    const N = 5; const PR = 26; const TR = 34;
    let W; let H; let targets = []; let pops = []; let trail = []; let score = 0; const hits = [];
    function spawn(avoid) {
      const m = TR + 30;
      for (let k = 0; k < 200; k += 1) {
        const x = rnd(m, W - m); const y = rnd(TOP + m, H - m);
        if (targets.every((t) => Math.hypot(t.x - x, t.y - y) > TR * 3.2) && (!avoid || Math.hypot(avoid.x - x, avoid.y - y) > 220)) return { x, y, born: performance.now() };
      }
      return { x: W / 2, y: H / 2, born: performance.now() };
    }
    return {
      title: 'Bubble pop', timed: true,
      init(w, h) { W = w; H = h; targets = []; for (let i = 0; i < N; i += 1) targets.push(spawn(null)); },
      update(now, p, elapsed) {
        if (p) {
          trail.push({ x: p.x, y: p.y, t: now }); while (trail.length && now - trail[0].t > 600) trail.shift();
          targets.forEach((t, i) => { if (Math.hypot(t.x - p.x, t.y - p.y) <= PR + TR) { score += 1; hits.push(elapsed); pops.push({ x: t.x, y: t.y, t: now }); targets[i] = spawn(p); } });
        }
      },
      draw(ctx, now, p) {
        targets.forEach((t) => { const g = Math.max(0.05, Math.min(1, (now - t.born) / 250)); ctx.beginPath(); ctx.arc(t.x, t.y, TR * g, 0, 7); ctx.fillStyle = C.orange; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.stroke(); });
        pops = pops.filter((q) => now >= q.t && now - q.t < 400);
        pops.forEach((q) => { const k = (now - q.t) / 400; ctx.beginPath(); ctx.arc(q.x, q.y, TR * (1 + k), 0, 7); ctx.strokeStyle = C.good; ctx.globalAlpha = 1 - k; ctx.lineWidth = 4; ctx.stroke(); ctx.globalAlpha = 1; });
        if (trail.length > 1) { ctx.beginPath(); trail.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.strokeStyle = 'rgba(42,120,214,.18)'; ctx.lineWidth = PR; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke(); }
        if (p) { ctx.beginPath(); ctx.arc(p.x, p.y, PR, 0, 7); ctx.fillStyle = C.gaze; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.stroke(); }
      },
      score: () => score,
      result() {
        const gaps = hits.slice(1).map((h, i) => h - hits[i]);
        const mean = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null;
        return { score, stats: [['Balls popped', String(score)], ['Mean time per pop', mean ? `${(mean / 1000).toFixed(2)} s` : '–'], ['Fastest pop', gaps.length ? `${(Math.min(...gaps) / 1000).toFixed(2)} s` : '–']], raw: { popped: score, meanGapMs: mean && Math.round(mean) }, events: hits.map((t) => ({ t: Math.round(t) })) };
      }
    };
  }

  /* ---------------- whack-a-mole ---------------- */
  function moles() {
    const COLS = 3; const ROWS = 3; const HOLD_MS = 120;
    let W; let H; let cells = []; let up = []; let nextAt = 0; let hits = 0; let misses = 0; const rts = []; let aim = null; let aimSince = 0; let fx = []; const events = [];
    const cellAt = (p) => (p ? cells.findIndex((c) => p.x >= c.x && p.x < c.x + c.w && p.y >= c.y && p.y < c.y + c.h) : -1);
    return {
      title: 'Whack-a-mole', timed: true,
      init(w, h) {
        W = w; H = h; cells = [];
        const gw = Math.min(W - 40, (H - TOP - 30) * 1.7); const gh = H - TOP - 30; const ox = (W - gw) / 2; const oy = TOP + 10;
        for (let r = 0; r < ROWS; r += 1) for (let c = 0; c < COLS; c += 1) cells.push({ x: ox + (c * gw) / COLS, y: oy + (r * gh) / ROWS, w: gw / COLS, h: gh / ROWS });
        nextAt = performance.now() + 400;
      },
      update(now, p, elapsed) {
        const upMs = Math.max(950, 1800 - 45 * hits);
        const maxUp = hits >= 10 ? 2 : 1;
        // escaped moles
        up = up.filter((m) => { if (now - m.at > upMs) { misses += 1; fx.push({ cell: m.cell, t: now, ok: false }); events.push({ t: Math.round(m.el), cell: m.cell, hit: false }); return false; } return true; });
        if (up.length < maxUp && now >= nextAt) {
          const free = cells.map((_, i) => i).filter((i) => !up.some((m) => m.cell === i) && i !== aim);
          const cell = free[Math.floor(Math.random() * free.length)];
          up.push({ cell, at: now, el: elapsed }); nextAt = now + rnd(350, 800);
        }
        const c = cellAt(p);
        if (c !== aim) { aim = c; aimSince = now; }
        const target = up.find((m) => m.cell === aim && now - Math.max(aimSince, m.at) >= HOLD_MS);
        if (target) { hits += 1; rts.push(now - target.at); events.push({ t: Math.round(target.el), cell: target.cell, hit: true, rt: Math.round(now - target.at) }); fx.push({ cell: target.cell, t: now, ok: true }); up = up.filter((m) => m !== target); nextAt = Math.min(nextAt, now + 300); }
      },
      draw(ctx, now, p) {
        ctx.fillStyle = C.grass; ctx.fillRect(0, TOP, W, H - TOP);
        const upMsNow = Math.max(950, 1800 - 45 * hits);
        cells.forEach((c, i) => {
          // the whole square is the hit area: show it
          ctx.strokeStyle = 'rgba(94,71,51,.18)'; ctx.setLineDash([6, 8]); ctx.lineWidth = 2; ctx.strokeRect(c.x + 6, c.y + 6, c.w - 12, c.h - 12); ctx.setLineDash([]);
          if (i === aim) { ctx.fillStyle = 'rgba(42,120,214,.10)'; ctx.fillRect(c.x + 6, c.y + 6, c.w - 12, c.h - 12); }
          const hx = c.x + c.w / 2; const hy = c.y + c.h * 0.7; const rx = Math.min(c.w * 0.26, c.h * 0.42); const ry = rx * 0.3;
          const mole = up.find((m) => m.cell === i);
          if (mole) {
            const k = Math.min(1, (now - mole.at) / 160); const mr = rx * 0.62; const my = hy - mr * 1.05 * k;
            ctx.save(); ctx.beginPath(); ctx.rect(c.x, c.y, c.w, hy - c.y); ctx.clip();
            ctx.beginPath(); ctx.ellipse(hx, my, mr, mr * 1.1, 0, 0, 7); ctx.fillStyle = C.moleFur; ctx.fill();
            ctx.fillStyle = '#fff'; [-1, 1].forEach((sg) => { ctx.beginPath(); ctx.arc(hx + sg * mr * 0.35, my - mr * 0.25, mr * 0.16, 0, 7); ctx.fill(); });
            ctx.fillStyle = C.ink; [-1, 1].forEach((sg) => { ctx.beginPath(); ctx.arc(hx + sg * mr * 0.35, my - mr * 0.22, mr * 0.08, 0, 7); ctx.fill(); });
            ctx.fillStyle = C.moleNose; ctx.beginPath(); ctx.ellipse(hx, my + mr * 0.12, mr * 0.2, mr * 0.14, 0, 0, 7); ctx.fill();
            ctx.restore();
            // time left before the mole hides: shrinking bar under the hole
            const left = Math.max(0, 1 - (now - mole.at) / upMsNow);
            ctx.fillStyle = 'rgba(23,32,39,.12)'; ctx.fillRect(hx - rx, hy + ry + 14, rx * 2, 6);
            ctx.fillStyle = left > 0.3 ? C.good : C.bad; ctx.fillRect(hx - rx, hy + ry + 14, rx * 2 * left, 6);
          }
          ctx.beginPath(); ctx.ellipse(hx, hy, rx, ry, 0, 0, 7); ctx.fillStyle = C.soilDark; ctx.fill();
          ctx.beginPath(); ctx.ellipse(hx, hy + ry * 0.35, rx, ry * 0.7, 0, 0, Math.PI); ctx.fillStyle = C.soil; ctx.fill();
        });
        fx = fx.filter((f) => now - f.t < 450);
        fx.forEach((f) => { const c = cells[f.cell]; const k = (now - f.t) / 450; ctx.globalAlpha = 1 - k; ctx.fillStyle = f.ok ? C.good : C.bad; ctx.font = `800 ${Math.round(c.h * 0.18)}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.fillText(f.ok ? '+1' : 'miss', c.x + c.w / 2, c.y + c.h * 0.35 - 30 * k); ctx.globalAlpha = 1; });
        if (p) { ctx.beginPath(); ctx.arc(p.x, p.y, 12, 0, 7); ctx.fillStyle = 'rgba(42,120,214,.85)'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke(); }
      },
      score: () => hits,
      result() {
        const total = hits + misses; const rt = rts.length ? rts.reduce((a, b) => a + b, 0) / rts.length : null;
        return { score: hits, stats: [['Moles hit', String(hits)], ['Hit rate', total ? `${Math.round((100 * hits) / total)}%` : '–'], ['Mean reaction', rt ? `${(rt / 1000).toFixed(2)} s` : '–']], raw: { hits, misses, meanReactionMs: rt && Math.round(rt) }, events };
      }
    };
  }

  /* ---------------- gaze pong ---------------- */
  function pong() {
    const R = 14;
    let W; let H; let pw; const ph = 16; let px; let py; let ball; let returns = 0; let misses = 0; let rally = 0; let best = 0; let respawnAt = 0; let flash = null; let lives = PONG_LIVES; const events = []; const rallies = []; const track = []; let lastTrack = -1e9;
    function serve(now) { const a = rnd(-0.5, 0.5); const sp = PONG_START_SPEED; ball = { x: rnd(W * 0.3, W * 0.7), y: TOP + 40, vx: sp * Math.sin(a), vy: sp * Math.cos(a) }; respawnAt = 0; rally = 0; flash = { t: now, ok: true, serve: true }; }
    return {
      title: 'Gaze pong', timed: false,
      lives: () => lives,
      over: () => lives <= 0 && !ball,
      init(w, h) { W = w; H = h; pw = Math.max(140, W * 0.22); px = W / 2; py = H - 46; serve(performance.now()); },
      update(now, p, elapsed, dt) {
        if (p) px += (Math.max(pw / 2, Math.min(W - pw / 2, p.x)) - px) * Math.min(1, dt * 10);
        if (!ball) { if (lives > 0 && now >= respawnAt) serve(now); return; }
        if (elapsed - lastTrack >= 50) { track.push({ t: Math.round(elapsed), ball: +(ball.x / W).toFixed(4), paddle: +(px / W).toFixed(4), gaze: p ? +(p.x / W).toFixed(4) : null }); lastTrack = elapsed; }
        ball.x += ball.vx * dt; ball.y += ball.vy * dt;
        if (ball.x < R) { ball.x = R; ball.vx = Math.abs(ball.vx); }
        if (ball.x > W - R) { ball.x = W - R; ball.vx = -Math.abs(ball.vx); }
        if (ball.y < TOP + R) { ball.y = TOP + R; ball.vy = Math.abs(ball.vy); }
        if (ball.vy > 0 && ball.y + R >= py - ph / 2 && ball.y + R <= py + ph && Math.abs(ball.x - px) <= pw / 2 + R) {
          const off = (ball.x - px) / (pw / 2); const sp = Math.min(PONG_MAX_SPEED, Math.hypot(ball.vx, ball.vy) * PONG_SPEEDUP);
          const ang = Math.max(-1, Math.min(1, off)) * 1.0; ball.vx = sp * Math.sin(ang); ball.vy = -sp * Math.cos(ang); ball.y = py - ph / 2 - R;
          returns += 1; rally += 1; best = Math.max(best, rally); flash = { t: now, ok: true }; events.push({ t: Math.round(elapsed), type: 'return' });
        }
        if (ball.y - R > H) { misses += 1; lives -= 1; rallies.push(rally); events.push({ t: Math.round(elapsed), type: 'miss' }); ball = null; respawnAt = now + 900; flash = { t: now, ok: false }; }
      },
      draw(ctx, now, p) {
        ctx.strokeStyle = C.line; ctx.setLineDash([8, 10]); ctx.beginPath(); ctx.moveTo(0, py + ph); ctx.lineTo(W, py + ph); ctx.stroke(); ctx.setLineDash([]);
        if (ball) { ctx.beginPath(); ctx.arc(ball.x, ball.y, R, 0, 7); ctx.fillStyle = C.orange; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.stroke(); }
        const glow = flash && now - flash.t < 300 && !flash.serve ? (flash.ok ? C.good : C.bad) : C.gaze;
        ctx.fillStyle = glow; const r = 8; const x = px - pw / 2; const y = py - ph / 2;
        ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + pw - r, y); ctx.quadraticCurveTo(x + pw, y, x + pw, y + r); ctx.lineTo(x + pw, y + ph - r); ctx.quadraticCurveTo(x + pw, y + ph, x + pw - r, y + ph); ctx.lineTo(x + r, y + ph); ctx.quadraticCurveTo(x, y + ph, x, y + ph - r); ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.fill();
        if (p) { ctx.beginPath(); ctx.moveTo(p.x, TOP); ctx.lineTo(p.x, py - ph); ctx.strokeStyle = 'rgba(42,120,214,.12)'; ctx.lineWidth = 2; ctx.stroke(); ctx.beginPath(); ctx.arc(p.x, p.y, 9, 0, 7); ctx.fillStyle = 'rgba(42,120,214,.6)'; ctx.fill(); }
        ctx.fillStyle = C.muted; ctx.font = '600 14px system-ui, sans-serif'; ctx.textAlign = 'right'; ctx.fillText(`Rally ${rally}`, W - 16, TOP + 24);
        ctx.font = '22px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = C.bad; ctx.fillText('♥'.repeat(Math.max(0, lives)), 16, TOP + 28); ctx.fillStyle = C.line; ctx.fillText('♥'.repeat(Math.max(0, PONG_LIVES - lives)), 16 + 24 * Math.max(0, lives), TOP + 28);
        if (!ball) { ctx.fillStyle = C.bad; ctx.font = '700 22px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(lives > 0 ? `Missed — ${lives} life left, next ball…` : 'Game over', W / 2, H / 2); }
      },
      score: () => returns,
      result() {
        const total = returns + misses;
        return { score: returns, stats: [['Returns', String(returns)], ['Return rate', total ? `${Math.round((100 * returns) / total)}%` : '–'], ['Longest rally', String(best)]], raw: { returns, misses, longestRally: best, rallies, lives: PONG_LIVES, startSpeed: PONG_START_SPEED }, events, track };
      }
    };
  }

  const FACTORY = { bubbles, moles, pong };

  function create({ canvas, onHud, onEnd, onSmoothing, roundMs: defaultRoundMs = ROUND_MS }) {
    let roundMs = defaultRoundMs;
    const ctx = canvas.getContext('2d');
    const st = { game: null, id: null, mode: 'gaze', gaze: null, gazeAt: 0, mouse: null, raf: 0, startAt: 0, last: 0, running: false, W: 0, H: 0, trace: [], lastTrace: -1e9 };
    function size() {
      const r = canvas.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      st.W = r.width; st.H = r.height;
    }
    function pointer() {
      if (st.mode === 'mouse') return st.mouse;
      return st.gaze && performance.now() - st.gazeAt < 600 ? st.gaze : null;
    }
    function hud(now) {
      const elapsed = now - st.startAt - COUNTDOWN_MS;
      const timed = st.game?.timed !== false;
      onHud?.({ id: st.id, title: st.game?.title, score: st.game?.score() ?? 0, timed, lives: st.game?.lives?.(), secondsLeft: timed ? Math.ceil(Math.max(0, roundMs - Math.max(0, elapsed)) / 1000) : null, elapsedS: Math.max(0, Math.floor(elapsed / 1000)), mode: st.mode });
    }
    function frame(now) {
      if (!st.running) return;
      const dt = Math.min(0.05, (now - (st.last || now)) / 1000); st.last = now;
      const elapsed = now - st.startAt - COUNTDOWN_MS;
      const p = pointer();
      ctx.clearRect(0, 0, st.W, st.H); ctx.fillStyle = C.surface; ctx.fillRect(0, 0, st.W, st.H);
      if (elapsed >= 0) {
        st.game.update(now, p, elapsed, dt);
        if (p && elapsed - st.lastTrace >= 50) { st.trace.push({ t: Math.round(elapsed), x: +(p.x / st.W).toFixed(4), y: +((p.y - TOP) / (st.H - TOP)).toFixed(4) }); st.lastTrace = elapsed; }
      }
      st.game.draw(ctx, now, p);
      if (!p) { ctx.fillStyle = C.muted; ctx.font = '600 16px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(st.mode === 'gaze' ? 'Looking for your eyes…' : 'Move the mouse', st.W / 2, TOP + 30); }
      if (elapsed < 0) {
        const n = Math.ceil(-elapsed / 1000);
        ctx.fillStyle = 'rgba(255,255,255,.7)'; ctx.fillRect(0, TOP, st.W, st.H - TOP);
        ctx.fillStyle = C.ink; ctx.font = '800 120px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(n), st.W / 2, st.H / 2); ctx.textBaseline = 'alphabetic';
      }
      hud(now);
      const timed = st.game.timed !== false;
      if ((timed && elapsed >= roundMs) || (!timed && (st.game.over?.() || elapsed >= 600000))) {
        st.running = false;
        onEnd?.({ game: st.id, title: st.game.title, mode: st.mode, timed, roundS: timed ? roundMs / 1000 : Math.round(elapsed / 1000), ...st.game.result(), trace: st.trace, field: { w: Math.round(st.W), h: Math.round(st.H - TOP) }, t: Date.now() });
        return;
      }
      st.raf = requestAnimationFrame(frame);
    }
    canvas.addEventListener('pointermove', (e) => { const r = canvas.getBoundingClientRect(); st.mouse = { x: e.clientX - r.left, y: e.clientY - r.top }; });
    addEventListener('resize', () => { if (st.running) size(); });
    addEventListener('keydown', (e) => {
      if (canvas.offsetParent === null) return;
      if (e.key === 'm' || e.key === 'M') api.setMode(st.mode === 'gaze' ? 'mouse' : 'gaze');
      if (['1', '2', '3'].includes(e.key)) onSmoothing?.({ 1: 'off', 2: 'light', 3: 'strong' }[e.key]);
    });
    const api = {
      start(id, opts = {}) {
        cancelAnimationFrame(st.raf); size();
        roundMs = opts.durationS ? opts.durationS * 1000 : defaultRoundMs; st.trace = []; st.lastTrace = -1e9;
        st.id = id; st.game = FACTORY[id](); st.game.init(st.W, st.H);
        st.startAt = performance.now(); st.last = 0; st.running = true;
        st.raf = requestAnimationFrame(frame);
      },
      stop() { st.running = false; cancelAnimationFrame(st.raf); },
      feed(x, y) { const r = canvas.getBoundingClientRect(); st.gaze = { x: x - r.left, y: y - r.top }; st.gazeAt = performance.now(); },
      setMode(m) { st.mode = m; canvas.style.cursor = m === 'gaze' ? 'none' : 'crosshair'; onHud?.({ id: st.id, title: st.game?.title, score: st.game?.score() ?? 0, secondsLeft: null, mode: m }); },
      get mode() { return st.mode; },
      get running() { return st.running; }
    };
    canvas.style.cursor = 'none';
    return api;
  }

  global.GazeGames = { create, GAMES: Object.keys(FACTORY), ROUND_MS, PONG_LIVES };
})(window);
