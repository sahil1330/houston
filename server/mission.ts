import { EventEmitter } from "node:events";
import {
  DT,
  FOOTPRINT_HALF_WIDTH,
  FAULT_DEFAULT,
  GRAVITY,
  LATERAL_ACCEL,
  MAIN_MAX_ACCEL,
  MAIN_MAX_ANGLE_DEG,
  MAX_DURATION,
  MIN_DURATION,
  SAFE_VX,
  SAFE_VY,
  START,
  ZONE,
} from "../shared/constants.js";
import {
  ballisticProjection,
  initialState,
  isTerminal,
  predict,
  step,
  stepsFor,
} from "../shared/sim.js";
import type {
  Action,
  AgentInfo,
  ClientConfig,
  ExecInfo,
  LanderState,
  LastCommand,
  LogEvent,
  MetaView,
  Phase,
  Prediction,
  PredictionMsg,
  SnapshotMsg,
  Source,
  StateMsg,
  ThrusterName,
} from "../shared/types.js";

export interface ManeuverResult {
  ok: true;
  startT: number;
  endT: number;
  stepsRun: number;
  stepsRequested: number;
  contact: boolean;
  events: string[];
  state: LanderState;
}
export interface Rejected {
  ok: false;
  code: "BUSY" | "TERMINAL" | "ABORTED" | "WRONG_MODE" | "STALE";
  error: string;
}

export interface MissionOptions {
  simSpeed: number;
  model: string;
  agentAvailable: boolean;
  setupMessage?: string;
}

interface ActiveExec {
  action: Action;
  source: Source;
  summary?: string;
  stepsDone: number;
  stepsTotal: number;
  startT: number;
  events: string[];
  resolve: (r: ManeuverResult | Rejected) => void;
}

const MAX_LOG = 600;
const MAX_TRAIL = 4000;

export function clientConfig(): ClientConfig {
  return {
    dt: DT,
    gravity: GRAVITY,
    mainMaxAccel: MAIN_MAX_ACCEL,
    maxAngleDeg: MAIN_MAX_ANGLE_DEG,
    lateralAccel: LATERAL_ACCEL,
    zone: { min: ZONE.min, max: ZONE.max },
    footprintHalfWidth: FOOTPRINT_HALF_WIDTH,
    safeVx: SAFE_VX,
    safeVy: SAFE_VY,
    minDuration: MIN_DURATION,
    maxDuration: MAX_DURATION,
    startFuel: START.fuel,
  };
}

/**
 * Backend-authoritative mission. All mutations happen synchronously on the
 * single JS thread, either in `tick()` (fixed-step integration) or in an API
 * call between ticks — i.e. always on a step boundary — so there is exactly one
 * writer and no concurrent maneuvers.
 */
export class Mission extends EventEmitter {
  epoch = 0;
  state: LanderState = initialState();
  mode: Source = "MANUAL";
  paused = false;
  agent: AgentInfo;
  lastCommand: LastCommand | null = null;
  faultInjected = false;
  faultLog: string[] = [];
  aiManeuvers = 0;
  manualManeuvers = 0;
  log: LogEvent[] = [];
  trail: [number, number][] = [];
  prediction: PredictionMsg | null = null;

  private exec: ActiveExec | null = null;
  private acc = 0;
  private lastTick = performance.now();
  private nextLogId = 1;
  private agentAbort: AbortController | null = null;
  private pauseWaiters: Array<() => void> = [];
  private timer: NodeJS.Timeout;

  constructor(private opts: MissionOptions) {
    super();
    this.agent = this.freshAgent();
    this.addLog("system", "Mission initialised. Lander is in powered descent, awaiting commands.");
    this.timer = setInterval(() => this.tick(), 1000 / 60);
  }

  dispose(): void {
    clearInterval(this.timer);
  }

  private freshAgent(): AgentInfo {
    return {
      state: "OFF",
      model: this.opts.model,
      toolCalls: 0,
      maneuvers: 0,
      turns: 0,
    };
  }

  // ---------- views ----------

