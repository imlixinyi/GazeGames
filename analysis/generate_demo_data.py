"""Generate SYNTHETIC demo sessions in the same JSON format the experiment exports.

These files exist only to test analysis.html and make_figures.py before real data
is collected. They are flagged with "simulated": true and IDs starting with DEMO-.
Never report them as results.

    python3 analysis/generate_demo_data.py            # writes sample_data/*.json
"""
import json
import math
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "sample_data"
VW, VH = 1440, 900
BOARD = {"left": 160, "top": 142, "right": 1280, "bottom": 662}
BW, BH = BOARD["right"] - BOARD["left"], BOARD["bottom"] - BOARD["top"]
TLX_KEYS = ["mental", "physical", "temporal", "performance", "effort", "frustration"]
CAL_POS = [(5, 8), (50, 8), (95, 8), (5, 50), (50, 50), (95, 50), (5, 92), (50, 92), (95, 92)]


def target_bounds(size):
    w, h, inset_x, inset_y = (0.28, 0.36, 0.22, 0.14) if size == "large" else (0.18, 0.24, 0.28, 0.20)
    out = {}
    for label, right, bottom in (("A", False, False), ("B", True, False), ("C", False, True), ("D", True, True)):
        left = BOARD["left"] + (BW * (1 - inset_x - w) if right else BW * inset_x)
        top = BOARD["top"] + (BH * (1 - inset_y - h) if bottom else BH * inset_y)
        out[label] = {"left": round(left), "top": round(top), "right": round(left + BW * w), "bottom": round(top + BH * h)}
    return out


def path(start, end, duration, hz, noise, bias, rng):
    """Smooth saccade-like path from start to end, then noisy fixation."""
    pts, t = [], 0.0
    while t <= duration:
        k = min(1.0, t / 350.0)
        k = k * k * (3 - 2 * k)
        x = start[0] + (end[0] - start[0]) * k + bias[0] + rng.gauss(0, noise)
        y = start[1] + (end[1] - start[1]) * k + bias[1] + rng.gauss(0, noise)
        pts.append((round(x), round(y), round(t)))
        t += 1000.0 / hz
    return pts


