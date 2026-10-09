// Outer-rotor hub motor: 15 pole pairs (30 magnets) passing over three Hall sensors.
// Sensors sit 128° apart mechanically = 120° electrical (128 · 15 = 1920 = 5·360 + 120),
// so the three signals give 6 edges per electrical cycle and 90 per mechanical turn.

const NS = "http://www.w3.org/2000/svg";
const TWO_PI = 2 * Math.PI;
export const MAGNETS = 30;
export const SENSOR_DEG = [0, 128, 256];
const SECTOR = TWO_PI / MAGNETS;
const SENSOR_RAD = SENSOR_DEG.map((d) => (d * Math.PI) / 180);

const mod = (a, m) => ((a % m) + m) % m;

/** 1 when a north pole is over sensor k at rotor angle theta (rad). */
export function hallState(theta, k) {
  return Math.floor(mod(SENSOR_RAD[k] - theta, TWO_PI) / SECTOR) % 2 === 0 ? 1 : 0;
}
export const hallStates = (theta) => [0, 1, 2].map((k) => hallState(theta, k));

/** Integrates rotor angle and records every Hall edge with its exact time. */
export class HallTracker {
  constructor() {
    this.theta = 0;
    this.t = 0;
    this.count = 0;
    this.edges = [[], [], []]; // per sensor: { t, s } state after the edge
    this.lastEdgeT = 0;
    this.lastEdgeDt = Infinity;
  }

  advance(dt, omega, keep = 0.5) {
    const ta = this.t, tb = this.t + dt;
    const tha = this.theta, thb = this.theta + omega * dt;
    const found = [];
    if (omega > 0) {
      for (let k = 0; k < 3; k++) {
        const hiM = Math.floor((SENSOR_RAD[k] - tha) / SECTOR);
        const loM = Math.floor((SENSOR_RAD[k] - thb) / SECTOR);
        for (let m = loM + 1; m <= hiM; m++) {
          const thc = SENSOR_RAD[k] - m * SECTOR;
          const te = ta + ((thc - tha) / (thb - tha)) * dt;
          found.push({ k, t: te, s: hallState(thc + 1e-7, k) });
        }
      }
    }
    found.sort((a, b) => a.t - b.t);
    for (const e of found) {
      this.edges[e.k].push({ t: e.t, s: e.s });
      this.lastEdgeDt = e.t - this.lastEdgeT;
      this.lastEdgeT = e.t;
      this.count++;
    }
    this.theta = thb;
    this.t = tb;
    for (const list of this.edges) while (list.length > 2 && list[1].t < tb - keep) list.shift();
    return found;
  }
}

function el(tag, attrs, parent) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}

function arc(r1, r2, a0, a1) {
  const p = (r, a) => `${(r * Math.sin(a)).toFixed(2)},${(-r * Math.cos(a)).toFixed(2)}`;
  return `M${p(r2, a0)}A${r2},${r2} 0 0 1 ${p(r2, a1)}L${p(r1, a1)}A${r1},${r1} 0 0 0 ${p(r1, a0)}Z`;
}

/** SVG drawing of the motor. update(theta, states, pulseAges) only touches attributes. */
export class RotorView {
  constructor(container, { size } = {}) {
    const svg = el("svg", { viewBox: "-210 -210 420 420", role: "img", "aria-label": "Hub motor: 30 magnets rotating over three Hall sensors" }, container);
    if (size) { svg.setAttribute("width", size); svg.setAttribute("height", size); }
    const defs = el("defs", {}, svg);
    const glow = el("filter", { id: "rotor-glow", x: "-50%", y: "-50%", width: "200%", height: "200%" }, defs);
    el("feGaussianBlur", { stdDeviation: 5 }, glow);
    const halo = el("radialGradient", { id: "rotor-halo" }, defs);
    el("stop", { offset: "55%", "stop-color": "#139fae", "stop-opacity": "0.16" }, halo);
    el("stop", { offset: "100%", "stop-color": "#139fae", "stop-opacity": "0" }, halo);

    el("circle", { r: 210, fill: "url(#rotor-halo)" }, svg);
    this.spin = el("g", {}, svg);
    el("circle", { r: 194, fill: "none", stroke: "#121921", "stroke-width": 16 }, this.spin);
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * TWO_PI;
      el("line", { x1: 188 * Math.sin(a), y1: -188 * Math.cos(a), x2: 200 * Math.sin(a), y2: -200 * Math.cos(a), stroke: "#1c2631", "stroke-width": 2 }, this.spin);
    }
    el("circle", { r: 182, fill: "#0b1016", stroke: "#222e3b", "stroke-width": 1.5 }, this.spin);
    const gap = (1.4 * Math.PI) / 180;
    for (let i = 0; i < MAGNETS; i++) {
      const a0 = i * SECTOR + gap / 2, a1 = (i + 1) * SECTOR - gap / 2;
      const north = i % 2 === 0;
      el("path", { d: arc(152, 176, a0, a1), fill: north ? "#139fae" : "#1d2a36", opacity: north ? 0.9 : 1 }, this.spin);
    }

