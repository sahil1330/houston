import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useStore } from "../store.js";

const TITLE = {
  LANDED: "SAFE LANDING",
  MISSED_ZONE: "MISSED LANDING ZONE",
  CRASHED: "CRASH",
  LOST: "LOST IN SPACE",
} as const;
const TONE = { LANDED: "cyan", MISSED_ZONE: "amber", CRASHED: "red", LOST: "red" } as const;
const TAGLINE = {
  LANDED: "The Eagle has landed.",
  MISSED_ZONE: "Gentle contact — wrong place.",
  CRASHED: "Too fast. The simulator doesn't negotiate.",
  LOST: "The lander left the operating area.",
} as const;

export function Outcome({ onChallenge }: { onChallenge: () => void }) {
  const st = useStore();
  const s = st.msg?.state;
  const cfg = st.config;
  const td = s?.touchdown;
  const [shown, setShown] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    setDismissed(false);
    if (!td) {
      setShown(false);
      return;
    }
    const id = setTimeout(() => setShown(true), 1500);
    return () => clearTimeout(id);
  }, [td?.t, st.resetAt]);
  if (!td || !s || !cfg || !shown || dismissed) return null;
  const tone = TONE[td.outcome];
  const center = (cfg.zone.min + cfg.zone.max) / 2;
  const res = st.result;
  const pilot = res?.pilot === "CLAUDE" ? `Claude (${st.meta?.agent.model})` : res?.pilot === "HUMAN" ? "You" : "Claude + manual";
  const landed = td.outcome === "LANDED";
  return (
    <div className={`outcome tone-${tone}`} role="status">
      <div className="o-head">
        <small>MISSION RESULT</small>
        <h2>{TITLE[td.outcome]}</h2>
        <p className="by">
          {TAGLINE[td.outcome]} <span className="dim">Flown by {pilot}{st.meta?.faultInjected ? " · after thruster failure" : ""}</span>
        </p>
      </div>
      {res && (
        <div className="o-score">
          <div className="grade">
            <b className="mono">{res.score.points}</b>
            <span className={`g g-${res.score.grade}`}>{res.score.grade}</span>
            {res.newBest && <em>NEW BEST</em>}
          </div>
          <div className="parts">
            {res.score.parts.map((p) => (
              <div key={p.label}>
                <span>{p.label}</span>
                <div className="bar thin"><div className="fill" style={{ width: `${(p.points / p.max) * 100}%` }} /></div>
                <b className="mono">{p.points}</b>
              </div>
            ))}
          </div>
        </div>
      )}
      {(st.records.CLAUDE || st.records.HUMAN) && (
        <div className="o-vs">
          <div className={res?.pilot === "CLAUDE" ? "me" : ""}>
            <small>CLAUDE BEST</small>
            <b className="mono">{st.records.CLAUDE?.best ?? "—"}</b>
          </div>
          <span>vs</span>
          <div className={res?.pilot === "HUMAN" ? "me" : ""}>
            <small>YOUR BEST</small>
            <b className="mono">{st.records.HUMAN?.best ?? "—"}</b>
          </div>
        </div>
      )}
      <div className="o-grid">
        <div><small>TOUCHDOWN X</small><b className="mono">{td.x.toFixed(1)} m</b></div>
        <div><small>FROM ZONE CENTRE</small><b className="mono">{(td.x - center >= 0 ? "+" : "") + (td.x - center).toFixed(1)} m</b></div>
        <div className={Math.abs(td.vy) > cfg.safeVy ? "bad" : "good"}><small>VERTICAL</small><b className="mono">{td.vy.toFixed(2)} m/s</b><i>limit {cfg.safeVy.toFixed(1)}</i></div>
        <div className={Math.abs(td.vx) > cfg.safeVx ? "bad" : "good"}><small>HORIZONTAL</small><b className="mono">{td.vx.toFixed(2)} m/s</b><i>limit {cfg.safeVx.toFixed(1)}</i></div>
        <div><small>FUEL LEFT</small><b className="mono">{td.fuel.toFixed(1)}</b></div>
        <div><small>MISSION TIME</small><b className="mono">{td.t.toFixed(1)} s</b></div>
      </div>
      <ul className="o-reasons">
        {td.reasons.map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ul>
      <div className="o-actions">
        <button
          className="btn primary"
          onClick={async () => {
            await api.reset();
            if (res?.pilot === "CLAUDE") onChallenge();
          }}
        >
          {res?.pilot === "CLAUDE" ? (landed ? "BEAT CLAUDE — FLY IT YOURSELF" : "YOUR TURN — FLY IT") : "RESET MISSION"}
        </button>
        {res?.pilot === "CLAUDE" && (
          <button className="btn" onClick={() => api.reset()}>
            RUN AGAIN
          </button>
        )}
        <button className="btn" onClick={() => setDismissed(true)}>
          VIEW SCENE
        </button>
      </div>
    </div>
  );
}