  phase(): Phase {
    const s = this.state.status;
    if (s !== "FLYING") return s;
    if (this.paused) return "PAUSED";
    if (this.exec) return "EXECUTING";
    if (this.agent.state === "DECIDING") return "AWAITING_DECISION";
    if (this.agent.state === "ERROR") return "AGENT_ERROR";
    return "IDLE";
  }

  meta(): MetaView {
    return {
      epoch: this.epoch,
      phase: this.phase(),
      mode: this.mode,
      paused: this.paused,
      busy: this.exec !== null,
      agent: { ...this.agent },
      agentAvailable: this.opts.agentAvailable,
      setupMessage: this.opts.setupMessage,
      lastCommand: this.lastCommand,
      faultInjected: this.faultInjected,
      simSpeed: this.opts.simSpeed,
      aiManeuvers: this.aiManeuvers,
      manualManeuvers: this.manualManeuvers,
    };
  }

  private execInfo(): ExecInfo | null {
    if (!this.exec) return null;
    return {
      action: this.exec.action,
      source: this.exec.source,
      elapsedS: this.exec.stepsDone * DT,
      summary: this.exec.summary,
    };
  }

  private currentRate = 0;

  stateMsg(): StateMsg {
    return {
      epoch: this.epoch,
      state: this.state,
      exec: this.execInfo(),
      simRate: this.currentRate,
      projection: ballisticProjection(this.state),
    };
  }

  snapshot(): SnapshotMsg {
    return {
      meta: this.meta(),
      state: this.stateMsg(),
      trail: this.trail,
      log: this.log,
      prediction: this.prediction,
      config: clientConfig(),
    };
  }

  private emitMeta(): void {
    this.emit("meta", this.meta());
  }
  private emitState(): void {
    this.emit("state", this.stateMsg());
  }

  // ---------- logging ----------

  addLog(kind: LogEvent["kind"], text: string, detail?: string, epoch = this.epoch): void {
    if (epoch !== this.epoch) return;
    const ev: LogEvent = {
      id: this.nextLogId++,
      epoch: this.epoch,
      simT: this.state.t,
      wall: Date.now(),
      kind,
      text,
      detail,
    };
    this.log.push(ev);
    if (this.log.length > MAX_LOG) this.log.shift();
    this.emit("log", ev);
  }

  // ---------- control surface ----------

  reset(): void {
    this.epoch++;
    this.agentAbort?.abort();
    this.agentAbort = null;
    const e = this.exec;
    this.exec = null;
    e?.resolve({ ok: false, code: "ABORTED", error: "Mission was reset." });
    this.state = initialState();
    this.mode = "MANUAL";
    this.paused = false;
    this.acc = 0;
    this.currentRate = 0;
    this.agent = this.freshAgent();
    this.lastCommand = null;
    this.faultInjected = false;
    this.faultLog = [];
    this.aiManeuvers = 0;
    this.manualManeuvers = 0;
    this.log = [];
    this.nextLogId = 1;
    this.trail = [[this.state.x, this.state.y]];
    this.prediction = null;
    this.releasePauseWaiters();
    this.addLog("system", "Mission reset. All faults cleared; previous run terminated.");
    this.emit("snapshot", this.snapshot());
  }

  /** Reserve the single agent slot. Returns epoch + abort signal, or an error. */
  beginAgent(): { ok: true; epoch: number; signal: AbortSignal } | { ok: false; error: string } {
    if (!this.opts.agentAvailable)
      return { ok: false, error: this.opts.setupMessage ?? "Claude is not configured." };
    if (this.agentAbort) return { ok: false, error: "An AI mission is already running." };
    if (isTerminal(this.state)) return { ok: false, error: "Mission is over. Reset to fly again." };
    if (this.exec) return { ok: false, error: "A manual maneuver is executing. Wait or reset." };
    this.agentAbort = new AbortController();
    this.mode = "AI";
    this.agent = { ...this.freshAgent(), state: "DECIDING", decisionStartedAt: Date.now() };
    this.addLog("system", `AI mission started. Model: ${this.opts.model}.`);
    this.emitMeta();
    return { ok: true, epoch: this.epoch, signal: this.agentAbort.signal };
  }

  setAgent(patch: Partial<AgentInfo>, epoch: number): void {
    if (epoch !== this.epoch) return;
    this.agent = { ...this.agent, ...patch };
    this.emitMeta();
  }

  /** Called by the agent loop when it stops (success, budget, or error). */
  endAgent(epoch: number, final: "DONE" | "ERROR", error?: string): void {
    if (epoch !== this.epoch) return;
    this.agentAbort = null;
    this.agent = {
      ...this.agent,
      state: final,
      error,
      currentTool: undefined,
      decisionStartedAt: undefined,
    };
    if (final === "ERROR") {
      this.mode = "MANUAL";
      this.addLog("error", `Agent stopped: ${error ?? "unknown error"}`, undefined, epoch);
      if (!isTerminal(this.state))
        this.addLog("system", "Claude is no longer in control. Manual mode re-enabled.", undefined, epoch);
    }
    this.emitMeta();
  }

  pause(): boolean {
    if (this.paused || isTerminal(this.state)) return false;
    this.paused = true;
    this.currentRate = 0;
    this.addLog("system", "Mission paused.");
    this.emitMeta();
    this.emitState();
    return true;
  }

  resume(): boolean {
    if (!this.paused) return false;
    this.paused = false;
    this.lastTick = performance.now();
    this.releasePauseWaiters();
    this.addLog("system", "Mission resumed.");
    this.emitMeta();
    return true;
  }

  private releasePauseWaiters(): void {
    const w = this.pauseWaiters;
    this.pauseWaiters = [];
    for (const f of w) f();
  }

  /** Resolves when the mission is not paused (or immediately if it is not). */
  waitWhilePaused(epoch: number): Promise<void> {
    if (!this.paused || epoch !== this.epoch) return Promise.resolve();
    return new Promise((res) => this.pauseWaiters.push(res));
  }

  injectFault(thruster: ThrusterName = FAULT_DEFAULT): { ok: true } | { ok: false; error: string } {
    if (isTerminal(this.state)) return { ok: false, error: "Mission is over." };
    if (this.state.failed[thruster]) return { ok: false, error: `${thruster} has already failed.` };
    // Single-threaded: this runs between integrator ticks, i.e. on a step boundary.
    this.state.failed[thruster] = true;
    this.faultInjected = true;
    const msg = `${thruster} FAILED at T+${this.state.t.toFixed(2)}s (step ${Math.round(this.state.t / DT)}). Thruster now produces zero force.`;
    this.faultLog.push(msg);
    this.exec?.events.push(msg);
    this.addLog("fault", msg);
    this.emit("fault", { epoch: this.epoch, thruster });
    this.emitMeta();
    this.emitState();
    return { ok: true };
  }

