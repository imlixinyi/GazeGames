"""Report figures + summary tables from exported session JSON files.

Usage
-----
    pip install matplotlib numpy          # once
    python3 analysis/make_figures.py data/            # folder with the exported *.json files
    python3 analysis/make_figures.py sample_data/ --out figures_demo   # synthetic demo

Outputs (in --out, default "figures/"):
    participant_summary.csv     one row per participant (accuracy, RT, error, ITR, TLX, SUS ...)
    trials_all.csv              every main trial from every participant (no gaze samples)
    fig1_accuracy_by_condition.png
    fig2_rt_by_condition.png
    fig3_paired_gaze_vs_mouse.png
    fig4_outcomes.png
    fig5_tlx_subscales.png
    fig6_sus.png
    fig7_validation_error.png
    fig8_gaze_heatmap.png
    fig9_learning_curve.png

Metric definitions match the in-browser dashboard (viz.js):
  accuracy   = correct / all main trials (skips count as misses)
  RT         = median selection time of correct trials, from stimulus onset (gaze includes dwell)
  error rate = wrong-target selections / all trials
  ITR        = Wolpaw bits/min: B = log2N + P log2P + (1-P) log2((1-P)/(N-1)), T = mean trial duration
"""
import argparse
import csv
import json
import math
import sys
from pathlib import Path

try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import numpy as np
except ImportError:  # pragma: no cover
    sys.exit("Please install the dependencies first:  pip install matplotlib numpy")

COL = {"gaze": "#2a78d6", "mouse": "#eb6834", "good": "#0ca30c", "critical": "#d03b3b", "warning": "#fab219",
       "ink": "#0b0b0b", "ink2": "#52514e", "muted": "#898781", "grid": "#e1e0d9", "axis": "#c3c2b7"}
MODES = ["gaze", "mouse"]
MODE_LABEL = {"gaze": "Gaze (dwell)", "mouse": "Mouse (click)"}
TLX = [("mental", "Mental"), ("physical", "Physical"), ("temporal", "Temporal"), ("performance", "Performance*"),
       ("effort", "Effort"), ("frustration", "Frustration"), ("rawTlx", "Raw TLX")]

plt.rcParams.update({
    "font.family": "sans-serif", "font.size": 10, "axes.edgecolor": COL["axis"], "axes.labelcolor": COL["ink2"],
    "xtick.color": COL["ink2"], "ytick.color": COL["ink2"], "axes.spines.top": False, "axes.spines.right": False,
    "axes.grid": True, "grid.color": COL["grid"], "grid.linewidth": 0.8, "axes.axisbelow": True,
    "figure.dpi": 150, "savefig.dpi": 200, "savefig.bbox": "tight", "legend.frameon": False,
})


# ---------------------------------------------------------------- metrics
def median(v):
    v = [x for x in v if x is not None]
    return float(np.median(v)) if v else None


def mean(v):
    v = [x for x in v if x is not None]
    return float(np.mean(v)) if v else None


def wolpaw_bits(n, p):
    if n < 2 or p is None:
        return None
    if p <= 1 / n:
        return 0.0
    if p >= 1:
        return math.log2(n)
    return math.log2(n) + p * math.log2(p) + (1 - p) * math.log2((1 - p) / (n - 1))


def itr(trials, overhead_ms=0):
    if not trials:
        return None
    bits = ms = 0.0
    for n in {int(t.get("setSize") or 4) for t in trials}:
        sub = [t for t in trials if int(t.get("setSize") or 4) == n]
        p = sum(t["correct"] for t in sub) / len(sub)
        bits += wolpaw_bits(n, p) * len(sub)
        ms += sum((t.get("durationMs") or t.get("rtMs") or 0) + overhead_ms for t in sub)
    return bits / (ms / 60000) if ms else None


