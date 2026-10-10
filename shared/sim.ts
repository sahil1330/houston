import {
  BALLISTIC_CAP_S,
  BOUNDS,
  DT,
  FOOTPRINT_HALF_WIDTH,
  GRAVITY,
  LATERAL_ACCEL,
  LATERAL_FUEL_RATE,
  MAIN_FUEL_RATE,
  MAIN_MAX_ACCEL,
  MAIN_MAX_ANGLE_DEG,
  MAX_COAST_AFTER,
  MAX_DURATION,
  MIN_DURATION,
  SAFE_VX,
  SAFE_VY,
  SAMPLE_EVERY_STEPS,
  START,
  ZONE,
} from "./constants.js";
import type {
  Action,
  LanderState,
  Lateral,
  Point,
  Prediction,
  ThrusterName,
  Touchdown,
} from "./types.js";

const DEG = Math.PI / 180;

export function initialState(): LanderState {
  return {
    t: 0,
    x: START.x,
    y: START.y,
    vx: START.vx,
    vy: START.vy,
    fuel: START.fuel,
    failed: { LEFT_PUSH: false, RIGHT_PUSH: false },
    status: "FLYING",
    touchdown: null,
  };
}

export function cloneState(s: LanderState): LanderState {
  return {
    ...s,
    failed: { ...s.failed },
    touchdown: s.touchdown ? { ...s.touchdown, reasons: [...s.touchdown.reasons] } : null,
  };
}

export const COAST: Action = { throttle: 0, angleDeg: 0, lateral: "NONE", durationS: 1 };

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Number of fixed steps a maneuver of this duration runs for. */
export function stepsFor(durationS: number): number {
  return Math.max(1, Math.round(durationS / DT));
}

export function isTerminal(s: LanderState): boolean {
  return s.status !== "FLYING";
}

type Control = Pick<Action, "throttle" | "angleDeg" | "lateral">;

/** Acceleration actually produced this step (used by step and tests). */
export function thrustAccel(
  s: LanderState,
  a: Control,
  dt: number,
): { ax: number; ay: number; fuelUsed: number } {
  const throttle = clamp(a.throttle, 0, 1);
  const angle = clamp(a.angleDeg, -MAIN_MAX_ANGLE_DEG, MAIN_MAX_ANGLE_DEG) * DEG;
  const latActive = a.lateral !== "NONE" && !s.failed[a.lateral as ThrusterName];

  let demand = MAIN_FUEL_RATE * throttle * dt + (latActive ? LATERAL_FUEL_RATE * dt : 0);
  let scale = 1;
  if (s.fuel <= 0) scale = 0;
  else if (demand > s.fuel) scale = s.fuel / demand;
  demand *= scale;

  const T = MAIN_MAX_ACCEL * throttle * scale;
  let ax = T * Math.sin(angle);
  const ay = T * Math.cos(angle);
  if (latActive) {
    ax += (a.lateral === "RIGHT_PUSH" ? 1 : -1) * LATERAL_ACCEL * scale;
  }
  return { ax, ay, fuelUsed: demand };
}

/**
 * Advance one fixed step in place. Semi-implicit Euler. Ground contact is
 * detected inside the step and the contact point interpolated.
 */
export function step(s: LanderState, a: Control, dt: number = DT): void {
  if (s.status !== "FLYING") return;
  const { ax, ay, fuelUsed } = thrustAccel(s, a, dt);
  s.fuel = Math.max(0, s.fuel - fuelUsed);
  s.vx += ax * dt;
  s.vy += (ay - GRAVITY) * dt;
  const ny = s.y + s.vy * dt;
  if (ny <= 0) {
    const frac = s.y / (s.y - ny); // 0..1 within this step
    s.x += s.vx * dt * frac;
    s.t += dt * frac;
    s.y = 0;
    s.touchdown = evaluateTouchdown(s);
    s.status = s.touchdown.outcome;
    return;
  }
  s.x += s.vx * dt;
  s.y = ny;
  s.t += dt;
  if (Math.abs(s.x) > BOUNDS.maxAbsX || s.y > BOUNDS.maxY) {
    s.status = "LOST";
    s.touchdown = {
      outcome: "LOST",
      x: s.x,
      vx: s.vx,
      vy: s.vy,
      fuel: s.fuel,
      t: s.t,
      footMin: s.x - FOOTPRINT_HALF_WIDTH,
      footMax: s.x + FOOTPRINT_HALF_WIDTH,
      reasons: ["Lander left the operating area without touching down."],
    };
  }
}

