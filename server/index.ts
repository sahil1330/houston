import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { FAULT_DEFAULT } from "../shared/constants.js";
import { validateAction, validateCoast } from "../shared/sim.js";
import type { ThrusterName } from "../shared/types.js";
import { DEFAULT_MODEL, runAgent, type AgentConfig } from "./agent.js";
import { Mission } from "./mission.js";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, "../.env") });

const PORT = Number(process.env.PORT ?? 8787);
const apiKey = (process.env.ANTHROPIC_API_KEY ?? "").trim();
const model = (process.env.ANTHROPIC_MODEL ?? "").trim() || DEFAULT_MODEL;
const effortEnv = (process.env.ANTHROPIC_EFFORT ?? "medium").trim();
const effort = (["low", "medium", "high"].includes(effortEnv) ? effortEnv : "medium") as AgentConfig["effort"];
const simSpeed = Math.min(4, Math.max(0.25, Number(process.env.SIM_SPEED ?? 2) || 2));

const setupMessage = apiKey
  ? undefined
  : "ANTHROPIC_API_KEY is not set. Copy .env.example to .env, add your key, and restart the server. Manual mode is fully available.";

const mission = new Mission({
  simSpeed,
  model,
  agentAvailable: Boolean(apiKey),
  setupMessage,
});
mission.reset(); // seeds trail and first log line under epoch 1

const clients = new Set<http.ServerResponse>();

function send(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcast(event: string, data: unknown): void {
  for (const c of clients) send(c, event, data);
}
for (const ev of ["state", "meta", "log", "prediction", "snapshot", "fault", "outcome"] as const)
  mission.on(ev, (d) => broadcast(ev, d));

function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 16_384) throw new Error("Body too large");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
};
const distDir = path.resolve(here, "../dist");

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (!fs.existsSync(distDir)) {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("HOUSTON backend is running. Start the UI with `npm run dev` (http://localhost:5173) or `npm run build` first.");
    return;
  }
  const url = new URL(req.url ?? "/", "http://x");
  let file = path.join(distDir, decodeURIComponent(url.pathname));
  if (!file.startsWith(distDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory())
    file = path.join(distDir, "index.html");
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

const HOST = process.env.HOST ?? "127.0.0.1";
const passcode = (process.env.HOUSTON_PASSCODE ?? "").trim();
// Comma-separated list of browser origins allowed to call this API cross-origin (e.g. your Vercel URL).
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

function passcodeOk(req: http.IncomingMessage): boolean {
  if (!passcode) return true;
  const got = String(req.headers["x-houston-passcode"] ?? "");
  const a = Buffer.from(got);
  const b = Buffer.from(passcode);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Houston-Passcode");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  const route = `${req.method} ${url.pathname}`;
  try {
    if (route === "GET /api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      clients.add(res);
      send(res, "snapshot", mission.snapshot());
      const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
      req.on("close", () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }
    if (route === "GET /api/config")
      return json(res, 200, { agentAvailable: Boolean(apiKey), model, effort, setupMessage, simSpeed });

    if (route === "POST /api/mission/start-ai") {
      if (!passcodeOk(req)) return json(res, 401, { error: "Passcode required to start an AI mission." });
      const b = mission.beginAgent();
      if (!b.ok) return json(res, 409, { error: b.error });
      void runAgent(mission, b.epoch, b.signal, { apiKey, model, effort }).catch((e) =>
        mission.endAgent(b.epoch, "ERROR", e instanceof Error ? e.message : String(e)),
      );
      return json(res, 202, { ok: true });
    }
    if (route === "POST /api/mission/pause")
      return mission.pause() ? json(res, 200, { ok: true }) : json(res, 409, { error: "Cannot pause now." });
    if (route === "POST /api/mission/resume")
      return mission.resume() ? json(res, 200, { ok: true }) : json(res, 409, { error: "Not paused." });
    if (route === "POST /api/mission/speed") {
      const b = await readBody(req);
      return mission.setSpeed(Number(b["speed"])) ? json(res, 200, { ok: true }) : json(res, 400, { error: "speed must be 0.25-4" });
    }
    if (route === "POST /api/mission/reset") {
      mission.reset();
      return json(res, 200, { ok: true });
    }
    if (route === "POST /api/mission/fault") {
      const b = await readBody(req);
      const t = (b["thruster"] ?? FAULT_DEFAULT) as ThrusterName;
      if (t !== "LEFT_PUSH" && t !== "RIGHT_PUSH") return json(res, 400, { error: "Unknown thruster." });
      const r = mission.injectFault(t);
      return r.ok ? json(res, 200, { ok: true }) : json(res, 409, { error: r.error });
    }
    if (route === "POST /api/mission/maneuver" || route === "POST /api/mission/predict") {
      const b = await readBody(req);
      const v = validateAction(b);
      if (!v.ok) return json(res, 400, { error: v.error });
      if (route.endsWith("predict")) {
        const c = validateCoast(b["coast_after_s"]);
        if (!c.ok) return json(res, 400, { error: c.error });
        const p = mission.previewPrediction(v.value, c.value);
        mission.setPrediction(p, "MANUAL");
        return json(res, 200, { ok: true });
      }
      if (mission.paused) return json(res, 409, { error: "Mission is paused." });
      const s = mission.startManeuver(v.value, "MANUAL");
      return s.ok ? json(res, 202, { ok: true }) : json(res, 409, { error: s.error });
    }
    if (url.pathname.startsWith("/api/")) return json(res, 404, { error: "Not found" });
    serveStatic(req, res);
  } catch (e) {
    json(res, 400, { error: e instanceof Error ? e.message : "Bad request" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`HOUSTON backend on http://${HOST}:${PORT}`);
  if (passcode) console.log("AI start is passcode-protected.");
  else if (HOST !== "127.0.0.1") console.warn("WARNING: HOUSTON_PASSCODE is not set — anyone who can reach this server can start AI missions on your API key.");
  console.log(
    apiKey
      ? `Claude ready: model=${model}, effort=${effort}, sim speed=${simSpeed}x`
      : "ANTHROPIC_API_KEY not set — AI mission disabled, manual mode available.",
  );
});

export { server, mission };
