import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DT,
  FOOTPRINT_HALF_WIDTH,
  GRAVITY,
  LATERAL_ACCEL,
  MAIN_MAX_ACCEL,
  SAFE_VX,
  SAFE_VY,
  ZONE,
} from "../shared/constants.js";
import {
  COAST,
  ballisticProjection,
  cloneState,
  evaluateTouchdown,
  initialState,
  predict,
  runManeuver,
  step,
  stepsFor,
  thrustAccel,
  validateAction,
} from "../shared/sim.js";
import type { Action, LanderState } from "../shared/types.js";
import { fly } from "./autopilot.js";

const act = (o: Partial<Action> = {}): Action => ({
  throttle: 0,
  angleDeg: 0,
  lateral: "NONE",
  durationS: 1,
  ...o,
});

test("gravity during coast", () => {
  const s = initialState();
  const y0 = s.y;
  const vy0 = s.vy;
  const n = stepsFor(3);
  for (let i = 0; i < n; i++) step(s, COAST);
  const t = n * DT;
  assert.ok(Math.abs(s.vy - (vy0 - GRAVITY * t)) < 1e-9);
  // semi-implicit Euler is within a fraction of a metre of the analytic position
  const exact = y0 + vy0 * t - 0.5 * GRAVITY * t * t;
  assert.ok(Math.abs(s.y - exact) < 0.1);
  assert.equal(s.fuel, initialState().fuel, "coast burns no fuel");
});

test("thrust direction, signs and control bounds", () => {
  const s = initialState();
  const up = thrustAccel(s, act({ throttle: 1 }), DT);
  assert.ok(Math.abs(up.ax) < 1e-12 && Math.abs(up.ay - MAIN_MAX_ACCEL) < 1e-9);
  assert.ok(thrustAccel(s, act({ throttle: 1, angleDeg: 15 }), DT).ax > 0);
  assert.ok(thrustAccel(s, act({ throttle: 1, angleDeg: -15 }), DT).ax < 0);
  assert.ok(Math.abs(thrustAccel(s, act({ lateral: "RIGHT_PUSH" }), DT).ax - LATERAL_ACCEL) < 1e-9);
  assert.ok(Math.abs(thrustAccel(s, act({ lateral: "LEFT_PUSH" }), DT).ax + LATERAL_ACCEL) < 1e-9);
  // Out-of-range values are clamped inside the integrator, never amplified.
  const over = thrustAccel(s, act({ throttle: 5, angleDeg: 90 }), DT);
  const max = thrustAccel(s, act({ throttle: 1, angleDeg: 15 }), DT);
  assert.deepEqual(over, max);
});

test("validator rejects out-of-bounds actions", () => {
  const ok = { throttle: 0.5, angle_deg: 5, lateral: "NONE", duration_s: 2 };
  assert.equal(validateAction(ok).ok, true);
  for (const bad of [
    { ...ok, throttle: 1.5 },
    { ...ok, throttle: -0.1 },
    { ...ok, angle_deg: 30 },
    { ...ok, duration_s: 10 },
    { ...ok, duration_s: 0.01 },
    { ...ok, lateral: "UP" },
    { ...ok, throttle: "1" },
    { ...ok, angle_deg: NaN },
    null,
  ])
    assert.equal(validateAction(bad).ok, false, JSON.stringify(bad));
});

test("fuel exhaustion: fuel never negative, no thrust afterwards", () => {
  const s = initialState();
  s.fuel = 0.5;
  s.y = 2000;
  let guard = 0;
  while (s.fuel > 0 && guard++ < 10000) step(s, act({ throttle: 1 }));
  assert.equal(s.fuel, 0);
  const vy = s.vy;
  step(s, act({ throttle: 1 }));
  assert.ok(Math.abs(s.vy - (vy - GRAVITY * DT)) < 1e-12, "pure gravity once empty");
  assert.equal(thrustAccel(s, act({ throttle: 1, lateral: "RIGHT_PUSH" }), DT).ay, 0);
});

test("failed thruster: zero force, zero fuel; other thruster unaffected", () => {
  const s = initialState();
  s.failed.RIGHT_PUSH = true;
  const dead = thrustAccel(s, act({ lateral: "RIGHT_PUSH" }), DT);
  assert.equal(dead.ax, 0);
  assert.equal(dead.fuelUsed, 0);
  const live = thrustAccel(s, act({ lateral: "LEFT_PUSH" }), DT);
  assert.ok(live.ax < 0 && live.fuelUsed > 0);
  const before = s.fuel;
  step(s, act({ lateral: "RIGHT_PUSH" }));
  assert.equal(s.fuel, before);
});

function touch(patch: Partial<LanderState>): LanderState {
  return { ...initialState(), y: 0, ...patch };
}

