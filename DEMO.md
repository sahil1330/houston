# HOUSTON — 2-minute demo script

**Pitch line:** “Can Claude rescue a spacecraft when its original plan stops working?”

## Before you go on stage (2 min)

1. `.env` has a valid `ANTHROPIC_API_KEY`. For snappier decisions set `ANTHROPIC_EFFORT=low`; `medium` is more deliberate but slower.
2. `npm run dev`, open <http://localhost:5173>, full-screen the browser (≥ 1440 px wide looks best).
3. Check the top bar: **LINK** is green, model name is shown, no setup banner.
4. Press **R** to reset. Do one dry run if you can — each real run takes roughly 1–3 minutes depending on model speed.
5. Know the keys: **Enter** start · **F** thruster failure · **Space** pause · **R** reset.

## Script

**0:00 – 0:15 · Set the scene**
> “This is a lunar lander in powered descent. Claude has the controls — through three tools: read telemetry, predict a trajectory, and fire a maneuver. The physics is a deterministic simulation. Claude never sees the future; it has to ask.”

Point at the amber dotted line: *“That's where we crash if nobody does anything.”*

**0:15 – 0:35 · Start Claude**
Press **START AI MISSION**.
> “While Claude is thinking, time is frozen — it issues bounded action batches, not a joystick signal.”

Point out the scanning bar and tool chips in the AGENT panel, then the dashed cyan **planned maneuver** appearing before each burn, and the burn actually playing out.

**0:35 – 1:05 · Show it working**
Let two or three maneuvers play. Read one log line aloud:
> “It predicted, executed, and its one-line intent shows here. Telemetry on the left is the real simulator state.”

**1:05 – 1:15 · The fault** (do it while the first or second burn is executing — Claude front-loads its sideways thrust, so an early fault is the one that bites; by ~230 m the sideways work is mostly done)
Press **THRUSTER FAILURE** (or **F**).
> “I've just killed the RIGHT_PUSH thruster. It's not a label — that thruster now produces zero force.”

The screen pulses red, the banner appears, the thruster panel goes red, and the amber projection swings away from the pad.

**1:15 – 1:50 · Watch the recovery**
> “Claude's original plan leaned on that thruster. Now it has to notice — the result of its next tool call reports the fault — and compensate with the main engine's thrust vector.”

Narrate what you see: a new prediction, a steeper vector angle, a less steady throttle. Mention fuel and the speed gauge's shaded safe band.

**1:50 – 2:00 · The verdict**
The outcome card appears with exact touchdown position, speeds, fuel, and the precise reason.
> “That's the simulator's verdict, not mine, and not Claude's. Safe landing, missed zone, or crash — all real outcomes.”

## If something goes wrong

| Situation | What to say / do |
|---|---|
| Claude crashes or misses | Lean in: *“That's the point — failure is a real outcome here, there's no autopilot behind it.”* Press **R** and run again, or fault earlier/later. |
| API error banner (rate limit, bad key) | The app stops cleanly. Say so, fix the key, **R**, restart. Backup: **MANUAL MODE** to fly the same fault yourself (sliders → *Execute burn*). |
| No API key / offline | The setup banner explains it. Demonstrate manual mode: hover (≈41% throttle), then press **F** and steer right with the thrust-angle slider. |
| Decision feels slow | Press **Space** to pause and narrate the telemetry; it also shows the pause is real. |
| Want a clean slate | **R** resets everything, including faults, and kills any running agent loop. |

## Manual fallback recipe (30 s)

1. Open **MANUAL MODE**, press **HOVER** (41%), duration 3 s, execute a few times to settle descent.
2. Set lateral **RIGHT_PUSH ▸**, execute — the lander drifts right.
3. Press **F**. Execute again with RIGHT_PUSH — nothing happens (the button's effect is gone; the panel shows `✕`).
4. Set thrust angle **+9°**, throttle ~55%, execute — the main engine now does the lateral work.
