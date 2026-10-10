// Exercises the agent LOOP MECHANICS (tool execution, transcript, errors, reset)
// against a local scripted stub of the Messages API. The stub is test-only: it
// is not Claude, never ships in the app, and says nothing about model quality.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { runAgent } from "../server/agent.js";
import { Mission } from "../server/mission.js";

type Reply = { status?: number; body: unknown };
interface Stub {
  url: string;
  requests: any[];
  close: () => Promise<void>;
}

async function stub(script: (req: any, n: number) => Reply): Promise<Stub> {
  const requests: any[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      requests.push(body);
      const r = script(body, requests.length - 1);
      res.writeHead(r.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

const msg = (content: unknown[], stop = "tool_use") => ({
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "stub",
  content,
  stop_reason: stop,
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
});
const tool = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
const cfg = { apiKey: "test-key", model: "stub-model", effort: "medium" as const };

function withBase<T>(url: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = url;
  return fn().finally(() => {
    if (prev === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = prev;
  });
}

test("loop: executes tool calls, returns every result, ends at touchdown", async () => {
  const s = await stub((_req, n) => {
    if (n === 0)
      return { body: msg([{ type: "text", text: "Reading telemetry." }, tool("t0", "read_telemetry", {})]) };
    return {
      body: msg([
        { type: "text", text: "Coasting." },
        tool(`t${n}`, "execute_maneuver", { throttle: 0, angle_deg: 0, lateral: "NONE", duration_s: 6, summary: "coast" }),
      ]),
    };
  });
  const m = new Mission({ simSpeed: 4, model: "stub-model", agentAvailable: true });
  try {
    const b = m.beginAgent();
    assert.ok(b.ok);
    await withBase(s.url, () => runAgent(m, (b as any).epoch, (b as any).signal, cfg));
    assert.equal(m.state.status, "CRASHED", "an unpowered descent crashes; no autopilot rescued it");
    assert.equal(m.agent.state, "DONE");
    assert.ok(m.agent.toolCalls >= 4);
    assert.ok(m.log.some((l) => l.kind === "tool" && l.text.startsWith("execute_maneuver")));
    assert.ok(m.log.some((l) => l.kind === "agent" && l.text === "Coasting."));
    // Request shape: tools present, effort set, no sampling params, no prefill, results echoed back.
    const first = s.requests[0];
    assert.equal(first.model, "stub-model");
    assert.equal(first.tools.length, 3);
    assert.deepEqual(first.output_config, { effort: "medium" });
    assert.equal(first.temperature, undefined);
    assert.match(first.system, /LEFT_PUSH/);
    const second = s.requests[1];
    const last = second.messages[second.messages.length - 1];
    assert.equal(last.role, "user");
    assert.equal(last.content[0].type, "tool_result");
    assert.equal(last.content[0].tool_use_id, "t0");
    // The run made exactly as many model calls as it needed, then stopped on touchdown.
    assert.ok(s.requests.length <= 6);
  } finally {
    m.dispose();
    await s.close();
  }
});

test("a thruster fault during Claude's burn is reported back in the tool result", async () => {
  const s = await stub((_req, n) => {
    if (n === 0)
      return {
        body: msg([tool("a", "execute_maneuver", { throttle: 0, angle_deg: 0, lateral: "RIGHT_PUSH", duration_s: 2 })]),
      };
    return { body: msg([{ type: "text", text: "done" }], "end_turn") };
  });
  const m = new Mission({ simSpeed: 4, model: "stub-model", agentAvailable: true });
  try {
    const b = m.beginAgent();
    assert.ok(b.ok);
    setTimeout(() => m.injectFault("RIGHT_PUSH"), 120);
    // end_turn before touchdown -> nudges, then error (bounded)
    await withBase(s.url, () => runAgent(m, (b as any).epoch, (b as any).signal, cfg));
    const second = s.requests[1];
    const tr = second.messages[second.messages.length - 1].content[0];
    const body = JSON.parse(tr.content);
    assert.equal(body.fault_events_during_burn.length, 1);
    assert.match(body.fault_events_during_burn[0], /RIGHT_PUSH FAILED/);
    assert.match(body.telemetry.thrusters.RIGHT_PUSH, /FAILED/);
    assert.equal(body.executed.lateral_had_effect, false);
  } finally {
    m.dispose();
    await s.close();
  }
});

test("auth failure stops cleanly with AGENT_ERROR; the lander is untouched", async () => {
  const s = await stub(() => ({
    status: 401,
    body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } },
  }));
  const m = new Mission({ simSpeed: 4, model: "stub-model", agentAvailable: true });
  try {
    const b = m.beginAgent();
    assert.ok(b.ok);
    await withBase(s.url, () => runAgent(m, (b as any).epoch, (b as any).signal, cfg));
    assert.equal(m.agent.state, "ERROR");
    assert.match(m.agent.error ?? "", /API key/);
    assert.equal(m.state.t, 0, "no commands were issued, nothing substituted");
    assert.equal(m.mode, "MANUAL");
    assert.equal(m.phase(), "AGENT_ERROR");
    assert.equal(s.requests.length, 1, "401 is not retried");
  } finally {
    m.dispose();
    await s.close();
  }
});

test("transient 5xx errors are retried a bounded number of times", async () => {
  const s = await stub(() => ({ status: 500, body: { type: "error", error: { type: "api_error", message: "boom" } } }));
  const m = new Mission({ simSpeed: 4, model: "stub-model", agentAvailable: true });
  try {
    const b = m.beginAgent();
    assert.ok(b.ok);
    await withBase(s.url, () => runAgent(m, (b as any).epoch, (b as any).signal, cfg));
    assert.equal(m.agent.state, "ERROR");
    assert.equal(s.requests.length, 3, "1 attempt + 2 retries, then stop");
  } finally {
    m.dispose();
    await s.close();
  }
});

test("reset while Claude is deciding or flying leaves no stale agent activity", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const s = await stub(() => ({
    body: msg([tool("x", "execute_maneuver", { throttle: 0, angle_deg: 0, lateral: "NONE", duration_s: 6 })]),
  }));
  const m = new Mission({ simSpeed: 4, model: "stub-model", agentAvailable: true });
  try {
    const b = m.beginAgent();
    assert.ok(b.ok);
    const run = withBase(s.url, () => runAgent(m, (b as any).epoch, (b as any).signal, cfg));
    await new Promise((r) => setTimeout(r, 150)); // maneuver is executing now
    m.reset();
    release();
    await gate;
    await run;
    const logAfter = m.log.length;
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(m.log.length, logAfter, "no late log lines from the dead loop");
    assert.equal(m.agent.state, "OFF");
    assert.equal(m.state.t, 0);
    assert.equal(m.state.status, "FLYING");
    assert.ok(m.beginAgent().ok, "slot is free again");
  } finally {
    m.dispose();
    await s.close();
  }
});

test("invalid tool input is returned to the model as an error, not executed", async () => {
  const s = await stub((_req, n) =>
    n === 0
      ? { body: msg([tool("bad", "execute_maneuver", { throttle: 9, angle_deg: 0, lateral: "NONE", duration_s: 1 })]) }
      : { body: msg([{ type: "text", text: "ok" }], "end_turn") },
  );
  const m = new Mission({ simSpeed: 4, model: "stub-model", agentAvailable: true });
  try {
    const b = m.beginAgent();
    assert.ok(b.ok);
    await withBase(s.url, () => runAgent(m, (b as any).epoch, (b as any).signal, cfg));
    const second = s.requests[1];
    const tr = second.messages[second.messages.length - 1].content[0];
    assert.equal(tr.is_error, true);
    assert.equal(m.state.t, 0);
  } finally {
    m.dispose();
    await s.close();
  }
});
