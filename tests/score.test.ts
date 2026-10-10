import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreTouchdown } from "../shared/score.js";
import { Mission } from "../server/mission.js";
import { evaluateTouchdown, initialState } from "../shared/sim.js";

const td = (x: number, vy: number, vx: number, fuel: number) =>
  evaluateTouchdown({ ...initialState(), y: 0, x, vy, vx, fuel });

test("only safe landings score; crashes and misses score zero", () => {
  assert.equal(scoreTouchdown(td(180, -5, 0, 10)).points, 0);
  assert.equal(scoreTouchdown(td(20, -1, 0, 10)).points, 0);
  assert.equal(scoreTouchdown(null).points, 0);
});

test("better landings score higher; grade follows points", () => {
  const perfect = scoreTouchdown(td(180, -0.1, 0, 26));
  const sloppy = scoreTouchdown(td(150, -1.9, 0.9, 1));
  assert.ok(perfect.points > sloppy.points);
  assert.equal(perfect.grade, "S");
  assert.ok(sloppy.points >= 500, "any safe landing earns the base points");
});

test("playback speed is validated and does not touch the simulation", () => {
  const m = new Mission({ simSpeed: 2, model: "x", agentAvailable: false });
  try {
    const before = JSON.stringify(m.state);
    assert.equal(m.setSpeed(4), true);
    assert.equal(m.setSpeed(0), false);
    assert.equal(m.setSpeed(99), false);
    assert.equal(m.meta().simSpeed, 4);
    assert.equal(JSON.stringify(m.state), before);
  } finally {
    m.dispose();
  }
});

test("pilot counters distinguish Claude from manual maneuvers", () => {
  const m = new Mission({ simSpeed: 4, model: "x", agentAvailable: true });
  try {
    m.startManeuver({ throttle: 0, angleDeg: 0, lateral: "NONE", durationS: 0.25 }, "MANUAL");
    assert.equal(m.meta().manualManeuvers, 1);
    assert.equal(m.meta().aiManeuvers, 0);
    m.reset();
    assert.equal(m.meta().manualManeuvers, 0);
  } finally {
    m.dispose();
  }
});
