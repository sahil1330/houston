import { useEffect, useRef, useState, type ReactNode } from "react";
import { useStore } from "../store.js";
import type { Phase } from "../../../shared/types.js";

export function Panel({
  title,
  right,
  children,
  className = "",
}: {
  title: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      <header className="panel-h">
        <span>{title}</span>
        <i />
        {right && <em>{right}</em>}
      </header>
      {children}
    </section>
  );
}

const PHASE_LABEL: Record<Phase, string> = {
  IDLE: "STANDBY",
  AWAITING_DECISION: "AWAITING DECISION",
  EXECUTING: "EXECUTING MANEUVER",
  PAUSED: "PAUSED",
  LANDED: "LANDED",
  MISSED_ZONE: "MISSED LANDING ZONE",
  CRASHED: "CRASHED",
  LOST: "LOST",
  AGENT_ERROR: "AGENT ERROR",
};
const PHASE_TONE: Record<Phase, string> = {
  IDLE: "dim",
  AWAITING_DECISION: "cyan",
  EXECUTING: "cyan",
  PAUSED: "amber",
  LANDED: "cyan",
  MISSED_ZONE: "amber",
  CRASHED: "red",
  LOST: "red",
  AGENT_ERROR: "red",
};

export function mmss(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
}

export function TopBar() {
  const st = useStore();
  const meta = st.meta;
  const phase = meta?.phase ?? "IDLE";
  return (
    <div className="topbar">
      <div className="brand">
        <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden>
          <circle cx="13" cy="13" r="11" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <circle cx="13" cy="13" r="4" fill="currentColor" />
          <path d="M13 1v5M13 20v5M1 13h5M20 13h5" stroke="currentColor" strokeWidth="1.4" />
        </svg>
        <div>
          <b>HOUSTON</b>
          <small>AI MISSION CONTROL</small>
        </div>
      </div>
      <div className={`pill tone-${PHASE_TONE[phase]}`}>
        <span className="dot" />
        {PHASE_LABEL[phase]}
      </div>
      <div className="grow" />
      <div className="chip">
        <small>MODE</small>
        <b>{meta?.mode === "AI" ? "CLAUDE" : "MANUAL"}</b>
      </div>
      <div className="chip">
        <small>MODEL</small>
        <b>{meta?.agent.model ?? "—"}</b>
      </div>
      <div className="chip">
        <small>MET</small>
        <b className="mono">T+{mmss(st.msg?.state.t ?? 0)}</b>
      </div>
      <div className={`link ${st.connected ? "up" : "down"}`} title={st.connected ? "Backend connected" : "Backend offline"}>
        <span className="dot" />
        {st.connected ? "LINK" : "NO LINK"}
      </div>
    </div>
  );
}

function Gauge({
  value,
  min,
  max,
  safeLo,
  safeHi,
  tone,
}: {
  value: number;
  min: number;
  max: number;
  safeLo: number;
  safeHi: number;
  tone: string;
}) {
  const pct = (v: number) => `${((Math.min(max, Math.max(min, v)) - min) / (max - min)) * 100}%`;
  return (
    <div className="gauge">
      <div className="band" style={{ left: pct(safeLo), width: `calc(${pct(safeHi)} - ${pct(safeLo)})` }} />
      <div className="zero" style={{ left: pct(0) }} />
      <div className={`needle tone-${tone}`} style={{ left: pct(value) }} />
    </div>
  );
}