test("safe vs unsafe touchdown", () => {
  const cx = (ZONE.min + ZONE.max) / 2;
  assert.equal(evaluateTouchdown(touch({ x: cx, vy: -1.5, vx: 0.5 })).outcome, "LANDED");
  const hard = evaluateTouchdown(touch({ x: cx, vy: -(SAFE_VY + 0.5), vx: 0 }));
  assert.equal(hard.outcome, "CRASHED");
  assert.match(hard.reasons.join(" "), /Vertical speed/);
  assert.equal(evaluateTouchdown(touch({ x: cx, vy: -1, vx: SAFE_VX + 0.2 })).outcome, "CRASHED");
  assert.equal(evaluateTouchdown(touch({ x: 20, vy: -1, vx: 0 })).outcome, "MISSED_ZONE");
});

test("footprint counts: centre inside zone but foot outside is a miss", () => {
  const x = ZONE.max - FOOTPRINT_HALF_WIDTH + 1; // centre inside, right foot 1 m over
  assert.equal(evaluateTouchdown(touch({ x, vy: -1, vx: 0 })).outcome, "MISSED_ZONE");
  const edge = ZONE.max - FOOTPRINT_HALF_WIDTH;
  assert.equal(evaluateTouchdown(touch({ x: edge, vy: -1, vx: 0 })).outcome, "LANDED");
});

test("ground contact is detected mid-maneuver and the run stops", () => {
  const s = initialState();
  s.y = 5;
  s.vy = -10;
  const run = runManeuver(s, act({ durationS: 6 }));
  assert.equal(run.contact, true);
  assert.ok(run.steps * DT < 1, "stopped well before the 6 s burn finished");
  assert.equal(run.state.y, 0);
  assert.equal(run.state.status, "CRASHED");
  const t = run.state.t;
  step(run.state, act({ throttle: 1 }));
  assert.equal(run.state.t, t, "terminal state never advances");
});

test("fast fall cannot tunnel through the ground in one step", () => {
  const s = initialState();
  s.y = 0.01;
  s.vy = -500;
  step(s, COAST);
  assert.equal(s.y, 0);
  assert.notEqual(s.status, "FLYING");
});

test("prediction matches actual execution from identical state", () => {
  const start = initialState();
  start.failed.RIGHT_PUSH = true;
  const a = act({ throttle: 0.6, angleDeg: 12, lateral: "RIGHT_PUSH", durationS: 3.3 });
  const pred = predict(start, a, 0);
  const live = cloneState(start);
  for (let i = 0; i < stepsFor(a.durationS); i++) step(live, a);
  assert.deepEqual(pred.end, {
    t: live.t,
    x: live.x,
    y: live.y,
    vx: live.vx,
    vy: live.vy,
    fuel: live.fuel,
  });
});

test("prediction does not mutate the mission state and flags short horizons", () => {
  const start = initialState();
  const snap = JSON.stringify(start);
  const p = predict(start, act({ throttle: 0.4, durationS: 1 }), 2);
  assert.equal(JSON.stringify(start), snap);
  assert.equal(p.horizonEndedBeforeTouchdown, true);
  assert.equal(p.touchdown, null);
  const long = predict(start, act({ durationS: 6 }), 30);
  assert.equal(long.contact, true);
  assert.equal(long.horizonEndedBeforeTouchdown, false);
  assert.ok(long.points.some((p) => p.phase === "ballistic"));
});

test("ballistic projection equals zero-thrust execution", () => {
  const start = initialState();
  const proj = ballisticProjection(start);
  const s = cloneState(start);
  let guard = 0;
  while (s.status === "FLYING" && guard++ < 100000) step(s, COAST);
  assert.equal(proj.end.x, s.x);
  assert.equal(proj.touchdown?.outcome, s.status);
});

test("scenario is manually landable before the fault", () => {
  const r = fly(null).state;
  assert.equal(r.status, "LANDED", JSON.stringify(r.touchdown));
});

test("scenario is manually landable after the RIGHT_PUSH fault at several times (T+2 s or later)", () => {
  for (const t of [2, 5, 10, 14, 18]) {
    const r = fly(t, "RIGHT_PUSH").state;
    assert.equal(r.status, "LANDED", `fault at ${t}s: ${JSON.stringify(r.touchdown)}`);
  }
});

test("the fault is consequential: a RIGHT_PUSH-reliant plan drifts less after failure", () => {
  const run = (failed: boolean) => {
    const s = initialState();
    s.failed.RIGHT_PUSH = failed;
    const a = act({ throttle: 0.4, lateral: "RIGHT_PUSH", durationS: 6 });
    let n = 0;
    while (s.status === "FLYING" && n++ < 5) Object.assign(s, runManeuver(s, a).state);
    return s;
  };
  assert.ok(run(false).x > run(true).x + 5);
});

test("passive plans fail: holding a hover with the starting drift cannot reach the zone", () => {
  const s = initialState();
  const hover = act({ throttle: 0.405, durationS: 6 });
  let n = 0;
  while (s.status === "FLYING" && n++ < 20) Object.assign(s, runManeuver(s, hover).state);
  assert.notEqual(s.status, "LANDED");
  assert.ok(s.x < 100, `hover-and-drift ended at x=${s.x.toFixed(1)}`);
});