def summarize(trials):
    n = len(trials)
    if not n:
        return {}
    c = lambda o: sum(t["outcome"] == o for t in trials)
    return {
        "n": n, "correct": c("correct"), "incorrect": c("incorrect"), "skipped": c("skipped"),
        "accuracy": 100 * c("correct") / n, "error": 100 * c("incorrect") / n, "skip": 100 * c("skipped") / n,
        "rt": median([t["rtMs"] for t in trials if t["correct"]]), "itr": itr(trials),
    }


def cond_key(t, multi_task):
    size = "Small" if t["targetSize"] == "small" else "Large"
    return f"{'Search' if t['taskType'] == 'search' else 'Choice'} · {size}" if multi_task else f"{size} targets"


def load(folder):
    sessions = []
    for f in sorted(Path(folder).glob("*.json")):
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            continue
        if isinstance(d, dict) and isinstance(d.get("trials"), list):
            d["trials"] = [t for t in d["trials"] if not t.get("practice")]
            if d["trials"]:
                sessions.append(d)
    return sessions


# ---------------------------------------------------------------- figures
def save(fig, out, name, title, subtitle=None):
    h = fig.get_figheight()
    fig.tight_layout(rect=(0, 0, 1, 1 - (0.62 if subtitle else 0.4) / h))
    fig.text(0.01, 1 - 0.08 / h, title, ha="left", va="top", fontsize=13, fontweight="bold", color=COL["ink"])
    if subtitle:
        fig.text(0.01, 1 - 0.36 / h, subtitle, ha="left", va="top", fontsize=9, color=COL["ink2"])
    fig.savefig(out / name)
    plt.close(fig)
    print("  ", name)