  /** Playback speed only (how fast maneuvers animate); never changes the step sequence. */
  setSpeed(speed: number): boolean {
    if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) return false;
    this.opts.simSpeed = speed;
    this.emitMeta();
    return true;
  }

  setPrediction(prediction: Prediction, source: Source, epoch = this.epoch): void {
    if (epoch !== this.epoch) return;
    this.prediction = { epoch, source, prediction };
    this.emit("prediction", this.prediction);
  }

  previewPrediction(action: Action, coastAfterS: number): Prediction {
    return predict(this.state, action, coastAfterS);
  }

  /** Start a maneuver. Synchronous validation; completion via `done`. */
  startManeuver(
    action: Action,
    source: Source,
    opts: { summary?: string; epoch?: number } = {},
  ): { ok: true; done: Promise<ManeuverResult | Rejected> } | Rejected {
    if (opts.epoch !== undefined && opts.epoch !== this.epoch)
      return { ok: false, code: "STALE", error: "Mission was reset; action discarded." };
    if (isTerminal(this.state))
      return { ok: false, code: "TERMINAL", error: `Mission is over (${this.state.status}).` };
    if (this.exec) return { ok: false, code: "BUSY", error: "A maneuver is already executing." };
    if (source !== this.mode)
      return {
        ok: false,
        code: "WRONG_MODE",
        error:
          this.mode === "AI"
            ? "Claude is in control; manual maneuvers are disabled."
            : "Not in AI mode.",
      };
    const stepsTotal = stepsFor(action.durationS);
    const done = new Promise<ManeuverResult | Rejected>((resolve) => {
      this.exec = {
        action,
        source,
        summary: opts.summary,
        stepsDone: 0,
        stepsTotal,
        startT: this.state.t,
        events: [],
        resolve,
      };
    });
    if (source === "AI") this.aiManeuvers++;
    else this.manualManeuvers++;
    this.lastCommand = { action, source, summary: opts.summary, simT: this.state.t, done: false };
    this.acc = 0;
    this.lastTick = performance.now();
    const a = action;
    // Keyboard flying issues many 0.25 s ticks; keep those out of the log.
    if (source === "AI" || action.durationS > 0.3)
    this.addLog(
      "maneuver",
      `${source === "AI" ? "CLAUDE" : "MANUAL"} burn: throttle ${(a.throttle * 100).toFixed(0)}%, angle ${a.angleDeg.toFixed(1)}°, lateral ${a.lateral}, ${a.durationS.toFixed(2)}s`,
      opts.summary,
    );
    this.emitMeta();
    return { ok: true, done };
  }

  // ---------- integration loop ----------

  private tick(): void {
    const now = performance.now();
    const wallDt = Math.min((now - this.lastTick) / 1000, 0.1);
    this.lastTick = now;
    const e = this.exec;
    if (!e || this.paused) {
      if (this.currentRate !== 0) {
        this.currentRate = 0;
      }
      return;
    }
    // Presentation pacing only: ease playback near touchdown. The number and
    // order of integration steps is unaffected.
    const s = this.state;
    const ttc = s.vy < 0 ? s.y / -s.vy : Infinity;
    const slow = s.y < 40 && ttc < 2.5 ? 0.45 : 1;
    this.currentRate = this.opts.simSpeed * slow;
    this.acc += wallDt * this.currentRate;
    const n = Math.floor(this.acc / DT);
    if (n <= 0) return;
    this.acc -= n * DT;
    for (let i = 0; i < n; i++) {
      step(this.state, e.action);
      e.stepsDone++;
      if (e.stepsDone % 6 === 0) this.pushTrail();
      if (this.state.status !== "FLYING" || e.stepsDone >= e.stepsTotal) {
        this.finishExec();
        return;
      }
    }
    this.emitState();
  }

  private pushTrail(): void {
    this.trail.push([this.state.x, this.state.y]);
    if (this.trail.length > MAX_TRAIL) this.trail.shift();
  }

  private finishExec(): void {
    const e = this.exec;
    if (!e) return;
    this.exec = null;
    this.currentRate = 0;
    this.pushTrail();
    const contact = this.state.status !== "FLYING";
    if (this.lastCommand) this.lastCommand = { ...this.lastCommand, done: true };
    this.prediction = null;
    this.emit("prediction", null);
    const result: ManeuverResult = {
      ok: true,
      startT: e.startT,
      endT: this.state.t,
      stepsRun: e.stepsDone,
      stepsRequested: e.stepsTotal,
      contact,
      events: e.events,
      state: this.state,
    };
    if (contact) this.recordOutcome();
    this.emitState();
    this.emitMeta();
    e.resolve(result);
  }

  private recordOutcome(): void {
    const td = this.state.touchdown;
    if (!td) return;
    this.addLog(
      "outcome",
      `${td.outcome} — x ${td.x.toFixed(1)} m, vx ${td.vx.toFixed(2)}, vy ${td.vy.toFixed(2)} m/s, fuel ${td.fuel.toFixed(1)}`,
      td.reasons.join(" "),
    );
    this.emit("outcome", td);
  }
}