export function TelemetryPanel() {
  const st = useStore();
  const m = st.msg;
  const cfg = st.config;
  if (!m || !cfg) return <Panel title="TELEMETRY">…</Panel>;
  const s = m.state;
  const alt = s.y;
  const vyBad = Math.abs(s.vy) > cfg.safeVy;
  const vxBad = Math.abs(s.vx) > cfg.safeVx;
  const vyTone = !vyBad ? "cyan" : alt < 60 ? "red" : "amber";
  const vxTone = !vxBad ? "cyan" : alt < 60 ? "red" : "amber";
  const center = (cfg.zone.min + cfg.zone.max) / 2;
  const fuelPct = Math.max(0, (s.fuel / cfg.startFuel) * 100);
  const fuelTone = fuelPct < 15 ? "red" : fuelPct < 35 ? "amber" : "cyan";
  const td = m.projection.touchdown;
  return (
    <Panel title="TELEMETRY" right={<span className="mono dim">{s.status === "FLYING" ? "LIVE" : "FINAL"}</span>}>
      <div className="alt">
        <small>ALTITUDE</small>
        <b className="mono">{alt.toFixed(1)}<u>m</u></b>
      </div>
      <div className="row2">
        <div>
          <small>VERTICAL SPEED</small>
          <b className={`mono tone-${vyTone}`}>{s.vy.toFixed(2)}<u>m/s</u></b>
        </div>
      </div>
      <Gauge value={s.vy} min={-16} max={4} safeLo={-cfg.safeVy} safeHi={cfg.safeVy} tone={vyTone} />
      <div className="gl"><span>−16</span><span>safe ±{cfg.safeVy.toFixed(1)}</span><span>+4</span></div>
      <div className="row2">
        <div>
          <small>HORIZONTAL SPEED</small>
          <b className={`mono tone-${vxTone}`}>{s.vx.toFixed(2)}<u>m/s</u></b>
        </div>
      </div>
      <Gauge value={s.vx} min={-12} max={12} safeLo={-cfg.safeVx} safeHi={cfg.safeVx} tone={vxTone} />
      <div className="gl"><span>−12</span><span>safe ±{cfg.safeVx.toFixed(1)}</span><span>+12</span></div>
      <div className="row2">
        <div>
          <small>FUEL</small>
          <b className={`mono tone-${fuelTone}`}>{s.fuel.toFixed(1)}<u>units · {fuelPct.toFixed(0)}%</u></b>
        </div>
      </div>
      <div className="bar"><div className={`fill tone-${fuelTone}`} style={{ width: `${fuelPct}%` }} /></div>
      <div className="kv">
        <span>X POSITION</span><b className="mono">{s.x.toFixed(1)} m</b>
        <span>TO ZONE CENTRE</span><b className="mono">{(center - s.x >= 0 ? "+" : "") + (center - s.x).toFixed(1)} m</b>
        <span>NO-THRUST IMPACT</span>
        <b className={`mono tone-${td ? (td.outcome === "LANDED" ? "cyan" : td.outcome === "MISSED_ZONE" ? "amber" : "red") : "dim"}`}>
          {s.status !== "FLYING" ? "—" : td ? `x ${td.x.toFixed(0)} · ${td.outcome.replace("_", " ")}` : "> 90 s"}
        </b>
      </div>
    </Panel>
  );
}

export function ThrusterPanel() {
  const st = useStore();
  const m = st.msg;
  if (!m) return null;
  const f = m.state.failed;
  const a = m.exec?.action;
  const row = (name: string, failed: boolean, active: boolean, detail?: string) => (
    <div className={`th ${failed ? "failed" : active ? "active" : ""}`} key={name}>
      <span className="led" />
      <b>{name}</b>
      <em>{failed ? "FAILED" : active ? "FIRING" : "NOMINAL"}</em>
      <small>{failed ? "zero force" : (detail ?? "")}</small>
    </div>
  );
  const main = a && a.throttle > 0;
  return (
    <Panel title="PROPULSION" className={f.LEFT_PUSH || f.RIGHT_PUSH ? "alarm" : ""}>
      {row("MAIN ENGINE", false, !!main, main ? `${(a!.throttle * 100).toFixed(0)}% · ${a!.angleDeg.toFixed(1)}°` : "idle")}
      {row("LEFT_PUSH", f.LEFT_PUSH, a?.lateral === "LEFT_PUSH", "force → −x")}
      {row("RIGHT_PUSH", f.RIGHT_PUSH, a?.lateral === "RIGHT_PUSH", "force → +x")}
    </Panel>
  );
}

function Elapsed({ since }: { since?: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 200);
    return () => clearInterval(id);
  }, []);
  if (!since) return <span className="mono">0.0s</span>;
  return <span className="mono">{((Date.now() - since) / 1000).toFixed(1)}s</span>;
}

export function AgentPanel() {
  const st = useStore();
  const meta = st.meta;
  if (!meta) return null;
  const a = meta.agent;
  const tools = st.log.filter((l) => l.kind === "tool").slice(-5);
  const deciding = a.state === "DECIDING" && !meta.paused;
  const label: Record<string, string> = {
    OFF: "NOT ENGAGED",
    DECIDING: "CLAUDE IS DECIDING",
    EXECUTING: "EXECUTING COMMAND",
    DONE: "MISSION COMPLETE",
    ERROR: "AGENT ERROR",
  };
  return (
    <Panel
      title="AGENT"
      right={<span className={`mono tone-${a.state === "ERROR" ? "red" : a.state === "OFF" ? "dim" : "cyan"}`}>{a.state}</span>}
    >
      <div className={`scan ${deciding ? "on" : ""}`}><i /></div>
      <div className="agent-state">
        <b>{label[a.state]}</b>
        {a.state === "DECIDING" && <Elapsed since={a.decisionStartedAt} />}
      </div>
      <div className="chips">
        {tools.length === 0 && <span className="dim small">no tool calls yet</span>}
        {tools.map((t, i) => {
          const name = t.text.split("(")[0]!;
          return (
            <span key={t.id} className={`tool ${i === tools.length - 1 && a.currentTool === name ? "live" : ""}`}>
              {name.replace("_", " ")}
            </span>
          );
        })}
      </div>
      {a.lastSummary && <p className="say">“{a.lastSummary}”</p>}
      <div className="budget">
        <span>TOOL CALLS</span>
        <div className="bar thin"><div className="fill tone-cyan" style={{ width: `${Math.min(100, (a.toolCalls / 45) * 100)}%` }} /></div>
        <b className="mono">{a.toolCalls}/45</b>
        <span>MANEUVERS</span>
        <div className="bar thin"><div className="fill tone-cyan" style={{ width: `${Math.min(100, (a.maneuvers / 32) * 100)}%` }} /></div>
        <b className="mono">{a.maneuvers}/32</b>
      </div>
    </Panel>
  );
}

