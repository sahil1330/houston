import type Anthropic from "@anthropic-ai/sdk";
import {
  AGENT_LIMITS,
  FOOTPRINT_HALF_WIDTH,
  GRAVITY,
  LATERAL_ACCEL,
  MAIN_MAX_ACCEL,
  MAIN_MAX_ANGLE_DEG,
  MAX_COAST_AFTER,
  MAX_DURATION,
  MIN_DURATION,
  SAFE_VX,
  SAFE_VY,
  ZONE,
} from "../shared/constants.js";
import { ballisticProjection, validateAction, validateCoast } from "../shared/sim.js";
import type { Point, Prediction, Touchdown } from "../shared/types.js";
import type { Mission } from "./mission.js";

const r = (n: number, d = 2) => Number(n.toFixed(d));

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "read_telemetry",
    description:
      "Return the authoritative current state: position, velocity, altitude, fuel, thruster health, known faults, engine limits, landing-zone bounds, mission status, and a ballistic (zero-thrust) projection of the touchdown point. Does not change the mission.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "predict_trajectory",
    description: `Simulate a proposed maneuver on a COPY of the state (same integrator as real execution), optionally followed by a zero-thrust coast, and return a sampled trajectory. Does not change the mission. Reports whether ground contact occurs within the horizon; if it does not, horizon_ended_before_touchdown is true. Currently failed thrusters are assumed to stay failed.`,
    input_schema: {
      type: "object",
      properties: {
        throttle: { type: "number", minimum: 0, maximum: 1, description: "Main engine throttle, 0..1." },
        angle_deg: {
          type: "number",
          minimum: -MAIN_MAX_ANGLE_DEG,
          maximum: MAIN_MAX_ANGLE_DEG,
          description: "Thrust-vector angle in degrees. 0 = straight up, positive adds rightward (+x) thrust.",
        },
        lateral: {
          type: "string",
          enum: ["NONE", "LEFT_PUSH", "RIGHT_PUSH"],
          description: "Lateral thruster to fire, named by force direction.",
        },
        duration_s: { type: "number", minimum: MIN_DURATION, maximum: MAX_DURATION, description: "Controlled burn duration in seconds." },
        coast_after_s: {
          type: "number",
          minimum: 0,
          maximum: MAX_COAST_AFTER,
          description: "Optional zero-thrust coast appended after the burn, to look further ahead. Default 0.",
        },
      },
      required: ["throttle", "angle_deg", "lateral", "duration_s"],
      additionalProperties: false,
    },
  },
  {
    name: "execute_maneuver",
    description:
      "Apply a main-engine throttle, thrust-vector angle and optional lateral thruster for a bounded duration in the REAL simulation. Returns the resulting telemetry, fuel used, any fault events during the burn, and whether ground contact occurred. Zero throttle with lateral NONE is a coast. Stops early on ground contact.",
    input_schema: {
      type: "object",
      properties: {
        throttle: { type: "number", minimum: 0, maximum: 1, description: "Main engine throttle, 0..1." },
        angle_deg: {
          type: "number",
          minimum: -MAIN_MAX_ANGLE_DEG,
          maximum: MAIN_MAX_ANGLE_DEG,
          description: "Thrust-vector angle in degrees. 0 = straight up, positive adds rightward (+x) thrust.",
        },
        lateral: {
          type: "string",
          enum: ["NONE", "LEFT_PUSH", "RIGHT_PUSH"],
          description: "Lateral thruster to fire, named by force direction.",
        },
        duration_s: { type: "number", minimum: MIN_DURATION, maximum: MAX_DURATION, description: "Burn duration in seconds." },
        summary: {
          type: "string",
          description: "One short sentence (<=140 chars) describing the intent of this maneuver, shown to the audience.",
        },
      },
      required: ["throttle", "angle_deg", "lateral", "duration_s"],
      additionalProperties: false,
    },
  },
];

function tdJson(t: Touchdown | null) {
  if (!t) return null;
  return {
    outcome: t.outcome,
    x_m: r(t.x),
    vx_mps: r(t.vx),
    vy_mps: r(t.vy),
    fuel_left: r(t.fuel, 1),
    foot_span_m: [r(t.footMin), r(t.footMax)],
    reasons: t.reasons,
  };
}

function thrusterHealth(m: Mission) {
  return {
    MAIN_ENGINE: "OK",
    LEFT_PUSH: m.state.failed.LEFT_PUSH ? "FAILED (zero force)" : "OK",
    RIGHT_PUSH: m.state.failed.RIGHT_PUSH ? "FAILED (zero force)" : "OK",
  };
}

export function telemetry(m: Mission) {
  const s = m.state;
  const proj = ballisticProjection(s);
  return {
    mission_status: s.status,
    sim_time_s: r(s.t),
    position_m: { x: r(s.x), y: r(s.y) },
    altitude_m: r(s.y),
    velocity_mps: { vx: r(s.vx), vy: r(s.vy) },
    fuel_units: r(s.fuel, 1),
    thrusters: thrusterHealth(m),
    known_faults: m.faultLog,
    landing_zone: {
      x_min_m: ZONE.min,
      x_max_m: ZONE.max,
      footprint_half_width_m: FOOTPRINT_HALF_WIDTH,
      safe_center_x_range_m: [ZONE.min + FOOTPRINT_HALF_WIDTH, ZONE.max - FOOTPRINT_HALF_WIDTH],
      center_offset_to_zone_middle_m: r((ZONE.min + ZONE.max) / 2 - s.x),
    },
    safe_touchdown: { max_abs_vy_mps: SAFE_VY, max_abs_vx_mps: SAFE_VX },
    engine_limits: {
      gravity_mps2: GRAVITY,
      main_max_accel_mps2: MAIN_MAX_ACCEL,
      angle_range_deg: [-MAIN_MAX_ANGLE_DEG, MAIN_MAX_ANGLE_DEG],
      lateral_accel_mps2: LATERAL_ACCEL,
      duration_range_s: [MIN_DURATION, MAX_DURATION],
    },
    ballistic_projection_no_thrust: {
      note: "Where the lander lands if it coasts from now with zero thrust.",
      contact: proj.contact,
      time_to_touchdown_s: proj.contact ? r(proj.end.t - s.t) : null,
      touchdown: tdJson(proj.touchdown),
    },
    budget_remaining: {
      tool_calls: Math.max(0, AGENT_LIMITS.maxToolCalls - m.agent.toolCalls),
      maneuvers: Math.max(0, AGENT_LIMITS.maxManeuvers - m.agent.maneuvers),
    },
  };
}

