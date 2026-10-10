# HOUSTON — AI Mission Control · Implementation Plan

Source brief: `BRIEF.md` (verbatim requirements). This file holds the concrete decisions and the build checklist.
Environment: Windows 11, Node 24.10, npm 11.6. Folder starts empty, not a git repo.

---

## 1. Architecture

```
claude-build/
  package.json            # single package; scripts: dev, build, test, typecheck
  tsconfig.json           # shared strict config
  vite.config.ts          # root=client, proxy /api -> http://localhost:8787
  .env.example            # ANTHROPIC_API_KEY=, ANTHROPIC_MODEL=
  .gitignore              # node_modules, dist, .env, .env.*  (keep .env.example)
  shared/
    constants.ts          # all physics + scenario + threshold numbers (single source of truth)
    types.ts              # LanderState, Action, Telemetry, MissionStatus, LogEvent, ServerMessage
    sim.ts                # pure: step(), runManeuver(), predict(), evaluateTouchdown(), clone
  server/
    index.ts              # node:http server: REST + SSE; serves nothing else in dev
    mission.ts            # MissionController: authoritative state, serial action queue, run epoch
    agent.ts              # Claude control loop (Anthropic SDK, manual tool-use loop)
    tools.ts              # tool JSON schemas + server-side validation + handlers
    prompt.ts             # system prompt built from shared/constants.ts
  client/
    index.html
    src/main.tsx, App.tsx, styles.css
    src/api.ts            # fetch wrappers + EventSource subscription
    src/Scene.tsx         # Canvas 2D renderer
    src/panels/*.tsx      # Telemetry, Thrusters, AgentStatus, LastCommand, EventLog, Controls, ManualPanel, OutcomeOverlay
  tests/
    sim.test.ts           # node:test via tsx (no test framework dependency)
    mission.test.ts
  README.md, DEMO.md
```

Dependencies (minimal):
- runtime: `react`, `react-dom`, `@anthropic-ai/sdk`, `dotenv`
- dev: `vite`, `@vitejs/plugin-react`, `typescript`, `tsx`, `concurrently`, `@types/react`, `@types/react-dom`, `@types/node`
- No express (use `node:http`), no test framework (use `node:test` + `node:assert` run with `tsx --test`).

`npm run dev` → `concurrently "tsx watch server/index.ts" "vite"`.
`npm run build` → `tsc --noEmit -p . && vite build`. `npm test` → `tsx --test tests/*.test.ts`.

### Backend-authoritative state
- Exactly one `MissionController` instance holds the mission state.
- All mutations (maneuver, fault, reset, pause) go through one serial queue — no concurrent maneuvers.
- **Real-time paced execution on the server:** a maneuver is run as a sequence of fixed 1/60 s steps; the server advances steps on a timer (batch of steps per ~33 ms tick, real-time 1×) and pushes state over SSE. This makes the client animation *the actual simulated trajectory*, and lets pause and fault injection land at a precise step boundary.
- **Run epoch:** every reset increments `epoch`. The agent loop and any in-flight maneuver capture the epoch at start and abort if it changes. SSE messages carry `epoch`; client drops stale ones.
- Manual mode and Claude both call `mission.executeManeuver(action, source)` — same validation, same sim path.

### API (REST + SSE)
| Method | Path | Purpose |
|---|---|---|
| GET  | `/api/events` | SSE: `snapshot` (full state on connect), `state` (~30 Hz during execution), `log`, `status` |
| GET  | `/api/config` | constants, `agentAvailable` (key present), model id |
| POST | `/api/mission/start-ai` | start agent loop (409 if one running or mission terminal) |
| POST | `/api/mission/maneuver` | manual maneuver (409 if AI mode active or busy) |
| POST | `/api/mission/pause` / `resume` | pause flag; execution stops at next step boundary; agent waits before next decision |
| POST | `/api/mission/fault` | `{ thruster: "LEFT_PUSH" \| "RIGHT_PUSH" }` — queued, applied at next step boundary, logged with sim time |
| POST | `/api/mission/reset` | abort agent (AbortController), bump epoch, restore scenario, clear faults/log |
| POST | `/api/mission/predict` | manual-mode preview of a proposed maneuver (no mutation) |