def grouped(ax, conds, modes, values, ylabel, fmt, ymax=None):
    """values[cond][mode] = list of per-participant values; bar = mean, dots = participants."""
    width = 0.22
    x = np.arange(len(conds))
    for i, m in enumerate(modes):
        xs = x + (i - (len(modes) - 1) / 2) * (width + 0.03)
        means = [mean(values[c][m]) or 0 for c in conds]
        ax.bar(xs, means, width, color=COL[m], label=MODE_LABEL[m], zorder=2)
        for xi, c in zip(xs, conds):
            pts = [v for v in values[c][m] if v is not None]
            if len(pts) > 1:
                jitter = np.linspace(-width * 0.25, width * 0.25, len(pts))
                ax.scatter(xi + jitter, pts, s=16, facecolor="white", edgecolor=COL["ink"], linewidth=0.8, zorder=3)
            elif pts:  # single participant: label the bar instead of drawing one dot
                ax.annotate(fmt(pts[0]), (xi, pts[0]), xytext=(0, 3), textcoords="offset points", ha="center", va="bottom", fontsize=8, color=COL["ink2"])
    ax.set_xticks(x, conds)
    ax.set_ylabel(ylabel)
    if ymax:
        ax.set_ylim(0, ymax)
    ax.grid(axis="x", visible=False)
    ax.legend(loc="lower left", bbox_to_anchor=(0, 1.0), ncol=2)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder", help="folder containing the exported session .json files")
    ap.add_argument("--out", default="figures", help="output folder (default: figures)")
    args = ap.parse_args()
    sessions = load(args.folder)
    if not sessions:
        sys.exit(f"No exported session JSON files found in {args.folder}")
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    print(f"{len(sessions)} session(s) loaded -> {out}/")
    if any(s.get("simulated") for s in sessions):
        print("   NOTE: some sessions are simulated/synthetic - do not report them as real results.")

    trials = [t for s in sessions for t in s["trials"]]
    modes = [m for m in MODES if any(t["mode"] == m for t in trials)]
    multi = len({t["taskType"] for t in trials}) > 1
    conds = sorted({cond_key(t, multi) for t in trials})
    ids = [s["participantId"] for s in sessions]

    # ---- per-participant table
    rows = []
    per = {}
    for s in sessions:
        pid = s["participantId"]
        per[pid] = {m: summarize([t for t in s["trials"] if t["mode"] == m]) for m in modes}
        per[pid]["_cond"] = {c: {m: summarize([t for t in s["trials"] if t["mode"] == m and cond_key(t, multi) == c]) for m in modes} for c in conds}
        q = s.get("questionnaire") or {}
        v = s.get("validation") or {}
        row = {"participantId": pid, "tracker": s.get("tracker") or (s.get("settings") or {}).get("tracker") or "webgazer", "simulated": bool(s.get("simulated")), "trials": len(s["trials"]),
               "validationErrorPx": v.get("medianErrorPx"), "validationPassed": v.get("passed")}
        for m in modes:
            d = per[pid][m]
            row.update({f"{m}_accuracy_pct": round(d["accuracy"], 1) if d else None, f"{m}_median_rt_ms": round(d["rt"]) if d and d["rt"] else None,
                        f"{m}_error_pct": round(d["error"], 1) if d else None, f"{m}_skip_pct": round(d["skip"], 1) if d else None,
                        f"{m}_itr_bits_min": round(d["itr"], 2) if d and d["itr"] is not None else None,
                        f"{m}_raw_tlx": (q.get("tlx") or {}).get(m, {}).get("rawTlx")})
        row["sus"] = (q.get("sus") or {}).get("score")
        row["preference"] = q.get("preference")
        rows.append(row)
    with open(out / "participant_summary.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    keys = ["participantId", "trial", "taskType", "searchType", "setSize", "mode", "targetSize", "target", "selected", "correct", "outcome", "timedOut", "rtMs", "durationMs", "gazeHz", "gazeOnBoardRate"]
    with open(out / "trials_all.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=keys, extrasaction="ignore")
        w.writeheader()
        w.writerows(trials)
    print("   participant_summary.csv, trials_all.csv")

    # ---- fig1 accuracy by condition
    vals = {c: {m: [per[p]["_cond"][c][m].get("accuracy") for p in ids] for m in modes} for c in conds}
    fig, ax = plt.subplots(figsize=(6.4, 3.8))
    grouped(ax, conds, modes, vals, "Accuracy (%)", lambda v: f"{v:.0f}%", 105)
    save(fig, out, "fig1_accuracy_by_condition.png", "Selection accuracy by condition", "Bars = mean across participants; dots = individual participants.")

    # ---- fig2 RT strip/box by condition
    fig, ax = plt.subplots(figsize=(6.4, 3.8))
    pos, labels, k = [], [], 0
    for ci, c in enumerate(conds):
        for mi, m in enumerate(modes):
            x = ci * (len(modes) + 1) + mi
            data = [t["rtMs"] / 1000 for t in trials if t["mode"] == m and cond_key(t, multi) == c and t["correct"]]
            if data:
                ax.boxplot([data], positions=[x], widths=0.55, showfliers=False, patch_artist=True,
                           boxprops=dict(facecolor=COL[m], alpha=0.25, edgecolor=COL[m]), medianprops=dict(color=COL["ink"], linewidth=2),
                           whiskerprops=dict(color=COL[m]), capprops=dict(color=COL[m]))
                ax.scatter(x + np.random.default_rng(k).uniform(-0.18, 0.18, len(data)), data, s=9, color=COL[m], alpha=0.6, zorder=3)
                k += 1
        pos.append(ci * (len(modes) + 1) + (len(modes) - 1) / 2)
        labels.append(c)
    ax.set_xticks(pos, labels)
    ax.set_ylabel("Selection time (s)")
    ax.set_ylim(bottom=0)
    ax.grid(axis="x", visible=False)
    for m in modes:
        ax.scatter([], [], color=COL[m], label=MODE_LABEL[m])
    ax.legend(loc="lower left", bbox_to_anchor=(0, 1.0), ncol=2)
    save(fig, out, "fig2_rt_by_condition.png", "Selection time by condition", "Correct trials pooled over participants; gaze time includes the dwell.")

    # ---- fig3 paired plots
    if len(modes) == 2:
        metrics = [("accuracy", "Accuracy (%)", 1), ("rt", "Median selection time (s)", 0.001), ("itr", "ITR (bits/min)", 1)]
        tlx_ok = any((s.get("questionnaire") or {}).get("tlx") for s in sessions)
        fig, axes = plt.subplots(1, 4 if tlx_ok else 3, figsize=(11, 3.4))
        for ax, (key, label, scale) in zip(axes, metrics):
            for p in ids:
                ys = [per[p][m].get(key) for m in modes]
                if None not in ys:
                    ax.plot([0, 1], [y * scale for y in ys], color=COL["axis"], linewidth=1.2, zorder=1)
                for i, m in enumerate(modes):
                    if ys[i] is not None:
                        ax.scatter(i, ys[i] * scale, color=COL[m], s=22, zorder=2)
            for i, m in enumerate(modes):
                mv = mean([per[p][m].get(key) for p in ids])
                if mv is not None:
                    ax.hlines(mv * scale, i - 0.18, i + 0.18, color=COL["ink"], linewidth=2.5, zorder=3)
            ax.set_xticks([0, 1], ["Gaze", "Mouse"])
            ax.set_xlim(-0.5, 1.5)
            ax.set_title(label, fontsize=10, color=COL["ink2"])
            ax.grid(axis="x", visible=False)
        if tlx_ok:
            ax = axes[3]
            for s in sessions:
                t = (s.get("questionnaire") or {}).get("tlx") or {}
                ys = [t.get(m, {}).get("rawTlx") for m in modes]
                if None not in ys:
                    ax.plot([0, 1], ys, color=COL["axis"], linewidth=1.2)
                for i, m in enumerate(modes):
                    if ys[i] is not None:
                        ax.scatter(i, ys[i], color=COL[m], s=22, zorder=2)
            for i, m in enumerate(modes):
                mv = mean([((s.get("questionnaire") or {}).get("tlx") or {}).get(m, {}).get("rawTlx") for s in sessions])
                if mv is not None:
                    ax.hlines(mv, i - 0.18, i + 0.18, color=COL["ink"], linewidth=2.5, zorder=3)
            ax.set_xticks([0, 1], ["Gaze", "Mouse"])
            ax.set_xlim(-0.5, 1.5)
            ax.set_ylim(0, 100)
            ax.set_title("Raw NASA-TLX (0-100)", fontsize=10, color=COL["ink2"])
            ax.grid(axis="x", visible=False)
        save(fig, out, "fig3_paired_gaze_vs_mouse.png", "Gaze vs mouse, per participant", "Grey lines connect the same participant; black ticks are group means.")

    # ---- fig4 outcomes
    fig, ax = plt.subplots(figsize=(6.4, 1.2 + 0.6 * len(modes)))
    for i, m in enumerate(modes):
        d = summarize([t for t in trials if t["mode"] == m])
        left = 0
        for key, label, color in (("correct", "Correct", COL["good"]), ("incorrect", "Wrong target", COL["critical"]), ("skipped", "Skipped", COL["warning"])):
            w = 100 * d[key] / d["n"]
            ax.barh(i, w, left=left, color=color, height=0.55, label=label if i == 0 else None, edgecolor="white", linewidth=1.5)
            if w > 7:
                ax.text(left + w / 2, i, f"{w:.0f}%", ha="center", va="center", color="white" if key != "skipped" else COL["ink"], fontsize=9, fontweight="bold")
            left += w
    ax.set_yticks(range(len(modes)), [MODE_LABEL[m] for m in modes])
    ax.set_xlim(0, 100)
    ax.set_xlabel("% of trials")
    ax.invert_yaxis()
    ax.grid(axis="y", visible=False)
    ax.legend(loc="lower left", bbox_to_anchor=(0, 1.0), ncol=3)
    save(fig, out, "fig4_outcomes.png", "Outcome breakdown (pooled)")

    # ---- fig5 TLX
    tlx_sessions = [(s.get("questionnaire") or {}).get("tlx") for s in sessions if (s.get("questionnaire") or {}).get("tlx")]
    if tlx_sessions:
        fig, ax = plt.subplots(figsize=(6.4, 4))
        y = np.arange(len(TLX))
        h = 0.36
        for i, m in enumerate(modes):
            means = [mean([t.get(m, {}).get(k) for t in tlx_sessions]) for k, _ in TLX]
            sds = [np.std([t[m][k] for t in tlx_sessions if m in t], ddof=1) if len(tlx_sessions) > 1 else 0 for k, _ in TLX]
            ys = y + (i - (len(modes) - 1) / 2) * (h + 0.04)
            ax.barh(ys, [v or 0 for v in means], h, xerr=sds, color=COL[m], label=MODE_LABEL[m], error_kw=dict(ecolor=COL["ink2"], lw=1, capsize=0))
        ax.set_yticks(y, [label for _, label in TLX])
        ax.invert_yaxis()
        ax.set_xlim(0, 100)
        ax.set_xlabel("Rating (0 = very low, 100 = very high)")
        ax.grid(axis="y", visible=False)
        ax.legend(loc="lower left", bbox_to_anchor=(0, 1.0), ncol=2)
        save(fig, out, "fig5_tlx_subscales.png", "Workload (NASA-TLX)", "Mean ± SD across participants. *Performance: 0 = perfect, 100 = failure.")

    # ---- fig6 SUS
    sus = [(s["participantId"], (s.get("questionnaire") or {}).get("sus", {}).get("score")) for s in sessions]
    sus = [(p, v) for p, v in sus if v is not None]
    if sus:
        fig, ax = plt.subplots(figsize=(6.4, 1.9))
        for (a, b, label), c in zip([(0, 51, "Poor"), (51, 68, "OK"), (68, 80.3, "Good"), (80.3, 100, "Excellent")], ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5"]):
            ax.axvspan(a, b, ymin=0.35, ymax=0.65, color=c, lw=0)
            ax.text((a + b) / 2, 0.12, label, ha="center", fontsize=9, color=COL["ink2"], transform=ax.get_xaxis_transform())
        ax.scatter([v for _, v in sus], [0.5] * len(sus), marker="D", s=50, color=COL["ink"], edgecolor="white", zorder=3, transform=ax.get_xaxis_transform())
        mv = mean([v for _, v in sus])
        ax.axvline(mv, color=COL["ink"], lw=1.5, ymin=0.25, ymax=0.75)
        ax.text(mv, 0.82, f"mean {mv:.1f}", ha="center", fontsize=9, fontweight="bold", transform=ax.get_xaxis_transform())
        ax.set_xlim(0, 100)
        ax.set_yticks([])
        ax.grid(False)
        ax.spines["left"].set_visible(False)
        ax.set_xlabel("SUS score (gaze system)")
        save(fig, out, "fig6_sus.png", "Usability (System Usability Scale)", "Each diamond is one participant; bands after Bangor et al. (2009).")

    # ---- fig7 validation
    val = [(s["participantId"], (s.get("validation") or {}).get("medianErrorPx"), (s.get("validation") or {}).get("passed")) for s in sessions]
    val = [v for v in val if v[1] is not None]
    if val:
        fig, ax = plt.subplots(figsize=(6.4, 3.2))
        ax.bar([v[0] for v in val], [v[1] for v in val], color=[COL["gaze"] if v[2] else COL["axis"] for v in val], width=0.5)
        for i, v in enumerate(val):
            ax.text(i, v[1] + 3, f"{v[1]}px", ha="center", fontsize=8, color=COL["ink2"])
        ax.set_ylabel("Median validation error (px)")
        ax.grid(axis="x", visible=False)
        save(fig, out, "fig7_validation_error.png", "Calibration quality per participant", "Blue = passed validation, grey = did not pass.")

    # ---- fig8 heatmap (gaze-mode trials, normalised to the board)
    fig, axes = plt.subplots(1, 2, figsize=(10, 3.4))
    for ax, size in zip(axes, ["large", "small"]):
        pts = []
        ref = None
        for t in trials:
            if t["mode"] != "gaze" or t["targetSize"] != size or not t.get("boardRect") or (t["taskType"] == "search" and int(t["setSize"]) == 8):
                continue
            b = t["boardRect"]
            ref = ref or t
            pts += [((g["x"] - b["left"]) / (b["right"] - b["left"]), (g["y"] - b["top"]) / (b["bottom"] - b["top"])) for g in t["gaze"]]
        ax.set_title(f"{size.capitalize()} targets (gaze trials, n={len(pts)} samples)", fontsize=10, color=COL["ink2"])
        ax.set_xlim(0, 1)
        ax.set_ylim(1, 0)
        ax.set_xticks([])
        ax.set_yticks([])
        ax.grid(False)
        if pts:
            p = np.array(pts)
            hmap, _, _ = np.histogram2d(p[:, 1], p[:, 0], bins=[40, 70], range=[[0, 1], [0, 1]])
            k = np.outer(np.hanning(7), np.hanning(7))
            from numpy.lib.stride_tricks import sliding_window_view
            padded = np.pad(hmap, 3)
            smooth = (sliding_window_view(padded, (7, 7)) * k).sum(axis=(2, 3))
            smooth = np.ma.masked_less(smooth, smooth.max() * 0.03)
            ax.imshow(smooth, extent=(0, 1, 1, 0), cmap="Blues", aspect="auto", interpolation="bilinear")
        if ref:
            b = ref["boardRect"]
            for label, r in (ref.get("targetBounds") or {}).items():
                x0, y0 = (r["left"] - b["left"]) / (b["right"] - b["left"]), (r["top"] - b["top"]) / (b["bottom"] - b["top"])
                w, h = (r["right"] - r["left"]) / (b["right"] - b["left"]), (r["bottom"] - r["top"]) / (b["bottom"] - b["top"])
                ax.add_patch(plt.Rectangle((x0, y0), w, h, fill=False, ec=COL["muted"], lw=1))
                ax.text(x0 + w / 2, y0 + h / 2, label, ha="center", va="center", color=COL["muted"], fontsize=12, fontweight="bold")
    save(fig, out, "fig8_gaze_heatmap.png", "Pooled gaze heatmap", "Gaze estimates during gaze-selection trials, normalised to the trial board.")

    # ---- fig9 learning curve
    fig, ax = plt.subplots(figsize=(6.4, 3.4))
    for m in modes:
        by_trial = {}
        for t in trials:
            if t["mode"] == m and t["correct"]:
                by_trial.setdefault(t["trial"], []).append(t["rtMs"] / 1000)
        xs = sorted(by_trial)
        ys = [median(by_trial[x]) for x in xs]
        ax.scatter(xs, ys, color=COL[m], s=14, alpha=0.6)
        if len(xs) >= 5:
            roll = [median(ys[max(0, i - 2): i + 3]) for i in range(len(ys))]
            ax.plot(xs, roll, color=COL[m], lw=2, label=MODE_LABEL[m])
    ax.set_xlabel("Trial number")
    ax.set_ylabel("Median selection time (s)")
    ax.set_ylim(bottom=0)
    ax.legend(loc="lower left", bbox_to_anchor=(0, 1.0), ncol=2)
    save(fig, out, "fig9_learning_curve.png", "Selection time across the session", "Dots = median over participants per trial; line = 5-trial running median.")


if __name__ == "__main__":
    main()
