import { useEffect, useState } from "react";
import { Scene } from "./Scene.js";
import { sound } from "./audio.js";
import { store } from "./store.js";
import { Dock, ManualPanel } from "./panels/Controls.js";
import { FlyPad, TopTools } from "./panels/Fly.js";
import {
  AgentPanel,
  Banners,
  EventLog,
  LastCommand,
  Legend,
  TelemetryPanel,
  ThrusterPanel,
  TopBar,
} from "./panels/Hud.js";
import { Outcome } from "./panels/Outcome.js";
import { AlarmOverlay, Briefing, Captions } from "./panels/Story.js";

// Camera insets must match the CSS layout (see styles.css: --left, --right, --top, --bottom).
const INSETS = { left: 268, right: 352, top: 64, bottom: 92 };
const INSETS_CINEMA = { left: 16, right: 16, top: 64, bottom: 150 };

export function App() {
  const [manualOpen, setManualOpen] = useState(false);
  const [fly, setFly] = useState(false);
  const [cinema, setCinema] = useState(false);

  useEffect(() => {
    store.connect();
    const unlock = () => sound.unlock();
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "c") setCinema((v) => !v);
      else if (k === "m") sound.setMuted(!sound.muted);
      else if (k === "k" && store.meta?.mode !== "AI") {
        setFly((v) => !v);
        setManualOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div className={cinema ? "root cinema" : "root"}>
      <Scene insets={cinema ? INSETS_CINEMA : INSETS} />
      <TopBar />
      <TopTools
        manualOpen={manualOpen}
        setManualOpen={setManualOpen}
        fly={fly}
        setFly={setFly}
        cinema={cinema}
        setCinema={setCinema}
      />
      <aside className="col left">
        <TelemetryPanel />
        <ThrusterPanel />
      </aside>
      <aside className="col right">
        <AgentPanel />
        <LastCommand />
        <EventLog />
      </aside>
      <Legend />
      <Banners />
      <AlarmOverlay />
      <Briefing
        onFly={() => {
          sound.unlock();
          setFly(true);
          setManualOpen(false);
        }}
      />
      <Captions />
      <Outcome
        onChallenge={() => {
          setFly(true);
          setManualOpen(false);
        }}
      />
      {manualOpen && <ManualPanel />}
      {fly && !manualOpen && <FlyPad />}
      <Dock />
    </div>
  );
}
