import type { Action, ThrusterName } from "../../shared/types.js";

async function post(path: string, body?: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    if (res.ok) return { ok: true };
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: j.error ?? `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Network error" };
  }
}

const wire = (a: Action) => ({
  throttle: a.throttle,
  angle_deg: a.angleDeg,
  lateral: a.lateral,
  duration_s: a.durationS,
});

export const api = {
  startAI: () => post("/api/mission/start-ai"),
  pause: () => post("/api/mission/pause"),
  resume: () => post("/api/mission/resume"),
  reset: () => post("/api/mission/reset"),
  speed: (speed: number) => post("/api/mission/speed", { speed }),
  fault: (thruster: ThrusterName = "RIGHT_PUSH") => post("/api/mission/fault", { thruster }),
  maneuver: (a: Action) => post("/api/mission/maneuver", wire(a)),
  predict: (a: Action, coastAfterS: number) =>
    post("/api/mission/predict", { ...wire(a), coast_after_s: coastAfterS }),
};
