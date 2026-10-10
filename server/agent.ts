import Anthropic from "@anthropic-ai/sdk";
import { AGENT_LIMITS } from "../shared/constants.js";
import { isTerminal } from "../shared/sim.js";
import type { Mission } from "./mission.js";
import { FIRST_USER_MESSAGE, NUDGE_MESSAGE, buildSystemPrompt } from "./prompt.js";
import { TOOLS, runTool } from "./tools.js";

export const DEFAULT_MODEL = "claude-opus-5-5";

export interface AgentConfig {
  apiKey: string;
  model: string;
  effort: "low" | "medium" | "high";
}

class Stop extends Error {}

function describeError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError)
    return "Anthropic rejected the API key (401). Check ANTHROPIC_API_KEY.";
  if (e instanceof Anthropic.PermissionDeniedError)
    return "Anthropic denied permission for this key/model (403).";
  if (e instanceof Anthropic.NotFoundError)
    return "Model not found (404). Check ANTHROPIC_MODEL.";
  if (e instanceof Anthropic.RateLimitError)
    return "Rate limited by Anthropic (429) after retries.";
  if (e instanceof Anthropic.BadRequestError) return `Bad request (400): ${e.message}`;
  if (e instanceof Anthropic.APIConnectionError)
    return `Could not reach the Anthropic API: ${e.message}`;
  if (e instanceof Anthropic.APIError) return `Anthropic API error (${e.status ?? "?"}): ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

/**
 * Claude's control loop. Claude is the only thing that issues commands in AI
 * mode: if anything here fails, the mission stops with an AGENT_ERROR; there is
 * no fallback autopilot.
 */
export async function runAgent(
  mission: Mission,
  epoch: number,
  signal: AbortSignal,
  cfg: AgentConfig,
): Promise<void> {
  const client = new Anthropic({
    apiKey: cfg.apiKey,
    maxRetries: AGENT_LIMITS.maxApiRetries, // bounded retries on 429/5xx/network
    timeout: 120_000,
  });
  const system = buildSystemPrompt();
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: FIRST_USER_MESSAGE }];
  const live = () => mission.epoch === epoch && !signal.aborted;
  const guard = () => {
    if (!live()) throw new Stop();
  };
  let nudges = 0;

  try {
    for (;;) {
      if (isTerminal(mission.state)) break;
      if (mission.agent.turns >= AGENT_LIMITS.maxModelTurns)
        throw new Error(`Model turn budget exhausted (${AGENT_LIMITS.maxModelTurns}). Mission not completed.`);

      await mission.waitWhilePaused(epoch);
      guard();
      mission.setAgent(
        {
          state: "DECIDING",
          currentTool: undefined,
          turns: mission.agent.turns + 1,
          decisionStartedAt: Date.now(),
        },
        epoch,
      );

      const response = await client.messages.create(
        {
          model: cfg.model,
          max_tokens: 16000,
          system,
          tools: TOOLS,
          tool_choice: { type: "auto" },
          output_config: { effort: cfg.effort },
          messages,
        },
        { signal },
      );
      guard();

      if (response.stop_reason === "refusal") {
        const cat = response.stop_details?.category;
        throw new Error(`The model declined to continue (refusal${cat ? `: ${cat}` : ""}).`);
      }
      if (response.stop_reason === "max_tokens")
        throw new Error("Model response was truncated (max_tokens) before a decision.");

      // Echo the full assistant content back unchanged (keeps thinking blocks valid).
      messages.push({ role: "assistant", content: response.content as Anthropic.ContentBlockParam[] });

      // Show only the model's brief visible commentary, never reasoning.
      for (const b of response.content) {
        if (b.type === "text" && b.text.trim()) {
          const text = b.text.trim().replace(/\s+/g, " ");
          mission.addLog("agent", text.length > 320 ? text.slice(0, 317) + "…" : text, undefined, epoch);
          mission.setAgent({ lastSummary: text.slice(0, 200) }, epoch);
        }
      }

      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );

      if (toolUses.length === 0) {
        if (isTerminal(mission.state)) break;
        if (++nudges > AGENT_LIMITS.maxNudges)
          throw new Error("Claude stopped issuing commands before touchdown.");
        mission.addLog("system", "Claude ended its turn before touchdown; prompting it to continue.", undefined, epoch);
        messages.push({ role: "user", content: NUDGE_MESSAGE });
        continue;
      }

      const results: Anthropic.ToolResultBlockParam[] = [];
      let exhausted = false;
      for (const tu of toolUses) {
        guard();
        const m = mission.agent;
        const isManeuver = tu.name === "execute_maneuver";
        if (
          m.toolCalls >= AGENT_LIMITS.maxToolCalls ||
          (isManeuver && m.maneuvers >= AGENT_LIMITS.maxManeuvers)
        ) {
          exhausted = true;
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            is_error: true,
            content: JSON.stringify({ error: "Action budget exhausted. No further tool calls are allowed." }),
          });
          continue;
        }
        mission.setAgent(
          {
            toolCalls: m.toolCalls + 1,
            maneuvers: m.maneuvers + (isManeuver ? 1 : 0),
            currentTool: tu.name,
          },
          epoch,
        );
        mission.addLog("tool", `${tu.name}(${compactInput(tu.input)})`, undefined, epoch);
        const out = await runTool(mission, epoch, tu.name, tu.input);
        guard();
        mission.addLog("result", out.display, undefined, epoch);
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: out.content,
          ...(out.isError ? { is_error: true } : {}),
        });
        if (isTerminal(mission.state)) {
          // Satisfy any remaining tool_use blocks so the transcript stays well-formed.
          for (const rest of toolUses.slice(toolUses.indexOf(tu) + 1))
            results.push({
              type: "tool_result",
              tool_use_id: rest.id,
              is_error: true,
              content: JSON.stringify({ error: "Mission is over." }),
            });
          break;
        }
      }
      messages.push({ role: "user", content: results });

      if (isTerminal(mission.state)) break;
      if (exhausted)
        throw new Error(
          `Action budget exhausted (${AGENT_LIMITS.maxToolCalls} tool calls / ${AGENT_LIMITS.maxManeuvers} maneuvers). Mission not completed.`,
        );
    }
    mission.endAgent(epoch, "DONE");
  } catch (e) {
    if (e instanceof Stop || !live()) return; // reset or abort: stay silent, state already replaced
    mission.endAgent(epoch, "ERROR", describeError(e));
  }
}

function compactInput(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const o = input as Record<string, unknown>;
  return Object.entries(o)
    .filter(([k]) => k !== "summary")
    .map(([k, v]) => `${k}=${typeof v === "number" ? Number(v.toFixed(3)) : String(v)}`)
    .join(", ");
}
