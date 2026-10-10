import { useEffect, useState } from "react";
import { api } from "../api.js";
import { sound } from "../audio.js";
import { store, useStore } from "../store.js";

const WHO: Record<string, string> = {
  CLAUDE: "CLAUDE",
  HOUSTON: "HOUSTON",
  ALERT: "ALERT",
  YOU: "YOU",
};

/** Subtitle-style radio chatter. CLAUDE lines are the model's own words; HOUSTON lines are
 *  scripted callouts generated from real telemetry thresholds (they are not model output). */
export function Captions() {
  const st = useStore();
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 400);
    return () => clearInterval(id);
  }, []);
  const now = performance.now();
  const live = st.captions.filter((c) => now - c.at < 9000).slice(-2);
  return (
    <div className="captions" aria-live="polite">
      {live.map((c) => (
        <div key={c.id} className={`cap tone-${c.tone} ${now - c.at > 7000 ? "old" : ""}`}>
          <b>{WHO[c.who]}</b>
          <span>{c.text}</span>
        </div>
      ))}
    </div>
  );
}

export function Briefing({ onFly }: { onFly: () => void }) {
  const st = useStore();
  const meta = st.meta;
  const cfg = st.config;
  const [hidden, setHidden] = useState(false);
  useEffect(() => setHidden(false), [st.resetAt]);
  if (!meta || !cfg || !st.msg || hidden) return null;
  const fresh =
    st.msg.state.t === 0 && meta.phase === "IDLE" && !meta.busy && meta.mode === "MANUAL" && meta.agent.state === "OFF";
  if (!fresh) return null;
  const s = st.msg.state;
  return (
    <div className="briefing panel">
      <small>MISSION BRIEFING</small>
      <h1>Bring it down.</h1>
      <p>
        The lander is <b>{s.y.toFixed(0)} m</b> above the Moon, falling at <b>{Math.abs(s.vy).toFixed(0)} m/s</b> with{" "}
        <b>{cfg.startFuel.toFixed(0)} fuel units</b>. Touch down gently inside the cyan landing zone.
      </p>
      <p className="warn">Something is going to go wrong. A thruster will fail mid-descent — and the plan has to change.</p>
      <div className="b-actions">
        <button
          className="btn primary"
          disabled={!meta.agentAvailable}
          onClick={(e) => {
            e.currentTarget.blur();
            sound.unlock();
            void api.startAI();
          }}
          title={meta.agentAvailable ? undefined : "Set ANTHROPIC_API_KEY to enable Claude"}
        >
          ▶ WATCH CLAUDE FLY IT
        </button>
        <button
          className="btn"
          onClick={(e) => {
            e.currentTarget.blur();
            onFly();
          }}
        >
          ✦ FLY IT YOURSELF
        </button>
        <button className="link-btn" onClick={() => setHidden(true)}>
          dismiss
        </button>
      </div>
      <p className="tip">
        Tip: press <kbd>F</kbd> during the descent to kill the <b>RIGHT_PUSH</b> thruster.
      </p>
    </div>
  );
}

export function AlarmOverlay() {
  const st = useStore();
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, []);
  const since = performance.now() - store.faultAt;
  const replan = st.meta?.mode === "AI" && st.meta.agent.state === "DECIDING" && since > 0 && since < 30000;
  if (since > 3800 && !replan) return null;
  return (
    <div className="alarm-wrap">
      {since < 3800 && (
        <div className="master-alarm">
          <b>MASTER ALARM</b>
          <span>THRUSTER FAILURE</span>
        </div>
      )}
      {replan && since >= 3800 && <div className="replan">CLAUDE RE-PLANNING AFTER FAULT…</div>}
    </div>
  );
}