---

## 2. Physics (shared/sim.ts) — deliberately simple

Coordinates: meters, seconds. **+x right, +y up**, ground at y = 0 (flat in the sim; terrain outside pad is decorative only). Gravity `g = 1.62 m/s²` downward. No rotation; mass treated as constant (accelerations specified directly). State this in README.

Starting constants (put in `shared/constants.ts`, tune in phase 4):

| Item | Value |
|---|---|
| dt | 1/60 s fixed |
| Main engine max accel | 4.0 m/s² at throttle 1.0 (TWR ≈ 2.5) |
| Throttle range | 0.0 – 1.0 |
| Thrust-vector angle | −15° … +15°; 0 = thrust straight up; **+angle adds rightward thrust** |
| Main accel vector | `ax = T·sin(θ)`, `ay = T·cos(θ)` with `T = 4.0·throttle` |
| Lateral thrusters | `LEFT_PUSH` (force toward −x), `RIGHT_PUSH` (force toward +x), 0.6 m/s² each, on/off |
| Lateral selection | `"NONE" \| "LEFT_PUSH" \| "RIGHT_PUSH"` (one at a time) |
| Fuel | 100 units; main burn 1.2 units/s × throttle; lateral 0.3 units/s |
| Fuel exhaustion | thrust within a step scales to fuel remaining; then zero thrust |
| Maneuver duration | 0.25 – 6.0 s (validated, rejected outside) |
| Start state | x = −150, y = 520, vx = +6, vy = −12, fuel = 100 |
| Landing zone | x ∈ [140, 220] (center 180, width 80) |
| Lander footprint | half-width 5 m (both feet must be inside the zone) |
| Safe touchdown | `|vy| ≤ 2.0`, `|vx| ≤ 1.0`, `zoneMin ≤ x−5` and `x+5 ≤ zoneMax` |
| Default fault | `RIGHT_PUSH` fails (presenter button); both selectable in manual/debug |

Fault recovery path: with RIGHT_PUSH dead, rightward correction comes from vectoring (+15° at full throttle ≈ 1.04 m/s² lateral, more than the 0.6 m/s² thruster) at the cost of some vertical authority — recoverable but harder.

Sim functions:
- `step(state, control, dt)` — semi-implicit Euler; applies failed-thruster mask (zero force), fuel limits, gravity; checks ground contact **inside** the step (if y crosses 0, interpolate the contact fraction, set y=0, freeze, evaluate touchdown).
- `runManeuver(state, action, opts)` — loops `step` for `duration`, stops early on contact; returns final state + sampled trajectory (every ~0.1 s) + `contact` info. Takes an optional per-step hook (used by server for pacing/pausing/fault injection).
- `predict(state, action, horizonSec)` — clones state, runs `action` then optional ballistic coast to horizon (≤ 30 s); returns trajectory, `touchdown` (point, velocities, verdict) or `horizonEndedBeforeTouchdown: true`. Same integrator as actual execution.
- `ballisticProjection(state)` — zero-thrust coast until contact (cap 60 s); drives the "projected touchdown" marker on screen.
- `evaluateTouchdown(state)` → `{ outcome: "LANDED" | "MISSED_ZONE" | "CRASHED", reasons: string[] }`. Crash = any speed threshold exceeded (with exact numbers in reason); Missed zone = speeds OK but footprint outside zone. Never fudged.
- Mission is terminal after contact or if out-of-bounds (|x| > 1500 or y > 2000) → `CRASHED`/`LOST` with reason. Terminal missions reject further actions.

---

## 3. Claude agent loop (server/agent.ts)

