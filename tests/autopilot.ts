// TEST-ONLY scripted pilot. Proves the scenario is landable by hand-written
// feedback control, before and after a thruster fault. It is never imported by
// the server or client; the app never substitutes it for Claude.
import { DT, GRAVITY, MAIN_MAX_ACCEL, MAIN_MAX_ANGLE_DEG, SAFE_VX, ZONE } from "../shared/constants.js";
import { clamp, initialState, step } from "../shared/sim.js";
import type { Action, LanderState } from "../shared/types.js";

export function decide(s: LanderState): Action {
  const target = (ZONE.min + ZONE.max) / 2;
  const dx = target - s.x;
  // Horizontal: aim for a speed proportional to remaining distance, tapered near the ground.
  const taper = clamp((s.y - 3) / 70, 0, 1);
  const vxDes = clamp(dx * 0.12, -10, 10) * taper;
  const ex = vxDes - s.vx;
  const angleDeg = clamp(ex * 6, -MAIN_MAX_ANGLE_DEG, MAIN_MAX_ANGLE_DEG);
  // Vertical: brake along a constant-deceleration profile, soft final approach.
  const aBrake = 0.7;
  const vyDes = -Math.max(0.9, Math.sqrt(2 * aBrake * Math.max(0, s.y - 2)));
  const ey = vyDes - s.vy;
  const cos = Math.cos((angleDeg * Math.PI) / 180);
  const throttle = clamp((GRAVITY + ey * 1.2) / (MAIN_MAX_ACCEL * cos), 0, 1);
  let lateral: Action["lateral"] = "NONE";
  if (Math.abs(ex) > 0.4 && Math.abs(angleDeg) >= MAIN_MAX_ANGLE_DEG * 0.8) {
    const want = ex > 0 ? "RIGHT_PUSH" : "LEFT_PUSH";
    if (!s.failed[want]) lateral = want;
  }
  return { throttle, angleDeg, lateral, durationS: 0.25 };
}

export interface FlightResult {
  state: LanderState;
  faultAt: number | null;
  maxSteps: number;
}

export function fly(faultAtT: number | null, fault: "LEFT_PUSH" | "RIGHT_PUSH" = "RIGHT_PUSH"): FlightResult {
  const s = initialState();
  let faulted = false;
  let i = 0;
  const maxSteps = 120 * 60;
  while (s.status === "FLYING" && i < maxSteps) {
    const a = decide(s);
    const n = Math.round(a.durationS / DT);
    for (let k = 0; k < n && s.status === "FLYING"; k++, i++) {
      if (faultAtT !== null && !faulted && s.t >= faultAtT) {
        s.failed[fault] = true;
        faulted = true;
      }
      step(s, a);
    }
  }
  return { state: s, faultAt: faultAtT, maxSteps };
}

export { SAFE_VX };