export function LastCommand() {
  const st = useStore();
  const lc = st.meta?.lastCommand;
  const exec = st.msg?.exec;
  const cfg = st.config;
  if (!cfg) return null;
  if (!lc)
    return (
      <Panel title="LAST COMMAND">
        <p className="dim small">No command issued yet.</p>
      </Panel>
    );
  const a = lc.action;
  const prog = exec ? Math.min(100, (exec.elapsedS / exec.action.durationS) * 100) : 100;
  const angPct = ((a.angleDeg + cfg.maxAngleDeg) / (2 * cfg.maxAngleDeg)) * 100;
  return (
    <Panel
      title="LAST COMMAND"
      right={<span className={`mono ${lc.source === "AI" ? "tone-cyan" : "dim"}`}>{lc.source === "AI" ? "CLAUDE" : "MANUAL"} · T+{lc.simT.toFixed(1)}</span>}
    >
      <div className="cmd">
        <span>THROTTLE</span>
        <div className="bar thin"><div className="fill tone-cyan" style={{ width: `${a.throttle * 100}%` }} /></div>
        <b className="mono">{(a.throttle * 100).toFixed(0)}%</b>
        <span>ANGLE</span>
        <div className="bar thin centered"><i style={{ left: `${angPct}%` }} /></div>
        <b className="mono">{a.angleDeg >= 0 ? "+" : ""}{a.angleDeg.toFixed(1)}°</b>
        <span>LATERAL</span>
        <b className={`mono lat ${a.lateral !== "NONE" && st.msg?.state.failed[a.lateral] ? "tone-red" : ""}`}>{a.lateral}{a.lateral !== "NONE" && st.msg?.state.failed[a.lateral] ? " ✕" : ""}</b>
        <b className="mono dim">{a.durationS.toFixed(2)}s</b>
      </div>
      <div className="bar thin prog"><div className="fill tone-cyan" style={{ width: `${lc.done ? 100 : prog}%` }} /></div>
      {lc.summary && <p className="say">“{lc.summary}”</p>}
    </Panel>
  );
}

const KIND_ICON: Record<string, string> = {
  system: "◦",
  fault: "⚠",
  agent: "◆",
  tool: "▸",
  result: "◂",
  maneuver: "▲",
  outcome: "■",
  error: "✕",
};

export function EventLog() {
  const st = useStore();
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  return (
    <Panel title="MISSION LOG" className="log-panel" right={<span className="mono dim">{st.log.length}</span>}>
      <div
        className="log"
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {st.log.map((l) => (
          <div key={l.id} className={`ev k-${l.kind}`}>
            <time className="mono">{l.simT.toFixed(1).padStart(5, "0")}</time>
            <span className="ic">{KIND_ICON[l.kind]}</span>
            <div>
              <span>{l.text}</span>
              {l.detail && <small>{l.detail}</small>}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

export function Legend() {
  return (
    <div className="legend">
      <span><i className="l-trail" />Flight path</span>
      <span><i className="l-ball" />Ballistic projection (no thrust)</span>
      <span><i className="l-plan" />Planned maneuver</span>
    </div>
  );
}

export function Banners() {
  const st = useStore();
  const meta = st.meta;
  if (!meta) return null;
  return (
    <div className="banners">
      {meta.agent.state === "ERROR" && (
        <div className="banner error">
          <b>✕ AGENT ERROR</b>
          <span>{meta.agent.error}</span>
          <small>Claude is no longer controlling the lander. Reset the mission, or fly manually.</small>
        </div>
      )}
      {!meta.agentAvailable && meta.setupMessage && (
        <div className="banner setup">
          <b>SETUP</b>
          <span>{meta.setupMessage}</span>
        </div>
      )}
      {!st.connected && (
        <div className="banner error">
          <b>NO LINK</b>
          <span>Cannot reach the HOUSTON backend. Is `npm run dev` running?</span>
        </div>
      )}
    </div>
  );
}
