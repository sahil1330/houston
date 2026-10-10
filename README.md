# HOUSTON — AI Mission Control

> Can Claude rescue a spacecraft when its original plan stops working?

A fictional lunar-lander emergency, flown by **Claude through tool calls** inside a deterministic 2D simulation. Mid-descent the presenter disables a thruster; Claude has to read telemetry, notice the fault, and re-plan using the main engine's thrust vectoring. The outcome — safe landing, missed zone, or crash — is whatever the simulator says. There is no autopilot fallback: if Claude fails, you see it fail.

This is an engineering-flavoured simulation, **not** an aerospace simulator.

## Quick start

Requires Node 20+ (developed on Node 24).

```bash
npm install
cp .env.example .env        # then put your key in .env
npm run dev                 # backend :8787 + UI :5173
```

Open <http://localhost:5173>.

| Command | What it does |
|---|---|
| `npm run dev` | Backend (tsx watch) and Vite UI together |
| `npm run build` | Typecheck + production UI build into `dist/` |
| `npm start` | Backend only; also serves `dist/` at <http://127.0.0.1:8787> |
| `npm test` | Simulator, mission-controller and agent-loop tests (Node's built-in runner) |
| `npm run typecheck` | `tsc --noEmit` |

### API setup

Create `.env` (git-ignored) from `.env.example`:

```
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=            # blank → claude-opus-5-5
ANTHROPIC_EFFORT=medium     # low | medium | high — lower is faster per decision
SIM_SPEED=2                 # playback speed of executing maneuvers (0.25–4)
```

The key stays on the server; the browser never sees it. Without a key the app still runs: manual mode works, the AI button is disabled, and a setup banner explains why. Nothing is ever mocked as Claude.

## Controls

| Control | Key | Notes |
|---|---|---|
| Start AI mission | Enter | One agent loop per mission; disabled while one is running |
| Pause / Resume | Space | Freezes integration at a step boundary; the agent waits before its next decision |
| Thruster failure | F | Disables `RIGHT_PUSH` at the next step boundary (real change in simulator capability) |
| Cinema / Sound / Fly | C / M / K |  |
| Reset | R | Terminates the agent loop, clears faults/log, restores the scenario |
| Manual mode | — | Sliders for throttle, thrust angle, lateral thruster, duration; preview and execute through the same code path Claude uses |

Manual controls lock while Claude is in control or a maneuver is executing.

### Extras (all cosmetic or presentation-only — none of them change the physics or the verdict)

| Feature | How |
|---|---|
| **Fly by keyboard** (**K**) | **W/S** throttle, **Q/E** or **←/→** thrust angle, **A/D** side thrusters, **X** cut engine. Time only runs while you fly. Sends back-to-back 0.25 s maneuvers through the same API as Claude |
| **Sliders** | Precise manual burns and trajectory preview |
| **Radio captions** | `CLAUDE` lines are the model's own one-line commentary. `HOUSTON` callouts (altitude, sink rate, touchdown) are scripted from real telemetry thresholds — they are not model output |
| **Master alarm** | Full-screen alarm, red pulse, camera shake and siren when a thruster fails; "Claude re-planning" indicator afterwards |
| **Score and grade** | 500 for a safe landing + up to 250 precision, 150 soft touch, 100 fuel left. Crashes and misses score 0. A Claude-vs-you best score is kept in your browser's localStorage |
| **Playback speed** 1×/2×/4× | Changes only how fast a maneuver animates, never the step sequence |
| **Cinema mode** (**C**) | Hides panels for a full-screen view |
| **Sound** (**M**) | Synthesized engine rumble, thruster hiss, alarm, touchdown/crash stings. No audio files; unlocks on first click or key press |

## Physics and its simplifications

Units: metres, seconds. Fixed integration step **1/60 s**, independent of render rate (semi-implicit Euler).

- **+x is right, +y is up, ground is y = 0.** Gravity is 1.62 m/s² downward.
- **Translation only — no rotation dynamics.** The lander is a point-mass with a footprint; its attitude is not simulated. The main engine's thrust vector is steerable by up to ±10°, which stands in for attitude control. Angle 0 thrusts straight up; **positive angle adds rightward thrust**. Exhaust is drawn along the actual thrust vector.
- Main engine: 4.0 m/s² at full throttle (hover ≈ 41%), fuel 1.2 units/s × throttle.
- Two lateral thrusters named by **force direction**: `LEFT_PUSH` (→ −x) and `RIGHT_PUSH` (→ +x), 0.6 m/s² each, 0.3 fuel units/s while firing. One may be selected per maneuver.
- Fuel starts at 26 units. When it is exhausted there is no thrust at all. Mass is treated as constant.
- A failed thruster produces **zero force and uses no fuel**, even if commanded.
- Maneuvers last 0.25–6 s and stop early on ground contact. Ground contact is detected **inside the step** (the touchdown point is interpolated), not only at the end of a burn.
- Terminal missions (landed, missed, crashed, lost) reject all further actions.

**Safe touchdown** requires all of: |vy| ≤ 2.0 m/s, |vx| ≤ 1.0 m/s, and the whole footprint (centre ± 5 m) inside the landing zone x ∈ [140, 220] m. Speeds too high → `CRASHED`; speeds fine but outside the zone → `MISSED_ZONE`.

**Scenario:** start at x = 0 m, 420 m up, vx = +1, vy = −10 m/s, 26 fuel. A zero-thrust coast lands about 17 m along, and simply holding a hover also drifts only ~40 m — nowhere near the zone at x = 140–220 — so Claude has to actively add more than 110 m of rightward motion. After `RIGHT_PUSH` fails, the main engine's vectoring (≈0.7 m/s² sideways at full throttle and 10°, ≈0.29 m/s² while hovering) is the remaining way to push right. The test suite includes a hand-written feedback pilot that lands the scenario with no fault and with the fault injected at 2, 5, 10, 14 and 18 s, which shows the scenario is feasible (a failure before about T+2 s is not recoverable by that pilot, and fuel margins at the end are thin). That pilot lives only in `tests/` and is never used by the app.

## Architecture

```
shared/   constants, types, the simulator (pure functions) — used by server, client and tests
server/   mission.ts  authoritative state, serial execution, fault/pause/reset, epoch guard
          tools.ts    tool schemas + server-side validation + handlers
          agent.ts    Claude control loop (Anthropic SDK, manual tool-use loop)
          prompt.ts   system prompt generated from the shared constants
          index.ts    HTTP + Server-Sent Events
client/   React + Canvas 2D mission-control UI
tests/    node:test suites
```

- **One authoritative mission** on the backend. Manual and Claude actions use the same `startManeuver` path. Everything mutates on a single thread (integration ticks and API calls interleave only between steps), so there are never two concurrent maneuvers, and fault injection always lands on a step boundary and is logged with sim time and step number.
- **Pause while deciding.** The simulation only advances while a maneuver executes. While Claude thinks, time is frozen. Each maneuver is animated from the real simulated trajectory, paced at `SIM_SPEED`× real time (eased near touchdown — presentation only; the step sequence is unchanged).
- **Reset** bumps an epoch counter, aborts the agent's HTTP request, resolves any in-flight maneuver as aborted, and every late message from the old run is discarded on both server and client.
- Updates stream to the browser over SSE.

### Claude's tools

| Tool | Purpose |
|---|---|
| `read_telemetry` | Authoritative state, thruster health, fault log, engine limits, landing zone, thresholds, and the zero-thrust (ballistic) touchdown projection |
| `predict_trajectory` | Simulates a proposed burn (optionally + a zero-thrust coast, ≤ 30 s) on a **cloned** state with the same integrator; reports whether ground contact occurs and whether the horizon ended before touchdown. Drawn on screen as the dashed "planned maneuver" |
| `execute_maneuver` | Applies throttle / angle / lateral / duration to the real simulation; returns new telemetry, fault events during the burn, fuel used, and touchdown details |

All inputs are validated server-side; invalid calls come back as `is_error` tool results. A zero-throttle, `NONE` maneuver is a coast. The system prompt gives Claude coordinates, units, limits, fuel costs, safe thresholds, the objective, a warning that thrusters can fail at any time, and a budget (45 tool calls, 32 maneuvers, 45 model turns). API errors are retried at most twice (SDK retries), then the mission stops with **AGENT ERROR**. Only Claude's brief visible commentary is shown (one-line summaries, tool calls, results) — never reasoning.

The default model is `claude-opus-5-5` (override with `ANTHROPIC_MODEL`). Thinking is left at the model default, `tool_choice` is `auto`, and `output_config.effort` comes from `ANTHROPIC_EFFORT`.

## Known limitations

- No rotational dynamics or fuel-mass change (see above).
- One scenario, one default fault (`RIGHT_PUSH`).
- Single mission per server process; no persistence across restarts.
- Live-model behaviour depends on the model and effort setting; the simulator never adjusts the outcome. Claude may fail to land, and that is a valid result.
- The scene targets a laptop-size window (≥ ~1280 px wide).