export function evaluateTouchdown(s: LanderState): Touchdown {
  const footMin = s.x - FOOTPRINT_HALF_WIDTH;
  const footMax = s.x + FOOTPRINT_HALF_WIDTH;
  const reasons: string[] = [];
  const f = (n: number) => n.toFixed(2);
  const vyBad = Math.abs(s.vy) > SAFE_VY;
  const vxBad = Math.abs(s.vx) > SAFE_VX;
  const inZone = footMin >= ZONE.min && footMax <= ZONE.max;
  if (vyBad)
    reasons.push(`Vertical speed ${f(Math.abs(s.vy))} m/s exceeds the ${f(SAFE_VY)} m/s limit.`);
  if (vxBad)
    reasons.push(`Horizontal speed ${f(Math.abs(s.vx))} m/s exceeds the ${f(SAFE_VX)} m/s limit.`);
  if (!inZone) {
    const off =
      footMax > ZONE.max ? footMax - ZONE.max : footMin < ZONE.min ? ZONE.min - footMin : 0;
    reasons.push(
      `Footprint [${f(footMin)}, ${f(footMax)}] m is outside the landing zone [${ZONE.min}, ${ZONE.max}] m by ${f(off)} m.`,
    );
  }
  let outcome: Touchdown["outcome"];
  if (vyBad || vxBad) outcome = "CRASHED";
  else if (!inZone) outcome = "MISSED_ZONE";
  else {
    outcome = "LANDED";
    reasons.push(
      `Touchdown at ${f(s.vy)} m/s vertical, ${f(s.vx)} m/s horizontal, inside the landing zone.`,
    );
  }
  return { outcome, x: s.x, vx: s.vx, vy: s.vy, fuel: s.fuel, t: s.t, footMin, footMax, reasons };
}

function toPoint(s: LanderState, phase: Point["phase"]): Point {
  return { t: s.t, x: s.x, y: s.y, vx: s.vx, vy: s.vy, phase };
}

export interface ManeuverRun {
  state: LanderState;
  points: Point[];
  steps: number;
  contact: boolean;
}

/** Synchronous maneuver on a *copy* of the state. Same `step` as live execution. */
export function runManeuver(
  start: LanderState,
  action: Action,
  phase: Point["phase"] = "controlled",
): ManeuverRun {
  const s = cloneState(start);
  const n = stepsFor(action.durationS);
  const points: Point[] = [toPoint(s, phase)];
  let i = 0;
  for (; i < n && s.status === "FLYING"; i++) {
    step(s, action);
    if ((i + 1) % SAMPLE_EVERY_STEPS === 0 || s.status !== "FLYING") points.push(toPoint(s, phase));
  }
  return { state: s, points, steps: i, contact: s.status !== "FLYING" };
}

/**
 * Controlled maneuver (optionally followed by a zero-thrust coast) on a cloned
 * state. Existing faults are assumed to persist. Never mutates the mission.
 */