def session(pid, rng, skill):
    dwell, n_trials = 800, 24
    cells = [(m, s) for m in ("gaze", "mouse") for s in ("large", "small")]
    plan = []
    while len(plan) < n_trials:
        block = cells[:]
        rng.shuffle(block)
        plan += block
    queues, trials = {}, []
    bias = (rng.gauss(0, 25 / skill), rng.gauss(0, 30 / skill))
    noise = 38 / skill
    for i, (mode, size) in enumerate(plan[:n_trials], start=1):
        q = queues.setdefault((mode, size), [])
        if not q:
            q += rng.sample(range(4), 4)
        ci = q.pop()
        bounds = target_bounds(size)
        labels = list(bounds)
        centre = lambda lab: ((bounds[lab]["left"] + bounds[lab]["right"]) / 2, (bounds[lab]["top"] + bounds[lab]["bottom"]) / 2)
        if mode == "gaze":
            p_ok = (0.93 if size == "large" else 0.80) * min(1.0, 0.9 + 0.1 * skill)
            skip = rng.random() < (0.02 if size == "large" else 0.06)
            rt = dwell + rng.gauss(650 if size == "large" else 900, 180) / skill
        else:
            p_ok = 0.99 if size == "large" else 0.96
            skip = False
            rt = rng.gauss(780 if size == "large" else 930, 120)
        ok = (not skip) and rng.random() < p_ok
        sel = None if skip else (labels[ci] if ok else rng.choice([l for l in labels if l != labels[ci]]))
        rt = None if skip else max(dwell + 150 if mode == "gaze" else 350, round(rt))
        duration = rt if rt else 5000 + rng.randint(800, 2500)
        start = ((BOARD["left"] + BOARD["right"]) / 2, (BOARD["top"] + BOARD["bottom"]) / 2)
        look_at = centre(sel or labels[ci])
        gaze = [{"x": x, "y": y, "rawX": x + round(rng.gauss(0, 12)), "rawY": y + round(rng.gauss(0, 12)), "t": t}
                for x, y, t in path(start, look_at, duration, 24, noise, bias, rng)]
        mouse = []
        if mode == "mouse":
            mouse = [{"x": x, "y": y, "t": t} for x, y, t in path(start, look_at, duration, 50, 2, (0, 0), rng)]
        on_board = sum(BOARD["left"] <= g["x"] <= BOARD["right"] and BOARD["top"] <= g["y"] <= BOARD["bottom"] for g in gaze)
        trials.append({
            "participantId": pid, "trial": i, "practice": False, "taskType": "choice", "searchType": "", "setSize": 4,
            "mode": mode, "targetSize": size, "target": labels[ci], "correctIndex": ci,
            "selected": sel or "", "selectedIndex": labels.index(sel) if sel else None, "correct": ok,
            "outcome": "skipped" if skip else ("correct" if ok else "incorrect"), "timedOut": duration > 5000, "rtMs": rt,
            "durationMs": duration, "dwellMs": dwell, "fixationMs": 500, "timeoutMs": 5000,
            "validationPassed": True, "validationMedianErrorPx": None, "gazeSampleCount": len(gaze),
            "gazeHz": round(len(gaze) / (duration / 1000), 1), "gazeOnBoardRate": round(on_board / len(gaze), 3),
            "viewport": {"width": VW, "height": VH}, "boardRect": BOARD, "targetBounds": bounds, "items": None,
            "gaze": gaze, "mouse": mouse, "simulated": True,
        })
    vpts = []
    for k, (lx, ly) in enumerate(CAL_POS, start=1):
        ex, ey = VW * lx / 100, VH * ly / 100
        edge = 1.6 if lx != 50 or ly != 50 else 1.0
        mx, my = ex + bias[0] * edge + rng.gauss(0, 20), ey + bias[1] * edge + rng.gauss(0, 20)
        vpts.append({"point": k, "expectedX": round(ex), "expectedY": round(ey), "sampleCount": rng.randint(18, 30),
                     "medianX": round(mx), "medianY": round(my), "medianErrorPx": round(math.hypot(mx - ex, my - ey) + abs(rng.gauss(0, 15))),
                     "precisionPx": round(noise * 1.1 + rng.uniform(0, 10))})
    med = sorted(p["medianErrorPx"] for p in vpts)[4]
    validation = {"attempt": 1, "points": vpts, "usablePointCount": 9, "viewport": {"width": VW, "height": VH},
                  "medianErrorPx": med, "medianErrorPctDiag": round(100 * med / math.hypot(VW, VH), 1),
                  "medianPrecisionPx": round(noise * 1.1), "accuracy": max(0, round(100 * (1 - med / 500))), "passed": med < 225}
    for t in trials:
        t["validationMedianErrorPx"] = med
    clip = lambda v: int(max(0, min(100, 5 * round(v / 5))))
    tlx = {}
    for mode, base in (("gaze", 55 - 8 * skill), ("mouse", 22)):
        scales = {k: clip(rng.gauss(base + (10 if k in ("mental", "effort") and mode == "gaze" else 0), 12)) for k in TLX_KEYS}
        tlx[mode] = {**scales, "rawTlx": round(sum(scales.values()) / 6, 1)}
    sus_answers = [max(1, min(5, round(rng.gauss(3.6 + 0.4 * skill if i % 2 == 0 else 2.4 - 0.4 * skill, 0.7)))) for i in range(10)]
    sus = sum((v - 1) if i % 2 == 0 else (5 - v) for i, v in enumerate(sus_answers)) * 2.5
    return {
        "schemaVersion": "2.0", "participantId": pid, "simulated": True, "synthetic": True,
        "note": "SYNTHETIC DEMO DATA generated by analysis/generate_demo_data.py - not real participants.",
        "settings": {"condition": "both", "taskType": "choice", "searchType": "mixed", "setSize": "mixed", "practiceCount": 4,
                     "fixationMs": 500, "timeoutMs": 5000, "dwellMs": dwell, "trialCount": n_trials},
        "screen": {"viewportWidth": VW, "viewportHeight": VH}, "validation": validation, "validationHistory": [validation],
        "calibration": [], "calibrationCorrection": None, "trialPlan": [], "trials": trials,
        "questionnaire": {"tlx": tlx, "sus": {"mode": "gaze", "answers": sus_answers, "score": sus},
                          "preference": "gaze" if rng.random() < 0.3 else "mouse", "comment": ""},
    }


def main(n=6, seed=5213):
    rng = random.Random(seed)
    OUT.mkdir(exist_ok=True)
    names = []
    for k in range(1, n + 1):
        pid = f"DEMO-{k:02d}"
        data = session(pid, rng, skill=rng.uniform(0.8, 1.3))
        name = f"{pid}.json"
        (OUT / name).write_text(json.dumps(data, separators=(",", ":")))
        names.append(name)
    (OUT / "index.json").write_text(json.dumps(names))
    print(f"wrote {len(names)} synthetic sessions to {OUT}")


if __name__ == "__main__":
    main()
