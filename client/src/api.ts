import type { Action, ThrusterName } from "../../shared/types.js";

/** Backend origin. Empty in dev (Vite proxies /api); set VITE_API_BASE for a separately hosted backend. */
export const API_BASE = ((import.meta.env.VITE_API_BASE as string | undefined) ?? "").replace(/\/$/, "");
const PASS_KEY = "houston.passcode";

async function post(path: string, body?: unknown, retried = false): Promise<{ ok: boolean; error?: string }> {
  try {
    const pass = sessionStorage.getItem(PASS_KEY);
    const res = await fetch(API_BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(pass ? { "X-Houston-Passcode": pass } : {}) },
      body: JSON.stringify(body ?? {}),
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 && !retried) {
      sessionStorage.removeItem(PASS_KEY);
      const entered = window.prompt("Passcode to start an AI mission:");
      if (entered) {
        sessionStorage.setItem(PASS_KEY, entered);
        return post(path, body, true);
      }
    }
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
