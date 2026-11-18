# Gaze Games & Selection Experiment

A browser-based webcam eye-tracking system that stands in for a **selection BCI**: the gaze tracker plays the role of
the neural decoder, and looking at a target plays the role of the BCI's selection command. After entering a name and
calibrating once, the player chooses from three eye-controlled games (bubble pop, whack-a-mole, gaze pong) or the
original **target selection experiment**. The experiment compares gaze dwell with mouse clicks and measures workload
(NASA-TLX) and usability (SUS). Everything runs locally in the browser. Nothing is uploaded.

A Chinese walkthrough (中文对照说明) is in [README_CN.md](README_CN.md).

---

## Contents

1. [Quick start](#1-quick-start)
2. [Before you start (setup checklist)](#2-before-you-start-setup-checklist)
3. [The full session, step by step](#3-the-full-session-step-by-step) (welcome, calibration, game hub, games, experiment, exit)
4. [Settings explained](#4-settings-explained)
5. [Results screen and downloads](#5-results-screen-and-downloads)
6. [Analysing several participants](#6-analysing-several-participants)
7. [Recording the demo video](#7-recording-the-demo-video)
8. [Troubleshooting](#8-troubleshooting)
9. [How it works (methods)](#9-how-it-works-methods)
10. [Metrics](#10-metrics)
11. [Files and data format](#11-files-and-data-format)
12. [References](#12-references)

---

## 1. Quick start

1. Install **Python 3** (Windows: tick *Add python.exe to PATH* during installation).
2. Double-click the launcher in this folder:
   - Windows: `start_experiment.bat`
   - macOS: `start_experiment.command` (first time: right-click → Open)
3. A console window opens and the experiment opens in your browser. **Keep the console window open** — it is the local
   web server. Closing it stops the experiment.
4. Use **Chrome or Edge**. If the page opened in another browser, copy the address (e.g. `http://localhost:5500/index.html`)
   into Chrome/Edge.

The console prints three addresses:

| Address | Use |
|---|---|
| `http://localhost:5500/index.html` | The experiment |
| `http://localhost:5500/analysis.html` | Multi-participant summary |
| `http://localhost:5500/index.html?sim=1` | Test mode without a camera (see below) |

The port is 5500 unless it is busy, in which case the launcher picks the next free one (5501–5519).

**Manual start (no launcher):** in a terminal, `cd` into this folder and run `python3 -m http.server 5500`
(Windows: `py -m http.server 5500`), then open `http://localhost:5500`.

> Do not open `index.html` by double-clicking it. Browsers only allow camera access on `http://localhost` or HTTPS,
> not on `file://` pages.

### Test mode (no camera)

`index.html?sim=1` replaces the gaze tracker with **the mouse pointer plus Gaussian noise**. Add `&noise=35` to set
the noise standard deviation in pixels (default 35). A red banner is shown and every record is flagged
`simulated: true`. Use it to learn the flow or debug, **never** for the video or the results.

### One-time step for the MediaPipe tracker

The default tracker downloads its model (~4 MB) from Google storage and its code from jsDelivr on first use. If
either is blocked (e.g. on networks in mainland China) or you want to run offline, run once on a network that can
reach them:

```bash
python3 tools/download_models.py
```

This saves the files into `vendor/`, and the tracker then loads them locally.

---

## 2. Before you start (setup checklist)

The webcam on a laptop sits **above** the screen. That is the opposite of research eye trackers, which sit below the
screen and light the eye with infrared from underneath. When you look at the bottom of the screen your upper eyelid
covers part of the iris, so posture and lighting matter a lot:

- **Eyes level with the top edge of the screen.** Raise the laptop or tilt the screen so the camera looks straight at
  your eyes, not down at your forehead.
- **Distance 50–70 cm**, face centred in the camera image.
- **Light from the front.** No window or lamp behind you; avoid a dark room.
- **Glasses:** take them off if possible, or tilt them to avoid reflections on the lenses.
- **Close apps that use the camera** (WeChat, Zoom, Teams, other browser tabs).
- **Keep your head still** from calibration until you finish playing. The model is fitted for one head position.
- Plan about **10–12 minutes per participant**.

---

## 3. The full session, step by step

```
Welcome (name) → Camera → 13-point calibration → 9-point validation → Game hub
                                                                        ├─ Bubble pop / Whack-a-mole / Gaze pong
                                                                        │     intro (choose time / control) → 3-2-1 → play → result + PNG figure
                                                                        │       → play again / another game / exit
                                                                        └─ Target selection experiment
                                                                              settings → trials → (optional NASA-TLX + SUS) → results → back to games / exit
                                                                      Exit → short questionnaire (6 items) → session summary
```

### Step 0 — Welcome

Type your **name or participant ID** and press **Start**. *Advanced settings* (collapsed) holds the tracker and
smoothing choice ([section 4.1](#41-welcome-screen--advanced-settings)); the defaults are fine.

### Step 1 — Camera

- Allow camera access when the browser asks.
- Wait until the message says the face has been detected (MediaPipe) or that the gaze model has started (WebGazer).
- Adjust your posture using the checklist above, then click **Go fullscreen & calibrate**.
- **Reconnect** restarts the camera if the image stays black.

### Step 2 — 13-point calibration

- A yellow dot appears at one of 13 positions: the 9 validation positions plus 4 inner points that add vertical
  coverage.
- **Look at the centre of the dot for about half a second, then click it.** Each dot needs **5 clicks**, and the
  progress fills inside the dot. Keep your eyes on the dot while clicking: each click tells the model "the eyes are
  looking here now".
- Clicks less than 150 ms apart are ignored.
- A small camera thumbnail is shown near the top. Its border is **green** when the face and open eyes are detected
  and **red** when they are not (MediaPipe only). Keep your face inside the dashed oval.
- Leaving fullscreen (Esc) discards the calibration. You then restart from the camera screen.

### Step 3 — 9-point validation

- A dot moves through 9 positions (1.4 s each). **Only look at it. Do not click.** The mouse pointer is hidden.
- The first 400 ms at each dot is ignored while the eyes travel to it and the smoothing settles.
- At the end the score is shown as `accuracy % · median error px`. Crosses mark the dots and coral circles mark where
  the gaze estimate landed.
- **Pass rule:** accuracy ≥ 55 %, which is a median error ≤ 225 px.
- If the gaze estimate barely moves across the nine dots (it covers less than 30 % of the screen width or height),
  a warning says the tracker is not following the eyes. Fix posture and lighting before recalibrating.

| Button | When it appears | What it does |
|---|---|---|
| **Choose a game** | Validation passed | Opens the game hub |
| **Show live gaze** | After validation | Shows a live blue dot at the current gaze estimate, so you can check that it follows your eyes |
| **Re-run validation** | Always | Repeats the 9 dots without recalibrating |
| **Recalibrate** | Validation failed | Clears the model and restarts calibration |
| **Continue anyway (low accuracy)** | Validation failed | Opens the game hub anyway. Experiment data are then marked `validationPassed: false` |

### Step 4 — Game hub

Four cards, each with an illustration, a short description and your best score so far:

| Card | What happens | Why it tolerates an imprecise tracker |
|---|---|---|
| **Bubble pop** | A blue ball follows your eyes; touch the 5 orange balls to pop them (contact counts immediately), and a new one appears elsewhere. Round length 30 / 60 / 90 / 120 s. Score = balls popped. | Balls are big and contact counts at once |
| **Whack-a-mole** | Moles pop out of 9 holes for a short time (1.8 s, getting shorter as you score; 2 at once after 10 hits). Look at a mole's square for 0.12 s to whack it. A bar under the hole shows the time left. Round length 30 / 60 / 90 / 120 s. Score = moles hit. | The whole grid square (⅓ of the screen in each direction) is the hit area, and the square under your gaze is highlighted |
| **Gaze pong** | The paddle follows your gaze **horizontally only**; watch the ball and the paddle goes under it. The ball starts at 520 px/s and speeds up 7 % per return (max 1100 px/s). **Three lives**: the game ends after the third missed ball (no time limit). Score = returns. | Only the horizontal axis is used. The vertical axis is the weak one for a webcam above the screen. The paddle is wide (22 % of the screen) |
| **Target selection experiment** | The original study task (step 5b). Opens a settings sheet first ([section 4.2](#42-experiment-settings)). | Large and small targets compared on purpose |

Buttons on the hub: **Recalibrate** (repeat steps 2–3), **Exit** (step 6), and **Return to fullscreen**, which only
appears if fullscreen was left. The calibration was made in fullscreen, so gaze positions are off outside it.

### Step 5a — Playing a game

1. **Intro card:** illustration and rules. For bubble pop and whack-a-mole choose the **time** (30 / 60 / 90 / 120 s;
   the choice is remembered). Gaze pong shows the three lives instead. Choose **Eyes** or **Mouse (for comparison)**,
   then **Start**.
2. A **3-2-1 countdown**, then the round. The top bar shows the score, the time left (pong: time played and the
   remaining lives ♥♥♥), the control mode and the smoothing level.
3. Keys during a game: **M** switches eyes ↔ mouse; **1 / 2 / 3** set smoothing off / light / strong (you see the
   jitter change immediately). **Back to games** stops the round.
4. **Result card:** score, three game-specific statistics, your previous best, the score with the other control
   mode if you have played it, and a preview of the **result figure**. **↓ Download result image (PNG)** saves the
   figure (2400 × 1440 px, file name `gaze-<name>-<time>-<game>-<mode>.png`). Then **Play again**, **Choose another
   game** or **Exit**.

**Result figure contents** (one per round):

| Panel | Bubble pop | Whack-a-mole | Gaze pong |
|---|---|---|---|
| Header | game, player, date/time, control mode, round length, tracker, smoothing, validation error | same | same (time played · 3 lives) |
| Left | score + three statistics | same | same |
| Main chart | cumulative balls popped over time | every mole: hits as green dots (height = reaction time), escaped moles as red ✕ | ball vs paddle horizontal position over time, misses marked: shows how closely the gaze followed the ball |
| Bottom left | gaze heatmap over the play area | gaze heatmap with the 3 × 3 grid | gaze heatmap |
| Bottom right | pops per 10 s | **hit rate per hole** (3 × 3): shows screen regions where gaze is less accurate (e.g. the bottom row with a camera above the screen) | rally length per life |

| Game | Result statistics |
|---|---|
| Bubble pop | balls popped · mean time per pop · fastest pop |
| Whack-a-mole | moles hit · hit rate (hit / (hit + escaped)) · mean reaction time (pop-up → hit) |
| Gaze pong | returns · return rate (returns / (returns + misses)) · longest rally |

Game results are kept for the session (`gameResults` in the JSON), with mode, smoothing, tracker and validation
error, so eyes-vs-mouse scores can be compared.

### Step 5b — Target selection experiment

After **Start experiment** on the settings sheet:

**Trials.** Each trial runs like this:

1. A **fixation cross "+"** appears in the centre for the fixation time. Look at it.
2. The targets appear and the timer starts. The top bar shows the trial number, the input method (blue tag = Gaze,
   orange tag = Mouse), the target size and the elapsed time.
3. Select the target named in the instruction:
   - **Gaze:** look at it. A ring fills over the dwell time and the target is selected when the ring is full. Brief
     tracking drop-outs (≤ 120 ms) do not reset the ring; looking away for longer does.
   - **Mouse:** click it.
4. Feedback: green outline = correct, red = wrong target (the correct one is then outlined in green).
5. After the response-reminder time a message appears and a **Skip this trial** button is offered. Nothing is
   skipped automatically.

Practice trials come first, are labelled *Practice*, and are not saved. If fullscreen is left during the trials,
completed trials are kept, the unfinished trial is discarded, and you must recalibrate and validate to continue.

**Questionnaire (optional).** By default the experiment goes straight to the results, and the short end-of-session
questionnaire (step 6) covers ease of use, workload and satisfaction. If *Questionnaire after the experiment* is set
to **Full NASA-TLX + SUS** ([section 4.2](#42-experiment-settings)), this questionnaire appears after the trials:

- **NASA-TLX workload**, one block per input method used (gaze and/or mouse). It has 6 sliders from 0 to 100:
  mental, physical and temporal demand, performance, effort and frustration. **Performance is reversed: 0 = perfect,
  100 = failure.** Every slider must be moved or clicked at least once, so untouched sliders are never recorded as 50.
- **SUS (System Usability Scale)**, 10 statements rated 1–5 (strongly disagree → strongly agree). It refers to the
  gaze system whenever gaze was used, otherwise to the mouse system.
- **Preference** (gaze / mouse / none), shown only when both inputs were used.
- **Comments** (optional).

**Results.** The dashboard appears (TLX/SUS charts only when the full questionnaire was used) ([section 5](#5-results-screen-and-downloads)). **Click "Full data (JSON)" before
leaving.** Then **Back to games** (re-enters fullscreen; the calibration is still valid) or **Exit**.

### Step 6 — Exit

**Exit** (on the hub, a game result or the experiment results) ends the session. It leaves fullscreen and pauses the
camera tracker, then shows a **short questionnaire**: six statements rated 1–5 (strongly disagree → strongly agree):

| # | Statement | Dimension |
|---|---|---|
| 1 | Controlling things with my eyes was easy. | Ease of use |
| 2 | The eye control went where I was looking. | Ease of use (perceived accuracy) |
| 3 | Using my eyes as a controller was tiring. | Workload |
| 4 | It took a lot of concentration. | Workload |
| 5 | I enjoyed using eye control. | Satisfaction |
| 6 | I would like to use eye control again. | Satisfaction |

Each dimension score is the mean of its two items (1–5; for workload, higher = more demanding). A preference question
(eyes / mouse / none) appears if the mouse was used, plus an optional comment. **Skip** is allowed. The session
summary then lists every game round with its score and details, and the three questionnaire scores. **Download session (JSON)** saves
everything, including experiment trials if any. **New player** reloads the page for the next person.

---

## 4. Settings explained

### 4.1 Welcome screen — Advanced settings

| Option | Choices (default first) | What it does | Recommendation |
|---|---|---|---|
| **Name / participant ID** | free text | Shown in the hub and the summary, stored in every record and in file names. Sessions with the same ID replace each other on the analysis page. | For the study use P01, P02, … rather than real names |
| **Gaze tracker** | *MediaPipe iris + head pose* / *WebGazer 2.1* | Chooses the algorithm that turns the camera image into a screen position ([section 9](#9-how-it-works-methods)). MediaPipe uses iris-to-eye-corner geometry, eyelid opening and head pose. WebGazer is the original appearance-based tracker, kept for comparison. | MediaPipe. Switch to WebGazer only if MediaPipe cannot load or to compare the two |
| **Gaze smoothing** | *Strong* / *Light* / *Off* | How much the raw gaze stream is stabilised. **Strong:** median-of-3 spike removal, then a fixation lock (holds the cursor at the running mean while you fixate, and jumps only when 3 consecutive samples agree you moved your eyes), then a One Euro filter. **Light:** One Euro filter only (the original behaviour). **Off:** raw tracker output. Strong removes most jitter at about 100 ms delay on eye jumps. It does not fix a constant offset; only calibration does. Can also be changed in games with keys 1/2/3. | Strong |

### 4.2 Experiment settings

Shown when you choose **Target selection experiment** in the hub.

| Option | Choices (default first) | What it does | Recommendation |
|---|---|---|---|
| **Input condition** | *Gaze vs mouse (balanced)* / *Gaze only* / *Mouse only* | *Balanced* mixes gaze and mouse trials in shuffled blocks, so both appear equally often and in no fixed order. The mouse is the non-BCI baseline. | Balanced, because the report compares the two |
| **Task** | *Target selection (2×2)* / *Visual search* / *Both (interleaved)* | **Target selection:** four letters A–D at fixed positions; select the named letter. This is the main BCI-like selection task. **Visual search:** find the single red circle among distractors, which adds a perceptual-search component. **Both:** the two tasks are interleaved and balanced. | Target selection |
| **Search difficulty** | *Mixed* / *Feature* / *Conjunction* | Applies only when the task includes visual search. **Feature:** the target (red circle) differs from all distractors (green circles) by colour alone, so it "pops out". **Conjunction:** distractors are red squares and green circles, so the target is defined by a combination of colour and shape, which usually takes longer and grows with the number of items (Treisman & Gelade, 1980). *Mixed* picks one at random per trial. | Mixed, if search is used |
| **Search set size** | *Mixed (4/8)* / *4* / *8* | Applies only to search trials. Sets the number of items on screen; 8 items use a 2 × 4 layout. Comparing 4 vs 8 gives the search slope. | Mixed, if search is used |
| **Dwell time** | *800 ms* / *1200 ms* / *600 ms* | How long the gaze must stay on a target to select it. Shorter is faster but causes more accidental selections (the "Midas touch" problem); longer is more accurate but slower and more tiring. It plays the role of a BCI's decision threshold or evidence-accumulation time. | 800 ms. Keep it fixed within a session; compare values in separate sessions |
| **Main trials** | 24 (range 8–48) | Number of scored trials. With *balanced × target selection* there are 4 cells (gaze/mouse × large/small), so 24 gives 6 per cell. Target position is counterbalanced within each cell. | 24 (minimum); 32–48 for more stable estimates |
| **Practice trials** | *4* / *2* / *None* | Unscored warm-up trials, generated independently from the main trials. They are not saved. | 4 |
| **Fixation cross** | *500 ms* / *300 ms* / *800 ms* | Time the central "+" is shown before the targets appear. It brings the gaze back to the centre, so every trial starts from the same place and no target is pre-selected by a resting gaze. | 500 ms |
| **Response reminder** | *5000 ms* / *3000 ms* / *8000 ms* | After this time the trial shows a reminder and a **Skip** button. It never ends the trial by itself. Such trials are flagged `timedOut`. | 5000 ms |
| **Questionnaire after the experiment** | *None* / *Full NASA-TLX + SUS* | *None*: results appear right after the trials; the short end-of-session questionnaire is used instead. *Full*: the standard NASA-TLX (per input) and SUS are asked straight after the trials, which feeds the TLX/SUS charts and the analysis page. | None for demos; Full for the formal comparison study |

**Target size** is not a setting. Every session contains both large and small targets as a within-subject factor
(large = 28 % × 36 % of the board, small = 18 % × 24 %).

### 4.3 URL options (added to the address)

| Parameter | Effect |
|---|---|
| `?sim=1` | Test mode: mouse + noise replaces the gaze tracker; data flagged `simulated` |
| `&noise=35` | Noise standard deviation in px for test mode |
| `&round=30` | Default game round length in seconds (5–600). The time chosen on the intro card overrides it |

---

## 5. Results screen and downloads

| Element | What it shows |
|---|---|
| **Stat tiles** | Accuracy, median selection time, error rate, ITR (bits/min), validation error, SUS, per input method |
| **Accuracy by condition** | % correct for each target size × input |
| **Selection time by condition** | Every trial as a dot (hollow = wrong target); the black tick is the median of correct trials |
| **Outcome breakdown** | Share of correct / wrong-target / skipped trials per input |
| **Selection time across the session** | Trial-by-trial times with a running median, showing learning or fatigue |
| **Visual search slope** | Selection time vs number of items, feature vs conjunction (search tasks only) |
| **Calibration quality** | The 9 validation points: target, median gaze estimate, error line, precision circle |
| **Gaze heatmap** | Where the gaze estimate landed, per layout and input |
| **Trial replay** | Plays back the gaze (blue) and mouse (orange) path of any trial |
| **Workload (NASA-TLX)** | Six subscales + raw TLX, gaze vs mouse |
| **Usability (SUS)** | Score with adjective band (Poor / OK / Good / Excellent) |
| **Table view** | All trials as a table |

Every chart has a **PNG** button; hover any mark for exact values.

| Download | Content | Needed for |
|---|---|---|
| **Full data (JSON)** | Everything: settings, calibration, validation, trials with gaze/mouse samples, questionnaire | `analysis.html`, `make_figures.py` — **always download this one** |
| **Trials (CSV)** | One row per trial | Excel / SPSS |
| **Gaze samples (CSV)** | One row per gaze or mouse sample | Custom analysis |

---

## 6. Analysing several participants

1. Put every participant's **Full data (JSON)** file in one folder, e.g. `data/`.
2. **Quick look in the browser:** open `analysis.html` and drag the files onto the drop zone (or use *Load JSON files…*).
   - Paired plots per participant (gaze vs mouse): accuracy, selection time, ITR, raw TLX.
   - Group means by condition with individual participants as dots, pooled outcomes, validation error per
     participant, SUS distribution, pooled heatmap, summary table (including which tracker was used).
   - **Summary CSV** exports one row per participant. **All charts as PNG** downloads every chart.
   - *Load synthetic demo data* loads `sample_data/` (fake participants `DEMO-xx`) to preview the page. Never report
     these.
3. **Report figures (Python):**
   ```bash
   pip install matplotlib numpy
   python3 analysis/make_figures.py data --out figures
   ```
   This writes `fig1_accuracy_by_condition.png` … `fig9_learning_curve.png`, `participant_summary.csv` and
   `trials_all.csv`. The metric definitions match the dashboard exactly.
4. Sessions run with **Continue anyway** (`validationPassed: false`) or in test mode (`simulated: true`) should be
   excluded or reported separately.

---

## 7. Recording the demo video

The brief asks for 1–2 minutes "just showing it in action". Record with macOS `Cmd+Shift+5` or Windows `Win+Alt+R`.
A suggested sequence:

1. Welcome screen → camera preview (≈10 s)
2. Calibration (speed it up when editing) and the validation result (≈15 s)
3. Game hub → **Whack-a-mole** or **Gaze pong** with the eyes (≈20 s). Press **1** then **3** mid-game to show the
   jitter with smoothing off vs strong.
4. Target selection experiment: a few gaze trials (the dwell ring filling up is the most "BCI-like" moment) and one
   mouse trial for contrast (≈30 s)
5. Results: game result card or the experiment dashboard (stat tiles, **Trial replay**) (≈15 s)

Use `?round=20` for shorter game rounds while recording.

---

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| Double-clicking the `.bat` shows "Python was not found" | Install Python 3 and tick *Add python.exe to PATH* |
| Browser says the page cannot be reached | The console window was closed; start the launcher again |
| Camera image black / "in use" | Close other apps and tabs using the camera, click **Reconnect**, or reload |
| "MediaPipe tracker failed …" | Run `python3 tools/download_models.py` on a network that can reach Google/jsDelivr, or reload and choose **WebGazer** |
| "WebGazer failed to load" | jsDelivr is unreachable; change network or VPN |
| Validation: all gaze points clustered in one corner, "not following your eyes" warning | Fix posture and lighting (section 2), keep the face inside the oval (green border), recalibrate without moving your head, check with **Show live gaze** |
| Validation passes but the bottom targets are hard to select | Expected with a camera above the screen; raise the screen so your eyes are level with its top edge and recalibrate |
| Page looks outdated after an update | Hard-reload: `Ctrl+F5` (Windows) or `Cmd+Shift+R` (macOS) |
| Port already in use | The launcher picks the next free port automatically; read the address in the console |

---

## 9. How it works (methods)

### Design

2 (input: gaze dwell vs mouse click) × 2 (target size: large vs small), within-subject. Trials are drawn in shuffled
blocks containing every cell, so the design stays balanced even if a session is cut short. Target location is
counterbalanced within each cell. An optional visual-search task adds search type (feature/conjunction) × set size
(4/8).

### Gaze pipeline

**Every part of the app uses the same gaze estimate.** Validation, the selection experiment and all three games
receive the same corrected coordinate from one function (`onGazePrediction` in `app.js`): the tracker chosen at the
start, then the smoothing level, then the calibration correction. A game start only clears the filter history; it
does not change any parameter. What differs between screens is only how that coordinate is used:

| Screen | Selection rule |
|---|---|
| Bubble pop | the gaze ball touches a target (immediate) |
| Whack-a-mole | the gaze stays in the mole's grid square for 0.12 s |
| Gaze pong | horizontal coordinate only; the paddle eases toward it |
| Selection experiment | dwell 600 / 800 / 1200 ms on a target |

```
camera → tracker (MediaPipe or WebGazer) → gaze stabiliser → calibration correction → dwell selection / games
```

**MediaPipe tracker (`tracker-mediapipe.js`, default).** MediaPipe Face Landmarker gives 478 face landmarks
(including both irises), a facial transformation matrix (head pose) and blendshapes for each video frame. From each
frame it computes:

- per eye: the iris centre relative to the two eye corners (horizontal *u*, vertical *v*, normalised by eye width so
  it does not depend on distance or head roll), the eyelid aperture, and the iris-to-upper-lid distance;
- head rotation and translation, face position and size in the image;
- MediaPipe's eye blendshapes (look up/down/in/out, blink), when available;
- a few quadratic terms.

During calibration, the frames from the 500 ms before each click are paired with the dot's screen position. Two
ridge regressions (x and y) are fitted on standardised features. The regularisation strength λ is chosen by
leave-one-calibration-point-out cross-validation. Blink frames (eyelid aperture below threshold) are discarded.

*Why these features:* head-pose inputs compensate for small head movements. The eyelid features carry vertical gaze
information when the iris is partly hidden by the upper lid, which happens when looking down at a screen below a
top-mounted webcam. The 4 extra calibration points also strengthen the vertical axis.

**WebGazer 2.1 tracker (original).** Appearance-based: eye-patch pixels are mapped to the screen by ridge regression
trained on the calibration clicks. WebGazer's default self-training on every mouse movement is disabled, because in
an experiment the eyes do not follow the cursor.

**Gaze stabiliser** (`gaze-filter.js`, setup option *Gaze smoothing*). The *strong* pipeline has three stages:

1. **Median of the last 3 samples** removes single-frame spikes (blinks, landmark glitches) that a low-pass filter
   would only smear.
2. **Fixation lock**, based on the dispersion-threshold idea (I-DT, Salvucci & Goldberg, 2000). While samples stay
   within 70 px of the current fixation centre, the output is the running mean of the fixation (≤ 20 samples). A
   sample outside is ignored unless 3 consecutive samples land outside and close to each other. Then it is a real
   saccade and the output jumps straight there.
3. **One Euro filter** (Casiez et al., 2012): an adaptive low-pass with min cutoff 0.8 Hz and β = 0.02. *Light*
   uses this stage alone with the original settings (1.2 Hz, β = 0.015).

On synthetic gaze (σ = 40 px noise plus 5 % large spikes, 30 Hz), the RMS error during fixations was **101 px raw,
92 px light, 20 px strong**, and strong reached a new fixation in about 100 ms. Validation ignores the first 400 ms at
each dot so the filter has settled.

**Calibration correction:** a bounded affine fit of the residuals at the calibration points. It applies 50 % gain,
at most 120 px per axis, and is used only when predictions during calibration are available (WebGazer).

**Dwell selection:** a target is selected when the filtered gaze stays inside it for the dwell time. Gaps of up to
120 ms are tolerated.

**Validation:** 9 points, measured on fresh samples (not the calibration data). It records the median error
(accuracy), the RMS spread (precision) and the median gaze position for each point.

---

## 10. Metrics

The definitions are identical in the dashboard, `analysis.html` and `make_figures.py`.

| Metric | Definition |
|---|---|
| Accuracy | correct / all main trials (skips count as misses) |
| Selection time | median time from target onset to selection, correct trials only. Gaze includes the dwell, so its minimum equals the dwell time |
| Error rate | wrong-target selections / all trials (for gaze: Midas-touch errors). Skip rate is reported separately |
| ITR | Wolpaw: B = log₂N + P·log₂P + (1−P)·log₂[(1−P)/(N−1)] bits per selection, where N is the number of targets and P the accuracy. ITR = B × 60 / T bits/min, with T the mean trial duration. *Practical ITR* adds the fixation and feedback time to T |
| Validation error | median over the 9 points of each point's median distance between the dot and the gaze estimate (px; also % of the screen diagonal) |
| Precision | RMS spread of the samples around their own centre at each validation point |
| Workload | raw NASA-TLX = mean of the 6 subscales (0–100, lower = less workload), per input |
| Usability / satisfaction | SUS 0–100; 68 ≈ average; bands < 51 Poor, 51–68 OK, 68–80.3 Good, > 80.3 Excellent (Bangor et al., 2009) |

The brief asks for descriptive statistics and visualisations, not inferential tests.

---

## 11. Files and data format

| File | Purpose |
|---|---|
| `start_experiment.bat` / `.command`, `start_server.py` | Launchers: local server on a free port + open the browser |
| `index.html`, `app.js`, `styles.css` | The experiment |
| `tracker-mediapipe.js` | MediaPipe landmark features + ridge regression tracker |
| `gaze-filter.js` | Gaze stabiliser (median + fixation lock + One Euro) |
| `game.js` | The three games (bubble pop, whack-a-mole, gaze pong): countdown, timed rounds / lives, event logs |
| `result-image.js` | Draws the exportable PNG result figure for each game round |
| `viz.js`, `viz.css` | Metrics and charts (results screen + analysis page), no external libraries |
| `analysis.html` | Multi-participant summary |
| `analysis/make_figures.py` | Report figures + summary CSVs |
| `analysis/generate_demo_data.py` | Writes **synthetic** sessions to `sample_data/` |
| `tools/download_models.py` | Downloads the MediaPipe files into `vendor/` |
| `sample_data/` | Synthetic demo sessions (`DEMO-xx`, flagged), not real data |
| `manifest.json`, `service-worker.js` | Installable-app support (network-first cache) |
| `说明_中文对照.md` | Chinese guide and UI glossary |

Each trial and `settings` also store `smoothing` (off/light/strong).

**JSON (schema 2.0), top level:** `participantId, tracker, trackerSource, training (MediaPipe fit: λ, CV error,
samples), simulated, settings, screen, userAgent, trialPlan, calibration, calibrationCorrection, validation,
validationHistory, trials, questionnaire, gameResults, finalQuestionnaire`.

**Each game result:** `game (bubbles|moles|pong), title, mode (gaze|mouse), timed, roundS, score, statsText, raw,
events (bubbles: pop times; moles: {t, cell, hit, rt}; pong: {t, type}), track (pong: ball / paddle / gaze x every
50 ms), trace (pointer position every 50 ms, normalised to the play area), field, smoothing, tracker,
validationMedianErrorPx, t`.

**finalQuestionnaire:** `answers {ease1, ease2, load1, load2, sat1, sat2}` (1–5), `scores {easeOfUse, workload,
satisfaction}`, `preference, comment` (or `{skipped: true}`).

**Each trial:** `trial, taskType, searchType, setSize, mode, targetSize, target, correctIndex, selected,
selectedIndex, correct, outcome (correct|incorrect|skipped), timedOut, rtMs, durationMs, dwellMs, fixationMs,
timeoutMs, validationPassed, validationMedianErrorPx, gazeSampleCount, gazeHz, gazeOnBoardRate, viewport,
boardRect, targetBounds, items (search stimuli), gaze[] / mouse[] (x, y, t = ms since target onset), tracker,
simulated`.

**Questionnaire:** `tlx.{gaze|mouse}.{mental, physical, temporal, performance, effort, frustration, rawTlx}`,
`sus.{mode, answers[10], score}`, `preference`, `comment`.

---

## 12. References

- Bangor, A., Kortum, P., & Miller, J. (2009). Determining what individual SUS scores mean. *J. Usability Studies*.
- Brooke, J. (1996). SUS: A "quick and dirty" usability scale.
- Casiez, G., Roussel, N., & Vogel, D. (2012). 1€ Filter. *CHI '12*.
- Gudi, A., Li, X., & van Gemert, J. (2020). Efficiency in real-time webcam gaze tracking. arXiv:2009.01270.
- Hart, S. G., & Staveland, L. E. (1988). Development of NASA-TLX.
- Jacob, R. J. K. (1990). What you look at is what you get (the Midas touch problem). *CHI '90*.
- Salvucci, D. D., & Goldberg, J. H. (2000). Identifying fixations and saccades in eye-tracking protocols. *ETRA '00*.
- Papoutsaki, A., et al. (2016). WebGazer: Scalable webcam eye tracking using user interactions. *IJCAI*.
- Treisman, A., & Gelade, G. (1980). A feature-integration theory of attention. *Cognitive Psychology*.
- Wolpaw, J. R., et al. (2002). Brain–computer interfaces for communication and control. *Clin. Neurophysiol.*
- MediaPipe Face Landmarker: https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker
