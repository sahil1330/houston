import { useEffect, useRef } from "react";
import { store } from "./store.js";
import { sound } from "./audio.js";
import type { Prediction } from "../../shared/types.js";

export interface Insets {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const CYAN = "79,209,217";
const AMBER = "255,176,0";
const RED = "255,59,48";
const OFFWHITE = "232,226,212";

interface P {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  kind: "exhaust" | "dust" | "spark" | "debris" | "puff";
}

// Deterministic pseudo-random helpers for procedural scenery.
function hash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function noise1(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash(i) * (1 - u) + hash(i + 1) * u;
}
function ridge(x: number): number {
  return noise1(x) * 0.6 + noise1(x * 2.3 + 40) * 0.3 + noise1(x * 5.1 + 90) * 0.1;
}

const STARS = Array.from({ length: 280 }, (_, i) => ({
  x: hash(i * 3.1),
  y: hash(i * 7.7 + 1),
  r: 0.4 + hash(i * 5.3) * 1.3,
  d: 0.2 + hash(i * 9.1) * 0.8,
  tw: hash(i * 2.2) * 6.28,
}));

export function Scene({ insets }: { insets: Insets }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const insetsRef = useRef(insets);
  insetsRef.current = insets;

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    let raf = 0;
    let last = performance.now();
    const cam = { cx: 100, s: 1.2, ybot: -30, init: false };
    const parts: P[] = [];
    let lastStatus = "FLYING";
    let lastReset = store.resetAt;
    let tdFx: { at: number; x: number; kind: string } | null = null;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(window.innerWidth * dpr);
      canvas.height = Math.floor(window.innerHeight * dpr);
      canvas.style.width = window.innerWidth + "px";
      canvas.style.height = window.innerHeight + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const spawn = (p: Omit<P, "life"> & { life?: number }) => {
      if (parts.length > 900) parts.shift();
      parts.push({ ...p, life: p.life ?? p.max });
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const W = window.innerWidth;
      const H = window.innerHeight;
      const ins = insetsRef.current;
      const aL = ins.left;
      const aR = W - ins.right;
      const aT = ins.top;
      const aB = H - ins.bottom;
      const aW = Math.max(200, aR - aL);
      const aH = Math.max(200, aB - aT);
      const cfg = store.config;
      const msg = store.msg;
      if (!msg || !cfg) {
        ctx.fillStyle = "#050709";
        ctx.fillRect(0, 0, W, H);
        return;
      }
      const t = now / 1000;
      if (store.resetAt !== lastReset) {
        lastReset = store.resetAt;
        parts.length = 0;
        tdFx = null;
        lastStatus = "FLYING";
        cam.init = false;
      }

      // ---- display state (dead-reckoned between server messages) ----
      const st = msg.state;
      let dx = st.x;
      let dy = st.y;
      if (st.status === "FLYING" && msg.simRate > 0) {
        const e = Math.min(0.1, (now - store.recvAt) / 1000) * msg.simRate;
        dx += st.vx * e;
        dy = Math.max(0, st.y + st.vy * e);
      }
      const exec = msg.exec;
      const act = exec?.action;
      const firing = !!act && msg.simRate > 0 && st.status === "FLYING" && st.fuel > 0;
      const throttle = firing ? act!.throttle : 0;
      const ang = firing ? act!.angleDeg : 0;
      const latCmd = firing ? act!.lateral : "NONE";

      // ---- camera ----
      const proj: Prediction = msg.projection;
      let minX = Math.min(dx, cfg.zone.min);
      let maxX = Math.max(dx, cfg.zone.max);
      if (proj.contact && st.status === "FLYING") {
        minX = Math.min(minX, proj.end.x);
        maxX = Math.max(maxX, proj.end.x);
      }
      const padX = Math.max(26, (maxX - minX) * 0.14);
      const spanX = Math.max(80, maxX - minX + padX * 2);
      const top = dy + Math.max(20, dy * 0.16);
      const spanY = top * 1.16;
      const tS = Math.min(Math.max(Math.min(aW / spanX, aH / spanY), 0.45), 13);
      const tC = (minX + maxX) / 2;
      const tYb = -top * 0.14;
      if (!cam.init) {
        cam.cx = tC;
        cam.s = tS;
        cam.ybot = tYb;
        cam.init = true;
      } else {
        const k = 1 - Math.exp(-dt * 2.6);
        cam.cx += (tC - cam.cx) * k;
        cam.s *= Math.exp(Math.log(tS / cam.s) * k);
        cam.ybot += (tYb - cam.ybot) * k;
      }
      const s = cam.s;
      const lateralWorking = latCmd !== "NONE" && !st.failed[latCmd as "LEFT_PUSH" | "RIGHT_PUSH"];
      sound.engine(throttle, lateralWorking);
      // Shake on fault / impact (cosmetic only).
      const sinceFault = now - store.faultAt;
      const sinceTd = now - store.outcomeAt;
      let shake = throttle * 1.4;
      if (sinceFault < 900) shake += 9 * Math.exp(-sinceFault / 280);
      if (sinceTd < 900 && tdFx?.kind === "CRASHED") shake += 16 * Math.exp(-sinceTd / 260);
      const shx = (Math.random() - 0.5) * shake;
      const shy = (Math.random() - 0.5) * shake;
      const X = (x: number) => aL + aW / 2 + (x - cam.cx) * s + shx;
      const Y = (y: number) => aB - (y - cam.ybot) * s + shy;
      const gy = Y(0);

      // ---- background ----
      const bg = ctx.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, "#03050a");
      bg.addColorStop(0.7, "#070b11");
      bg.addColorStop(1, "#0b1016");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);

      // stars
      for (const st2 of STARS) {
        const px = (((st2.x * W - cam.cx * s * 0.03 * st2.d) % W) + W) % W;
        const py = st2.y * Math.min(gy, H) * 0.95;
        const a = (0.35 + 0.65 * st2.d) * (0.75 + 0.25 * Math.sin(t * 1.3 + st2.tw));
        ctx.fillStyle = `rgba(${OFFWHITE},${a * 0.75})`;
        ctx.fillRect(px, py, st2.r, st2.r);
      }
      // distant planet
      {
        const px = W * 0.6 - cam.cx * s * 0.01;
        const py = Math.min(gy, H) * 0.24;
        const r = Math.min(W, H) * 0.075;
        const g = ctx.createRadialGradient(px - r * 0.3, py - r * 0.3, r * 0.1, px, py, r);
        g.addColorStop(0, "rgba(120,170,190,0.55)");
        g.addColorStop(0.6, "rgba(40,80,110,0.4)");
        g.addColorStop(1, "rgba(8,18,30,0.5)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, 6.283);
        ctx.fill();
        ctx.strokeStyle = `rgba(${CYAN},0.18)`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // horizon glow
      const hg = ctx.createLinearGradient(0, gy - 140, 0, gy);
      hg.addColorStop(0, "rgba(79,209,217,0)");
      hg.addColorStop(1, "rgba(79,209,217,0.07)");
      ctx.fillStyle = hg;
      ctx.fillRect(0, Math.max(0, gy - 140), W, 140);

      // parallax ridgelines
      for (const [par, hpx, col, off] of [
        [0.18, 90, "#0c1218", 3],
        [0.4, 55, "#10171e", 11],
      ] as const) {
        ctx.beginPath();
        ctx.moveTo(0, gy);
        for (let px = 0; px <= W + 8; px += 8) {
          const wx = (px + cam.cx * s * par) * 0.006 + off;
          ctx.lineTo(px, gy - ridge(wx) * hpx);
        }
        ctx.lineTo(W, gy);
        ctx.closePath();
        ctx.fillStyle = col;
        ctx.fill();
      }

      // altitude grid
      const stepM = [5, 10, 20, 50, 100, 200].find((m) => m * s >= 42) ?? 200;
      ctx.font = "10px ui-monospace, Consolas, monospace";
      ctx.textBaseline = "middle";
      for (let m = stepM; Y(m) > -10; m += stepM) {
        const yy = Y(m);
        if (yy > aB) continue;
        ctx.strokeStyle = `rgba(${OFFWHITE},0.045)`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(aL, yy);
        ctx.lineTo(aR, yy);
        ctx.stroke();
        ctx.fillStyle = `rgba(${OFFWHITE},0.38)`;
        ctx.textAlign = "left";
        ctx.fillText(`${m} m`, aL + 6, yy - 7);
        ctx.strokeStyle = `rgba(${OFFWHITE},0.28)`;
        ctx.beginPath();
        ctx.moveTo(aL, yy);
        ctx.lineTo(aL + 14, yy);
        ctx.stroke();
      }

      // surface
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(W, gy);
      ctx.lineTo(W, H);
      ctx.lineTo(0, H);
      ctx.closePath();
      const sg = ctx.createLinearGradient(0, gy, 0, H);
      sg.addColorStop(0, "#1b232b");
      sg.addColorStop(1, "#0a0e12");
      ctx.fillStyle = sg;
      ctx.fill();
      // craters (dark ellipses dipping below the surface line)
      for (let c = Math.floor((cam.cx - aW / s) / 55) - 1; c <= Math.ceil((cam.cx + aW / s) / 55) + 1; c++) {
        const r = hash(c * 1.7);
        if (r < 0.45) continue;
        const cxw = c * 55 + hash(c * 4.4) * 40;
        const rw = 7 + hash(c * 8.8) * 20;
        const zoneOverlap = cxw + rw > cfg.zone.min - 15 && cxw - rw < cfg.zone.max + 15;
        if (zoneOverlap) continue;
        ctx.fillStyle = "rgba(0,0,0,0.38)";
        ctx.beginPath();
        ctx.ellipse(X(cxw), gy + 3, rw * s, Math.min(rw * s * 0.14, 12) + 2, 0, 0, 6.283);
        ctx.fill();
      }
      // surface line + distance ticks
      ctx.strokeStyle = `rgba(${OFFWHITE},0.55)`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(W, gy);
      ctx.stroke();
      const dStep = [10, 20, 50, 100, 200].find((m) => m * s >= 70) ?? 200;
      ctx.textAlign = "center";
      for (let m = Math.ceil((cam.cx - aW / s) / dStep) * dStep; m < cam.cx + aW / s; m += dStep) {
        const xx = X(m);
        if (xx < aL || xx > aR) continue;
        ctx.strokeStyle = `rgba(${OFFWHITE},0.35)`;
        ctx.beginPath();
        ctx.moveTo(xx, gy);
        ctx.lineTo(xx, gy + 6);
        ctx.stroke();
        ctx.fillStyle = `rgba(${OFFWHITE},0.38)`;
        ctx.fillText(`${m}`, xx, gy + 16);
      }

      // ---- landing zone ----
      {
        const x0 = X(cfg.zone.min);
        const x1 = X(cfg.zone.max);
        const pulse = 0.5 + 0.5 * Math.sin(t * 2.4);
        const curtain = ctx.createLinearGradient(0, gy, 0, gy - 90);
        curtain.addColorStop(0, `rgba(${CYAN},0.16)`);
        curtain.addColorStop(1, `rgba(${CYAN},0)`);
        ctx.fillStyle = curtain;
        ctx.fillRect(x0, gy - 90, x1 - x0, 90);
        ctx.fillStyle = `rgba(${CYAN},${0.22 + 0.08 * pulse})`;
        ctx.fillRect(x0, gy - 3, x1 - x0, 6);
        ctx.fillStyle = `rgba(${CYAN},0.95)`;
        ctx.fillRect(x0, gy - 1.5, x1 - x0, 3);
        // chevrons
        ctx.strokeStyle = `rgba(${CYAN},0.5)`;
        ctx.lineWidth = 1.5;
        const chev = Math.max(14, 6 * s);
        for (let xx = x0 + chev; xx < x1 - chev / 2; xx += chev * 1.8) {
          ctx.beginPath();
          ctx.moveTo(xx - 4, gy + 5);
          ctx.lineTo(xx, gy + 10);
          ctx.lineTo(xx + 4, gy + 5);
          ctx.stroke();
        }
        // beacons
        for (const bx of [x0, x1]) {
          ctx.strokeStyle = `rgba(${CYAN},0.55)`;
          ctx.beginPath();
          ctx.moveTo(bx, gy);
          ctx.lineTo(bx, gy - 26);
          ctx.stroke();
          const gg = ctx.createRadialGradient(bx, gy - 26, 0, bx, gy - 26, 14);
          gg.addColorStop(0, `rgba(${CYAN},${0.5 + 0.5 * pulse})`);
          gg.addColorStop(1, `rgba(${CYAN},0)`);
          ctx.fillStyle = gg;
          ctx.fillRect(bx - 14, gy - 40, 28, 28);
        }
        ctx.font = "600 10px ui-monospace, Consolas, monospace";
        ctx.textAlign = "center";
        ctx.fillStyle = `rgba(${CYAN},0.9)`;
        ctx.fillText("LANDING ZONE", (x0 + x1) / 2, gy + 24);
        // safe centre-of-lander range
        const sc0 = X(cfg.zone.min + cfg.footprintHalfWidth);
        const sc1 = X(cfg.zone.max - cfg.footprintHalfWidth);
        ctx.strokeStyle = `rgba(${OFFWHITE},0.55)`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(sc0, gy + 31);
        ctx.lineTo(sc0, gy + 35);
        ctx.lineTo(sc1, gy + 35);
        ctx.lineTo(sc1, gy + 31);
        ctx.stroke();
        ctx.fillStyle = `rgba(${OFFWHITE},0.45)`;
        ctx.font = "9px ui-monospace, Consolas, monospace";
        ctx.fillText("SAFE CENTRE", (sc0 + sc1) / 2, gy + 47);
      }

      // ---- trail ----
      {
        const tr = store.trail;
        if (tr.length > 1) {
          const split = Math.floor(tr.length * 0.7);
          const pathFor = (from: number, to: number) => {
            ctx.beginPath();
            for (let i = from; i <= to; i++) {
              const p = tr[i]!;
              if (i === from) ctx.moveTo(X(p[0]), Y(p[1]));
              else ctx.lineTo(X(p[0]), Y(p[1]));
            }
            if (to === tr.length - 1) ctx.lineTo(X(dx), Y(dy));
          };
          ctx.lineJoin = "round";
          pathFor(0, split);
          ctx.strokeStyle = `rgba(${CYAN},0.28)`;
          ctx.lineWidth = 1.5;
          ctx.stroke();
          pathFor(split, tr.length - 1);
          ctx.strokeStyle = `rgba(${CYAN},0.22)`;
          ctx.lineWidth = 6;
          ctx.stroke();
          ctx.strokeStyle = `rgba(${CYAN},0.9)`;
          ctx.lineWidth = 1.8;
          ctx.stroke();
        }
      }

      // ---- ballistic projection ----
      if (st.status === "FLYING") {
        const pts = proj.points;
        ctx.setLineDash([2, 6]);
        ctx.lineCap = "round";
        ctx.lineWidth = 2;
        ctx.strokeStyle = `rgba(${AMBER},0.85)`;
        ctx.beginPath();
        ctx.moveTo(X(dx), Y(dy));
        for (let i = 1; i < pts.length; i++) ctx.lineTo(X(pts[i]!.x), Y(pts[i]!.y));
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineCap = "butt";
        if (proj.contact && proj.touchdown) {
          const td = proj.touchdown;
          const col =
            td.outcome === "LANDED" ? CYAN : td.outcome === "MISSED_ZONE" ? AMBER : RED;
          const rx = X(td.x);
          const rr = 12 + 2 * Math.sin(t * 5);
          ctx.strokeStyle = `rgba(${col},0.95)`;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(rx, gy, rr, 0, 6.283);
          ctx.stroke();
          ctx.save();
          ctx.translate(rx, gy);
          ctx.rotate(t * 1.2);
          for (let k = 0; k < 4; k++) {
            ctx.rotate(Math.PI / 2);
            ctx.beginPath();
            ctx.moveTo(rr + 3, 0);
            ctx.lineTo(rr + 10, 0);
            ctx.stroke();
          }
          ctx.restore();
          const center = (cfg.zone.min + cfg.zone.max) / 2;
          const off = td.x - center;
          const lines = [
            "IF NO FURTHER THRUST",
            `impact x ${td.x.toFixed(0)} m (${off >= 0 ? "+" : ""}${off.toFixed(0)} from zone centre)`,
            `${Math.abs(td.vy).toFixed(1)} m/s down · ${td.outcome.replace("_", " ")}`,
          ];
          ctx.font = "600 10px ui-monospace, Consolas, monospace";
          ctx.textAlign = "center";
          if (dy * s > 110 || Math.abs(X(dx) - rx) > 170)
          lines.forEach((l, i) => {
            ctx.fillStyle = i === 0 ? `rgba(${col},0.95)` : `rgba(${OFFWHITE},0.7)`;
            ctx.fillText(l, rx, gy - 62 + i * 13);
          });
        }
      }

      // ---- predicted maneuver (Claude's plan / manual preview) ----
      const pr = store.prediction?.prediction;
      if (pr && st.status === "FLYING") {
        ctx.lineWidth = 2.2;
        ctx.lineCap = "round";
        const drawSeg = (phase: string, alpha: number, dash: number[]) => {
          ctx.setLineDash(dash);
          ctx.lineDashOffset = -t * 24;
          ctx.strokeStyle = `rgba(${CYAN},${alpha})`;
          ctx.beginPath();
          let pen = false;
          for (const p of pr.points) {
            if (p.phase !== phase) {
              pen = false;
              continue;
            }
            if (!pen) {
              ctx.moveTo(X(p.x), Y(p.y));
              pen = true;
            } else ctx.lineTo(X(p.x), Y(p.y));
          }
          ctx.stroke();
        };
        // bridge so segments connect visually
        ctx.shadowColor = `rgba(${CYAN},0.9)`;
        ctx.shadowBlur = 10;
        drawSeg("controlled", 0.95, [9, 6]);
        drawSeg("ballistic", 0.4, [3, 7]);
        ctx.shadowBlur = 0;
        ctx.setLineDash([]);
        ctx.lineCap = "butt";
        const e = pr.points[pr.points.length - 1]!;
        ctx.save();
        ctx.translate(X(e.x), Y(e.y));
        ctx.rotate(Math.PI / 4);
        ctx.strokeStyle = `rgba(${CYAN},1)`;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(-4, -4, 8, 8);
        ctx.restore();
        ctx.font = "600 10px ui-monospace, Consolas, monospace";
        ctx.textAlign = "left";
        ctx.fillStyle = `rgba(${CYAN},0.95)`;
        ctx.fillText(
          store.prediction!.source === "AI" ? "CLAUDE PLAN" : "PREVIEW",
          X(e.x) + 9,
          Y(e.y) - 4,
        );
        if (pr.horizonEndedBeforeTouchdown) {
          ctx.fillStyle = `rgba(${OFFWHITE},0.6)`;
          ctx.font = "9px ui-monospace, Consolas, monospace";
          ctx.fillText("horizon ends before touchdown", X(e.x) + 9, Y(e.y) + 8);
        }
      }

      // ---- terminal transitions (cosmetic effects) ----
      if (st.status !== lastStatus) {
        lastStatus = st.status;
        if (st.status !== "FLYING") {
          tdFx = { at: now, x: st.x, kind: st.status };
          if (st.status === "CRASHED" || st.status === "LOST") {
            for (let i = 0; i < 90; i++) {
              const a = Math.PI * (0.05 + 0.9 * Math.random());
              const v = 6 + Math.random() * 22;
              spawn({
                x: st.x + (Math.random() - 0.5) * 6,
                y: 1 + Math.random() * 4,
                vx: Math.cos(a) * v * (Math.random() < 0.5 ? -1 : 1) * 0.8,
                vy: Math.sin(a) * v,
                max: 2.8,
                size: 1 + Math.random() * 2.4,
                kind: Math.random() < 0.55 ? "debris" : "spark",
              });
            }
          } else {
            for (let i = 0; i < 50; i++)
              spawn({
                x: st.x + (Math.random() - 0.5) * 8,
                y: 0.3,
                vx: (Math.random() - 0.5) * 16,
                vy: Math.random() * 3,
                max: 1.8,
                size: 3 + Math.random() * 5,
                kind: "dust",
              });
          }
        }
      }

      // ---- particle spawning ----
      const gimbal = (ang * Math.PI) / 180;
      const dirX = -Math.sin(gimbal);
      const dirY = -Math.cos(gimbal);
      if (throttle > 0.01 && dt > 0) {
        const n = Math.ceil(120 * dt * (0.4 + throttle) * (2 / Math.max(1, Math.min(2.5, msg.simRate))));
        for (let i = 0; i < n; i++) {
          const sp = 9 + 20 * throttle + Math.random() * 6;
          const jitter = (Math.random() - 0.5) * 0.28;
          const c = Math.cos(jitter);
          const sn = Math.sin(jitter);
          spawn({
            x: dx + Math.sin(gimbal) * -0.1,
            y: dy + 1.4,
            vx: (dirX * c - dirY * sn) * sp + st.vx * 0.4,
            vy: (dirX * sn + dirY * c) * sp + st.vy * 0.4,
            max: 0.35 + Math.random() * 0.45,
            size: 1.6 + throttle * 2.2 + Math.random() * 1.5,
            kind: "exhaust",
          });
        }
        if (dy < 14 && throttle > 0.1) {
          for (let i = 0; i < 3; i++) {
            const side = Math.random() < 0.5 ? -1 : 1;
            spawn({
              x: dx + side * (1 + Math.random() * 2),
              y: 0.2,
              vx: side * (6 + Math.random() * 14) * (1 - dy / 18),
              vy: Math.random() * 2.5,
              max: 1.3 + Math.random() * 0.8,
              size: 2.5 + Math.random() * 4,
              kind: "dust",
            });
          }
        }
      }
      const lateralDead =
        latCmd !== "NONE" && st.failed[latCmd as "LEFT_PUSH" | "RIGHT_PUSH"];
      // RIGHT_PUSH nozzle is on the left side (exhausts left to push right), LEFT_PUSH on the right.
      const nozzleX = (which: "LEFT_PUSH" | "RIGHT_PUSH") => (which === "RIGHT_PUSH" ? -3.6 : 3.6);
      if (latCmd !== "NONE" && !lateralDead) {
        const nx = nozzleX(latCmd as "LEFT_PUSH" | "RIGHT_PUSH");
        const sgn = nx < 0 ? -1 : 1;
        for (let i = 0; i < 3; i++)
          spawn({
            x: dx + nx,
            y: dy + 3.2,
            vx: sgn * (14 + Math.random() * 8) + st.vx * 0.3,
            vy: (Math.random() - 0.5) * 3 + st.vy * 0.3,
            max: 0.25 + Math.random() * 0.2,
            size: 1.2 + Math.random(),
            kind: "puff",
          });
      }
      for (const nm of ["LEFT_PUSH", "RIGHT_PUSH"] as const) {
        const recentlyFailed = st.failed[nm] && now - store.faultAt < 3500;
        if ((lateralDead && latCmd === nm) || (recentlyFailed && Math.random() < 0.35)) {
          const nx = nozzleX(nm);
          spawn({
            x: dx + nx,
            y: dy + 3.2,
            vx: (Math.random() - 0.5) * 12 + st.vx * 0.5,
            vy: Math.random() * 9 + st.vy * 0.5,
            max: 0.5 + Math.random() * 0.5,
            size: 1.2,
            kind: "spark",
          });
        }
      }

      // ---- particles update + draw ----
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i]!;
        p.life -= dt;
        if (p.life <= 0) {
          parts.splice(i, 1);
          continue;
        }
        if (p.kind === "debris" || p.kind === "spark") p.vy -= cfg.gravity * 2.2 * dt;
        if (p.kind === "dust") p.vx *= 1 - 0.8 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.y < 0 && (p.kind === "debris" || p.kind === "spark")) {
          p.y = 0;
          p.vy *= -0.3;
          p.vx *= 0.6;
        }
        if (p.y < 0 && p.kind === "exhaust") {
          p.y = 0;
          p.vy *= -0.2;
          p.vx *= 1.6;
        }
      }
      ctx.globalCompositeOperation = "lighter";
      for (const p of parts) {
        if (p.kind === "dust" || p.kind === "debris") continue;
        const f = p.life / p.max;
        const px = X(p.x);
        const py = Y(p.y);
        const rad = Math.max(1, p.size * Math.max(0.6, Math.min(s, 3)) * (p.kind === "exhaust" ? 0.5 + (1 - f) * 0.8 : 1));
        if (p.kind === "exhaust" || p.kind === "puff") {
          const g = ctx.createRadialGradient(px, py, 0, px, py, rad);
          if (p.kind === "puff") {
            g.addColorStop(0, `rgba(190,245,255,${0.85 * f})`);
            g.addColorStop(1, `rgba(${CYAN},0)`);
          } else {
            g.addColorStop(0, `rgba(255,248,225,${0.95 * f})`);
            g.addColorStop(0.35, `rgba(${AMBER},${0.6 * f})`);
            g.addColorStop(1, `rgba(255,90,20,0)`);
          }
          ctx.fillStyle = g;
          ctx.fillRect(px - rad, py - rad, rad * 2, rad * 2);
        } else {
          ctx.fillStyle = `rgba(255,${180 + 60 * f},60,${f})`;
          ctx.fillRect(px, py, 2, 2);
        }
      }
      ctx.globalCompositeOperation = "source-over";
      for (const p of parts) {
        if (p.kind !== "dust" && p.kind !== "debris") continue;
        const f = p.life / p.max;
        if (p.kind === "dust") {
          const rad = p.size * Math.max(0.8, Math.min(s, 3.5)) * (1.3 - f * 0.5);
          ctx.fillStyle = `rgba(150,158,165,${0.16 * f})`;
          ctx.beginPath();
          ctx.arc(X(p.x), Y(p.y), rad, 0, 6.283);
          ctx.fill();
        } else {
          ctx.fillStyle = `rgba(150,150,150,${Math.min(1, f * 1.6)})`;
          ctx.fillRect(X(p.x), Y(p.y), p.size, p.size);
        }
      }

      // ---- lander ----
      const crashed = st.status === "CRASHED" || st.status === "LOST";
      if (!crashed) {
        const ls = Math.max(s, 6.5);
        const idle = !firing && st.status === "FLYING" ? Math.sin(t * 2.1) * 2.2 : 0;
        const jolt = sinceFault < 600 ? (Math.random() - 0.5) * 7 * Math.exp(-sinceFault / 200) : 0;
        drawLander(ctx, X(dx) + jolt, Y(dy) + idle, ls, {
          now,
          gimbal,
          throttle,
          latCmd,
          failed: st.failed,
          faultAt: store.faultAt,
          landed: st.status !== "FLYING",
        });
      } else {
        const ls = Math.max(s, 6.5);
        ctx.save();
        ctx.translate(X(dx), Y(0));
        ctx.fillStyle = "#12171c";
        ctx.strokeStyle = `rgba(${OFFWHITE},0.4)`;
        ctx.lineWidth = 1;
        ctx.rotate(0.35);
        ctx.fillRect(-3 * ls, -2.4 * ls, 6 * ls, 2.4 * ls);
        ctx.strokeRect(-3 * ls, -2.4 * ls, 6 * ls, 2.4 * ls);
        ctx.restore();
      }

      // ---- touchdown rings ----
      if (tdFx) {
        const a = (now - tdFx.at) / 1000;
        if (a < 2.2) {
          const col = tdFx.kind === "LANDED" ? CYAN : tdFx.kind === "MISSED_ZONE" ? AMBER : RED;
          const r = (6 + a * 26) * s;
          ctx.strokeStyle = `rgba(${col},${Math.max(0, 0.9 - a * 0.42)})`;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.ellipse(X(tdFx.x), gy, r, r * 0.22, 0, 0, 6.283);
          ctx.stroke();
          if (a < 0.35) {
            ctx.fillStyle = `rgba(${col === RED ? "255,200,150" : "220,250,255"},${0.35 * (1 - a / 0.35)})`;
            ctx.fillRect(0, 0, W, H);
          }
        }
      }

      // ---- screen-space finish: vignette + fault flash ----
      const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
      vg.addColorStop(0, "rgba(0,0,0,0)");
      vg.addColorStop(1, "rgba(0,0,0,0.6)");
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, W, H);
      if (st.status === "FLYING" && dy < 80 && Math.abs(st.vy) > cfg.safeVy * 1.5) {
        const a = 0.16 + 0.14 * Math.sin(t * 9);
        const dg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.7);
        dg.addColorStop(0, "rgba(255,59,48,0)");
        dg.addColorStop(1, `rgba(255,59,48,${a})`);
        ctx.fillStyle = dg;
        ctx.fillRect(0, 0, W, H);
      }
      if (sinceFault < 1800) {
        const a = Math.exp(-sinceFault / 520);
        const fg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.max(W, H) * 0.7);
        fg.addColorStop(0, `rgba(${RED},0)`);
        fg.addColorStop(1, `rgba(${RED},${0.55 * a})`);
        ctx.fillStyle = fg;
        ctx.fillRect(0, 0, W, H);
      }
      // subtle scanlines
      ctx.fillStyle = "rgba(255,255,255,0.012)";
      for (let y = 0; y < H; y += 4) ctx.fillRect(0, y, W, 1);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return <canvas ref={ref} className="scene" />;
}