function subsample(points: Point[], max: number): Point[] {
  if (points.length <= max) return points;
  const out: Point[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round((i * (points.length - 1)) / (max - 1))]!);
  return out;
}

function predictionJson(p: Prediction) {
  return {
    description:
      "Controlled burn" +
      (p.points.some((q) => q.phase === "ballistic") ? " followed by a zero-thrust (ballistic) coast." : "."),
    assumes_failed_thrusters_stay_failed: p.assumesFaults,
    controlled_duration_s: r(p.controlledS),
    horizon_s: r(p.horizonS),
    ground_contact_within_horizon: p.contact,
    horizon_ended_before_touchdown: p.horizonEndedBeforeTouchdown,
    end_state: {
      t_s: r(p.end.t),
      x_m: r(p.end.x),
      y_m: r(p.end.y),
      vx_mps: r(p.end.vx),
      vy_mps: r(p.end.vy),
      fuel_units: r(p.end.fuel, 1),
    },
    touchdown_if_any: tdJson(p.touchdown),
    samples: subsample(p.points, 14).map((q) => ({
      t_s: r(q.t),
      x_m: r(q.x),
      y_m: r(q.y),
      vx_mps: r(q.vx),
      vy_mps: r(q.vy),
      phase: q.phase,
    })),
  };
}

export interface ToolOutcome {
  content: string;
  isError: boolean;
  /** One-line, human-readable result for the on-screen log. */
  display: string;
}

const err = (msg: string): ToolOutcome => ({
  content: JSON.stringify({ error: msg }),
  isError: true,
  display: `error: ${msg}`,
});
const ok = (obj: unknown, display: string): ToolOutcome => ({
  content: JSON.stringify(obj),
  isError: false,
  display,
});

/** Execute one tool call against the mission. Validates all inputs server-side. */
export async function runTool(
  m: Mission,
  epoch: number,
  name: string,
  input: unknown,
): Promise<ToolOutcome> {
  switch (name) {
    case "read_telemetry": {
      const t = telemetry(m);
      return ok(
        t,
        `y ${t.altitude_m} m · vx ${t.velocity_mps.vx} · vy ${t.velocity_mps.vy} · fuel ${t.fuel_units} · ballistic→x ${t.ballistic_projection_no_thrust.touchdown?.x_m ?? "n/a"}`,
      );
    }
    case "predict_trajectory": {
      const v = validateAction(input);
      if (!v.ok) return err(v.error);
      const c = validateCoast((input as Record<string, unknown>)["coast_after_s"]);
      if (!c.ok) return err(c.error);
      const p = m.previewPrediction(v.value, c.value);
      m.setPrediction(p, "AI", epoch);
      const body = predictionJson(p);
      const disp = p.contact
        ? `contact at x ${r(p.end.x)} m, vx ${r(p.end.vx)}, vy ${r(p.end.vy)} → ${p.touchdown?.outcome}`
        : `no contact within ${r(p.horizonS)} s horizon · end y ${r(p.end.y)} m, x ${r(p.end.x)} m`;
      return ok(body, disp);
    }
    case "execute_maneuver": {
      const v = validateAction(input);
      if (!v.ok) return err(v.error);
      const raw = (input as Record<string, unknown>)["summary"];
      const summary = typeof raw === "string" ? raw.slice(0, 200) : undefined;
      const started = m.startManeuver(v.value, "AI", { summary, epoch });
      if (!started.ok) return err(started.error);
      m.setAgent({ state: "EXECUTING", currentTool: "execute_maneuver" }, epoch);
      const fuelBefore = m.state.fuel;
      const res = await started.done;
      if (!res.ok) return err(res.error);
      const t = telemetry(m);
      const body = {
        executed: {
          requested_duration_s: v.value.durationS,
          simulated_duration_s: r(res.endT - res.startT),
          stopped_early_by_ground_contact: res.contact && res.stepsRun < res.stepsRequested,
          throttle: v.value.throttle,
          angle_deg: v.value.angleDeg,
          lateral: v.value.lateral,
          lateral_had_effect: v.value.lateral === "NONE" ? null : !res.state.failed[v.value.lateral],
        },
        fuel_used: r(fuelBefore - res.state.fuel, 2),
        fault_events_during_burn: res.events,
        ground_contact: res.contact,
        touchdown: tdJson(res.state.touchdown),
        telemetry: t,
      };
      const disp = res.contact
        ? `TOUCHDOWN ${res.state.touchdown?.outcome} at x ${r(res.state.x)} m, vx ${r(res.state.vx)}, vy ${r(res.state.vy)}`
        : `now y ${r(res.state.y)} m, x ${r(res.state.x)} m, vx ${r(res.state.vx)}, vy ${r(res.state.vy)}, fuel ${r(res.state.fuel, 1)}` +
          (res.events.length ? ` · ${res.events.length} fault event(s)` : "");
      return ok(body, disp);
    }
    default:
      return err(`Unknown tool "${name}".`);
  }
}
