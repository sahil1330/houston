import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { sound } from "../audio.js";
import { store, useStore } from "../store.js";
import type { Lateral } from "../../../shared/types.js";

interface ToolsProps {
  manualOpen: boolean;
  setManualOpen: (b: boolean) => void;
  fly: boolean;
  setFly: (b: boolean) => void;
  cinema: boolean;
  setCinema: (b: boolean) => void;
}

export function TopTools({ manualOpen, setManualOpen, fly, setFly, cinema, setCinema }: ToolsProps) {
  const st = useStore();
  const meta = st.meta;
  const [muted, setMuted] = useState(sound.muted);
  useEffect(() => {
    const off = sound.onChange(() => setMuted(sound.muted));
    return () => void off();
  }, []);
  const aiActive = meta?.mode === "AI";
  const speed = meta?.simSpeed ?? 2;
  return (
    <div className="tools">
      <button
        className={`tool-btn ${fly ? "on" : ""}`}
        disabled={aiActive}
        onClick={() => {
          setFly(!fly);
          setManualOpen(false);
        }}
        title="Fly the lander yourself with the keyboard (K)"
      >
        FLY<kbd>K</kbd>
      </button>
      <button
        className={`tool-btn ${manualOpen ? "on" : ""}`}
        disabled={aiActive}
        onClick={() => {
          setManualOpen(!manualOpen);
          setFly(false);
        }}
        title="Sliders for precise burns"
      >
        SLIDERS
      </button>
      <div className="speed" title="Playback speed of maneuvers (physics unchanged)">
        {[1, 2, 4].map((v) => (
          <button key={v} className={speed === v ? "on" : ""} onClick={() => api.speed(v)}>
            {v}×
          </button>
        ))}
      </div>
      <button className={`tool-btn ${cinema ? "on" : ""}`} onClick={() => setCinema(!cinema)} title="Hide panels (C)">
        CINEMA<kbd>C</kbd>
      </button>
      <button
        className={`tool-btn ${muted ? "" : "on"}`}
        onClick={() => {
          sound.unlock();
          sound.setMuted(!muted);
        }}
        title="Sound (M)"
      >
        {muted ? "SOUND OFF" : "SOUND ON"}
        <kbd>M</kbd>
      </button>
    </div>
  );
}

const FLY_KEYS = ["w", "s", "a", "d", "q", "e", "x", "arrowleft", "arrowright", "arrowup", "arrowdown"];
const TERMINAL = ["LANDED", "MISSED_ZONE", "CRASHED", "LOST"];

/** Keyboard flying. Sends back-to-back 0.25 s maneuvers through the same API as everything else. */
export function FlyPad({ onExit }: { onExit: () => void }) {
  const st = useStore();
  const cfg = st.config;
  const [view, setView] = useState({ throttle: 0, angle: 0, lateral: "NONE" as Lateral, armed: false });
  const ref = useRef({ throttle: 0, angle: 0, keys: new Set<string>(), armed: false, inflight: false });

  useEffect(() => {
    if (!cfg) return;
    const r = ref.current;
    const down = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (!FLY_KEYS.includes(k)) return;
      e.preventDefault();
      sound.unlock();
      r.keys.add(k);
      if (k === "x") r.throttle = 0;
      if (k === "w" || k === "arrowup") r.armed = true;
    };
    const up = (e: KeyboardEvent) => r.keys.delete(e.key.toLowerCase());
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    let last = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const k = r.keys;
      if (k.has("w") || k.has("arrowup")) r.throttle = Math.min(1, r.throttle + 0.9 * dt);
      if (k.has("s") || k.has("arrowdown")) r.throttle = Math.max(0, r.throttle - 0.9 * dt);
      const aim =
        (k.has("e") || k.has("arrowright") ? 1 : 0) - (k.has("q") || k.has("arrowleft") ? 1 : 0);
      if (aim !== 0)
        r.angle = Math.max(-cfg.maxAngleDeg, Math.min(cfg.maxAngleDeg, r.angle + aim * 30 * dt));
      else r.angle -= Math.sign(r.angle) * Math.min(Math.abs(r.angle), 40 * dt);
      const lateral: Lateral = k.has("d") ? "RIGHT_PUSH" : k.has("a") ? "LEFT_PUSH" : "NONE";
      setView({ throttle: r.throttle, angle: r.angle, lateral, armed: r.armed });
      const m = store.meta;
      if (
        r.armed &&
        !r.inflight &&
        m &&
        m.mode === "MANUAL" &&
        !m.busy &&
        !m.paused &&
        !TERMINAL.includes(m.phase)
      ) {
        r.inflight = true;
        void api
          .maneuver({ throttle: r.throttle, angleDeg: r.angle, lateral, durationS: 0.25 })
          .finally(() => (r.inflight = false));
      }
    }, 16);
    return () => {
      clearInterval(id);
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [cfg]);

  // After a reset, disarm so the lander doesn't fall until the pilot presses W again.
  useEffect(() => {
    ref.current.armed = false;
    ref.current.throttle = 0;
    ref.current.angle = 0;
  }, [st.resetAt]);

  if (!cfg) return (
    <div className="flypad panel">
      <header className="panel-h"><span>FLY BY KEYBOARD</span><i /></header>
      <p className="fly-hint">Not connected to the HOUSTON backend, so there is nothing to fly. Check that the server is running (and VITE_API_BASE on a deployed site).</p>
    </div>
  );
  const aiFlying = st.meta?.mode === "AI";
  const aPct = ((view.angle + cfg.maxAngleDeg) / (2 * cfg.maxAngleDeg)) * 100;
  return (
    <div className="flypad panel">
      <header className="panel-h">
        <span>FLY BY KEYBOARD</span>
        <i />
        <em>
          <button className="link-btn" onClick={onExit}>
            close
          </button>
        </em>
      </header>
      <div className="fly-grid">
        <div className="keys">
          <span>
            <kbd>W</kbd>
            <kbd>S</kbd> throttle
          </span>
          <span>
            <kbd>Q</kbd>
            <kbd>E</kbd> or <kbd>←</kbd>
            <kbd>→</kbd> thrust angle
          </span>
          <span>
            <kbd>A</kbd>
            <kbd>D</kbd> side thrusters
          </span>
          <span>
            <kbd>X</kbd> cut engine
          </span>
        </div>
        <div className="cmd">
          <span>THROTTLE</span>
          <div className="bar thin">
            <div className="fill tone-cyan" style={{ width: `${view.throttle * 100}%` }} />
          </div>
          <b className="mono">{(view.throttle * 100).toFixed(0)}%</b>
          <span>ANGLE</span>
          <div className="bar thin centered">
            <i style={{ left: `${aPct}%` }} />
          </div>
          <b className="mono">{view.angle.toFixed(1)}°</b>
          <span>SIDE</span>
          <b className="mono lat">{view.lateral}</b>
          <b />
        </div>
      </div>
      {aiFlying && (
        <p className="fly-hint">Claude is flying this mission, so keyboard controls are locked. Press <kbd>R</kbd> to reset and take over.</p>
      )}
      {!aiFlying && !view.armed && (
        <p className="fly-hint">
          Press <kbd>W</kbd> to start — time only runs while you fly. Press <kbd>F</kbd> any time to kill a thruster.
        </p>
      )}
    </div>
  );
}
