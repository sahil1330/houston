import { FOOTPRINT_HALF_WIDTH, SAFE_VX, SAFE_VY, START, ZONE } from "./constants.js";
import type { Touchdown } from "./types.js";

export interface Score {
  points: number;
  grade: "S" | "A" | "B" | "C" | "D" | "—";
  parts: { label: string; points: number; max: number }[];
}

/**
 * Presentation-only scoring of a finished mission. It reads the simulator's
 * verdict and never feeds back into it. Non-landings score 0.
 */
export function scoreTouchdown(td: Touchdown | null, fuelStart: number = START.fuel): Score {
  if (!td || td.outcome !== "LANDED")
    return { points: 0, grade: "—", parts: [{ label: "Safe landing", points: 0, max: 500 }] };
  const centre = (ZONE.min + ZONE.max) / 2;
  const half = (ZONE.max - ZONE.min) / 2 - FOOTPRINT_HALF_WIDTH;
  const precision = Math.max(0, 1 - Math.abs(td.x - centre) / half);
  const soft = Math.max(0, 1 - (Math.abs(td.vy) / SAFE_VY) * 0.6 - (Math.abs(td.vx) / SAFE_VX) * 0.4);
  const fuel = Math.max(0, Math.min(1, td.fuel / fuelStart));
  const parts = [
    { label: "Safe landing", points: 500, max: 500 },
    { label: "Precision", points: Math.round(250 * precision), max: 250 },
    { label: "Soft touch", points: Math.round(150 * soft), max: 150 },
    { label: "Fuel left", points: Math.round(100 * fuel), max: 100 },
  ];
  const points = parts.reduce((a, p) => a + p.points, 0);
  const grade = points >= 900 ? "S" : points >= 800 ? "A" : points >= 700 ? "B" : points >= 600 ? "C" : "D";
  return { points, grade, parts };
}
