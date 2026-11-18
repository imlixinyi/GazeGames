/* GazeViz — metrics + charts for the gaze-selection experiment.
 * Used by index.html (single-session results) and analysis.html (multi-participant summary).
 * Plain SVG/canvas, no external libraries, so it works offline. */
(function (global) {
  'use strict';

  /* ================= palette (validated reference palette, light mode) ================= */
  const C = {
    surface: '#fcfcfb', ink: '#0b0b0b', ink2: '#52514e', muted: '#898781', grid: '#e1e0d9', axis: '#c3c2b7',
    gaze: '#2a78d6', mouse: '#eb6834', feature: '#1baf7a', conjunction: '#6250d6', neutral: '#898781',
    good: '#0ca30c', warning: '#fab219', critical: '#d03b3b',
    seq: ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b']
  };
  const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
  const MODES = ['gaze', 'mouse'];
  const MODE_LABEL = { gaze: 'Gaze (dwell)', mouse: 'Mouse (click)' };
  const OUTCOMES = [['correct', 'Correct', C.good, '✓'], ['incorrect', 'Wrong target', C.critical, '✕'], ['skipped', 'Skipped', C.warning, '–']];

  /* ================= statistics ================= */
  const finite = (v) => typeof v === 'number' && Number.isFinite(v);
  function median(values) { const s = values.filter(finite).sort((a, b) => a - b); if (!s.length) return null; const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
  function mean(values) { const v = values.filter(finite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; }
  function sd(values) { const v = values.filter(finite); if (v.length < 2) return null; const m = mean(v); return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1)); }
  function quantile(values, q) { const s = values.filter(finite).sort((a, b) => a - b); if (!s.length) return null; const pos = (s.length - 1) * q; const lo = Math.floor(pos); return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (pos - lo); }
  const round = (v, d = 0) => (finite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

  /** Wolpaw bits per selection for N choices at accuracy P. */
  function wolpawBits(N, P) {
    if (!(N > 1) || !finite(P)) return null;
    if (P <= 1 / N) return 0;
    if (P >= 1) return Math.log2(N);
    return Math.log2(N) + P * Math.log2(P) + (1 - P) * Math.log2((1 - P) / (N - 1));
  }
  /** ITR in bits/min. Groups trials by N (choice count) so mixed set sizes are handled correctly.
   *  timeKey: 'durationMs' = selection time only; overheadMs adds fixation + feedback interval per selection. */
  function itr(trials, overheadMs = 0) {
    if (!trials.length) return null;
    const byN = groupBy(trials, (t) => Number(t.setSize) || 4);
    let bits = 0; let ms = 0;
    Object.entries(byN).forEach(([N, list]) => {
      const P = list.filter((t) => t.correct).length / list.length;
      bits += wolpawBits(Number(N), P) * list.length;
      ms += list.reduce((a, t) => a + (finite(t.durationMs) ? t.durationMs : (t.rtMs || 0)) + overheadMs, 0);
    });
    return ms > 0 ? bits / (ms / 60000) : null;
  }
  function groupBy(list, keyFn) { return list.reduce((acc, item) => { const k = keyFn(item); (acc[k] = acc[k] || []).push(item); return acc; }, {}); }

  function summarize(trials, overheadMs) {
    const n = trials.length;
    const count = (o) => trials.filter((t) => t.outcome === o).length;
    const correctRts = trials.filter((t) => t.correct && finite(t.rtMs)).map((t) => t.rtMs);
    const respondedRts = trials.filter((t) => finite(t.rtMs)).map((t) => t.rtMs);
    return {
      n, correct: count('correct'), incorrect: count('incorrect'), skipped: count('skipped'), timedOut: trials.filter((t) => t.timedOut).length,
      accuracyPct: n ? round(100 * count('correct') / n, 1) : null,
      errorPct: n ? round(100 * count('incorrect') / n, 1) : null,
      skipPct: n ? round(100 * count('skipped') / n, 1) : null,
      medianRtMs: round(median(correctRts)), meanRtMs: round(mean(correctRts)), sdRtMs: round(sd(correctRts)),
      q1RtMs: round(quantile(correctRts, 0.25)), q3RtMs: round(quantile(correctRts, 0.75)),
      medianRtAllMs: round(median(respondedRts)),
      itrBitsPerMin: round(itr(trials), 1), itrPracticalBitsPerMin: round(itr(trials, overheadMs), 1),
      gazeHz: round(median(trials.map((t) => t.gazeHz)), 1), gazeOnBoardPct: round(100 * (median(trials.map((t) => t.gazeOnBoardRate)) ?? NaN), 1)
    };
  }

  const taskLabel = (t) => (t.taskType === 'search' ? 'Search' : 'Choice');
  const sizeLabel = (s) => (s === 'small' ? 'Small' : 'Large');
  function conditionKey(t, multiTask) { return multiTask ? `${taskLabel(t)} · ${sizeLabel(t.targetSize)}` : `${sizeLabel(t.targetSize)} targets`; }

  function computeMetrics(payload) {
    const trials = (payload.trials || []).filter((t) => !t.practice);
    const settings = payload.settings || payload; // v1 payloads stored settings at the top level
    const overheadMs = (Number(settings.fixationMs) || 500) + 1100;
    const modes = MODES.filter((m) => trials.some((t) => t.mode === m));
    const multiTask = new Set(trials.map((t) => t.taskType)).size > 1;
    const conditions = [...new Set(trials.map((t) => conditionKey(t, multiTask)))].sort((a, b) => a.localeCompare(b));
    const byMode = Object.fromEntries(modes.map((m) => [m, summarize(trials.filter((t) => t.mode === m), overheadMs)]));
    const byCondition = {};
    conditions.forEach((c) => { byCondition[c] = Object.fromEntries(modes.map((m) => [m, summarize(trials.filter((t) => t.mode === m && conditionKey(t, multiTask) === c), overheadMs)])); });
    const searchTrials = trials.filter((t) => t.taskType === 'search');
    const search = searchTrials.length ? modes.map((m) => ({ mode: m, rows: ['feature', 'conjunction'].map((type) => ({ type, points: [4, 8].map((N) => { const list = searchTrials.filter((t) => t.mode === m && t.searchType === type && Number(t.setSize) === N); return { setSize: N, n: list.length, medianRtMs: round(median(list.filter((t) => t.correct).map((t) => t.rtMs))), accuracyPct: list.length ? round(100 * list.filter((t) => t.correct).length / list.length, 1) : null }; }) })) })) : null;
    const v = payload.validation;
    const q = payload.questionnaire || null;
    return {
      participantId: payload.participantId, tracker: payload.tracker || payload.settings?.tracker || 'webgazer', simulated: Boolean(payload.simulated || trials.some((t) => t.simulated)),
      trials, modes, conditions, multiTask, overheadMs, settings,
      overall: summarize(trials, overheadMs), byMode, byCondition, search,
      validation: v ? { medianErrorPx: v.medianErrorPx, medianErrorPctDiag: v.medianErrorPctDiag ?? null, precisionPx: v.medianPrecisionPx ?? null, accuracy: v.accuracy, passed: v.passed, attempts: (payload.validationHistory || []).length || 1 } : null,
      tlx: q?.tlx || null, sus: q?.sus || null, preference: q?.preference || null, comment: q?.comment || ''
    };
  }

  /* ================= DOM / SVG helpers ================= */
  const NS = 'http://www.w3.org/2000/svg';
  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => { if (v == null) return; if (k === 'text') node.textContent = v; else if (k === 'class') node.className = v; else node.setAttribute(k, v); });
    [].concat(children).filter(Boolean).forEach((c) => node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return node;
  }
  function s(tag, attrs = {}, children = []) {
    const node = document.createElementNS(NS, tag);
    Object.entries(attrs).forEach(([k, v]) => { if (v == null) return; if (k === 'text') node.textContent = v; else node.setAttribute(k, v); });
    [].concat(children).filter(Boolean).forEach((c) => node.appendChild(c));
    return node;
  }
  const txt = (x, y, text, o = {}) => s('text', { x, y, 'font-family': FONT, 'font-size': o.size || 11, fill: o.fill || C.muted, 'text-anchor': o.anchor || 'start', 'dominant-baseline': o.baseline || 'auto', 'font-weight': o.weight || 400, text });
  function niceMax(v) { if (!(v > 0)) return 1; const p = 10 ** Math.floor(Math.log10(v)); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p; }
  function ticks(max, count = 4) { const step = niceMax(max / count); const out = []; for (let v = 0; v <= max + 1e-9; v += step) out.push(round(v, 6)); return out; }
  /** Column with 4px rounded data-end, square at the baseline. */
  function colPath(x, y, w, h) { const r = Math.min(4, w / 2, h); return h <= 0 ? '' : `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`; }
  function rowPath(x, y, w, h) { const r = Math.min(4, h / 2, w); return w <= 0 ? '' : `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`; }
  const fmtS = (ms) => (finite(ms) ? `${(ms / 1000).toFixed(2)} s` : '–');
  const fmtPct = (v) => (finite(v) ? `${v}%` : '–');

  /* ---- tooltip (values lead, labels follow; textContent only) ---- */
  let tip = null;
  function tooltip() {
    if (tip) return tip;
    tip = el('div', { class: 'gv-tooltip', role: 'tooltip' }); tip.hidden = true; document.body.appendChild(tip);
    return tip;
  }
  function showTip(event, rows, title) {
    const t = tooltip(); t.replaceChildren();
    if (title) t.appendChild(el('div', { class: 'gv-tip-title', text: title }));
    rows.forEach(([color, value, label]) => t.appendChild(el('div', { class: 'gv-tip-row' }, [color ? el('span', { class: 'gv-key', style: `background:${color}` }) : null, el('strong', { text: value }), el('span', { text: label || '' })])));
    t.hidden = false;
    const x = event.clientX ?? (event.target.getBoundingClientRect().left + 10); const y = event.clientY ?? event.target.getBoundingClientRect().top;
    const w = t.offsetWidth; const h = t.offsetHeight;
    t.style.left = `${Math.min(innerWidth - w - 8, x + 14)}px`; t.style.top = `${Math.max(8, y - h - 10)}px`;
  }
  const hideTip = () => { if (tip) tip.hidden = true; };
  function hover(node, rowsFn, titleFn) {
    node.setAttribute('tabindex', '0'); node.classList.add('gv-hit');
    const show = (e) => showTip(e, rowsFn(), titleFn ? titleFn() : null);
    node.addEventListener('pointermove', show); node.addEventListener('focus', show);
    node.addEventListener('pointerleave', hideTip); node.addEventListener('blur', hideTip);
  }

  /* ---- card + legend + export ---- */
  function card(title, subtitle, opts = {}) {
    const exportBtn = el('button', { class: 'gv-export', type: 'button', text: 'PNG', title: 'Download this chart as PNG' });
    const head = el('div', { class: 'gv-card-head' }, [el('div', {}, [el('h3', { text: title }), subtitle ? el('p', { class: 'gv-sub', text: subtitle }) : null]), exportBtn]);
    const body = el('div', { class: 'gv-card-body' });
    const node = el('section', { class: `gv-card ${opts.wide ? 'gv-wide' : ''} ${opts.full ? 'gv-full' : ''}` }, [head, body]);
    exportBtn.addEventListener('click', () => exportCard(node, title));
    return { node, body };
  }
  function legend(items, kind = 'rect') {
    return el('div', { class: 'gv-legend' }, items.map(([color, label, extra]) => el('span', { class: 'gv-legend-item' }, [el('span', { class: `gv-swatch gv-swatch-${extra || kind}`, style: `--c:${color}` }), label])));
  }
  function slug(t) { return t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
  async function exportCard(node, title) {
    const scale = 2; const svg = node.querySelector('.gv-card-body svg'); const canvas = node.querySelector('.gv-card-body canvas');
    const source = svg || canvas; if (!source) return;
    const box = source.getBoundingClientRect(); const legendEl = node.querySelector('.gv-legend');
    const titleH = 44; const legendH = legendEl ? 26 : 0;
    const out = document.createElement('canvas'); out.width = Math.round(box.width * scale); out.height = Math.round((box.height + titleH + legendH + 12) * scale);
    const ctx = out.getContext('2d'); ctx.scale(scale, scale);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, box.width, box.height + titleH + legendH + 12);
    ctx.fillStyle = C.ink; ctx.font = `600 15px ${FONT}`; ctx.fillText(title, 8, 22);
    const sub = node.querySelector('.gv-sub'); if (sub) { ctx.fillStyle = C.ink2; ctx.font = `12px ${FONT}`; ctx.fillText(sub.textContent.slice(0, 120), 8, 38); }
    let lx = 8; const ly = titleH + 8;
    if (legendEl) {
      legendEl.querySelectorAll('.gv-legend-item').forEach((item) => {
        const sw = item.querySelector('.gv-swatch'); const color = sw.style.getPropertyValue('--c').trim();
        ctx.fillStyle = color; if (sw.classList.contains('gv-swatch-line')) ctx.fillRect(lx, ly + 5, 14, 2); else if (sw.classList.contains('gv-swatch-dot')) { ctx.beginPath(); ctx.arc(lx + 5, ly + 6, 4.5, 0, 7); ctx.fill(); } else ctx.fillRect(lx, ly, 12, 12);
        ctx.fillStyle = C.ink2; ctx.font = `12px ${FONT}`; ctx.fillText(item.textContent, lx + 18, ly + 10); lx += 30 + ctx.measureText(item.textContent).width;
      });
    }
    const top = titleH + legendH + 4;
    if (svg) {
      const clone = svg.cloneNode(true); clone.setAttribute('width', box.width); clone.setAttribute('height', box.height);
      const img = new Image(); const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }));
      await new Promise((resolve) => { img.onload = resolve; img.onerror = resolve; img.src = url; });
      ctx.drawImage(img, 0, top, box.width, box.height); URL.revokeObjectURL(url);
    } else ctx.drawImage(canvas, 0, top, box.width, box.height);
    const a = document.createElement('a'); a.href = out.toDataURL('image/png'); a.download = `${slug(title)}.png`; document.body.appendChild(a); a.click(); a.remove();
  }

  /* ================= chart primitives ================= */
  const W = 560;
  function frame(h, m) { const svg = s('svg', { viewBox: `0 0 ${W} ${h}`, class: 'gv-svg', role: 'img', 'font-family': FONT }); svg.appendChild(s('rect', { x: 0, y: 0, width: W, height: h, fill: C.surface })); return { svg, iw: W - m.l - m.r, ih: h - m.t - m.b }; }
  function yAxis(svg, m, iw, ih, max, fmt) {
    ticks(max).forEach((v) => { const y = m.t + ih - (v / max) * ih; svg.appendChild(s('line', { x1: m.l, x2: m.l + iw, y1: y, y2: y, stroke: v === 0 ? C.axis : C.grid, 'stroke-width': 1 })); svg.appendChild(txt(m.l - 8, y, fmt(v), { anchor: 'end', baseline: 'middle' })); });
  }

  /** Grouped columns: categories on x, one column per series; optional per-participant dots. */
  function groupedColumns({ categories, series, get, max, fmt, yLabel, dots }) {
    const m = { t: 18, r: 12, b: 38, l: 46 }; const h = 280; const { svg, iw, ih } = frame(h, m);
    const yMax = max ?? niceMax(Math.max(1, ...categories.flatMap((c) => series.map((sr) => get(c, sr.key)?.value ?? 0)), ...(dots ? categories.flatMap((c) => series.flatMap((sr) => dots(c, sr.key))) : [])));
    yAxis(svg, m, iw, ih, yMax, fmt);
    if (yLabel) svg.appendChild(txt(12, m.t + ih / 2, yLabel, { anchor: 'middle', baseline: 'middle' })).setAttribute('transform', `rotate(-90 12 ${m.t + ih / 2})`);
    const band = iw / categories.length; const barW = Math.min(24, (band * 0.7) / series.length - 2);
    categories.forEach((c, ci) => {
      const groupW = series.length * barW + (series.length - 1) * 2; const x0 = m.l + ci * band + (band - groupW) / 2;
      svg.appendChild(txt(m.l + ci * band + band / 2, h - m.b + 18, c, { anchor: 'middle', fill: C.ink2 }));
      series.forEach((sr, si) => {
        const d = get(c, sr.key); if (!d || !finite(d.value)) return;
        const x = x0 + si * (barW + 2); const bh = (d.value / yMax) * ih; const y = m.t + ih - bh;
        const g = s('g'); g.appendChild(s('rect', { x: x - 4, y: m.t, width: barW + 8, height: ih, fill: 'transparent' }));
        g.appendChild(s('path', { d: colPath(x, y, barW, bh), fill: sr.color, class: 'gv-mark' }));
        if (finite(d.lo) && finite(d.hi)) g.appendChild(s('line', { x1: x + barW / 2, x2: x + barW / 2, y1: m.t + ih - (d.hi / yMax) * ih, y2: m.t + ih - (d.lo / yMax) * ih, stroke: C.ink2, 'stroke-width': 1.5 }));
        if (dots) dots(c, sr.key).forEach((v, k, arr) => g.appendChild(s('circle', { cx: x + barW / 2 + (arr.length > 1 ? (k / (arr.length - 1) - 0.5) * barW * 0.6 : 0), cy: m.t + ih - (v / yMax) * ih, r: 3.5, fill: C.surface, stroke: C.ink, 'stroke-width': 1.2 })));
        else if (bh > 0) g.appendChild(txt(x + barW / 2, y - 5, d.short ?? fmt(d.value), { anchor: 'middle', fill: C.ink2, size: 10 }));
        hover(g, () => [[sr.color, d.label ?? fmt(d.value), sr.label], ...(d.extra || []).map((e) => [null, e[0], e[1]])], () => c);
        svg.appendChild(g);
      });
    });
    return svg;
  }

  /** Strip plot: every trial as a dot (hollow = wrong target), median tick per group. */
  function stripPlot({ categories, series, points }) {
    const m = { t: 16, r: 12, b: 38, l: 46 }; const h = 280; const { svg, iw, ih } = frame(h, m);
    const all = categories.flatMap((c) => series.flatMap((sr) => points(c, sr.key).map((p) => p.v)));
    const yMax = niceMax(Math.max(1000, ...all));
    yAxis(svg, m, iw, ih, yMax, (v) => `${(v / 1000).toFixed(v % 1000 ? 1 : 0)} s`);
    const band = iw / categories.length; const lane = (band * 0.8) / series.length;
    categories.forEach((c, ci) => {
      svg.appendChild(txt(m.l + ci * band + band / 2, h - m.b + 18, c, { anchor: 'middle', fill: C.ink2 }));
      series.forEach((sr, si) => {
        const pts = points(c, sr.key); if (!pts.length) return;
        const cx = m.l + ci * band + band * 0.1 + lane * (si + 0.5);
        pts.forEach((p, k) => {
          const jitter = ((k * 0.618) % 1 - 0.5) * lane * 0.55; const y = m.t + ih - (p.v / yMax) * ih;
          const g = s('g'); g.appendChild(s('circle', { cx: cx + jitter, cy: y, r: 10, fill: 'transparent' }));
          g.appendChild(s('circle', { cx: cx + jitter, cy: y, r: 4, fill: p.ok ? sr.color : C.surface, stroke: p.ok ? C.surface : sr.color, 'stroke-width': 2, 'fill-opacity': p.ok ? 0.85 : 1 }));
          hover(g, () => [[sr.color, fmtS(p.v), sr.label], [null, p.ok ? 'correct' : 'wrong target', `trial ${p.trial}`]], () => c);
          svg.appendChild(g);
        });
        const med = median(pts.filter((p) => p.ok).map((p) => p.v));
        if (finite(med)) { const y = m.t + ih - (med / yMax) * ih; svg.appendChild(s('line', { x1: cx - lane * 0.38, x2: cx + lane * 0.38, y1: y, y2: y, stroke: C.ink, 'stroke-width': 2.5, 'stroke-linecap': 'round' })); svg.appendChild(txt(cx + lane * 0.42, y, fmtS(med), { baseline: 'middle', fill: C.ink2, size: 10 })); }
      });
    });
    return svg;
  }

  /** Horizontal 100% stacked bars for outcomes, one row per mode. */
  function outcomeBars(rows) {
    const m = { t: 10, r: 16, b: 26, l: 110 }; const rowH = 24; const gap = 22; const h = m.t + m.b + rows.length * (rowH + gap); const { svg, iw } = frame(h, m);
    [0, 25, 50, 75, 100].forEach((v) => { const x = m.l + (v / 100) * iw; svg.appendChild(s('line', { x1: x, x2: x, y1: m.t, y2: h - m.b, stroke: v ? C.grid : C.axis })); svg.appendChild(txt(x, h - m.b + 16, `${v}%`, { anchor: 'middle' })); });
    rows.forEach((r, ri) => {
      const y = m.t + ri * (rowH + gap) + gap / 2; let x = m.l;
      svg.appendChild(txt(m.l - 10, y + rowH / 2, r.label, { anchor: 'end', baseline: 'middle', fill: C.ink2, size: 12 }));
      OUTCOMES.forEach(([key, label, color], oi) => {
        const n = r.summary[key]; if (!n) return; const w = (n / r.summary.n) * iw - 2; const pct = round(100 * n / r.summary.n, 1);
        const g = s('g'); g.appendChild(s('rect', { x, y, width: Math.max(1, w), height: rowH, fill: color, rx: oi === 0 || x === m.l ? 0 : 0, class: 'gv-mark' }));
        if (w > 44) g.appendChild(txt(x + w / 2, y + rowH / 2, `${pct}%`, { anchor: 'middle', baseline: 'middle', fill: key === 'skipped' ? C.ink : '#ffffff', size: 11, weight: 600 }));
        hover(g, () => [[color, `${pct}%`, label], [null, `${n} of ${r.summary.n}`, 'trials']], () => r.label);
        svg.appendChild(g); x += w + 2;
      });
    });
    return svg;
  }

  /** Trial-by-trial scatter of selection time (learning / fatigue over the session). */
  function trialScatter(trials, modes) {
    const m = { t: 16, r: 14, b: 34, l: 46 }; const h = 260; const { svg, iw, ih } = frame(h, m);
    const pts = trials.filter((t) => finite(t.rtMs)); const xMax = Math.max(1, ...trials.map((t) => t.trial));
    const yMax = niceMax(Math.max(1000, ...pts.map((t) => t.rtMs)));
    yAxis(svg, m, iw, ih, yMax, (v) => `${(v / 1000).toFixed(v % 1000 ? 1 : 0)} s`);
    const xs = (v) => m.l + ((v - 0.5) / xMax) * iw;
    ticks(xMax, 6).filter((v) => v >= 1).forEach((v) => svg.appendChild(txt(xs(v), h - m.b + 16, String(v), { anchor: 'middle' })));
    svg.appendChild(txt(m.l + iw / 2, h - 4, 'Trial number', { anchor: 'middle' }));
    modes.forEach((mode) => {
      const list = pts.filter((t) => t.mode === mode).sort((a, b) => a.trial - b.trial); const color = C[mode];
      // running median (window 5) of correct trials shows the trend without over-plotting
      const ok = list.filter((t) => t.correct); const path = ok.map((t, i) => { const w = ok.slice(Math.max(0, i - 2), i + 3).map((d) => d.rtMs); return `${i ? 'L' : 'M'}${xs(t.trial)},${m.t + ih - (median(w) / yMax) * ih}`; }).join('');
      if (ok.length > 2) svg.appendChild(s('path', { d: path, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', opacity: 0.55 }));
      list.forEach((t) => {
        const g = s('g'); const cx = xs(t.trial); const cy = m.t + ih - (t.rtMs / yMax) * ih;
        g.appendChild(s('circle', { cx, cy, r: 10, fill: 'transparent' }));
        g.appendChild(s('circle', { cx, cy, r: 4.5, fill: t.correct ? color : C.surface, stroke: t.correct ? C.surface : color, 'stroke-width': 2 }));
        hover(g, () => [[color, fmtS(t.rtMs), MODE_LABEL[mode]], [null, t.correct ? 'correct' : `wrong (${t.selected} instead of ${t.target})`, `${sizeLabel(t.targetSize)} · ${taskLabel(t)}`]], () => `Trial ${t.trial}`);
        svg.appendChild(g);
      });
    });
    return svg;
  }

  /** Horizontal grouped bars (NASA-TLX subscales), 0–100. */
  function hGrouped({ rows, series, get, max = 100 }) {
    const m = { t: 8, r: 40, b: 24, l: 120 }; const barH = 10; const rowH = series.length * (barH + 2) + 14; const h = m.t + m.b + rows.length * rowH; const { svg, iw } = frame(h, m);
    [0, 25, 50, 75, 100].forEach((v) => { const x = m.l + (v / max) * iw; svg.appendChild(s('line', { x1: x, x2: x, y1: m.t, y2: h - m.b, stroke: v ? C.grid : C.axis })); svg.appendChild(txt(x, h - m.b + 15, String(v), { anchor: 'middle' })); });
    rows.forEach(([key, label], ri) => {
      const y0 = m.t + ri * rowH + 7; const bold = key === 'rawTlx';
      svg.appendChild(txt(m.l - 10, y0 + (series.length * (barH + 2)) / 2, label, { anchor: 'end', baseline: 'middle', fill: bold ? C.ink : C.ink2, size: 12, weight: bold ? 700 : 400 }));
      series.forEach((sr, si) => {
        const v = get(key, sr.key); if (!finite(v)) return; const y = y0 + si * (barH + 2); const w = (v / max) * iw;
        const g = s('g'); g.appendChild(s('rect', { x: m.l, y: y - 2, width: iw, height: barH + 4, fill: 'transparent' }));
        g.appendChild(s('path', { d: rowPath(m.l, y, Math.max(1, w), barH), fill: sr.color, class: 'gv-mark' }));
        g.appendChild(txt(m.l + w + 5, y + barH / 2, String(round(v, 1)), { baseline: 'middle', fill: C.ink2, size: 10 }));
        hover(g, () => [[sr.color, String(round(v, 1)), sr.label]], () => label);
        svg.appendChild(g);
      });
    });
    return svg;
  }

  /** Validation map: target crosses, median gaze dots, error vectors, precision circles. */
  function validationMap(validation) {
    const vw = validation.viewport?.width || 1440; const vh = validation.viewport?.height || 900;
    const h = Math.round(W * vh / vw); const svg = s('svg', { viewBox: `0 0 ${W} ${h}`, class: 'gv-svg', role: 'img' });
    const k = W / vw;
    svg.appendChild(s('rect', { x: 0.5, y: 0.5, width: W - 1, height: h - 1, fill: C.surface, stroke: C.axis }));
    validation.points.forEach((p) => {
      const ex = p.expectedX * k; const ey = p.expectedY * k;
      const g = s('g');
      g.appendChild(s('circle', { cx: ex, cy: ey, r: 22, fill: 'transparent' }));
      if (finite(p.precisionPx) && finite(p.medianX)) g.appendChild(s('circle', { cx: p.medianX * k, cy: p.medianY * k, r: Math.max(3, p.precisionPx * k), fill: C.gaze, 'fill-opacity': 0.1, stroke: C.gaze, 'stroke-opacity': 0.4 }));
      if (finite(p.medianX)) g.appendChild(s('line', { x1: ex, y1: ey, x2: p.medianX * k, y2: p.medianY * k, stroke: C.ink2, 'stroke-width': 1.5 }));
      g.appendChild(s('path', { d: `M${ex - 7},${ey}H${ex + 7}M${ex},${ey - 7}V${ey + 7}`, stroke: C.ink, 'stroke-width': 2 }));
      if (finite(p.medianX)) g.appendChild(s('circle', { cx: p.medianX * k, cy: p.medianY * k, r: 5, fill: C.gaze, stroke: C.surface, 'stroke-width': 2 }));
      const lx = ex + (ex > W * 0.7 ? -12 : 12); g.appendChild(txt(lx, ey + (ey < h * 0.2 ? 20 : -12), finite(p.medianErrorPx) ? `${p.medianErrorPx}px` : 'no data', { anchor: ex > W * 0.7 ? 'end' : 'start', fill: C.ink2, size: 11, weight: 600 }));
      hover(g, () => [[C.gaze, finite(p.medianErrorPx) ? `${p.medianErrorPx} px` : 'no data', 'median error'], [null, finite(p.precisionPx) ? `${p.precisionPx} px` : '–', 'precision (RMS spread)'], [null, String(p.sampleCount), 'samples']], () => `Point ${p.point}`);
      svg.appendChild(g);
    });
    return svg;
  }

  /** Search slope: RT vs set size, one line per search type (classic Treisman pattern). */
  function searchSlope(rows) {
    const m = { t: 16, r: 90, b: 34, l: 46 }; const h = 240; const { svg, iw, ih } = frame(h, m);
    const vals = rows.flatMap((r) => r.points.map((p) => p.medianRtMs)).filter(finite);
    const yMax = niceMax(Math.max(1000, ...vals)); yAxis(svg, m, iw, ih, yMax, (v) => `${(v / 1000).toFixed(v % 1000 ? 1 : 0)} s`);
    const xs = (N) => m.l + (N === 4 ? 0.2 : 0.8) * iw;
    [4, 8].forEach((N) => svg.appendChild(txt(xs(N), h - m.b + 16, `${N} items`, { anchor: 'middle', fill: C.ink2 })));
    rows.forEach((r) => {
      const color = C[r.type]; const pts = r.points.filter((p) => finite(p.medianRtMs));
      if (pts.length > 1) svg.appendChild(s('path', { d: pts.map((p, i) => `${i ? 'L' : 'M'}${xs(p.setSize)},${m.t + ih - (p.medianRtMs / yMax) * ih}`).join(''), stroke: color, 'stroke-width': 2, fill: 'none', 'stroke-linecap': 'round' }));
      pts.forEach((p, i) => {
        const g = s('g'); const cx = xs(p.setSize); const cy = m.t + ih - (p.medianRtMs / yMax) * ih;
        g.appendChild(s('circle', { cx, cy, r: 12, fill: 'transparent' })); g.appendChild(s('circle', { cx, cy, r: 5, fill: color, stroke: C.surface, 'stroke-width': 2 }));
        if (i === pts.length - 1) g.appendChild(txt(cx + 10, cy, r.type === 'feature' ? 'Feature' : 'Conjunction', { baseline: 'middle', fill: C.ink2, size: 11 }));
        hover(g, () => [[color, fmtS(p.medianRtMs), r.type], [null, fmtPct(p.accuracyPct), `accuracy (n=${p.n})`]], () => `${p.setSize} items`);
        svg.appendChild(g);
      });
    });
    return svg;
  }

  /** Paired dot plot across participants: one gray line per participant, mean marker per mode. */
  function pairedPlot({ participants, modes, get, fmt, max }) {
    const m = { t: 16, r: 50, b: 30, l: 46 }; const h = 230; const { svg, iw, ih } = frame(h, m);
    const vals = participants.flatMap((p) => modes.map((mo) => get(p, mo))).filter(finite);
    const yMax = max ?? niceMax(Math.max(1e-9, ...vals)); yAxis(svg, m, iw, ih, yMax, fmt);
    const xs = (i) => m.l + (modes.length === 1 ? 0.5 : 0.22 + 0.56 * i / (modes.length - 1)) * iw; const ys = (v) => m.t + ih - (v / yMax) * ih;
    modes.forEach((mo, i) => svg.appendChild(txt(xs(i), h - m.b + 18, MODE_LABEL[mo], { anchor: 'middle', fill: C.ink2 })));
    participants.forEach((p) => {
      const pts = modes.map((mo, i) => [i, get(p, mo)]).filter(([, v]) => finite(v));
      if (pts.length > 1) svg.appendChild(s('path', { d: pts.map(([i, v], k) => `${k ? 'L' : 'M'}${xs(i)},${ys(v)}`).join(''), stroke: C.axis, 'stroke-width': 1.5, fill: 'none' }));
      pts.forEach(([i, v]) => { const g = s('g'); g.appendChild(s('circle', { cx: xs(i), cy: ys(v), r: 10, fill: 'transparent' })); g.appendChild(s('circle', { cx: xs(i), cy: ys(v), r: 4, fill: C[modes[i]], 'fill-opacity': 0.55, stroke: C.surface, 'stroke-width': 1.5 })); hover(g, () => [[C[modes[i]], fmt(v), MODE_LABEL[modes[i]]]], () => p.participantId); svg.appendChild(g); });
    });
    modes.forEach((mo, i) => {
      const mv = mean(participants.map((p) => get(p, mo))); if (!finite(mv)) return;
      svg.appendChild(s('line', { x1: xs(i) - 18, x2: xs(i) + 18, y1: ys(mv), y2: ys(mv), stroke: C.ink, 'stroke-width': 2.5, 'stroke-linecap': 'round' }));
      svg.appendChild(txt(xs(i) + (i === modes.length - 1 ? 24 : -24), ys(mv), `M=${fmt(mv)}`, { anchor: i === modes.length - 1 ? 'start' : 'end', baseline: 'middle', fill: C.ink, size: 11, weight: 600 }));
    });
    return svg;
  }

  /* ================= heatmap + replay (canvas) ================= */
  function boardSpace(trial, x, y) { const b = trial.boardRect; return b ? [(x - b.left) / (b.right - b.left), (y - b.top) / (b.bottom - b.top)] : [x / (trial.viewport?.width || 1), y / (trial.viewport?.height || 1)]; }
  function layoutKey(t) { return t.taskType === 'search' && Number(t.setSize) === 8 ? `8-item search · ${sizeLabel(t.targetSize)}` : `2×2 · ${sizeLabel(t.targetSize)}`; }
  function heatColor(v) { // sequential blue ramp, transparent near zero
    const stops = C.seq; const f = Math.min(0.9999, v) * (stops.length - 1); const i = Math.floor(f); const t = f - i;
    const a = hex(stops[i]); const b = hex(stops[Math.min(i + 1, stops.length - 1)]);
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, Math.min(1, v * 2.2) * 0.9];
  }
  function hex(h) { return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); }
  function drawTargets(ctx, trial, w, h, opts = {}) {
    Object.entries(trial.targetBounds || {}).forEach(([label, r], idx) => {
      const [x0, y0] = boardSpace(trial, r.left, r.top); const [x1, y1] = boardSpace(trial, r.right, r.bottom);
      const item = trial.items?.[idx]; const isTarget = label === trial.target;
      ctx.save();
      if (item) { ctx.fillStyle = item.color === 'red' ? 'rgba(237,106,90,.35)' : 'rgba(123,198,164,.35)'; ctx.beginPath(); if (item.shape === 'circle') ctx.ellipse((x0 + x1) / 2 * w, (y0 + y1) / 2 * h, (x1 - x0) * w / 2, (y1 - y0) * h / 2, 0, 0, 7); else ctx.rect(x0 * w, y0 * h, (x1 - x0) * w, (y1 - y0) * h); ctx.fill(); }
      ctx.strokeStyle = opts.highlight && isTarget ? C.good : C.axis; ctx.lineWidth = opts.highlight && isTarget ? 3 : 1.2;
      ctx.strokeRect(x0 * w, y0 * h, (x1 - x0) * w, (y1 - y0) * h);
      if (!item) { ctx.fillStyle = C.muted; ctx.font = `600 ${Math.round(h / 14)}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(label, (x0 + x1) / 2 * w, (y0 + y1) / 2 * h); }
      ctx.restore();
    });
  }
  function heatmap(trials, w = W, h = 300) {
    const canvas = el('canvas', { class: 'gv-canvas', width: w * 2, height: h * 2 }); const ctx = canvas.getContext('2d'); ctx.scale(2, 2);
    ctx.fillStyle = C.surface; ctx.fillRect(0, 0, w, h);
    const gw = 112; const gh = Math.round(gw * h / w); const grid = new Float32Array(gw * gh); const sigma = 2.2; const R = 6;
    trials.forEach((t) => t.gaze.forEach((g) => {
      const [nx, ny] = boardSpace(t, g.x, g.y); if (nx < -0.05 || nx > 1.05 || ny < -0.05 || ny > 1.05) return;
      const cx = nx * gw; const cy = ny * gh;
      for (let y = Math.max(0, Math.floor(cy - R)); y < Math.min(gh, cy + R); y += 1) for (let x = Math.max(0, Math.floor(cx - R)); x < Math.min(gw, cx + R); x += 1) grid[y * gw + x] += Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * sigma * sigma));
    }));
    const maxV = Math.max(1e-9, ...grid); const img = ctx.createImageData(gw, gh);
    grid.forEach((v, i) => { const [r, g, b, a] = heatColor(v / maxV); img.data.set([r, g, b, Math.round(a * 255)], i * 4); });
    const off = document.createElement('canvas'); off.width = gw; off.height = gh; off.getContext('2d').putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true; ctx.drawImage(off, 0, 0, w, h);
    if (trials[0]) drawTargets(ctx, { ...trials[0], target: null, items: null }, w, h);
    ctx.strokeStyle = C.axis; ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
    return canvas;
  }
  function replay(trials) {
    const wrap = el('div', { class: 'gv-replay' });
    const select = el('select', { class: 'gv-select', 'aria-label': 'Trial to replay' });
    trials.forEach((t, i) => select.appendChild(el('option', { value: String(i), text: `Trial ${t.trial} · ${t.mode} · ${sizeLabel(t.targetSize)}${t.taskType === 'search' ? ` · search ${t.setSize}` : ''} · ${t.outcome}${finite(t.rtMs) ? ` · ${fmtS(t.rtMs)}` : ''}` })));
    const play = el('button', { class: 'gv-btn', type: 'button', text: '▶ Play' });
    const speed = el('select', { class: 'gv-select gv-speed', 'aria-label': 'Speed' }, [['0.5', '0.5×'], ['1', '1×'], ['2', '2×']].map(([v, l]) => el('option', { value: v, text: l })));
    speed.value = '1';
    const scrub = el('input', { type: 'range', min: '0', max: '1000', value: '1000', class: 'gv-scrub', 'aria-label': 'Time' });
    const clock = el('span', { class: 'gv-clock', text: '0.00 s' });
    const w = W; const h = 315; const canvas = el('canvas', { class: 'gv-canvas', width: w * 2, height: h * 2 }); const ctx = canvas.getContext('2d'); ctx.scale(2, 2);
    wrap.append(el('div', { class: 'gv-controls' }, [select, play, speed, clock]), canvas, scrub);
    let raf = null; let startAt = 0; let t0 = 0;
    const current = () => trials[Number(select.value)];
    const duration = () => { const t = current(); return Math.max(t.durationMs || t.rtMs || 0, ...t.gaze.map((g) => g.t), ...(t.mouse || []).map((g) => g.t), 1); };
    function draw(ms) {
      const t = current(); ctx.clearRect(0, 0, w, h); ctx.fillStyle = C.surface; ctx.fillRect(0, 0, w, h);
      drawTargets(ctx, t, w, h, { highlight: true }); ctx.strokeStyle = C.axis; ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
      const trail = (pts, color, dotR) => {
        const vis = pts.filter((p) => p.t <= ms); if (!vis.length) return;
        ctx.lineWidth = 2; ctx.lineJoin = 'round';
        for (let i = 1; i < vis.length; i += 1) { const age = (ms - vis[i].t) / 1500; ctx.strokeStyle = color; ctx.globalAlpha = Math.max(0.08, 0.85 - age); const [x0, y0] = boardSpace(t, vis[i - 1].x, vis[i - 1].y); const [x1, y1] = boardSpace(t, vis[i].x, vis[i].y); ctx.beginPath(); ctx.moveTo(x0 * w, y0 * h); ctx.lineTo(x1 * w, y1 * h); ctx.stroke(); }
        ctx.globalAlpha = 1; const last = vis[vis.length - 1]; const [lx, ly] = boardSpace(t, last.x, last.y);
        ctx.beginPath(); ctx.arc(lx * w, ly * h, dotR, 0, 7); ctx.fillStyle = color; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = C.surface; ctx.stroke();
      };
      trail(t.gaze, C.gaze, 6); if (t.mouse?.length) trail(t.mouse, C.mouse, 5);
      if (finite(t.rtMs) && ms >= t.rtMs && t.selected) { ctx.fillStyle = t.correct ? C.good : C.critical; ctx.font = `700 14px ${FONT}`; ctx.textAlign = 'left'; ctx.fillText(`${t.correct ? '✓' : '✕'} selected ${t.selected} at ${fmtS(t.rtMs)}`, 10, h - 12); }
      clock.textContent = `${(ms / 1000).toFixed(2)} s`; scrub.value = String(Math.round(1000 * ms / duration()));
    }
    function stop() { cancelAnimationFrame(raf); raf = null; play.textContent = '▶ Play'; }
    function tick(ts) { if (!startAt) startAt = ts; const ms = t0 + (ts - startAt) * Number(speed.value); if (ms >= duration()) { draw(duration()); stop(); return; } draw(ms); raf = requestAnimationFrame(tick); }
    play.addEventListener('click', () => { if (raf) { stop(); return; } t0 = Number(scrub.value) >= 999 ? 0 : (Number(scrub.value) / 1000) * duration(); startAt = 0; play.textContent = '❚❚ Pause'; raf = requestAnimationFrame(tick); });
    scrub.addEventListener('input', () => { stop(); draw((Number(scrub.value) / 1000) * duration()); });
    select.addEventListener('change', () => { stop(); draw(duration()); });
    draw(duration());
    return wrap;
  }

  /* ================= stat tiles ================= */
  function tile(label, perMode, note) {
    const values = el('div', { class: 'gv-tile-values' }, perMode.map(([mode, value]) => el('div', { class: 'gv-tile-value' }, [mode ? el('span', { class: 'gv-key', style: `background:${C[mode]}` }) : null, el('strong', { text: value }), mode ? el('small', { text: mode === 'gaze' ? 'gaze' : 'mouse' }) : null])));
    return el('div', { class: 'gv-tile' }, [el('div', { class: 'gv-tile-label', text: label }), values, note ? el('div', { class: 'gv-tile-note', text: note }) : null]);
  }
  function susBand(score) { return score >= 80.3 ? 'Excellent' : score >= 68 ? 'Good' : score >= 51 ? 'OK' : 'Poor'; }
  function susMeter(score, scores) {
    const m = { t: 34, r: 16, b: 30, l: 16 }; const h = 110; const { svg, iw } = frame(h, m);
    const bands = [[0, 51, 'Poor'], [51, 68, 'OK'], [68, 80.3, 'Good'], [80.3, 100, 'Excellent']];
    bands.forEach(([a, b, label], i) => { const x = m.l + (a / 100) * iw; const w = ((b - a) / 100) * iw - 2; svg.appendChild(s('rect', { x, y: m.t, width: w, height: 14, fill: C.seq[i + 1], rx: 0 })); svg.appendChild(txt(x + w / 2, m.t + 32, label, { anchor: 'middle', fill: C.ink2, size: 11 })); });
    [0, 25, 50, 68, 100].forEach((v) => svg.appendChild(txt(m.l + (v / 100) * iw, m.t - 8, String(v), { anchor: 'middle', size: 10 })));
    (scores || [score]).filter(finite).forEach((v) => { const x = m.l + (v / 100) * iw; const g = s('g'); g.appendChild(s('circle', { cx: x, cy: m.t + 7, r: 12, fill: 'transparent' })); g.appendChild(s('path', { d: `M${x},${m.t + 7}m-7,0l7,-9l7,9l-7,9z`, fill: C.ink, stroke: C.surface, 'stroke-width': 2 })); hover(g, () => [[null, String(v), 'SUS score'], [null, susBand(v), 'adjective band']]); svg.appendChild(g); });
    return svg;
  }

  /* ================= table view ================= */
  function table(columns, rows) {
    const t = el('table', { class: 'gv-table' });
    t.appendChild(el('thead', {}, el('tr', {}, columns.map(([, label]) => el('th', { text: label })))));
    t.appendChild(el('tbody', {}, rows.map((r) => el('tr', {}, columns.map(([key, , f]) => el('td', { text: f ? f(r[key], r) : (r[key] ?? '–') }))))));
    return el('div', { class: 'gv-table-wrap' }, t);
  }

  /* ================= single-session dashboard ================= */
  function renderDashboard(container, payload) {
    container.replaceChildren(); container.classList.add('viz-root');
    const M = computeMetrics(payload);
    if (!M.trials.length) { container.appendChild(el('p', { class: 'gv-empty', text: 'No main trials were recorded in this session.' })); return M; }
    const modes = M.modes; const series = modes.map((m) => ({ key: m, label: MODE_LABEL[m], color: C[m] }));
    const modeLegend = legend(series.map((sr) => [sr.color, sr.label]));
    if (M.simulated) container.appendChild(el('div', { class: 'gv-flag', text: 'Simulated gaze (mouse + noise) — test data, not eye-tracking results.' }));
    if (M.validation && !M.validation.passed) container.appendChild(el('div', { class: 'gv-flag', text: 'Validation did not pass — gaze results are flagged as low accuracy.' }));

    // KPI tiles
    const tiles = el('div', { class: 'gv-tiles' });
    const per = (fn) => modes.map((m) => [modes.length > 1 ? m : null, fn(M.byMode[m])]);
    tiles.append(
      tile('Accuracy', per((d) => fmtPct(d.accuracyPct)), 'correct / all trials'),
      tile('Median selection time', per((d) => fmtS(d.medianRtMs)), 'correct trials, from stimulus onset'),
      tile('Error rate', per((d) => fmtPct(d.errorPct)), `wrong target · skipped ${modes.map((m) => fmtPct(M.byMode[m].skipPct)).join(' / ')}`),
      tile('Information transfer rate', per((d) => (finite(d.itrBitsPerMin) ? `${d.itrBitsPerMin}` : '–')), `bits/min (Wolpaw) · incl. fixation+feedback: ${modes.map((m) => M.byMode[m].itrPracticalBitsPerMin ?? '–').join(' / ')}`),
      tile('Validation error', [[null, M.validation && finite(M.validation.medianErrorPx) ? `${M.validation.medianErrorPx}px` : '–']], M.validation ? `${M.validation.medianErrorPctDiag ?? '–'}% of diagonal · ${M.validation.passed ? 'passed' : 'not passed'}` : 'no validation'),
      tile('SUS (usability)', [[null, M.sus ? String(M.sus.score) : '–']], M.sus ? `${susBand(M.sus.score)} · ${M.sus.mode} system` : 'questionnaire not completed')
    );
    container.appendChild(tiles);

    const grid = el('div', { class: 'gv-grid' }); container.appendChild(grid);

    // 1. Accuracy by condition
    {
      const c = card('Accuracy by condition', 'Percentage of trials where the correct target was selected (skips count as misses).');
      c.body.append(modes.length > 1 ? modeLegend.cloneNode(true) : el('span'), groupedColumns({ categories: M.conditions, series, max: 100, fmt: (v) => `${round(v)}%`, get: (cond, mode) => { const d = M.byCondition[cond][mode]; return d.n ? { value: d.accuracyPct, label: `${d.accuracyPct}%`, extra: [[`${d.correct}/${d.n}`, 'correct'], [`${d.incorrect}`, 'wrong target'], [`${d.skipped}`, 'skipped']] } : null; } }));
      grid.appendChild(c.node);
    }
    // 2. Selection time strip
    {
      const multi = M.multiTask;
      const c = card('Selection time by condition', 'Every trial is a dot (hollow = wrong target); the black tick is the median of correct trials. Gaze time includes the dwell.');
      c.body.append(legend([...series.map((sr) => [sr.color, sr.label, 'dot']), [C.ink2, 'wrong target', 'ring']]), stripPlot({ categories: M.conditions, series, points: (cond, mode) => M.trials.filter((t) => t.mode === mode && conditionKey(t, multi) === cond && finite(t.rtMs)).map((t) => ({ v: t.rtMs, ok: t.correct, trial: t.trial })) }));
      grid.appendChild(c.node);
    }
    // 3. Outcomes
    {
      const c = card('Outcome breakdown', 'Share of trials that were correct, wrong-target selections (Midas-touch errors for gaze) or skipped.');
      c.body.append(legend(OUTCOMES.map(([, label, color, icon]) => [color, `${icon} ${label}`])), outcomeBars(modes.map((m) => ({ label: MODE_LABEL[m], summary: M.byMode[m] }))));
      grid.appendChild(c.node);
    }
    // 4. Trial-by-trial
    {
      const c = card('Selection time across the session', 'Dots are trials in order; the line is a 5-trial running median of correct trials (learning or fatigue).');
      c.body.append(legend([...series.map((sr) => [sr.color, sr.label, 'dot'])]), trialScatter(M.trials, modes));
      grid.appendChild(c.node);
    }
    // 5. Search slope
    if (M.search) {
      M.search.forEach((block) => {
        const c = card(`Visual search slope — ${MODE_LABEL[block.mode]}`, 'Median selection time vs number of items. Feature search should stay flat; conjunction search should rise.');
        c.body.append(legend([[C.feature, 'Feature', 'line'], [C.conjunction, 'Conjunction', 'line']]), searchSlope(block.rows));
        grid.appendChild(c.node);
      });
    }
    // 6. Validation map
    if (payload.validation?.points?.length) {
      const c = card('Calibration quality (validation)', 'Cross = dot shown; blue dot = median gaze estimate; line = error; shaded circle = precision (sample spread).');
      c.body.append(legend([[C.ink, 'target', 'line'], [C.gaze, 'median gaze', 'dot']]), validationMap(payload.validation));
      grid.appendChild(c.node);
    }
    // 7. Heatmap with layout + mode selectors
    {
      const withGaze = M.trials.filter((t) => t.gaze?.length && t.boardRect);
      if (withGaze.length) {
        const c = card('Gaze heatmap', 'Where the gaze estimate landed during trials, pooled over trials with the same layout. Darker blue = more time.');
        const layouts = [...new Set(withGaze.map(layoutKey))];
        const layoutSel = el('select', { class: 'gv-select', 'aria-label': 'Layout' }, layouts.map((l) => el('option', { value: l, text: l })));
        const modeSel = el('select', { class: 'gv-select', 'aria-label': 'Input mode' }, modes.map((m) => el('option', { value: m, text: `${MODE_LABEL[m]} trials` })));
        const holder = el('div');
        const redraw = () => { const list = withGaze.filter((t) => layoutKey(t) === layoutSel.value && t.mode === modeSel.value); holder.replaceChildren(list.length ? heatmap(list) : el('p', { class: 'gv-empty', text: 'No trials for this combination.' })); };
        layoutSel.addEventListener('change', redraw); modeSel.addEventListener('change', redraw);
        c.body.append(el('div', { class: 'gv-controls' }, [layoutSel, modeSel]), holder); redraw();
        grid.appendChild(c.node);
      }
    }
    // 8. Replay
    {
      const replayable = M.trials.filter((t) => t.gaze?.length && t.boardRect);
      if (replayable.length) {
        const c = card('Trial replay', 'Re-plays the gaze estimate (blue) and mouse path (orange) for one trial. The correct target is outlined in green.');
        c.body.append(legend([[C.gaze, 'gaze', 'line'], [C.mouse, 'mouse', 'line'], [C.good, 'correct target', 'rect']]), replay(replayable));
        grid.appendChild(c.node);
      }
    }
    // 9. Workload
    if (M.tlx) {
      const tlxModes = Object.keys(M.tlx).filter((m) => MODES.includes(m));
      const rows = [['mental', 'Mental'], ['physical', 'Physical'], ['temporal', 'Temporal'], ['performance', 'Performance*'], ['effort', 'Effort'], ['frustration', 'Frustration'], ['rawTlx', 'Raw TLX']];
      const c = card('Workload (NASA-TLX)', '0 = very low, 100 = very high. *Performance is reversed: 0 = perfect, 100 = failure. Raw TLX = mean of the six.');
      c.body.append(tlxModes.length > 1 ? legend(tlxModes.map((m) => [C[m], MODE_LABEL[m]])) : el('span'), hGrouped({ rows, series: tlxModes.map((m) => ({ key: m, label: MODE_LABEL[m], color: C[m] })), get: (k, m) => M.tlx[m][k] }));
      grid.appendChild(c.node);
    }
    // 10. SUS
    if (M.sus) {
      const c = card('Usability (SUS)', `System Usability Scale for the ${M.sus.mode} system. 68 is the commonly cited average; bands after Bangor et al. (2009).`);
      c.body.append(el('div', { class: 'gv-hero' }, [el('strong', { text: String(M.sus.score) }), el('span', { text: `/ 100 · ${susBand(M.sus.score)}${M.preference ? ` · preferred input: ${M.preference}` : ''}` })]), susMeter(M.sus.score));
      if (M.comment) c.body.appendChild(el('p', { class: 'gv-quote', text: `“${M.comment}”` }));
      grid.appendChild(c.node);
    }
    // Table view
    const details = el('details', { class: 'gv-details' }, [el('summary', { text: 'Table view — all trials' }), table([
      ['trial', '#'], ['mode', 'Input'], ['taskType', 'Task'], ['targetSize', 'Size'], ['setSize', 'Items'], ['searchType', 'Search', (v) => v || '–'], ['target', 'Target'], ['selected', 'Selected', (v) => v || '–'], ['outcome', 'Outcome'], ['rtMs', 'Time', (v) => fmtS(v)], ['timedOut', 'Reminder', (v) => (v ? 'yes' : '')], ['gazeHz', 'Gaze Hz']
    ], M.trials)]);
    container.appendChild(details);
    return M;
  }

  /* ================= multi-participant dashboard ================= */
  function participantRow(M) {
    const g = M.byMode.gaze || {}; const mo = M.byMode.mouse || {};
    return {
      participantId: M.participantId, tracker: M.tracker, simulated: M.simulated ? 'yes' : '', trials: M.trials.length,
      validationErrorPx: M.validation?.medianErrorPx ?? null, validationPassed: M.validation ? (M.validation.passed ? 'yes' : 'no') : '',
      gazeAccuracyPct: g.accuracyPct ?? null, mouseAccuracyPct: mo.accuracyPct ?? null,
      gazeMedianRtMs: g.medianRtMs ?? null, mouseMedianRtMs: mo.medianRtMs ?? null,
      gazeErrorPct: g.errorPct ?? null, mouseErrorPct: mo.errorPct ?? null,
      gazeItr: g.itrBitsPerMin ?? null, mouseItr: mo.itrBitsPerMin ?? null,
      gazeTlx: M.tlx?.gaze?.rawTlx ?? null, mouseTlx: M.tlx?.mouse?.rawTlx ?? null,
      sus: M.sus?.score ?? null, preference: M.preference || ''
    };
  }
  function renderGroupDashboard(container, payloads, opts = {}) {
    container.replaceChildren(); container.classList.add('viz-root');
    const metrics = payloads.map(computeMetrics).filter((M) => M.trials.length);
    if (!metrics.length) { container.appendChild(el('p', { class: 'gv-empty', text: 'Load at least one exported session JSON to see the summary.' })); return []; }
    const modes = MODES.filter((m) => metrics.some((M) => M.byMode[m]));
    const series = modes.map((m) => ({ key: m, label: MODE_LABEL[m], color: C[m] }));
    const rows = metrics.map(participantRow);
    if (metrics.some((M) => M.simulated)) container.appendChild(el('div', { class: 'gv-flag', text: `${metrics.filter((M) => M.simulated).length} of ${metrics.length} sessions use simulated gaze or synthetic demo data — do not report them as real results.` }));

    const per = (fn) => modes.map((m) => [modes.length > 1 ? m : null, fn(m)]);
    const meanOf = (fn) => round(mean(metrics.map(fn)), 1);
    const tiles = el('div', { class: 'gv-tiles' });
    tiles.append(
      tile('Participants', [[null, String(metrics.length)]], `${metrics.reduce((a, M) => a + M.trials.length, 0)} main trials in total`),
      tile('Mean accuracy', per((m) => fmtPct(meanOf((M) => M.byMode[m]?.accuracyPct))), 'mean of participant accuracies'),
      tile('Mean of median selection time', per((m) => fmtS(meanOf((M) => M.byMode[m]?.medianRtMs))), 'correct trials'),
      tile('Mean ITR', per((m) => String(meanOf((M) => M.byMode[m]?.itrBitsPerMin) ?? '–')), 'bits/min (Wolpaw)'),
      tile('Mean raw TLX', per((m) => String(meanOf((M) => M.tlx?.[m]?.rawTlx) ?? '–')), '0–100, lower = less workload'),
      tile('Mean SUS', [[null, String(meanOf((M) => M.sus?.score) ?? '–')]], 'gaze system, 68 = average')
    );
    container.appendChild(tiles);
    const grid = el('div', { class: 'gv-grid' }); container.appendChild(grid);
    const modeLegend = () => (modes.length > 1 ? legend(series.map((sr) => [sr.color, sr.label])) : el('span'));

    const paired = [
      ['Accuracy per participant', 'Each grey line is one participant; black tick = group mean.', (M, m) => M.byMode[m]?.accuracyPct, (v) => `${round(v)}%`, 100],
      ['Median selection time per participant', 'Correct trials only; gaze includes the dwell time.', (M, m) => M.byMode[m]?.medianRtMs, (v) => `${(v / 1000).toFixed(2)}s`, null],
      ['Information transfer rate per participant', 'Wolpaw ITR in bits/min, selection time only.', (M, m) => M.byMode[m]?.itrBitsPerMin, (v) => String(round(v, 1)), null],
      ['Workload (raw NASA-TLX) per participant', '0–100; lower means less workload.', (M, m) => M.tlx?.[m]?.rawTlx, (v) => String(round(v)), 100]
    ];
    paired.forEach(([title, sub, get, fmt, max]) => {
      if (!metrics.some((M) => modes.some((m) => finite(get(M, m))))) return;
      const c = card(title, sub);
      c.body.append(legend(series.map((sr) => [sr.color, sr.label, 'dot'])), pairedPlot({ participants: metrics, modes, get, fmt, max }));
      grid.appendChild(c.node);
    });

    // accuracy & RT by condition, bars = mean of participants, dots = participants
    const conditions = [...new Set(metrics.flatMap((M) => M.conditions))].sort();
    [['Accuracy by condition (group)', 'Bars = mean across participants; open dots = individual participants.', 'accuracyPct', (v) => `${round(v)}%`, 100], ['Selection time by condition (group)', 'Bars = mean of participant medians (correct trials); open dots = participants.', 'medianRtMs', (v) => `${(v / 1000).toFixed(1)}s`, null]].forEach(([title, sub, key, fmt, max]) => {
      const c = card(title, sub);
      const vals = (cond, mode) => metrics.map((M) => M.byCondition[cond]?.[mode]?.[key]).filter(finite);
      c.body.append(modeLegend(), groupedColumns({ categories: conditions, series, max, fmt, get: (cond, mode) => { const v = vals(cond, mode); return v.length ? { value: mean(v), label: fmt(mean(v)), extra: [[`n=${v.length}`, 'participants'], [finite(sd(v)) ? fmt(sd(v)) : '–', 'SD']] } : null; }, dots: (cond, mode) => vals(cond, mode) }));
      grid.appendChild(c.node);
    });

    // outcomes pooled
    {
      const pooled = Object.fromEntries(modes.map((m) => [m, summarize(metrics.flatMap((M) => M.trials.filter((t) => t.mode === m)), 1600)]));
      const c = card('Outcome breakdown (pooled trials)', 'All main trials from all participants.');
      c.body.append(legend(OUTCOMES.map(([, label, color, icon]) => [color, `${icon} ${label}`])), outcomeBars(modes.map((m) => ({ label: MODE_LABEL[m], summary: pooled[m] }))));
      grid.appendChild(c.node);
    }
    // validation per participant
    if (metrics.some((M) => M.validation)) {
      const c = card('Validation error per participant', 'Median distance between the validation dots and the gaze estimate (px). Lower is better.');
      const ids = metrics.map((M) => M.participantId);
      c.body.append(groupedColumns({ categories: ids, series: [{ key: 'v', label: 'median error', color: C.gaze }], fmt: (v) => `${round(v)}px`, get: (id) => { const M = metrics.find((x) => x.participantId === id); return M?.validation && finite(M.validation.medianErrorPx) ? { value: M.validation.medianErrorPx, label: `${M.validation.medianErrorPx}px`, extra: [[M.validation.passed ? 'passed' : 'not passed', 'validation']] } : null; } }));
      grid.appendChild(c.node);
    }
    // SUS
    if (metrics.some((M) => M.sus)) {
      const scores = metrics.map((M) => M.sus?.score).filter(finite);
      const c = card('Usability (SUS) across participants', 'Each diamond is one participant; bands after Bangor et al. (2009).');
      c.body.append(el('div', { class: 'gv-hero' }, [el('strong', { text: String(round(mean(scores), 1)) }), el('span', { text: `mean SUS · ${susBand(mean(scores))} · n=${scores.length}` })]), susMeter(mean(scores), scores));
      grid.appendChild(c.node);
    }
    // pooled heatmap (choice task, gaze trials)
    {
      const pool = metrics.flatMap((M) => M.trials).filter((t) => t.gaze?.length && t.boardRect);
      if (pool.length) {
        const c = card('Pooled gaze heatmap', 'Gaze positions from all participants, normalised to the trial board.');
        const layouts = [...new Set(pool.map(layoutKey))];
        const layoutSel = el('select', { class: 'gv-select' }, layouts.map((l) => el('option', { value: l, text: l })));
        const modeSel = el('select', { class: 'gv-select' }, modes.map((m) => el('option', { value: m, text: `${MODE_LABEL[m]} trials` })));
        const holder = el('div');
        const redraw = () => { const list = pool.filter((t) => layoutKey(t) === layoutSel.value && t.mode === modeSel.value); holder.replaceChildren(list.length ? heatmap(list) : el('p', { class: 'gv-empty', text: 'No trials for this combination.' })); };
        layoutSel.addEventListener('change', redraw); modeSel.addEventListener('change', redraw); redraw();
        c.body.append(el('div', { class: 'gv-controls' }, [layoutSel, modeSel]), holder);
        grid.appendChild(c.node);
      }
    }
    const fmtMs = (v) => fmtS(v);
    container.appendChild(el('details', { class: 'gv-details', open: '' }, [el('summary', { text: 'Participant summary table' }), table([
      ['participantId', 'ID'], ['tracker', 'Tracker'], ['trials', 'Trials'], ['validationErrorPx', 'Val. err (px)'], ['gazeAccuracyPct', 'Acc gaze', fmtPct], ['mouseAccuracyPct', 'Acc mouse', fmtPct], ['gazeMedianRtMs', 'RT gaze', fmtMs], ['mouseMedianRtMs', 'RT mouse', fmtMs], ['gazeItr', 'ITR gaze'], ['mouseItr', 'ITR mouse'], ['gazeTlx', 'TLX gaze'], ['mouseTlx', 'TLX mouse'], ['sus', 'SUS'], ['preference', 'Prefers'], ['simulated', 'Simulated']
    ], rows)]));
    if (opts.onRemove) {
      const chips = el('div', { class: 'gv-chips' }, metrics.map((M) => { const b = el('button', { class: 'gv-chip', type: 'button', title: 'Remove this session' }, [M.participantId, el('span', { text: ' ×' })]); b.addEventListener('click', () => opts.onRemove(M.participantId)); return b; }));
      container.insertBefore(chips, container.firstChild);
    }
    return rows;
  }

  function summaryCsv(payloads) {
    const rows = payloads.map(computeMetrics).filter((M) => M.trials.length).map(participantRow);
    if (!rows.length) return '';
    const cols = Object.keys(rows[0]);
    return [cols.join(','), ...rows.map((r) => cols.map((k) => (r[k] == null ? '' : String(r[k]).replace(/,/g, ';'))).join(','))].join('\n');
  }

  global.GazeViz = { computeMetrics, renderDashboard, renderGroupDashboard, summaryCsv, wolpawBits, itr, colors: C };
})(window);
