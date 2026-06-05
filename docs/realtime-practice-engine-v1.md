# Realtime Practice Engine — V1 (locked)

Slopsmith V1 ships **realtime preserve-pitch practice slowdown** for musician workflows.
The desktop app applies timestretch in the native JUCE backing path; this document covers
the **web UI and lifecycle** in the `slopsmith` repo.

## Status

**Feature-complete for V1.** Further DSP engines are out of scope until product priorities
(loops, section practice, count-in, etc.) advance.

## UX philosophy

Musicians practice at **known-good speeds**, not arbitrary micro-percentages.

| Control | Role |
|---------|------|
| **Practice presets** (100 → 50%) | Primary workflow |
| **Fine slider** | Secondary adjustment between presets |
| **Snap on release** | ±2% of a preset snaps to exact target |
| **Quality hints** | Informational only — nothing blocked |

**Sweet spot:** 70–80% is visually emphasized as the recommended realtime practice range.

## Engine abstraction (stable API)

```js
window.slopsmithPlayback.speed = {
  engine: 'soundtouch-realtime',
  profile: 'musician-practice-v1',
  presets: [100, 90, 80, 75, 70, 60, 50],
  sweetSpot: [80, 75, 70],
  setRate(rate),      // → setSpeed()
  applyPreset(pct),
  snapRate(rate),
  qualityLabel(rate),
};
```

Future engines (Rubber Band, offline cache, spectral hybrid) should plug in here **without**
rewriting player UX.

## Frontend stability

- WebSocket connect closes superseded sockets; errors after `ready` are ignored.
- `playSong` sequencing prevents overlapping loads.
- Speed slider: single bridge path; `change` skips duplicate apply after final `input`.
- HTML5 `audio.play()` guarded when `src` is empty after JUCE routing.

## 3D highway overlay

`.h3d-wrap` / WebGL canvas use `pointer-events: none` so player controls (speed slider)
remain interactive.

## Artifact expectations

Realtime WSOLA-style stretching (SoundTouch) produces **normal** artifacts at aggressive
slowdown: wobble, watery tone, flutter, transient smear. This is expected for V1.

Commercial tools reduce artifacts with proprietary engines, offline renders, and years of
tuning — not a V1 goal.

## Native DSP profile

Locked in `slopsmith-desktop` — **Musician Practice Profile V1**:

- `SETTING_USE_QUICKSEEK = 0`
- `SETTING_USE_AA_FILTER = 1`
- `SETTING_SEQUENCE_MS = 60`
- `SETTING_SEEKWINDOW_MS = 20`
- `SETTING_OVERLAP_MS = 12`

## Milestone

Tag: **`v1-realtime-practice-engine`** (paired with `slopsmith-desktop`).
