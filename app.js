// bldc-drive page logic. Every curve is computed here from sim.js (the same
// model file the studio renders use), so the page and the report use the same numbers.
import { digitalCurrentStep, lockedRotorStep, currentStep, openLoop, margins, hallSpeedEstimate, MOTOR, LOOP, rpmToRadS, radSToRpm } from "./sim.js";

const INK = "#262a6b", INK2 = "#4a4f8a", INK3 = "#9a9dc6", PAPER = "#eef0ec", GRID = "#d5d8de", RED = "#c42019";
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const smooth = (x) => { x = clamp01(x); return x * x * (3 - 2 * x); };
const actP = (el) => parseFloat(el.style.getPropertyValue("--sc-p")) || 0;
const KP_DESIGN = LOOP.KpDesign;
const TS = LOOP.Ts;
const I_REF = 5;

// ------------------------------------------------------------ geometry --
function polar(cx, cy, r, a) {
  const t = ((a - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(t), cy + r * Math.sin(t)];
}
function sector(cx, cy, r0, r1, a0, a1) {
  const p = (r, a) => polar(cx, cy, r, a).map((n) => n.toFixed(2)).join(" ");
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${p(r1, a0)}A${r1} ${r1} 0 ${large} 1 ${p(r1, a1)}L${p(r0, a1)}A${r0} ${r0} 0 ${large} 0 ${p(r0, a0)}Z`;
}
function ring(cx, cy, r0, r1) {
  return `M${cx - r1} ${cy}a${r1} ${r1} 0 1 0 ${2 * r1} 0a${r1} ${r1} 0 1 0 ${-2 * r1} 0Z` +
         `M${cx - r0} ${cy}a${r0} ${r0} 0 1 1 ${2 * r0} 0a${r0} ${r0} 0 1 1 ${-2 * r0} 0Z`;
}
/** Polyline for points {t, v} in a box. Values outside the range are not drawn: the trace leaves and comes back. */
function trace(points, box, ax) {
  const X = (t) => box.x + ((t - ax.t0) / (ax.t1 - ax.t0)) * box.w;
  const Y = (v) => box.y + box.h - ((v - ax.v0) / (ax.v1 - ax.v0)) * box.h;
  const inside = (p) => p.v >= ax.v0 && p.v <= ax.v1;
  const f = (n) => n.toFixed(1);
  let d = "", pen = false, prev = null;
  for (const p of points) {
    if (p.t > ax.t1 + 1e-12) break;
    if (inside(p)) {
      if (!pen && prev) {
        const e = prev.v > ax.v1 ? ax.v1 : ax.v0;
        const tt = prev.t + ((e - prev.v) / (p.v - prev.v)) * (p.t - prev.t);
        d += `M${f(X(tt))} ${f(Y(e))}`;
        pen = true;
      }
      d += `${pen ? "L" : "M"}${f(X(p.t))} ${f(Y(p.v))}`;
      pen = true;
    } else if (pen && prev) {
      const e = p.v > ax.v1 ? ax.v1 : ax.v0;
      const tt = prev.t + ((e - prev.v) / (p.v - prev.v)) * (p.t - prev.t);
      d += `L${f(X(tt))} ${f(Y(e))}`;
      pen = false;
    }
    prev = p;
  }
  return d;
}
function gridLines(box, ax, dt, dv) {
  let d = "";
  for (let t = ax.t0; t <= ax.t1 + 1e-12; t += dt) { const x = box.x + ((t - ax.t0) / (ax.t1 - ax.t0)) * box.w; d += `M${x.toFixed(1)} ${box.y}V${box.y + box.h}`; }
  for (let v = ax.v0; v <= ax.v1 + 1e-12; v += dv) { const y = box.y + box.h - ((v - ax.v0) / (ax.v1 - ax.v0)) * box.h; d += `M${box.x} ${y.toFixed(1)}H${box.x + box.w}`; }
  return d;
}
function cloud(x, y, w, h, r) {
  const pts = [];
  const edge = (x0, y0, x1, y1) => {
    const n = Math.max(2, Math.round(Math.hypot(x1 - x0, y1 - y0) / (r * 1.6)));
    for (let i = 1; i <= n; i++) pts.push([x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]);
  };
  edge(x, y, x + w, y); edge(x + w, y, x + w, y + h); edge(x + w, y + h, x, y + h); edge(x, y + h, x, y);
  return `M${x} ${y}` + pts.map(([px, py]) => `A${r} ${r} 0 0 1 ${px.toFixed(1)} ${py.toFixed(1)}`).join("") + "Z";
}
const txt = (x, y, s, attrs = "") => `<text x="${x.toFixed ? x.toFixed(1) : x}" y="${y.toFixed ? y.toFixed(1) : y}" ${attrs}>${s}</text>`;
const sizeOf = (el) => ({ w: Math.max(el.clientWidth, 10), h: Math.max(el.clientHeight, 10) });

// ------------------------------------------------- the sampled loop model --
const stepCache = new Map();
function sampled(kp, tEnd = 4.5e-3) {
  const key = kp.toFixed(3) + ":" + tEnd;
  if (!stepCache.has(key)) stepCache.set(key, digitalCurrentStep(kp, { tEnd, iRef: I_REF }));
  return stepCache.get(key);
}
/** Classify the loop at a gain from the model itself: overshoot, slow decay, or growth. */
function classify(kp) {
  const d = sampled(kp, 30e-3);
  const amp = (t0, t1) => Math.max(...d.filter((p) => p.t >= t0 && p.t < t1).map((p) => Math.abs(p.i - I_REF)));
  const growth = amp(20e-3, 30e-3) / Math.max(amp(10e-3, 20e-3), 1e-9);
  const peak = Math.max(...d.filter((p) => p.t <= 5e-3).map((p) => p.i));
  let state = "No overshoot";
  if (growth > 1) state = "Unstable";
  else if (growth > 0.3) state = "Edge of stability";
  else if (peak > I_REF * 1.01) state = "Overshoot";
  return { state, peak, growth };
}
const PRE = 0.5e-3; // flat lead-in before the step, one control sample
const withLead = (pts) => [{ t: 0, v: 0 }, { t: PRE, v: 0 }, ...pts.map((p) => ({ t: p.t + PRE, v: p.i }))];

// ============================================================ Section A-A ==
function drawSection() {
  const c = 500;
  let s = `<defs>
    <pattern id="h45" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="14" stroke="${INK2}" stroke-width="1.6"/></pattern>
    <pattern id="h135" width="11" height="11" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><line x1="0" y1="0" x2="0" y2="11" stroke="${INK3}" stroke-width="1.8"/></pattern>
    <pattern id="hx" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><path d="M0 0V10M0 0H10" stroke="${INK2}" stroke-width="1.3"/></pattern>
  </defs>`;
  s += `<circle cx="${c}" cy="${c}" r="497" fill="${PAPER}"/>`;
  // rim, cut and hatched
  s += `<path d="${ring(c, c, 436, 495)}" fill="url(#h45)" fill-rule="evenodd" stroke="${INK}" stroke-width="3"/>`;
  // 30 magnets for 15 pole pairs, north poles cross-hatched
  for (let k = 0; k < MOTOR.polePairs * 2; k++) {
    s += `<path d="${sector(c, c, 386, 434, k * 12 + 0.8, (k + 1) * 12 - 0.8)}" fill="${k % 2 ? PAPER : "url(#hx)"}" stroke="${INK}" stroke-width="2"/>`;
  }
  // stator: core hatched, teeth drawn on the left half (partial view), the rest as phantom outline
  s += `<path d="${ring(c, c, 134, 199)}" fill="url(#h135)" fill-rule="evenodd" stroke="${INK}" stroke-width="2.4"/>`;
  s += `<circle cx="${c}" cy="${c}" r="330" fill="none" stroke="${INK2}" stroke-width="1.6" stroke-dasharray="26 6 4 6 4 6"/>`;
  for (let a = 190; a <= 350; a += 20) {
    s += `<path d="${sector(c, c, 199, 318, a - 4, a + 4)}" fill="${PAPER}" stroke="${INK}" stroke-width="2"/>`;
    s += `<path d="${sector(c, c, 316, 330, a - 8.6, a + 8.6)}" fill="${PAPER}" stroke="${INK}" stroke-width="2"/>`;
  }
  for (let a = 200; a <= 340; a += 20) {
    for (const [r, da, dot] of [[236, -4.4, 1], [236, 4.4, 0], [284, -4.2, 1], [284, 4.2, 0]]) {
      const [x, y] = polar(c, c, r, a + da);
      s += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="8.5" fill="${PAPER}" stroke="${INK}" stroke-width="1.6"/>`;
      s += dot
        ? `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.4" fill="${INK}"/>`
        : `<path d="M${(x - 4.5).toFixed(1)} ${(y - 4.5).toFixed(1)}l9 9m0 -9l-9 9" stroke="${INK}" stroke-width="1.5"/>`;
    }
  }
  for (const a of [181, 359]) {
    const [xa, ya] = polar(c, c, 192, a), [xb, yb] = polar(c, c, 338, a);
    s += `<path d="M${xa.toFixed(1)} ${ya.toFixed(1)}L${xb.toFixed(1)} ${yb.toFixed(1)}" stroke="${INK}" stroke-width="1.4" stroke-dasharray="14 4 3 4"/>`;
  }
  // three Hall sensors in the slot openings
  for (const a of [260, 280, 300]) {
    const [x, y] = polar(c, c, 323, a);
    s += `<rect x="${(x - 8).toFixed(1)}" y="${(y - 6).toFixed(1)}" width="16" height="12" fill="${INK}" transform="rotate(${a} ${x.toFixed(1)} ${y.toFixed(1)})"/>`;
  }
  // bearing: races in section, balls not hatched
  s += `<path d="${ring(c, c, 108, 128)}" fill="url(#h45)" fill-rule="evenodd" stroke="${INK}" stroke-width="2"/>`;
  s += `<path d="${ring(c, c, 62, 80)}" fill="url(#h45)" fill-rule="evenodd" stroke="${INK}" stroke-width="2"/>`;
  for (let k = 0; k < 12; k++) { const [x, y] = polar(c, c, 94, k * 30 + 15); s += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="12.5" fill="${PAPER}" stroke="${INK}" stroke-width="1.8"/>`; }
  // axle with two flats
  s += `<path d="M466 463.3A50 50 0 0 1 534 463.3L534 536.7A50 50 0 0 1 466 536.7Z" fill="url(#h135)" stroke="${INK}" stroke-width="2.4"/>`;
  // centre lines
  s += `<path d="M0 500H1000M500 0V1000" stroke="${INK2}" stroke-width="1.4" stroke-dasharray="30 6 4 6" fill="none"/>`;
  $("#section").innerHTML = s;

  // callouts sit on their own layer, outside the clip, and arrive once the cut is through
  const balloon = (n, bx, by, tx, ty) =>
    `<path d="M${bx} ${by}L${tx.toFixed(1)} ${ty.toFixed(1)}" stroke="${INK}" stroke-width="1.6"/>` +
    `<circle cx="${tx.toFixed(1)}" cy="${ty.toFixed(1)}" r="5" fill="${INK}"/>` +
    `<circle cx="${bx}" cy="${by}" r="27" fill="${PAPER}" stroke="${INK}" stroke-width="2.2"/>` +
    `<text x="${bx}" y="${by + 10}" text-anchor="middle" font-family="Barlow Semi Condensed, sans-serif" font-weight="600" font-size="30" fill="${INK}">${n}</text>`;
  const m = polar(c, c, 410, 42), h = polar(c, c, 323, 280), w = polar(c, c, 260, 222);
  $("#callouts").innerHTML =
    balloon(1, 960, 70, m[0], m[1]) +
    balloon(2, -50, 250, h[0], h[1]) +
    balloon(3, -40, 900, w[0], w[1]) +
    balloon(4, 1000, 930, 520, 520);
}

// size the plate to the space the stage leaves, so it never pushes the label off
function sizePlate() {
  const va = $(".view-a"), plate = $("#plate"), label = $(".view-a .vlabel");
  if (!va || !plate) return;
  const phone = innerWidth < 860;
  const px = phone ? 23 : 45;   // parallax travel either way, see data-sc-parallax on #plate
  const w = va.clientWidth * (phone ? 0.82 : 0.84);
  const h = va.clientHeight - label.offsetHeight - (px + 18) - px - (phone ? 8 : 24);
  const s = Math.max(160, Math.floor(Math.min(w, h)));
  plate.style.width = plate.style.height = s + "px";
}

// ============================================================== Detail B ==
let chartBParts = null;
function drawChartB() {
  const svg = $("#chartB");
  const W = svg.clientWidth, narrow = W < 560;
  const H = Math.round(narrow ? W * 0.82 : W * 0.46);
  svg.style.height = H + "px";
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const box = { x: narrow ? 46 : 64, y: narrow ? 96 : 104, w: W - (narrow ? 46 : 64) - 12, h: H - (narrow ? 96 : 104) - 46 };
  const tMax = narrow ? 9e-3 : 13e-3, pre = 1e-3;
  const ax = { t0: 0, t1: tMax, v0: 0, v1: 1.08 };
  const X = (t) => box.x + (t / tMax) * box.w, Y = (v) => box.y + box.h - (v / 1.08) * box.h;
  const motor = [{ t: 0, v: 0 }];
  const loop = [{ t: 0, v: 0 }];
  for (let k = 0; k <= 320; k++) {
    const t = ((tMax - pre) * k) / 320;
    motor.push({ t: t + pre, v: lockedRotorStep(t) / MOTOR.iStepFinal });
    loop.push({ t: t + pre, v: currentStep(t, KP_DESIGN, 1) });
  }
  const share = 1 - Math.exp(-1);
  const x0 = X(pre), xT = X(pre + MOTOR.tauE), xC = X(pre + LOOP.tauCl), y63 = Y(share);
  const fs = narrow ? 14 : 15;
  let ticks = "";
  for (let k = 0; k * 1e-3 <= tMax - pre + 1e-9; k += 2) ticks += txt(X(pre + k * 1e-3), box.y + box.h + 20, k, `text-anchor="middle" font-size="${fs}"`);
  const yd1 = box.y - (narrow ? 66 : 70), yd2 = box.y - (narrow ? 26 : 28);
  const dim = (cls, xa, xb, y, label, note) => `
    <g class="dimg ${cls}">
      <path class="dl" pathLength="1" d="M${xa} ${y - 10}V${y63}" stroke="${INK}" stroke-width="1"/>
      <path class="dl" pathLength="1" d="M${xb} ${y - 10}V${y63}" stroke="${INK}" stroke-width="1"/>
      <path class="dl" pathLength="1" d="M${xa + 1} ${y}H${xb - 1}" stroke="${INK}" stroke-width="1.4"/>
      <g class="dh"><path d="M${xa + 1} ${y}l12 -4v8z" fill="${INK}"/><path d="M${xb - 1} ${y}l-12 -4v8z" fill="${INK}"/>
      <rect x="${(xa + xb) / 2 - 27}" y="${y - 24}" width="54" height="20" fill="${PAPER}"/>
      ${txt((xa + xb) / 2, y - 8, label, `text-anchor="middle" font-size="${narrow ? 18 : 20}" font-weight="600" fill="${INK}" style="fill:${INK}"`)}
      ${txt(xb + 14, y + 5, note, `font-size="${fs + 1}" style="fill:${INK}"`)}</g>
    </g>`;
  svg.innerHTML = `
    <path d="${gridLines(box, ax, 1e-3, 0.25)}" stroke="${GRID}" stroke-width="1" fill="none"/>
    <path d="M${box.x} ${box.y + box.h}H${box.x + box.w}M${box.x} ${box.y}V${box.y + box.h}" stroke="${INK}" stroke-width="1.4"/>
    <path d="M${box.x} ${y63}H${box.x + box.w}" stroke="${INK2}" stroke-width="1" stroke-dasharray="22 4 3 4"/>
    ${txt(box.x - 8, y63 + 5, "63.2 %", `text-anchor="end" font-size="${fs}"`)}
    ${txt(box.x - 8, Y(1) + 5, "100 %", `text-anchor="end" font-size="${fs}"`)}
    ${txt(box.x - 8, box.y + box.h + 5, "0", `text-anchor="end" font-size="${fs}"`)}
    ${ticks}
    ${txt(box.x + box.w, box.y + box.h + 40, "t after the step, ms", `text-anchor="end" font-size="${fs}" font-style="italic"`)}
    <path d="${trace(motor, box, ax)}" stroke="${INK2}" stroke-width="1.6" fill="none"/>
    <path d="${trace(loop, box, ax)}" stroke="${INK}" stroke-width="3" fill="none"/>
    <circle cx="${xT}" cy="${y63}" r="4.5" fill="${PAPER}" stroke="${INK}" stroke-width="1.6"/>
    <circle cx="${xC}" cy="${y63}" r="4.5" fill="${INK}"/>
    ${dim("d1", x0, xT, yd1, (MOTOR.tauE * 1e3).toFixed(2), narrow ? "τ, motor (measured)" : "τ, motor alone, rotor locked (measured)")}
    ${dim("d2", x0, xC, yd2, "1.00", narrow ? "τ<tspan font-size='11' dy='4'>cl</tspan><tspan dy='-4'>, current loop</tspan>" : `τ<tspan font-size='12' dy='4'>cl</tspan><tspan dy='-4'>, current loop with K</tspan><tspan font-size='12' dy='4'>p</tspan><tspan dy='-4'> = ${KP_DESIGN.toFixed(2)}</tspan>`)}
  `;
  chartBParts = { d1: $$(".d1 .dl", svg), h1: $(".d1 .dh", svg), d2: $$(".d2 .dl", svg), h2: $(".d2 .dh", svg) };
  for (const p of [...chartBParts.d1, ...chartBParts.d2]) { p.style.strokeDasharray = "1"; }
  updateChartB(true);
}
function updateChartB(force) {
  if (!chartBParts) return;
  const svg = $("#chartB");
  let q = 1;
  if (!reduce) {
    const r = svg.getBoundingClientRect();
    const cy = r.top + r.height / 2;
    q = clamp01((innerHeight * 0.92 - cy) / (innerHeight * 0.45));
  }
  const a = smooth(q / 0.55), b = smooth((q - 0.45) / 0.5);
  if (!force && a === chartBParts.a && b === chartBParts.b) return;
  chartBParts.a = a; chartBParts.b = b;
  chartBParts.d1.forEach((p) => (p.style.strokeDashoffset = String(1 - a)));
  chartBParts.d2.forEach((p) => (p.style.strokeDashoffset = String(1 - b)));
  chartBParts.h1.style.opacity = a > 0.96 ? 1 : 0;
  chartBParts.h2.style.opacity = b > 0.96 ? 1 : 0;
}

// ============================================================== Detail C ==
const live = { svg: null, box: null, ax: null, parts: {}, kp: KP_DESIGN, manual: false, shown: -1 };
function drawLive() {
  const svg = $("#live");
  const { w: W, h: H } = sizeOf(svg);
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const narrow = W < 520;
  const box = { x: narrow ? 52 : 54, y: 18, w: W - (narrow ? 52 : 54) - 14, h: H - 18 - (narrow ? 32 : 42) };
  const ax = { t0: 0, t1: 5e-3, v0: -2.5, v1: 12.5 };
  const Y = (v) => box.y + box.h - ((v - ax.v0) / (ax.v1 - ax.v0)) * box.h;
  const X = (t) => box.x + (t / ax.t1) * box.w;
  const fs = narrow ? 12 : 14;
  const ref = trace([{ t: 0, v: 0 }, { t: PRE, v: 0 }, { t: PRE, v: I_REF }, { t: ax.t1, v: I_REF }], box, ax);
  svg.innerHTML = `
    <path d="${gridLines(box, ax, TS, 2.5)}" stroke="${GRID}" stroke-width="1" fill="none"/>
    <rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="none" stroke="${INK}" stroke-width="1.4"/>
    <path d="M${box.x} ${Y(0)}H${box.x + box.w}" stroke="${INK3}" stroke-width="1.2"/>
    <path d="${ref}" stroke="${INK2}" stroke-width="1.6" stroke-dasharray="16 4 3 4" fill="none"/>
    ${txt(box.x - 16, Y(0) + 4, "0", `text-anchor="end" font-size="${fs}"`)}
    ${txt(box.x - 16, Y(5) + 4, "5", `text-anchor="end" font-size="${fs}"`)}
    ${txt(box.x - 16, Y(10) + 4, "10", `text-anchor="end" font-size="${fs}"`)}
    ${txt(box.x - 16, box.y + 4, "A", `text-anchor="end" font-size="${fs}" font-style="italic"`)}
    ${txt(box.x, box.y + box.h + (narrow ? 26 : 32), "0", `font-size="${fs}"`)}
    ${txt(box.x + box.w, box.y + box.h + (narrow ? 26 : 32), "5 ms", `text-anchor="end" font-size="${fs}"`)}
    ${narrow ? "" : txt(box.x + box.w / 2, box.y + box.h + 32, "one column = one control sample, 0.5 ms", `text-anchor="middle" font-size="13" font-style="italic"`)}
    <g id="liveSamples" fill="${INK}"></g>
    <path id="liveTrace" stroke="${INK}" stroke-width="3" fill="none" stroke-linejoin="round"/>
    <text id="liveOff" x="${box.x + box.w - 8}" y="${box.y + 18}" text-anchor="end" font-size="${fs}" font-weight="600" style="fill:${RED}" opacity="0">off scale</text>
    <path id="liveCloud" class="cloud" pathLength="1" d="${cloud(box.x - (narrow ? 7 : 10), box.y - 9, box.w + (narrow ? 14 : 20), box.h + 17, narrow ? 6 : 10)}" style="stroke-dasharray:1;stroke-dashoffset:1"/>
  `;
  live.svg = svg; live.box = box; live.ax = ax; live.shown = -1;
  live.parts = { trace: $("#liveTrace"), samples: $("#liveSamples"), off: $("#liveOff"), cloud: $("#liveCloud") };
  renderKp(live.kp, true);
}
function renderKp(kp, force) {
  kp = Math.round(kp * 100) / 100;
  if (!force && kp === live.shown) return;
  live.shown = kp;
  const pts = withLead(sampled(kp));
  const { box, ax } = live;
  live.parts.trace.setAttribute("d", trace(pts, box, ax));
  // the values the controller actually reads, one per sample
  let dots = "";
  const X = (t) => box.x + (t / ax.t1) * box.w, Y = (v) => box.y + box.h - ((v - ax.v0) / (ax.v1 - ax.v0)) * box.h;
  for (const p of pts) {
    const k = (p.t - PRE) / TS;
    if (p.t >= PRE - 1e-12 && Math.abs(k - Math.round(k)) < 1e-6 && p.v >= ax.v0 && p.v <= ax.v1) dots += `<circle cx="${X(p.t).toFixed(1)}" cy="${Y(p.v).toFixed(1)}" r="3.4"/>`;
  }
  live.parts.samples.innerHTML = dots;
  const c = classify(kp);
  const bad = c.state === "Unstable";
  const offScale = pts.some((p) => p.v > ax.v1 || p.v < ax.v0);
  live.parts.off.setAttribute("opacity", offScale ? 1 : 0);
  live.parts.cloud.style.strokeDashoffset = bad ? "0" : "1";
  live.parts.cloud.style.opacity = bad ? 1 : 0;
  $("#redline").style.opacity = bad ? 1 : 0;
  $("#kpOut").textContent = kp.toFixed(2);
  const st = $("#stateOut");
  st.textContent = c.state;
  st.classList.toggle("bad", bad);
  $("#peakOut").textContent = bad ? "keeps growing" : `${c.peak.toFixed(1)} A`;
  const input = $("#kp");
  if (document.activeElement !== input) input.value = kp.toFixed(2);
  input.setAttribute("aria-valuetext", `Kp ${kp.toFixed(2)}, ${c.state.toLowerCase()}`);
  // nearest preset in the test strip
  let best = null, bd = 1e9;
  for (const b of $$(".presets button")) { const d = Math.abs(parseFloat(b.dataset.kp) - kp); if (d < bd) { bd = d; best = b; } }
  for (const b of $$(".presets button")) b.setAttribute("aria-pressed", String(b === best && bd < 0.06));
  moveThumb(kp);
  $("#peakStage").setAttribute("data-sc-verify-state", `${kp.toFixed(2)}|${c.state}`);
}

const RULER = { m: 12, v0: 0.5, v1: 5 };
function drawRuler() {
  const svg = $("#ruler");
  const { w: W, h: H } = sizeOf(svg);
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const X = (v) => RULER.m + ((v - RULER.v0) / (RULER.v1 - RULER.v0)) * (W - 2 * RULER.m);
  const base = H - 22;
  let d = "", labels = "";
  for (let i = 0; i <= 45; i++) {
    const v = RULER.v0 + i * 0.1, major = i % 5 === 0;
    d += `M${X(v).toFixed(1)} ${base}V${base - (major ? 14 : 7)}`;
    if (major && (W > 420 || i % 10 === 5 || i === 0)) labels += txt(X(v), base + 16, v.toFixed(1), `text-anchor="middle" font-size="12" style="fill:${INK2}"`);
  }
  const mark = (v, color, label, anchor = "middle") =>
    `<path d="M${X(v).toFixed(1)} ${base}V${base - 24}" stroke="${color}" stroke-width="2"/>` +
    txt(X(v) + (anchor === "end" ? -10 : 0), anchor === "end" ? base - 17 : base - 28, label, `text-anchor="${anchor}" font-size="12" font-weight="600" style="fill:${color}"`);
  svg.innerHTML = `
    <path d="M${RULER.m} ${base}H${W - RULER.m}" stroke="${INK}" stroke-width="1.6"/>
    <path d="${d}" stroke="${INK}" stroke-width="1.2"/>
    ${labels}
    ${mark(KP_DESIGN, INK, "design", "end")}
    ${mark(2, INK2, "≈ 2")}
    ${mark(3.9, RED, "≈ 3.9")}
    <g id="thumb"><path d="M0 ${base}V${base - 30}" stroke="${INK}" stroke-width="2.5"/><path d="M-8 ${base - 42}h16l-8 11z" fill="${INK}"/></g>`;
  RULER.X = X;
  moveThumb(live.kp);
}
function moveThumb(kp) {
  const t = $("#thumb");
  if (t && RULER.X) t.setAttribute("transform", `translate(${RULER.X(Math.max(RULER.v0, Math.min(RULER.v1, kp))).toFixed(1)} 0)`);
}
function drawPresets() {
  for (const b of $$(".presets button")) {
    const svg = b.querySelector("svg");
    const { w: W, h: H } = sizeOf(svg);
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const box = { x: 1, y: 1, w: W - 2, h: H - 2 }, ax = { t0: 0, t1: 5e-3, v0: -2.5, v1: 12.5 };
    const kp = parseFloat(b.dataset.kp);
    const bad = classify(kp).state === "Unstable";
    const ref = trace([{ t: 0, v: 0 }, { t: PRE, v: 0 }, { t: PRE, v: I_REF }, { t: ax.t1, v: I_REF }], box, ax);
    svg.innerHTML = `<path d="${ref}" stroke="${INK3}" stroke-width="1" fill="none"/><path d="${trace(withLead(sampled(kp)), box, ax)}" stroke="${bad ? RED : INK}" stroke-width="1.6" fill="none"/>`;
  }
}
/** Scroll drives the gain: hold the design value, raise it past the limit, hold, come back. */
function kpFromP(p) {
  const hi = 4.5;
  if (p < 0.1) return KP_DESIGN;
  if (p < 0.6) return KP_DESIGN + (hi - KP_DESIGN) * smooth((p - 0.1) / 0.5);
  if (p < 0.74) return hi;
  if (p < 0.86) return hi + (KP_DESIGN - hi) * smooth((p - 0.74) / 0.12);
  return KP_DESIGN;
}
function setupPeak() {
  const input = $("#kp");
  input.addEventListener("input", () => { live.manual = true; live.kp = parseFloat(input.value); renderKp(live.kp); });
  for (const b of $$(".presets button")) b.addEventListener("click", () => { live.manual = true; live.kp = parseFloat(b.dataset.kp); renderKp(live.kp); });
}

// ============================================================== Detail D ==
function drawChartD() {
  const svg = $("#chartD");
  const W = svg.clientWidth, narrow = W < 460;
  const H = Math.round(W * (narrow ? 0.78 : 0.62));
  svg.style.height = H + "px";
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const box = { x: 52, y: 16, w: W - 52 - 14, h: H - 16 - 44 };
  const lx0 = 1, lx1 = 4, p0 = -185, p1 = -80;
  const X = (w) => box.x + ((Math.log10(w) - lx0) / (lx1 - lx0)) * box.w;
  const Y = (ph) => box.y + box.h - ((ph - p0) / (p1 - p0)) * box.h;
  let grid = "";
  for (let e = 1; e < 4; e++) for (let k = 1; k <= 9; k++) { const x = X(k * 10 ** e); grid += `M${x.toFixed(1)} ${box.y}V${box.y + box.h}`; }
  for (const ph of [-90, -135, -180]) grid += `M${box.x} ${Y(ph).toFixed(1)}H${box.x + box.w}`;
  const kp = KP_DESIGN, fc = LOOP.filterCut;
  let dF = "", n = 220;
  for (let i = 0; i <= n; i++) { const w = 10 ** (lx0 + ((lx1 - lx0) * i) / n); const ph = openLoop(w, { Kp: kp, fc }).phase; dF += `${i ? "L" : "M"}${X(w).toFixed(1)} ${Y(ph).toFixed(1)}`; }
  const mF = margins({ Kp: kp, fc }), mN = margins({ Kp: kp });
  const xF = X(mF.wc), yF = Y(-180 + mF.pm), xN = X(mN.wc);
  const fs = narrow ? 12 : 13;
  const vdim = (x, ya, yb, label, anchor) => `
    <path d="M${x} ${ya + 1}V${yb - 1}" stroke="${INK}" stroke-width="1.4"/>
    <path d="M${x} ${ya + 1}l-4 11h8z" fill="${INK}"/><path d="M${x} ${yb - 1}l-4 -11h8z" fill="${INK}"/>
    ${txt(anchor === "end" ? x - 8 : x + 8, (ya + yb) / 2 + 6, label, `text-anchor="${anchor}" font-size="${narrow ? 16 : 19}" font-weight="600" style="fill:${INK}"`)}`;
  svg.innerHTML = `
    <path d="${grid}" stroke="${GRID}" stroke-width="1" fill="none"/>
    <rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="none" stroke="${INK}" stroke-width="1.4"/>
    <path d="M${box.x} ${Y(-180)}H${box.x + box.w}" stroke="${INK2}" stroke-width="1.2" stroke-dasharray="22 4 3 4"/>
    <path d="M${box.x} ${Y(-90)}H${box.x + box.w}" stroke="${INK2}" stroke-width="1.6"/>
    <path d="${dF}" stroke="${INK}" stroke-width="3" fill="none"/>
    ${vdim(xF, yF, Y(-180), `${mF.pm.toFixed(0)}°`, "end")}
    ${vdim(xN, Y(-90), Y(-180), `${mN.pm.toFixed(0)}°`, "start")}
    <circle cx="${xF}" cy="${yF}" r="4.5" fill="${INK}"/>
    <path d="M${X(13)} ${Y(-158)}h26" stroke="${INK}" stroke-width="3"/>
    ${txt(X(13) + 32, Y(-158) + 4, narrow ? "with filter" : `with the ${fc} rad/s filter`, `font-size="${fs}" style="fill:${INK}"`)}
    <path d="M${X(13)} ${Y(-170)}h26" stroke="${INK2}" stroke-width="1.6"/>
    ${txt(X(13) + 32, Y(-170) + 4, "no filter", `font-size="${fs}"`)}
    ${txt(box.x - 6, Y(-90) + 4, "-90°", `text-anchor="end" font-size="${fs}"`)}
    ${txt(box.x - 6, Y(-135) + 4, "-135°", `text-anchor="end" font-size="${fs}"`)}
    ${txt(box.x - 6, Y(-180) + 4, "-180°", `text-anchor="end" font-size="${fs}"`)}
    ${[1, 2, 3, 4].map((e) => txt(X(10 ** e), box.y + box.h + 18, `10<tspan dy="-6" font-size="10">${e}</tspan>`, `text-anchor="middle" font-size="${fs}"`)).join("")}
    ${txt(box.x + box.w, box.y + box.h + 38, "ω, rad/s", `text-anchor="end" font-size="${fs}" font-style="italic"`)}
  `;
}

// ============================================================== Detail E ==
function drawChartE() {
  const svg = $("#chartE");
  const W = svg.clientWidth, narrow = W < 460;
  const H = Math.round(W * (narrow ? 0.78 : 0.62));
  svg.style.height = H + "px";
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const box = { x: 52, y: 16, w: W - 52 - 14, h: H - 16 - 44 };
  const tEnd = 0.6, rampT = 0.6, top = 200;
  const ax = { t0: 0, t1: tEnd, v0: 0, v1: 220 };
  const speedOf = (t) => rpmToRadS(Math.min(top, (top * t) / rampT));
  const est = hallSpeedEstimate(speedOf, { tEnd, dt: 1e-4 });
  const truth = [], meas = [];
  for (let i = 0; i < est.length; i += 2) {
    truth.push({ t: est[i].t, v: radSToRpm(est[i].true) });
    meas.push({ t: est[i].t, v: radSToRpm(est[i].measured) });
  }
  const X = (t) => box.x + (t / tEnd) * box.w, Y = (v) => box.y + box.h - (v / 220) * box.h;
  const fs = narrow ? 12 : 13;
  let grid = "";
  for (let t = 0.1; t < tEnd; t += 0.1) grid += `M${X(t).toFixed(1)} ${box.y}V${box.y + box.h}`;
  for (let v = 50; v <= 200; v += 50) grid += `M${box.x} ${Y(v).toFixed(1)}H${box.x + box.w}`;
  svg.innerHTML = `
    <path d="${grid}" stroke="${GRID}" stroke-width="1" fill="none"/>
    <rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="none" stroke="${INK}" stroke-width="1.4"/>
    <path d="${trace(truth, box, ax)}" stroke="${INK2}" stroke-width="1.4" stroke-dasharray="16 4 3 4" fill="none"/>
    <path d="${trace(meas, box, ax)}" stroke="${INK}" stroke-width="2.4" fill="none" stroke-linejoin="miter"/>
    ${[0, 100, 200].map((v) => txt(box.x - 6, Y(v) + 4, v, `text-anchor="end" font-size="${fs}"`)).join("")}
    ${txt(box.x - 6, box.y + 4, "rpm", `text-anchor="end" font-size="${fs}" font-style="italic"`)}
    ${[0, 0.2, 0.4, 0.6].map((t) => txt(X(t), box.y + box.h + 18, t.toFixed(1), `text-anchor="middle" font-size="${fs}"`)).join("")}
    ${txt(box.x + box.w, box.y + box.h + 38, "t, s", `text-anchor="end" font-size="${fs}" font-style="italic"`)}
    ${txt(X(0.34), Y(80), "estimate, held between edges", `font-size="${fs}" style="fill:${INK}"`)}
    ${txt(X(0.1), Y(76), "actual speed", `font-size="${fs}" font-style="italic"`)}
  `;
}

// ============================================================= navigation ==
const views = $$("main > section[data-view]");
function updateNav() {
  let cur = views[0];
  for (const v of views) if (v.getBoundingClientRect().top <= innerHeight * 0.4) cur = v;
  if (cur === updateNav.cur) return;
  updateNav.cur = cur;
  for (const a of $$(".bar-index a")) a.setAttribute("aria-current", String(a.dataset.nav === cur.id));
  $(".bar-here").textContent = cur.dataset.view;
}

// ================================================================ the loop ==
const heroAct = $("#a"), peakAct = $("#c"), plate = $("#plate");
function frame() {
  // hero: the cutting plane sweeps across, the photo becomes its section
  const ph = actP(heroAct);
  const u = reduce ? 0.5 : 0.32 + 0.74 * smooth((ph - 0.04) / 0.58);
  const co = reduce ? 1 : smooth((ph - 0.6) / 0.16);
  plate.style.setProperty("--u", u.toFixed(4));
  plate.style.setProperty("--co", co.toFixed(3));
  plate.style.setProperty("--cutop", clamp01((1.035 - u) / 0.035).toFixed(3));
  $("#heroStage").setAttribute("data-sc-verify-state", `${u.toFixed(3)}|${co.toFixed(2)}`);

  // peak: scroll drives the gain unless the visitor has taken the scale
  const pp = actP(peakAct);
  if (pp <= 0.001 || pp >= 0.999) live.manual = false;
  if (!reduce && !live.manual) { live.kp = kpFromP(pp); renderKp(live.kp); }
  $("#revb").style.opacity = reduce ? 1 : smooth((pp - 0.86) / 0.06).toFixed(3);

  updateChartB(false);
  updateNav();
  requestAnimationFrame(frame);
}

function drawAll() {
  sizePlate();
  drawChartB();
  drawRuler();
  drawPresets();
  drawLive();
  drawChartD();
  drawChartE();
}
// Pending real media (see PENDING-ASSETS.md): media/manifest.json switches each slot on.
fetch("media/manifest.json", { cache: "no-cache" })
  .then((r) => (r.ok ? r.json() : {}))
  .then((m) => {
    for (const [flag, slot] of [["scooterVideo", "scooter-video"], ["boardPhoto", "board-photo"]]) {
      if (!m[flag]) continue;
      const fig = $(`[data-slot="${slot}"]`);
      const media = fig && fig.querySelector("[data-src]");
      if (!media) continue;
      media.src = media.dataset.src;
      fig.hidden = false;
    }
  })
  .catch(() => {});

drawSection();
setupPeak();
drawAll();
let rt;
addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(drawAll, 120); });
document.fonts && document.fonts.ready.then(drawAll);
requestAnimationFrame(frame);