- Use `@anthropic-ai/sdk` `client.messages.create` with `tools`, a hand-written loop (not Tool Runner — we need per-step epoch/pause checks). **Before coding, verify current SDK usage and model IDs via the `claude-api` skill / official docs.** Model from `ANTHROPIC_MODEL`; if unset, use a documented current default (verify — do not invent) and show it in UI.
- Pause the sim while Claude decides (status `AWAITING_DECISION`). Statuses: `IDLE`, `AWAITING_DECISION`, `EXECUTING`, `PAUSED`, `LANDED`, `MISSED_ZONE`, `CRASHED`, `AGENT_ERROR`.
- Budget: max 40 tool calls / 30 maneuvers / 60 model turns per mission; when exhausted, stop and report "budget exhausted" honestly (lander coasts? — **no**: mission halts with status `AGENT_ERROR: budget exhausted`, the UI can still show the ballistic projection; never hand over to an autopilot).
- Retries: up to 2 retries with backoff on 429/5xx/network; then `AGENT_ERROR` with message. 401/missing key → clear setup message.
- Conversation + tool results persisted in memory for the mission (and exposed via `/api/mission/transcript` for debugging).
- If Claude ends its turn without landing, send one nudge ("Mission not terminal; continue"), max 3 nudges, then `AGENT_ERROR`.
- Display: each tool call (name + input), compact result, and Claude's short text "action summary". System prompt asks for a one-line summary before each tool call; we do **not** request or display chain-of-thought. If extended thinking is ever used, don't render it.

Tools (validate every input server-side; on invalid input return `is_error: true` tool_result with the reason):

1. `read_telemetry` `{}` → position, velocity, altitude, fuel, sim time, engine limits, thruster health (`LEFT_PUSH: ok|FAILED`), fault log, landing zone bounds, thresholds, mission status, ballistic projected touchdown.
2. `execute_maneuver` `{ throttle: 0..1, angle_deg: -15..15, lateral: "NONE"|"LEFT_PUSH"|"RIGHT_PUSH", duration_s: 0.25..6, summary: string }` → resulting telemetry, fuel used, whether contact occurred, any fault events during the burn. Zero throttle + NONE = coast. Commanding a failed thruster is allowed but produces no force; result states that clearly.
3. `predict_trajectory` `{ throttle, angle_deg, lateral, duration_s, coast_after_s?: 0..30 }` → sampled points (≤ 20), end state, touchdown verdict or "horizon ended before touchdown", labelled `controlled` vs `ballistic` portion. No mutation. Predictions also drawn on canvas (dashed).

System prompt (server/prompt.ts, generated from constants): coordinate/sign conventions, units, engine limits, fuel costs, thresholds, zone bounds + footprint, objective, budget, "re-read telemetry after each maneuver; thrusters may fail at any time; if a thruster fails, adapt using thrust vectoring", "keep summaries to one line".

---

## 4. UI (client)

Visual: near-black `#07090b`, warm off-white `#e8e2d4` labels, amber `#ffb000` caution, red `#ff3b30` critical, restrained cyan `#4fd1d9` accents; monospace/compact type (`ui-monospace`, 11–13 px), 1 px borders `#2a2f33`, small radii (2 px). No gradients/large cards.

