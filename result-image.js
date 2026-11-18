/* ResultImage — draws an exportable summary figure (PNG) for one game round.
 * Layout (1200 × 720 logical px, rendered at 2× for print):
 *   header: game, player, date, control mode, tracker / smoothing / validation error
 *   left:   big score + three statistics
 *   right:  game-specific main chart (top) + gaze heatmap and a second panel (bottom)
 */
(function (global) {
  'use strict';

  const W = 1200; const H = 720; const SCALE = 2;
  const C = { ink: '#172027', ink2: '#52514e', muted: '#898781', grid: '#e1e0d9', axis: '#c3c2b7', surface: '#ffffff', panel: '#fbfcfc', gaze: '#2a78d6', mouse: '#eb6834', ball: '#eb6834', good: '#0ca30c', bad: '#d03b3b', teal: '#087f73', seq: ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'] };
  const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

  function text(ctx, s, x, y, { size = 13, weight = 400, color = C.ink2, align = 'left', base = 'alphabetic' } = {}) {
    ctx.font = `${weight} ${size}px ${FONT}`; ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = base; ctx.fillText(s, x, y);
  }
  function panel(ctx, x, y, w, h, title, sub, legend) {
    ctx.fillStyle = C.panel; ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, 10) : ctx.rect(x, y, w, h); ctx.fill(); ctx.stroke();
    text(ctx, title, x + 16, y + 26, { size: 15, weight: 700, color: C.ink });
    if (sub) text(ctx, sub, x + 16, y + 44, { size: 11, color: C.muted });
    if (legend) {
      let lx = x + w - 16;
      legend.slice().reverse().forEach(([color, label, shape]) => {
        ctx.font = `12px ${FONT}`; const tw = ctx.measureText(label).width;
        text(ctx, label, lx, y + 26, { size: 12, color: C.ink2, align: 'right' }); lx -= tw + 8;
        ctx.fillStyle = color; ctx.strokeStyle = color; ctx.lineWidth = 2.5;
        if (shape === 'x') { ctx.beginPath(); ctx.moveTo(lx - 9, y + 17); ctx.lineTo(lx - 1, y + 25); ctx.moveTo(lx - 1, y + 17); ctx.lineTo(lx - 9, y + 25); ctx.stroke(); }
        else if (shape === 'dot') { ctx.beginPath(); ctx.arc(lx - 5, y + 21, 4.5, 0, 7); ctx.fill(); }
        else ctx.fillRect(lx - 14, y + 20, 14, 3);
        lx -= 26;
      });
    }
    return { x: x + 16, y: y + (sub ? 58 : 40), w: w - 32, h: h - (sub ? 72 : 54) };
  }
  function niceMax(v) { if (!(v > 0)) return 1; const p = 10 ** Math.floor(Math.log10(v)); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; }
  /** xTicks: array of [value, label]. */
  function axes(ctx, a, xMax, yMax, xTicks, yFmt) {
    const l = 40; const b = 22; const box = { x: a.x + l, y: a.y + 4, w: a.w - l - 6, h: a.h - b - 4 };
    for (let i = 0; i <= 4; i += 1) {
      const v = (yMax * i) / 4; const y = box.y + box.h - (v / yMax) * box.h;
      ctx.strokeStyle = i ? C.grid : C.axis; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(box.x, y); ctx.lineTo(box.x + box.w, y); ctx.stroke();
      const lab = yFmt(v); if (lab) text(ctx, lab, box.x - 6, y, { size: 10, color: C.muted, align: 'right', base: 'middle' });
    }
    xTicks.forEach(([v, lab]) => text(ctx, lab, box.x + (v / xMax) * box.w, box.y + box.h + 15, { size: 10, color: C.muted, align: 'center' }));
    return { ...box, sx: (v) => box.x + (v / xMax) * box.w, sy: (v) => box.y + box.h - (v / yMax) * box.h };
  }
  /** Time ticks every 1/2/5/10/15/30/60 s, at most ~7 of them. */
  function timeTicks(T) {
    const step = [1, 2, 5, 10, 15, 30, 60, 120].map((x) => x * 1000).find((st) => T / st <= 7) || 300000;
    const out = []; for (let v = 0; v <= T + 1; v += step) out.push([v, `${Math.round(v / 1000)}s`]); return out;
  }

  function heatmap(ctx, a, trace, field, overlay) {
    const ar = field && field.w && field.h ? field.w / field.h : 16 / 9;
    let w = a.w; let h = w / ar; if (h > a.h) { h = a.h; w = h * ar; }
    const x0 = a.x + (a.w - w) / 2; const y0 = a.y + (a.h - h) / 2;
    ctx.fillStyle = C.surface; ctx.fillRect(x0, y0, w, h); ctx.strokeStyle = C.axis; ctx.strokeRect(x0 + 0.5, y0 + 0.5, w - 1, h - 1);
    overlay?.(ctx, x0, y0, w, h);
    const gw = 96; const gh = Math.max(8, Math.round(gw / ar)); const grid = new Float32Array(gw * gh);
    (trace || []).forEach((p) => {
      if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return;
      const cx = p.x * gw; const cy = p.y * gh;
      for (let y = Math.max(0, Math.floor(cy - 5)); y < Math.min(gh, cy + 5); y += 1) for (let x = Math.max(0, Math.floor(cx - 5)); x < Math.min(gw, cx + 5); x += 1) grid[y * gw + x] += Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / 6);
    });
    const max = Math.max(1e-9, ...grid);
    const off = document.createElement('canvas'); off.width = gw; off.height = gh; const oc = off.getContext('2d'); const img = oc.createImageData(gw, gh);
    const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
    grid.forEach((v, i) => {
      const f = Math.min(0.999, v / max) * (C.seq.length - 1); const k = Math.floor(f); const t = f - k;
      const p = hex(C.seq[k]); const q = hex(C.seq[Math.min(k + 1, C.seq.length - 1)]);
      img.data.set([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t, Math.min(1, (v / max) * 2.2) * 230], i * 4);
    });
    oc.putImageData(img, 0, 0); ctx.imageSmoothingEnabled = true; ctx.drawImage(off, x0, y0, w, h);
    if (!trace?.length) text(ctx, 'no gaze samples', x0 + w / 2, y0 + h / 2, { size: 12, color: C.muted, align: 'center', base: 'middle' });
  }

  /* -------- game-specific panels -------- */
  function bubblesMain(ctx, a, r) {
    const ev = r.events || []; const T = r.roundS * 1000; const n = ev.length;
    const ax = axes(ctx, a, T, niceMax(Math.max(5, n)), timeTicks(T), (v) => String(Math.round(v)));
    ctx.strokeStyle = C[r.mode] || C.gaze; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(ax.sx(0), ax.sy(0));
    ev.forEach((e, i) => { ctx.lineTo(ax.sx(e.t), ax.sy(i)); ctx.lineTo(ax.sx(e.t), ax.sy(i + 1)); });
    ctx.lineTo(ax.sx(T), ax.sy(n)); ctx.stroke();
    ev.forEach((e, i) => { ctx.beginPath(); ctx.arc(ax.sx(e.t), ax.sy(i + 1), 3.5, 0, 7); ctx.fillStyle = C[r.mode] || C.gaze; ctx.fill(); });
  }
  function bubblesSecond(ctx, a, r) {
    const T = r.roundS * 1000; const bin = 10000; const nb = Math.max(1, Math.ceil(T / bin)); const counts = new Array(nb).fill(0);
    (r.events || []).forEach((e) => { counts[Math.min(nb - 1, Math.floor(e.t / bin))] += 1; });
    const ax = axes(ctx, a, nb, niceMax(Math.max(2, ...counts)), counts.map((_, i) => [i + 0.5, `${i * 10}–${Math.min((i + 1) * 10, Math.round(T / 1000))}s`]), (v) => String(Math.round(v)));
    const bw = Math.min(28, (ax.w / nb) * 0.6);
    counts.forEach((c, i) => { const x = ax.sx(i + 0.5) - bw / 2; const y = ax.sy(c); ctx.fillStyle = C[r.mode] || C.gaze; ctx.fillRect(x, y, bw, ax.sy(0) - y); if (c) text(ctx, String(c), x + bw / 2, y - 4, { size: 10, color: C.ink2, align: 'center' }); });
  }
  function molesMain(ctx, a, r) {
    const ev = r.events || []; const T = r.roundS * 1000;
    const rtMax = niceMax(Math.max(1000, ...ev.filter((e) => e.hit).map((e) => e.rt)));
    const ax = axes(ctx, a, T, rtMax, timeTicks(T), (v) => `${(v / 1000).toFixed(1)}s`);
    ev.forEach((e) => {
      const x = ax.sx(e.t);
      if (e.hit) { ctx.beginPath(); ctx.arc(x, ax.sy(e.rt), 5, 0, 7); ctx.fillStyle = C.good; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke(); }
      else { const y = ax.y + 8; ctx.strokeStyle = C.bad; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(x - 5, y - 5); ctx.lineTo(x + 5, y + 5); ctx.moveTo(x + 5, y - 5); ctx.lineTo(x - 5, y + 5); ctx.stroke(); }
    });
  }
  function molesSecond(ctx, a, r) {
    const ev = r.events || []; const cells = Array.from({ length: 9 }, (_, i) => { const e = ev.filter((x) => x.cell === i); return { n: e.length, hit: e.filter((x) => x.hit).length }; });
    const size = Math.min(a.w, a.h); const x0 = a.x + (a.w - size * 1.4) / 2; const cw = (size * 1.4) / 3; const ch = size / 3;
    cells.forEach((c, i) => {
      const x = x0 + (i % 3) * cw; const y = a.y + Math.floor(i / 3) * ch; const rate = c.n ? c.hit / c.n : null;
      ctx.fillStyle = rate == null ? '#f0f1ef' : C.seq[Math.min(6, Math.round(rate * 5) + 1)]; ctx.fillRect(x + 2, y + 2, cw - 4, ch - 4);
      const dark = rate != null && rate > 0.55;
      text(ctx, rate == null ? '–' : `${Math.round(rate * 100)}%`, x + cw / 2, y + ch / 2 - 4, { size: 16, weight: 700, color: dark ? '#fff' : C.ink, align: 'center', base: 'middle' });
      text(ctx, c.n ? `${c.hit}/${c.n}` : 'no moles', x + cw / 2, y + ch / 2 + 14, { size: 10, color: dark ? '#fff' : C.ink2, align: 'center', base: 'middle' });
    });
  }
  function pongMain(ctx, a, r) {
    const tr = r.track || []; const T = Math.max(1000, (r.roundS || 1) * 1000);
    const ax = axes(ctx, a, T, 1, timeTicks(T), (v) => (v === 0 ? 'left' : v === 1 ? 'right' : ''));
    const line = (key, color, width) => { ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath(); let started = false; tr.forEach((p) => { if (p[key] == null) { started = false; return; } const x = ax.sx(p.t); const y = ax.sy(p[key]); if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y); }); ctx.stroke(); };
    // y axis = horizontal screen position (left at the bottom, right at the top)
    line('ball', C.ball, 2); line('paddle', C[r.mode] || C.gaze, 2.5);
    (r.events || []).filter((e) => e.type === 'miss').forEach((e) => { const x = ax.sx(e.t); ctx.strokeStyle = C.bad; ctx.setLineDash([4, 4]); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x, ax.y); ctx.lineTo(x, ax.y + ax.h); ctx.stroke(); ctx.setLineDash([]); const right = x > ax.x + ax.w - 40; text(ctx, 'miss', right ? x - 4 : x + 4, ax.y + 12, { size: 10, color: C.bad, align: right ? 'right' : 'left' }); });
  }
  function pongSecond(ctx, a, r) {
    const rallies = r.raw?.rallies || []; const n = Math.max(1, rallies.length);
    const ax = axes(ctx, a, n, niceMax(Math.max(3, ...rallies)), [], (v) => String(Math.round(v)));
    const bw = Math.min(60, (ax.w / n) * 0.5);
    rallies.forEach((c, i) => { const x = ax.sx(i + 0.5) - bw / 2; const y = ax.sy(c); ctx.fillStyle = C[r.mode] || C.gaze; ctx.fillRect(x, y, bw, ax.sy(0) - y); text(ctx, `${c} return${c === 1 ? '' : 's'}`, x + bw / 2, y - 5, { size: 11, color: C.ink2, align: 'center' }); text(ctx, `life ${i + 1}`, x + bw / 2, ax.sy(0) + 15, { size: 10, color: C.muted, align: 'center' }); });
  }
  const SPEC = {
    bubbles: { main: ['Balls popped over time', 'cumulative count'], mainFn: bubblesMain, second: ['Pops per 10 s', 'speed across the round'], secondFn: bubblesSecond },
    moles: { main: ['Every mole', 'green = hit (height = reaction time), red = escaped'], mainFn: molesMain, second: ['Hit rate per hole', 'reveals screen regions where gaze is less accurate'], secondFn: molesSecond },
    pong: { main: ['Ball vs paddle (horizontal position)', 'how closely your gaze followed the ball'], mainFn: pongMain, second: ['Rally length per life', 'returns before each miss'], secondFn: pongSecond }
  };

  function render(r, meta = {}) {
    const canvas = document.createElement('canvas'); canvas.width = W * SCALE; canvas.height = H * SCALE;
    const ctx = canvas.getContext('2d'); ctx.scale(SCALE, SCALE);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
    // header
    ctx.fillStyle = C.teal; ctx.fillRect(0, 0, W, 6);
    text(ctx, 'GAZE GAMES · RESULT', 40, 42, { size: 12, weight: 800, color: C.teal });
    text(ctx, r.title, 40, 78, { size: 32, weight: 800, color: C.ink });
    const when = new Date(r.t || Date.now()); const pad = (n) => String(n).padStart(2, '0');
    const dateStr = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}`;
    text(ctx, `${meta.player || ''}`, W - 40, 50, { size: 20, weight: 700, color: C.ink, align: 'right' });
    text(ctx, dateStr, W - 40, 74, { size: 13, color: C.muted, align: 'right' });
    const ctl = r.mode === 'gaze' ? 'Eye control' : 'Mouse control';
    const len = r.timed === false ? `${r.roundS} s · ${r.raw?.lives || 3} lives` : `${r.roundS} s round`;
    const tech = [ctl, len, r.tracker ? `tracker: ${r.tracker}` : null, r.smoothing ? `smoothing: ${r.smoothing}` : null, r.validationMedianErrorPx != null ? `validation error ≈ ${r.validationMedianErrorPx}px` : null].filter(Boolean).join('   ·   ');
    text(ctx, tech, 40, 104, { size: 12, color: C.ink2 });
    ctx.strokeStyle = C.grid; ctx.beginPath(); ctx.moveTo(40, 118); ctx.lineTo(W - 40, 118); ctx.stroke();
    // left column
    const unit = { bubbles: 'balls popped', moles: 'moles hit', pong: 'returns' }[r.game] || 'points';
    text(ctx, String(r.score), 40, 230, { size: 96, weight: 800, color: C.ink });
    text(ctx, unit, 44, 262, { size: 16, color: C.muted });
    const stats = Object.entries(r.statsText || {});
    stats.forEach(([k, v], i) => {
      const y = 300 + i * 92;
      ctx.fillStyle = C.panel; ctx.strokeStyle = C.grid; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(40, y, 300, 76, 10) : ctx.rect(40, y, 300, 76); ctx.fill(); ctx.stroke();
      text(ctx, v, 58, y + 38, { size: 26, weight: 700, color: C.ink });
      text(ctx, k, 58, y + 62, { size: 12, color: C.muted });
    });
    // right column
    const spec = SPEC[r.game];
    const modeColor = C[r.mode] || C.gaze;
    const legend = { bubbles: null, moles: [[C.good, 'hit', 'dot'], [C.bad, 'escaped', 'x']], pong: [[C.ball, 'ball'], [modeColor, r.mode === 'gaze' ? 'paddle (your gaze)' : 'paddle (mouse)'], [C.bad, 'miss', 'x']] }[r.game];
    const a1 = panel(ctx, 370, 138, 790, 300, spec.main[0], spec.main[1], legend); spec.mainFn(ctx, a1, r);
    const a2 = panel(ctx, 370, 452, 385, 240, 'Where you looked', 'gaze heatmap over the play area'); heatmap(ctx, a2, r.trace, r.field, r.game === 'moles' ? (c, x, y, w, h) => { c.strokeStyle = C.grid; for (let i = 1; i < 3; i += 1) { c.beginPath(); c.moveTo(x + (w * i) / 3, y); c.lineTo(x + (w * i) / 3, y + h); c.moveTo(x, y + (h * i) / 3); c.lineTo(x + w, y + (h * i) / 3); c.stroke(); } } : null);
    const a3 = panel(ctx, 775, 452, 385, 240, spec.second[0], spec.second[1]); spec.secondFn(ctx, a3, r);
    text(ctx, 'BN5213 · webcam gaze as a simulated selection BCI', 40, H - 16, { size: 10, color: C.muted });
    return canvas;
  }

  global.ResultImage = { render };
})(window);
