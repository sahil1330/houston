import { test } from "node:test";
import assert from "node:assert/strict";
import { Mission } from "../server/mission.js";
import { runTool } from "../server/tools.js";
import type { Action } from "../shared/types.js";

const mk = (agentAvailable = true) =>
  new Mission({ simSpeed: 4, model: "test-model", agentAvailable });
const burn = (o: Partial<Action> = {}): Action => ({
  throttle: 0,
  angleDeg: 0,
  lateral: "NONE",
  durationS: 0.5,
  ...o,
});

test("fault injection changes simulator capability and is logged", () => {
  const m = mk();
  try {
    assert.equal(m.injectFault("RIGHT_PUSH").ok, true);
    assert.equal(m.state.failed.RIGHT_PUSH, true);
    assert.ok(m.log.some((l) => l.kind === "fault" && /RIGHT_PUSH FAILED/.test(l.text)));
    assert.equal(m.injectFault("RIGHT_PUSH").ok, false, "cannot fail twice");
  } finally {
    m.dispose();
  }
});

test("maneuver executes through the real integrator and respects busy state", async () => {
  const m = mk();
  try {
    const t0 = m.state.t;
    const a = m.startManeuver(burn(), "MANUAL");
    assert.ok(a.ok);
    const b = m.startManeuver(burn(), "MANUAL");
    assert.equal(b.ok, false, "no concurrent maneuvers");
    const res = await (a as Extract<typeof a, { ok: true }>).done;
    assert.ok(res.ok);
    assert.ok(Math.abs(m.state.t - t0 - 0.5) < 1e-6);
    assert.ok(m.state.vy < -10, "gravity accelerated the coast");
  } finally {
    m.dispose();
  }
});

test("fault injected mid-maneuver is reported in that maneuver's result", async () => {
  const m = mk();
  try {
    const s = m.startManeuver(burn({ lateral: "RIGHT_PUSH", durationS: 1 }), "MANUAL");
    assert.ok(s.ok);
    setTimeout(() => m.injectFault("RIGHT_PUSH"), 30);
    const res = await (s as Extract<typeof s, { ok: true }>).done;
    assert.ok(res.ok && res.events.length === 1);
  } finally {
    m.dispose();
  }
});

test("reset clears faults, terminates the in-flight run and bumps the epoch", async () => {
  const m = mk();
  try {
    m.injectFault("LEFT_PUSH");
    const e0 = m.epoch;
    const s = m.startManeuver(burn({ durationS: 5 }), "MANUAL");
    assert.ok(s.ok);
    m.reset();
    const res = await (s as Extract<typeof s, { ok: true }>).done;
    assert.equal(res.ok, false);
    assert.equal(m.epoch, e0 + 1);
    assert.equal(m.state.failed.LEFT_PUSH, false);
    assert.equal(m.faultLog.length, 0);
    assert.equal(m.state.t, 0);
    // Stale-epoch actions (e.g. an old agent loop) are discarded.
    const stale = m.startManeuver(burn(), "MANUAL", { epoch: e0 });
    assert.equal(stale.ok, false);
  } finally {
    m.dispose();
  }
});

test("terminal mission rejects further actions", async () => {
  const m = mk();
  try {
    m.state.y = 1;
    m.state.vy = -20;
    const s = m.startManeuver(burn({ durationS: 2 }), "MANUAL");
    assert.ok(s.ok);
    const res = await (s as Extract<typeof s, { ok: true }>).done;
    assert.ok(res.ok && res.contact);
    assert.equal(m.state.status, "CRASHED");
    assert.equal(m.startManeuver(burn(), "MANUAL").ok, false);
    assert.equal(m.injectFault("LEFT_PUSH").ok, false);
    assert.equal(m.phase(), "CRASHED");
  } finally {
    m.dispose();
  }
});

test("only one agent loop may control a mission; reset frees the slot", () => {
  const m = mk();
  try {
    const a = m.beginAgent();
    assert.ok(a.ok);
    assert.equal(m.beginAgent().ok, false);
    // Manual commands are locked out while Claude is in control.
    assert.equal(m.startManeuver(burn(), "MANUAL").ok, false);
    m.reset();
    assert.equal((a as { signal: AbortSignal }).signal.aborted, true);
    assert.ok(m.beginAgent().ok);
  } finally {
    m.dispose();
  }
});

test("AI cannot start without credentials and is never mocked", () => {
  const m = new Mission({
    simSpeed: 4,
    model: "x",
    agentAvailable: false,
    setupMessage: "no key",
  });
  try {
    const r = m.beginAgent();
    assert.equal(r.ok, false);
    assert.equal(m.mode, "MANUAL");
  } finally {
    m.dispose();
  }
});

test("tool layer validates input and predicts without mutating", async () => {
  const m = mk();
  try {
    const bad = await runTool(m, m.epoch, "execute_maneuver", { throttle: 3, angle_deg: 0, lateral: "NONE", duration_s: 1 });
    assert.equal(bad.isError, true);
    const before = JSON.stringify(m.state);
    const p = await runTool(m, m.epoch, "predict_trajectory", {
      throttle: 0.5, angle_deg: 5, lateral: "NONE", duration_s: 2, coast_after_s: 5,
    });
    assert.equal(p.isError, false);
    assert.equal(JSON.stringify(m.state), before);
    assert.equal(JSON.parse(p.content).horizon_ended_before_touchdown, true);
    const t = JSON.parse((await runTool(m, m.epoch, "read_telemetry", {})).content);
    assert.equal(t.thrusters.RIGHT_PUSH, "OK");
    m.injectFault("RIGHT_PUSH");
    const t2 = JSON.parse((await runTool(m, m.epoch, "read_telemetry", {})).content);
    assert.match(t2.thrusters.RIGHT_PUSH, /FAILED/);
    assert.equal((await runTool(m, m.epoch, "nope", {})).isError, true);
  } finally {
    m.dispose();
  }
});

test("pause holds integration; resume continues", async () => {
  const m = mk();
  try {
    const s = m.startManeuver(burn({ durationS: 1 }), "MANUAL");
    assert.ok(s.ok);
    await new Promise((r) => setTimeout(r, 40));
    m.pause();
    const t = m.state.t;
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(m.state.t, t, "no steps while paused");
    assert.equal(m.phase(), "PAUSED");
    m.resume();
    const res = await (s as Extract<typeof s, { ok: true }>).done;
    assert.ok(res.ok);
  } finally {
    m.dispose();
  }
});