    el("circle", { r: 146, fill: "#0c1117", stroke: "#1f2a36", "stroke-width": 1.5 }, svg);
    el("circle", { r: 104, fill: "none", stroke: "#18212b", "stroke-width": 1 }, svg);

    this.sensors = SENSOR_RAD.map((a, k) => {
      const g = el("g", { transform: `rotate(${SENSOR_DEG[k]})` }, svg);
      const pulse = el("circle", { cx: 0, cy: -138, r: 10, fill: "none", stroke: "#5ef2e4", "stroke-width": 2, opacity: 0 }, g);
      const glowRect = el("rect", { x: -9, y: -144, width: 18, height: 11, rx: 3, fill: "#5ef2e4", filter: "url(#rotor-glow)", opacity: 0 }, g);
      const body = el("rect", { x: -8, y: -143.5, width: 16, height: 10, rx: 2.5, fill: "#26323f" }, g);
      const label = el("text", { x: 0, y: -116, "text-anchor": "middle", fill: "#708090", "font-family": "IBM Plex Mono, monospace", "font-size": 12, transform: `rotate(${-SENSOR_DEG[k]} 0 -116)` }, g);
      label.textContent = `H${k + 1}`;
      return { pulse, glowRect, body };
    });
  }

  update(theta, states, pulseAges = [Infinity, Infinity, Infinity]) {
    this.spin.setAttribute("transform", `rotate(${((theta * 180) / Math.PI).toFixed(3)})`);
    this.sensors.forEach((s, k) => {
      const on = states[k] === 1;
      s.body.setAttribute("fill", on ? "#5ef2e4" : "#26323f");
      s.glowRect.setAttribute("opacity", on ? 0.7 : 0);
      const age = pulseAges[k];
      if (age >= 0 && age < 0.18) {
        const f = age / 0.18;
        s.pulse.setAttribute("r", 10 + 16 * f);
        s.pulse.setAttribute("opacity", (1 - f) * 0.9);
      } else s.pulse.setAttribute("opacity", 0);
    });
  }
}

/** Three-channel logic-analyser trace of the last `window` seconds. */
export class LogicStrip {
  constructor(container, { window = 0.06, width, height, fontScale = 1 } = {}) {
    this.c = container;
    this.window = window;
    this.fixed = width ? { width, height } : null;
    this.fs = fontScale;
    this.svg = el("svg", { role: "img", "aria-label": "Hall sensor signals H1, H2, H3" }, container);
  }

  render(tracker, tNow = tracker.t) {
    const width = this.fixed?.width ?? this.c.clientWidth;
    const fs = this.fs;
    const rowH = 22 * fs, gapH = 8 * fs, labelW = 30 * fs;
    const height = this.fixed?.height ?? 3 * rowH + 2 * gapH + 4;
    const svg = this.svg;
    svg.setAttribute("width", width);
    svg.setAttribute("height", height);
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.replaceChildren();
    const t0 = tNow - this.window;
    const X = (t) => labelW + ((t - t0) / this.window) * (width - labelW);
    for (let k = 0; k < 3; k++) {
      const top = k * (rowH + gapH) + 2;
      const yHi = top + 3 * fs, yLo = top + rowH - 3 * fs;
      const lab = el("text", { x: 0, y: top + rowH / 2 + 4 * fs, fill: "#708090", "font-family": "IBM Plex Mono, monospace", "font-size": 11.5 * fs }, svg);
      lab.textContent = `H${k + 1}`;
      el("line", { x1: labelW, x2: width, y1: yLo, y2: yLo, stroke: "#18212b", "stroke-width": 1 }, svg);
      const edges = tracker.edges[k];
      let state = hallStateAtStart(edges, t0, tracker, k);
      let d = `M${labelW},${state ? yHi : yLo}`;
      for (const e of edges) {
        if (e.t <= t0 || e.t > tNow) continue;
        const x = X(e.t).toFixed(1);
        d += `L${x},${state ? yHi : yLo}L${x},${e.s ? yHi : yLo}`;
        state = e.s;
      }
      d += `L${width},${state ? yHi : yLo}`;
      el("path", { d, fill: "none", stroke: "#139fae", "stroke-width": 2 * fs, "stroke-linejoin": "round" }, svg);
    }
  }
}

function hallStateAtStart(edges, t0, tracker, k) {
  let s = null;
  for (const e of edges) { if (e.t <= t0) s = e.s; else break; }
  if (s !== null) return s;
  const first = edges.find((e) => e.t > t0);
  return first ? 1 - first.s : hallState(tracker.theta, k);
}
