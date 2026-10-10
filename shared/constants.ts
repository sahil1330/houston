// Single source of truth for physics, scenario and safety thresholds.
// Units: meters, seconds. +x right, +y up. Ground is y = 0.

export const DT = 1 / 60;
export const GRAVITY = 1.62; // m/s^2, downward

export const MAIN_MAX_ACCEL = 4.0; // m/s^2 at throttle 1.0
export const MAIN_MAX_ANGLE_DEG = 10; // thrust-vector limit, +/-
export const MAIN_FUEL_RATE = 1.2; // fuel units / s at throttle 1.0
export const LATERAL_ACCEL = 0.6; // m/s^2 per lateral thruster
export const LATERAL_FUEL_RATE = 0.3; // fuel units / s while firing

export const MIN_DURATION = 0.25;
export const MAX_DURATION = 6;
export const MAX_COAST_AFTER = 30;

export const START = {
  x: 0,
  y: 420,
  vx: 1,
  vy: -10,
  fuel: 26,
} as const;

export const ZONE = { min: 140, max: 220 } as const;
export const FOOTPRINT_HALF_WIDTH = 5; // lander half-width, m

export const SAFE_VY = 2.0; // max |vertical speed| at touchdown, m/s
export const SAFE_VX = 1.0; // max |horizontal speed| at touchdown, m/s

export const BOUNDS = { maxAbsX: 1500, maxY: 3000 } as const;

export const BALLISTIC_CAP_S = 90;
export const SAMPLE_EVERY_STEPS = 6; // trajectory sampling = 0.1 s

export const AGENT_LIMITS = {
  maxToolCalls: 45,
  maxManeuvers: 32,
  maxModelTurns: 45,
  maxApiRetries: 2,
  maxNudges: 3,
} as const;

export const FAULT_DEFAULT = "RIGHT_PUSH" as const;