interface LanderFx {
  now: number;
  gimbal: number;
  throttle: number;
  latCmd: string;
  failed: { LEFT_PUSH: boolean; RIGHT_PUSH: boolean };
  faultAt: number;
  landed: boolean;
}

/** Lander at screen (px,py) = centre of footprint on the ground; `u` = px per metre. */
function drawLander(ctx: CanvasRenderingContext2D, px: number, py: number, u: number, fx: LanderFx) {
  ctx.save();
  ctx.translate(px, py);
  ctx.scale(u, -u); // local metres, +y up
  const lw = 1 / u;
  // soft shadow glow when thrusting
  if (fx.throttle > 0.02) {
    ctx.globalCompositeOperation = "lighter";
    const g = ctx.createRadialGradient(0, 1.2, 0, 0, 1.2, 9);
    g.addColorStop(0, `rgba(255,170,60,${0.28 * fx.throttle})`);
    g.addColorStop(1, "rgba(255,170,60,0)");
    ctx.fillStyle = g;
    ctx.fillRect(-10, -8, 20, 20);
    ctx.globalCompositeOperation = "source-over";
  }
  // legs
  ctx.strokeStyle = `rgba(${OFFWHITE},0.85)`;
  ctx.lineWidth = 1.6 * lw;
  for (const sgn of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(sgn * 2.2, 2);
    ctx.lineTo(sgn * 4.7, 0.15);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(sgn * 3.1, 1.2);
    ctx.lineTo(sgn * 3.6, 2.6);
    ctx.stroke();
    ctx.lineWidth = 2.2 * lw;
    ctx.beginPath();
    ctx.moveTo(sgn * 4.0, 0.1);
    ctx.lineTo(sgn * 5.5, 0.1);
    ctx.stroke();
    ctx.lineWidth = 1.6 * lw;
  }
  // engine bell (gimballed)
  ctx.save();
  ctx.translate(0, 1.9);
  ctx.rotate(-fx.gimbal * 0.9);
  ctx.fillStyle = "#2a3139";
  ctx.strokeStyle = `rgba(${OFFWHITE},0.7)`;
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.moveTo(-0.7, 0);
  ctx.lineTo(0.7, 0);
  ctx.lineTo(1.35, -1.5);
  ctx.lineTo(-1.35, -1.5);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  if (fx.throttle > 0.02) {
    ctx.globalCompositeOperation = "lighter";
    const len = (1.5 + 5 * fx.throttle) * (0.85 + 0.15 * Math.sin(fx.now * 0.06));
    const g = ctx.createLinearGradient(0, -1.5, 0, -1.5 - len);
    g.addColorStop(0, "rgba(255,250,235,0.95)");
    g.addColorStop(0.4, `rgba(${AMBER},0.7)`);
    g.addColorStop(1, "rgba(255,90,20,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-1.1, -1.5);
    ctx.lineTo(1.1, -1.5);
    ctx.lineTo(0, -1.5 - len);
    ctx.closePath();
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
  }
  ctx.restore();
  // descent stage
  ctx.fillStyle = "#171c22";
  ctx.strokeStyle = `rgba(${OFFWHITE},0.9)`;
  ctx.lineWidth = 1.2 * lw;
  ctx.beginPath();
  ctx.moveTo(-2.8, 2);
  ctx.lineTo(2.8, 2);
  ctx.lineTo(3.2, 3.2);
  ctx.lineTo(2.4, 4.5);
  ctx.lineTo(-2.4, 4.5);
  ctx.lineTo(-3.2, 3.2);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // amber stripe
  ctx.fillStyle = `rgba(${AMBER},0.9)`;
  ctx.fillRect(-2.9, 2.75, 5.8, 0.35);
  // cabin
  ctx.fillStyle = "#1d242b";
  ctx.beginPath();
  ctx.moveTo(-1.9, 4.5);
  ctx.lineTo(1.9, 4.5);
  ctx.lineTo(1.4, 6.2);
  ctx.lineTo(-1.4, 6.2);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = `rgba(${CYAN},0.95)`;
  ctx.fillRect(-0.7, 5.0, 1.4, 0.7);
  // lateral thrusters
  for (const nm of ["LEFT_PUSH", "RIGHT_PUSH"] as const) {
    // RIGHT_PUSH nozzle on the left side (pushes right); LEFT_PUSH on the right side.
    const sx = nm === "RIGHT_PUSH" ? -1 : 1;
    const dead = fx.failed[nm];
    const on = fx.latCmd === nm && !dead;
    ctx.save();
    ctx.translate(sx * 3.4, 3.2);
    ctx.fillStyle = dead ? "#3a1512" : on ? `rgba(${CYAN},0.95)` : "#2a3139";
    ctx.strokeStyle = dead
      ? `rgba(${RED},${0.6 + 0.4 * Math.sin(fx.now * 0.012)})`
      : `rgba(${OFFWHITE},0.8)`;
    ctx.lineWidth = lw;
    ctx.fillRect(sx > 0 ? -0.2 : -0.8, -0.5, 1, 1);
    ctx.strokeRect(sx > 0 ? -0.2 : -0.8, -0.5, 1, 1);
    if (dead) {
      ctx.beginPath();
      ctx.moveTo(-0.5, -0.5);
      ctx.lineTo(0.5, 0.5);
      ctx.moveTo(-0.5, 0.5);
      ctx.lineTo(0.5, -0.5);
      ctx.stroke();
    }
    ctx.restore();
  }
  if (fx.landed) {
    ctx.strokeStyle = `rgba(${CYAN},0.5)`;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.arc(0, 3.2, 7.5, 0, 6.283);
    ctx.stroke();
  }
  ctx.restore();
}
