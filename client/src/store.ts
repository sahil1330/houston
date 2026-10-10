import { useSyncExternalStore } from "react";
import type {
  ClientConfig,
  LogEvent,
  MetaView,
  PredictionMsg,
  SnapshotMsg,
  StateMsg,
  Touchdown,
} from "../../shared/types.js";
import { scoreTouchdown, type Score } from "../../shared/score.js";
import { sound } from "./audio.js";

export interface Caption {
  id: number;
  who: "CLAUDE" | "HOUSTON" | "ALERT" | "YOU";
  text: string;
  tone: "cyan" | "amber" | "red" | "dim";
  at: number;
}

export type Pilot = "CLAUDE" | "HUMAN";
export interface PilotRecord {
  best: number;
  last: number;
  runs: number;
}
export interface RunResult {
  pilot: Pilot | "MIXED";
  score: Score;
  rival?: { pilot: Pilot; best: number } | null;
  newBest: boolean;
}

const REC_KEY = "houston.records.v1";
function loadRecords(): Partial<Record<Pilot, PilotRecord>> {
  try {
    return JSON.parse(localStorage.getItem(REC_KEY) ?? "{}");
  } catch {
    return {};
  }
}

const ALT_CALLOUTS = [300, 200, 100, 50, 30, 15];

/** Client-side mirror of the backend mission. The server is authoritative. */
class Store {
  meta: MetaView | null = null;
  msg: StateMsg | null = null;
  recvAt = 0;
  trail: [number, number][] = [];
  log: LogEvent[] = [];
  prediction: PredictionMsg | null = null;
  config: ClientConfig | null = null;
  connected = false;
  captions: Caption[] = [];
  records = loadRecords();
  result: RunResult | null = null;
  /** Cosmetic effect timestamps (performance.now) consumed by the scene. */
  faultAt = -1e9;
  outcomeAt = -1e9;
  resetAt = 0;
  version = 0;
  private listeners = new Set<() => void>();
  private pending = false;
  private started = false;
  private capId = 1;
  private lastAlt = Infinity;
  private prevAgentState = "OFF";

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = () => this.version;

