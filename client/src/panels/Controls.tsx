import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { useStore } from "../store.js";
import type { Action, Lateral } from "../../../shared/types.js";

/** Runs an API call with a lock so a double click can't fire twice. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const lock = useRef(false);
  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setErr(null);
    const r = await fn();
    if (!r.ok) {
      setErr(r.error ?? "Request failed");
      setTimeout(() => setErr(null), 5000);
    }
    lock.current = false;
    setBusy(false);
  };
  return { busy, err, run };
}

export function Dock() {
  const st = useStore();
  const meta = st.meta;
  const { busy, err, run } = useAction();
  const terminal = !!meta && ["LANDED", "MISSED_ZONE", "CRASHED", "LOST"].includes(meta.phase);
  const aiActive = meta?.mode === "AI";
  const canStart = !!meta && meta.agentAvailable && !terminal && !aiActive && !meta.busy && !busy;
  const failedBoth = !!st.msg && st.msg.state.failed.RIGHT_PUSH;
  const canFault = !!meta && !terminal && !failedBoth && !busy;
  const canPause = !!meta && !terminal && (meta.paused || meta.busy || aiActive);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "f" || e.key === "F") canFault && run(() => api.fault("RIGHT_PUSH"));
      else if (e.key === "r" || e.key === "R") run(() => api.reset());
      else if (e.key === " ") {
        e.preventDefault();
        if (canPause) run(() => (meta!.paused ? api.resume() : api.pause()));
      } else if (e.key === "Enter" && canStart) run(() => api.startAI());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="dock">
      <button
        className="btn primary"
        disabled={!canStart}
        title={!meta?.agentAvailable ? "Set ANTHROPIC_API_KEY to enable Claude" : undefined}
        onClick={() => run(() => api.startAI())}
      >
        <kbd>↵</kbd>
        {aiActive ? "AI MISSION ACTIVE" : meta?.agent.state === "ERROR" ? "RESTART AI" : "START AI MISSION"}
      </button>
      <button
        className="btn"
        disabled={!canPause}
        onClick={() => run(() => (meta!.paused ? api.resume() : api.pause()))}
      >
        <kbd>␣</kbd>
        {meta?.paused ? "RESUME" : "PAUSE"}
      </button>
      <button className="btn danger" disabled={!canFault} onClick={() => run(() => api.fault("RIGHT_PUSH"))}>
        <kbd>F</kbd>
        {failedBoth ? "THRUSTER FAILED" : "THRUSTER FAILURE"}
      </button>
      <button className="btn" onClick={() => run(() => api.reset())}>
        <kbd>R</kbd>RESET
      </button>
      {err && <div className="toast">{err}</div>}
    </div>
  );
}

const LATS: Lateral[] = ["NONE", "LEFT_PUSH", "RIGHT_PUSH"];

export function ManualPanel() {
  const st = useStore();
  const cfg = st.config;
  const meta = st.meta;
  const { busy, err, run } = useAction();
  const [a, setA] = useState<Action>({ throttle: 0.4, angleDeg: 0, lateral: "NONE", durationS: 1.5 });
  if (!cfg || !meta) return null;
  const terminal = ["LANDED", "MISSED_ZONE", "CRASHED", "LOST"].includes(meta.phase);
  const locked = meta.mode === "AI" || meta.busy || terminal || meta.paused;
  const set = (p: Partial<Action>) => setA((o) => ({ ...o, ...p }));
  return (
    <div className="manual panel">
      <header className="panel-h"><span>MANUAL CONTROL</span><i /><em className="mono dim">same path as Claude</em></header>
      <div className="mgrid">
        <label>
          <span>THROTTLE <b className="mono">{(a.throttle * 100).toFixed(0)}%</b></span>
          <input type="range" min={0} max={1} step={0.01} value={a.throttle} onChange={(e) => set({ throttle: +e.target.value })} />
        </label>
        <label>
          <span>THRUST ANGLE <b className="mono">{a.angleDeg >= 0 ? "+" : ""}{a.angleDeg.toFixed(1)}°</b></span>
          <input type="range" min={-cfg.maxAngleDeg} max={cfg.maxAngleDeg} step={0.5} value={a.angleDeg} onChange={(e) => set({ angleDeg: +e.target.value })} />
        </label>
        <label>
          <span>DURATION <b className="mono">{a.durationS.toFixed(2)}s</b></span>
          <input type="range" min={cfg.minDuration} max={cfg.maxDuration} step={0.25} value={a.durationS} onChange={(e) => set({ durationS: +e.target.value })} />
        </label>
        <div className="seg">
          <span>LATERAL</span>
          <div>
            {LATS.map((l) => (
              <button key={l} className={a.lateral === l ? "on" : ""} onClick={() => set({ lateral: l })}>
                {l === "NONE" ? "NONE" : l === "LEFT_PUSH" ? "◂ LEFT_PUSH" : "RIGHT_PUSH ▸"}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="mactions">
        <button className="btn" disabled={busy || terminal} onClick={() => run(() => api.predict(a, 8))}>PREVIEW +8s COAST</button>
        <button className="btn primary" disabled={busy || locked} onClick={() => run(() => api.maneuver(a))}>EXECUTE BURN</button>
        <button className="btn" disabled={busy || locked} onClick={() => run(() => api.maneuver({ throttle: 0, angleDeg: 0, lateral: "NONE", durationS: 1 }))}>COAST 1s</button>
        <button className="btn" onClick={() => setA({ throttle: GRAV_HOVER, angleDeg: 0, lateral: "NONE", durationS: 1.5 })}>HOVER</button>
      </div>
      {err && <div className="toast inline">{err}</div>}
    </div>
  );
}

const GRAV_HOVER = 0.41; // ≈ lunar gravity / main-engine max acceleration
