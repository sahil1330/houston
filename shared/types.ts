export type Lateral = "NONE" | "LEFT_PUSH" | "RIGHT_PUSH";
export type ThrusterName = "LEFT_PUSH" | "RIGHT_PUSH";

export interface Action {
  throttle: number; // 0..1
  angleDeg: number; // -15..15, + adds rightward thrust
  lateral: Lateral;
  durationS: number; // 0.25..6
}

export type SimStatus = "FLYING" | "LANDED" | "MISSED_ZONE" | "CRASHED" | "LOST";

export interface Touchdown {
  outcome: "LANDED" | "MISSED_ZONE" | "CRASHED" | "LOST";
  x: number;
  vx: number;
  vy: number;
  fuel: number;
  t: number;
  footMin: number;
  footMax: number;
  reasons: string[];
}

export interface LanderState {
  t: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fuel: number;
  failed: Record<ThrusterName, boolean>;
  status: SimStatus;
  touchdown: Touchdown | null;
}

export interface Point {
  t: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  phase: "controlled" | "ballistic";
}

export interface Prediction {
  kind: "controlled+ballistic" | "ballistic";
  points: Point[];
  horizonS: number;
  controlledS: number;
  contact: boolean;
  horizonEndedBeforeTouchdown: boolean;
  end: { t: number; x: number; y: number; vx: number; vy: number; fuel: number };
  touchdown: Touchdown | null;
  assumesFaults: Record<ThrusterName, boolean>;
}

// ---- Mission view model shared by server and client ----

export type Phase =
  | "IDLE"
  | "AWAITING_DECISION"
  | "EXECUTING"
  | "PAUSED"
  | "LANDED"
  | "MISSED_ZONE"
  | "CRASHED"
  | "LOST"
  | "AGENT_ERROR";

export type Source = "AI" | "MANUAL";

export interface ExecInfo {
  action: Action;
  source: Source;
  elapsedS: number;
  summary?: string;
}

export interface LogEvent {
  id: number;
  epoch: number;
  simT: number;
  wall: number;
  kind:
    | "system"
    | "fault"
    | "agent"
    | "tool"
    | "result"
    | "maneuver"
    | "outcome"
    | "error";
  text: string;
  detail?: string;
}

export interface LastCommand {
  action: Action;
  source: Source;
  summary?: string;
  simT: number;
  done: boolean;
}

export interface AgentInfo {
  state: "OFF" | "DECIDING" | "EXECUTING" | "DONE" | "ERROR";
  model: string;
  toolCalls: number;
  maneuvers: number;
  turns: number;
  error?: string;
  currentTool?: string;
  lastSummary?: string;
  decisionStartedAt?: number;
}

export interface MetaView {
  epoch: number;
  phase: Phase;
  mode: Source;
  paused: boolean;
  busy: boolean;
  agent: AgentInfo;
  agentAvailable: boolean;
  setupMessage?: string;
  lastCommand: LastCommand | null;
  faultInjected: boolean;
  simSpeed: number;
  aiManeuvers: number;
  manualManeuvers: number;
}

export interface StateMsg {
  epoch: number;
  state: LanderState;
  exec: ExecInfo | null;
  simRate: number; // sim seconds per wall second right now (0 when not stepping)
  projection: Prediction;
}

export interface SnapshotMsg {
  meta: MetaView;
  state: StateMsg;
  trail: [number, number][];
  log: LogEvent[];
  prediction: PredictionMsg | null;
  config: ClientConfig;
}

export interface PredictionMsg {
  epoch: number;
  source: Source;
  prediction: Prediction;
}

export interface ClientConfig {
  dt: number;
  gravity: number;
  mainMaxAccel: number;
  maxAngleDeg: number;
  lateralAccel: number;
  zone: { min: number; max: number };
  footprintHalfWidth: number;
  safeVx: number;
  safeVy: number;
  minDuration: number;
  maxDuration: number;
  startFuel: number;
}