  /** Coalesce notifications to one per animation frame. */
  private bump() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.version++;
      this.listeners.forEach((l) => l());
    });
  }

  get epoch(): number {
    return this.meta?.epoch ?? 0;
  }

  caption(who: Caption["who"], text: string, tone: Caption["tone"] = "cyan", beep = true) {
    this.captions.push({ id: this.capId++, who, text, tone, at: performance.now() });
    if (this.captions.length > 6) this.captions.shift();
    if (beep) sound.radio();
    this.bump();
  }

  private altitudeCallouts(s: StateMsg) {
    const st = s.state;
    if (st.status !== "FLYING") return;
    const alt = st.y;
    for (const T of ALT_CALLOUTS) {
      if (this.lastAlt > T && alt <= T) {
        const cfg = this.config;
        const fast = cfg ? Math.abs(st.vy) > cfg.safeVy : false;
        const fuelLow = cfg ? st.fuel / cfg.startFuel < 0.2 : false;
        const msg = `Altitude ${T} meters · sink ${Math.abs(st.vy).toFixed(1)} m/s${fast ? " — TOO FAST" : ""}${fuelLow ? " · fuel low" : ""}`;
        this.caption("HOUSTON", msg, fast && T <= 100 ? "red" : fast ? "amber" : "cyan");
        if (T <= 50) sound.tick();
      }
    }
    this.lastAlt = alt;
  }

  private onOutcome(td: Touchdown) {
    this.outcomeAt = performance.now();
    sound.stopAlarm();
    sound.touchdown(td.outcome);
    const m = this.meta;
    const ai = m?.aiManeuvers ?? 0;
    const man = m?.manualManeuvers ?? 0;
    const pilot: RunResult["pilot"] = ai > 0 && man === 0 ? "CLAUDE" : man > 0 && ai === 0 ? "HUMAN" : "MIXED";
    const score = scoreTouchdown(td, this.config?.startFuel);
    let newBest = false;
    let rival: RunResult["rival"] = null;
    if (pilot !== "MIXED") {
      const prev = this.records[pilot];
      newBest = td.outcome === "LANDED" && (!prev || score.points > prev.best);
      this.records[pilot] = {
        best: Math.max(prev?.best ?? 0, score.points),
        last: score.points,
        runs: (prev?.runs ?? 0) + 1,
      };
      localStorage.setItem(REC_KEY, JSON.stringify(this.records));
      const other: Pilot = pilot === "CLAUDE" ? "HUMAN" : "CLAUDE";
      const o = this.records[other];
      rival = o ? { pilot: other, best: o.best } : null;
    }
    this.result = { pilot, score, rival, newBest };
    const line =
      td.outcome === "LANDED"
        ? `Touchdown! Safe landing — ${score.points} points, grade ${score.grade}.`
        : td.outcome === "MISSED_ZONE"
          ? "Contact — but outside the landing zone."
          : "Impact! The lander is lost.";
    this.caption("HOUSTON", line, td.outcome === "LANDED" ? "cyan" : td.outcome === "MISSED_ZONE" ? "amber" : "red", false);
  }

  connect() {
    if (this.started) return;
    this.started = true;
    const es = new EventSource("/api/events");
    es.onopen = () => {
      this.connected = true;
      this.bump();
    };
    es.onerror = () => {
      this.connected = false;
      this.bump();
    };
    es.addEventListener("snapshot", (e) => {
      const s = JSON.parse((e as MessageEvent).data) as SnapshotMsg;
      this.meta = s.meta;
      this.msg = s.state;
      this.recvAt = performance.now();
      this.trail = s.trail.slice();
      this.log = s.log.slice();
      this.prediction = s.prediction;
      this.config = s.config;
      this.resetAt = performance.now();
      this.outcomeAt = -1e9;
      this.faultAt = -1e9;
      this.captions = [];
      this.result = null;
      this.lastAlt = s.state.state.y;
      this.prevAgentState = s.meta.agent.state;
      sound.stopAlarm();
      this.bump();
    });
    es.addEventListener("meta", (e) => {
      const m = JSON.parse((e as MessageEvent).data) as MetaView;
      if (m.epoch < this.epoch) return;
      if (this.prevAgentState === "OFF" && m.agent.state === "DECIDING") {
        sound.start();
        this.caption("HOUSTON", `Claude has the controls. Landing zone ${this.config?.zone.min}–${this.config?.zone.max} m.`, "cyan");
      }
      this.prevAgentState = m.agent.state;
      this.meta = m;
      this.bump();
    });
    es.addEventListener("state", (e) => {
      const s = JSON.parse((e as MessageEvent).data) as StateMsg;
      if (s.epoch < this.epoch) return; // stale update from a previous run
      this.msg = s;
      this.recvAt = performance.now();
      const last = this.trail[this.trail.length - 1];
      if (!last || Math.hypot(last[0] - s.state.x, last[1] - s.state.y) > 0.6)
        this.trail.push([s.state.x, s.state.y]);
      this.altitudeCallouts(s);
      this.bump();
    });
    es.addEventListener("log", (e) => {
      const l = JSON.parse((e as MessageEvent).data) as LogEvent;
      if (l.epoch < this.epoch) return;
      this.log.push(l);
      if (this.log.length > 600) this.log.shift();
      if (l.kind === "agent") this.caption("CLAUDE", l.text, "cyan");
      else if (l.kind === "error") this.caption("ALERT", l.text, "red");
      this.bump();
    });
    es.addEventListener("prediction", (e) => {
      const p = JSON.parse((e as MessageEvent).data) as PredictionMsg | null;
      if (p && p.epoch < this.epoch) return;
      this.prediction = p;
      this.bump();
    });
    es.addEventListener("fault", (e) => {
      const f = JSON.parse((e as MessageEvent).data) as { epoch: number; thruster: string };
      if (f.epoch < this.epoch) return;
      this.faultAt = performance.now();
      sound.alarm();
      this.caption("ALERT", `MASTER ALARM — ${f.thruster} thruster offline`, "red", false);
      this.bump();
    });
    es.addEventListener("outcome", (e) => {
      this.onOutcome(JSON.parse((e as MessageEvent).data) as Touchdown);
      this.bump();
    });
  }
}

export const store = new Store();

export function useStore(): Store {
  useSyncExternalStore(store.subscribe, store.getVersion);
  return store;
}
