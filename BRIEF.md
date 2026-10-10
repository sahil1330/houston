# HOUSTON — Original Brief

(The full requirements as pasted by the user are in the session that created PLAN.md. Key non-negotiables, summarised:)

- Lunar lander in a deterministic 2D simulation, controlled by real Claude tool calls in bounded action batches; sim pauses while Claude decides.
- Presenter triggers a lateral-thruster failure mid-descent; it must actually remove that thruster's force. Main-engine thrust vectoring must make recovery physically possible.
- Outcomes (safe landing / missed zone / crash) reported honestly with exact reasons. Never substitute an autopilot for Claude, never label a mock as Claude, never tweak the evaluator to turn a failure into a success.
- Stack: React + TS + Vite, Canvas 2D, small Node/TS backend, official Anthropic SDK, shared TS sim. Minimal deps; no DB/auth/3D/agent framework.
- Env: ANTHROPIC_API_KEY, ANTHROPIC_MODEL (server-side only; .env.example; .env gitignored). Verify model IDs from official docs, don't invent them.
- Sign conventions: +x right, +y up, gravity down, angle 0 = thrust up, +angle = rightward thrust, thrusters named LEFT_PUSH / RIGHT_PUSH by force direction.
- Fixed dt ≤ 1/60 s; enforce bounds, fuel, failed-thruster zero force, terminal state, in-step ground contact; footprint included in zone check.
- Tools: read_telemetry, execute_maneuver, predict_trajectory (same integrator; distinguish ballistic vs controlled; say if horizon ends before touchdown).
- Statuses: awaiting decision, executing, paused, landed, crashed, agent error. Show tool calls, results, short model summaries; no chain-of-thought.
- Sequential state mutations, single agent loop per mission, reset terminates prior run, no stale updates.
- Mission-control visual style: near-black, warm off-white, amber caution, red critical, restrained cyan; compact, thin borders; no purple gradients/giant cards.
- Deliverables: runnable source, .env.example, README, DEMO.md (2-min script), implementation summary with checks run and limitations; one dev command for frontend + backend.