export function predict(start: LanderState, action: Action, coastAfterS = 0): Prediction {
  const first = runManeuver(start, action, "controlled");
  let points = first.points;
  let s = first.state;
  const coastS = clamp(coastAfterS, 0, MAX_COAST_AFTER);
  let coastRan = 0;
  if (s.status === "FLYING" && coastS > 0) {
    const second = runManeuver(s, { ...COAST, durationS: coastS }, "ballistic");
    points = points.concat(second.points.slice(1));
    s = second.state;
    coastRan = second.steps * DT;
  }
  const contact = s.status !== "FLYING";
  return {
    kind: "controlled+ballistic",
    points,
    horizonS: first.steps * DT + coastRan,
    controlledS: first.steps * DT,
    contact,
    horizonEndedBeforeTouchdown: !contact,
    end: { t: s.t, x: s.x, y: s.y, vx: s.vx, vy: s.vy, fuel: s.fuel },
    touchdown: s.touchdown,
    assumesFaults: { ...start.failed },
  };
}

/** Zero-thrust projection to ground contact (capped). Same integrator. */
export function ballisticProjection(start: LanderState): Prediction {
  const s = cloneState(start);
  const points: Point[] = [toPoint(s, "ballistic")];
  const maxSteps = Math.round(BALLISTIC_CAP_S / DT);
  let i = 0;
  for (; i < maxSteps && s.status === "FLYING"; i++) {
    step(s, COAST);
    if ((i + 1) % (SAMPLE_EVERY_STEPS * 2) === 0 || s.status !== "FLYING")
      points.push(toPoint(s, "ballistic"));
  }
  const contact = s.status !== "FLYING";
  return {
    kind: "ballistic",
    points,
    horizonS: s.t - start.t,
    controlledS: 0,
    contact,
    horizonEndedBeforeTouchdown: !contact,
    end: { t: s.t, x: s.x, y: s.y, vx: s.vx, vy: s.vy, fuel: s.fuel },
    touchdown: s.touchdown,
    assumesFaults: { ...start.failed },
  };
}

// ---- Validation (shared by REST manual path and Claude tool path) ----

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

const LATERALS: Lateral[] = ["NONE", "LEFT_PUSH", "RIGHT_PUSH"];

export function validateAction(input: unknown): ValidationResult<Action> {
  if (typeof input !== "object" || input === null)
    return { ok: false, error: "Input must be an object." };
  const o = input as Record<string, unknown>;
  const need = (k: string): number | string => {
    const v = o[k];
    return typeof v === "number" && Number.isFinite(v) ? v : `${k} must be a finite number.`;
  };
  const throttle = need("throttle");
  if (typeof throttle === "string") return { ok: false, error: throttle };
  const angleDeg = need("angle_deg");
  if (typeof angleDeg === "string") return { ok: false, error: angleDeg };
  const durationS = need("duration_s");
  if (typeof durationS === "string") return { ok: false, error: durationS };
  const lateral = (o["lateral"] ?? "NONE") as Lateral;
  if (!LATERALS.includes(lateral))
    return { ok: false, error: `lateral must be one of ${LATERALS.join(", ")}.` };
  if (throttle < 0 || throttle > 1) return { ok: false, error: "throttle must be within 0..1." };
  if (angleDeg < -MAIN_MAX_ANGLE_DEG || angleDeg > MAIN_MAX_ANGLE_DEG)
    return {
      ok: false,
      error: `angle_deg must be within -${MAIN_MAX_ANGLE_DEG}..${MAIN_MAX_ANGLE_DEG}.`,
    };
  if (durationS < MIN_DURATION || durationS > MAX_DURATION)
    return { ok: false, error: `duration_s must be within ${MIN_DURATION}..${MAX_DURATION}.` };
  return { ok: true, value: { throttle, angleDeg, lateral, durationS } };
}

export function validateCoast(input: unknown): ValidationResult<number> {
  if (input === undefined || input === null) return { ok: true, value: 0 };
  if (typeof input !== "number" || !Number.isFinite(input))
    return { ok: false, error: "coast_after_s must be a finite number." };
  if (input < 0 || input > MAX_COAST_AFTER)
    return { ok: false, error: `coast_after_s must be within 0..${MAX_COAST_AFTER}.` };
  return { ok: true, value: input };
}