Layout (full viewport, no page scroll):
```
┌ HOUSTON · AI MISSION CONTROL ─ status pill ─ model ─ sim time ─────────────┐
│                                                   │ TELEMETRY              │
│         CANVAS SCENE (~72% width)                 │ alt / vx / vy / fuel   │
│  stars, terrain, pad, lander + exhaust,           │ THRUSTERS health       │
│  trail (solid), prediction (dashed cyan),         │ AGENT status           │
│  ballistic projection (amber dotted) + X marker,  │ LAST COMMAND           │
│  legend, zone bounds                              │ EVENT LOG (scroll)     │
├───────────────────────────────────────────────────┴────────────────────────┤
│ [START AI] [PAUSE/RESUME] [⚠ THRUSTER FAILURE] [RESET] [MANUAL ▸ sliders]  │
└─────────────────────────────────────────────────────────────────────────────┘
```
- Camera: fixed world view auto-fit to x ∈ [−300, 350], y ∈ [0, 600] with slight zoom-in near ground (optional, cut if tight).
- Exhaust drawn along the thrust vector, length ∝ throttle; lateral puffs on the correct side; failed thruster drawn red with sparks.
- Outcome overlay (centered, doesn't need scroll): outcome, touchdown x, vx, vy, fuel left, precise reason(s).
- Agent errors / setup message ("ANTHROPIC_API_KEY not set — manual mode available") shown in a persistent banner, not just the log.
- Control enabling: Start AI disabled unless IDLE & agentAvailable; manual maneuver disabled while EXECUTING or AI active; fault disabled when terminal or already failed; reset always enabled. Buttons disable optimistically on click to prevent double-submit; server also returns 409.

---

## 4b. UX bar — "mind-blowing, very modern" (first-class requirement, not Phase 4 garnish)

The demo is judged on how it *feels* in two minutes. Build the scene and HUD with this bar from Phase 1, still within the brief's palette (near-black, warm off-white, amber, red, restrained cyan; no purple gradients, no giant rounded cards).

**Scene (Canvas 2D)**
- Dynamic camera: smooth follow/zoom that tightens toward the ground as altitude drops, eased (critically-damped spring), with a small altitude/ground-distance ruler that appears near touchdown.
- Glow/bloom on exhaust, thrusters, trail head and trajectory (additive blending, `globalCompositeOperation = "lighter"`); exhaust as a particle system (pooled, fixed cap ~400) with velocity inheritance and fade; dust plume kicked up by exhaust near the surface.
- Parallax starfield + soft earth/horizon glow, layered procedural terrain with pad lights pulsing; subtle film grain/vignette overlay.
- Projected-touchdown marker: animated reticle that snaps and flashes amber/red when the prediction misses the zone or exceeds speed limits; live "miss distance" label.
- Fault moment: screen-edge red pulse, brief camera shake, sparks from the failed thruster, thruster glyph flicker → dead; a "FAULT DETECTED · RIGHT_PUSH" banner slides in, and the projection line visibly swings to the new miss point.
- Claude's command visualised: when a maneuver is chosen, a ghost of its predicted arc draws in (dashed cyan, stroke-dash animation) before the burn executes; thrust-vector gimbal arc shows commanded angle.
- Touchdown: slow-mo for the last ~1.5 s, contact flash + dust burst, then an outcome sequence (LANDED = cyan confirmation ring and tally; MISSED = amber offset ruler to zone edge; CRASHED = red debris particles).

**HUD / panels**
- Glass-style panels (translucent near-black, 1 px hairline border, backdrop blur, tiny corner ticks) — dense and compact, not big cards.
- Animated numerics (tabular mono, eased count, colour-shifting amber/red as limits approach), vertical-speed tape/gauge with the safe band shaded, fuel bar with burn-rate readout, mini attitude/thrust-vector dial.
- Agent panel: "thinking" scanner animation during AWAITING_DECISION, streaming-style reveal of the one-line summary, tool-call chips (`read_telemetry` → `predict_trajectory` → `execute_maneuver`) that light up in sequence with latency timers; event log with typed icons, colour-coded severity, auto-scroll that pauses on manual scroll.
- Mission timeline strip along the bottom: maneuvers as blocks on a time axis, fault marker as a red flag, current time cursor.
- Smooth state transitions (150–250 ms), subtle sounds are optional (muted by default, cut if tight), `prefers-reduced-motion` respected.
- Performance: 60 fps target on a laptop; offscreen-cached static layers (stars, terrain), pooled particles, DPR-aware canvas, no per-frame allocations in the hot path.

**Honesty guard:** all effects are cosmetic layers over the real sim state. Slow-mo and camera shake must never alter simulation steps, outcomes, or timing of decisions.

**Cut order for UX** (if time runs out): sounds → film grain → timeline strip → dust plume → slow-mo. Keep: camera follow/zoom, glow + exhaust particles, fault moment, animated outcome overlay.

## 5. Verification

Automated (`npm test`, node:test):
- Coast: after t s with no thrust, `vy ≈ vy0 − 1.62t` and `y` matches within tolerance.
- Thrust direction: angle 0 → ax=0, ay>0; +15° → ax>0; LEFT_PUSH → ax<0; RIGHT_PUSH → ax>0.
- Bounds: throttle 1.5, angle 30, duration 10, unknown lateral → rejected by validator.
- Fuel: burn until empty → fuel never < 0, accel equals pure gravity afterwards.
- Failed thruster: RIGHT_PUSH failed → ax contribution 0, no fuel used for it.
- Touchdown: safe inside zone → LANDED; vy −3 → CRASHED w/ reason; safe speeds, foot outside zone → MISSED_ZONE.
- Ground contact mid-maneuver: 6 s burn that hits ground at 2 s stops at contact.
- Prediction == execution from identical state (bit-identical end state).
- Mission: reset clears faults, bumps epoch, rejects actions from the old epoch; terminal mission rejects maneuvers; second start-ai returns 409.
- Feasibility: a scripted *test-only* manual sequence lands safely in nominal and with RIGHT_PUSH failed at a fixed time (proves the scenario is landable; never used at runtime).

Manual / browser:
- `npm run build` passes. Run `npm run dev`, check manual flight, start/pause/resume/reset, fault injection, error banner with no key, no stale updates after reset.
- With a valid key: run a real Claude mission with a mid-descent fault; record the actual outcome in the summary honestly.

---

## 6. TODO checklist

### Phase 0 — Scaffold (≈5 min)
- [ ] `git init`; create `package.json`, `tsconfig.json`, `vite.config.ts`, `.gitignore`, `.env.example`
- [ ] Install deps; verify `npm run dev` serves a blank page and server answers `/api/config`

### Phase 1 — Simulator + render + manual (0–35 min)
- [ ] `shared/constants.ts`, `shared/types.ts`
- [ ] `shared/sim.ts`: step, runManeuver, predict, ballisticProjection, evaluateTouchdown
- [ ] `tests/sim.test.ts` for physics checks above; make them pass
- [ ] `server/mission.ts`: controller, serial queue, real-time paced execution, epoch, reset
- [ ] `server/index.ts`: SSE + REST endpoints (maneuver, reset, pause/resume, predict, config)
- [ ] Client: SSE subscription, Canvas scene (pad, lander, exhaust, trail), telemetry panel
- [ ] Manual panel (throttle, angle, lateral, duration sliders + Execute / Preview), reset button
- [ ] Outcome overlay with exact numbers and reasons

### Phase 2 — Claude integration (35–70 min)
- [ ] Check current Anthropic SDK + model IDs via `claude-api` skill
- [ ] `server/tools.ts`: schemas + validators + handlers (shared with manual path)
- [ ] `server/prompt.ts`: system prompt from constants
- [ ] `server/agent.ts`: bounded loop, retries, budget, abort on epoch change, nudges
- [ ] `/api/mission/start-ai`; duplicate-start protection
- [ ] UI: agent status, last command, tool calls/results + summaries in event log, error banner, missing-key setup message

### Phase 3 — Fault, prediction, pause (70–95 min)
- [ ] Fault endpoint: queued, applied at step boundary, logged with sim time, real capability change
- [ ] Thruster health panel + red failed-thruster visuals
- [ ] Ballistic projection line + projected touchdown marker (recomputed on every state update)
- [ ] Draw Claude's latest `predict_trajectory` as dashed path; legend
- [ ] Pause/resume during execution and during decision wait
- [ ] `tests/mission.test.ts` (reset/epoch/terminal/duplicate start/fault)

### Phase 4 — Tune, verify, polish (95–120 min)
- [ ] UX wow pass per section 4b (camera, bloom, particles, fault moment, outcome sequence); budget UX from Phase 1 so this is polish, not first build
- [ ] Tune constants so the test-only scripted landing works nominal **and** with fault at ~t=12 s; keep margins reasonable
- [ ] Real Claude run(s) with fault; note outcome honestly; adjust prompt clarity only (never the evaluator)
- [ ] Visual polish: stars, terrain silhouette, typography, control disabled states
- [ ] `npm run build` + `npm test` green
- [ ] README.md (install, run, physics simplifications, sign conventions, controls, API setup)
- [ ] DEMO.md (2-minute presenter script + fallback if API fails)
- [ ] Implementation summary: checks run, tested vs untested behaviour, limitations

### Cut list if time is tight (in order)
camera zoom → terrain detail → prediction drawing for manual mode → transcript endpoint → keyboard controls.
Never cut: simulator, real Claude control, one genuine fault, honest outcome reporting.
