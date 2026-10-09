import {
  MOTOR, LOOP, tauClosedLoop, lockedRotorStep, currentStep, digitalCurrentStep,
  bode, margins, noisyCurrent, lowPass, noiseLeft, hallSpeedEstimate, rpmToRadS, radSToRpm, hallEdgesPerSecond,
} from "./sim.js";
import { Scope, fmt, valuesTable, sample, nearestByX } from "./charts.js";
import { RotorView, LogicStrip, HallTracker, hallStates } from "./rotor.js";

const $ = (id) => document.getElementById(id);
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const C = { measured: "var(--measured)", reference: "var(--reference)", muted: "var(--muted)", alert: "var(--alert)", ink: "var(--ink-2)" };

/** Range inputs work on 0..1000 and map to a log scale. */
const logMap = (min, max) => ({
  toValue: (pos) => min * (max / min) ** (pos / 1000),
  toPos: (val) => Math.round((1000 * Math.log(val / min)) / Math.log(max / min)),
});
function paintFill(input) {
  const f = ((input.value - input.min) / (input.max - input.min)) * 100;
  input.style.setProperty("--fill", `${f}%`);
}
function setReadout(id, value, unit) {
  const node = $(id);
  node.textContent = value;
  if (unit) { const s = document.createElement("small"); s.textContent = unit; node.appendChild(s); }
}
function setStatus(id, level, text) { const n = $(id); n.dataset.level = level; n.textContent = text; }

// ---------------------------------------------------------------- hero rotor
function initHero() {
  const rotor = new RotorView($("rotor"));
  const strip = new LogicStrip($("logic"), { window: 0.06 });
  const tracker = new HallTracker();
  const slider = $("rpm");
  const lastPulse = [-1, -1, -1];
  let rpm = +slider.value;

  const label = () => {
    $("rpm-out").textContent = `${rpm} rpm · ${fmt.sig(hallEdgesPerSecond(rpm), 3)} edges/s`;
    $("hero-rpm").textContent = rpm;
    paintFill(slider);
  };
  slider.addEventListener("input", () => { rpm = +slider.value; label(); if (reduceMotion) step(0.02); });
  label();

  function step(dt) {
    const found = tracker.advance(dt, rpmToRadS(rpm), 0.2);
    for (const e of found) lastPulse[e.k] = e.t;
    const states = hallStates(tracker.theta);
    rotor.update(tracker.theta, states, lastPulse.map((t) => (t < 0 ? Infinity : tracker.t - t)));
    $("hero-code").textContent = states.join(" ");
    $("hero-edges").textContent = `${tracker.count.toLocaleString("en")} edges`;
    strip.render(tracker);
  }

  // warm up so the logic trace is full on first paint
  for (let i = 0; i < 40; i++) step(0.002);
  if (reduceMotion) return;

  let visible = true, last = performance.now();
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; last = performance.now(); }).observe($("rotor"));
  const frame = (now) => {
    if (visible && !document.hidden) step(Math.min(Math.max((now - last) / 1000, 0), 0.05));
    last = now;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- characterise
function initTau() {
  const tauMs = MOTOR.tauE * 1e3;
  const data = [];
  for (let i = 0; i <= 300; i++) { const t = (15 * i) / 300; data.push({ x: t, y: lockedRotorStep(t / 1e3) }); }
  const chart = new Scope($("chart-tau"), {
    aspect: 0.55, minHeight: 220, maxHeight: 340,
    x: { min: 0, max: 15, label: "time [ms]", fmt: (v) => `${v}` },
    y: { min: 0, max: 1.2, label: "current [A]", ticks: [0, 0.4, 0.8, 1.2] },
    tipX: (x) => `t = ${x.toFixed(2)} ms`,
    ariaLabel: "Locked-rotor current rising to 1.04 A with a 3.36 ms time constant",
  });
  const slider = $("tau-cursor");
  const draw = () => {
    const t = +slider.value;
    const i = lockedRotorStep(t / 1e3);
    const share = (i / MOTOR.iStepFinal) * 100;
    const atTau = Math.abs(t - tauMs) < 0.05;
    $("tau-cursor-out").textContent = `${t.toFixed(2)} ms${atTau ? " = τ" : ""}`;
    setReadout("tau-t", t.toFixed(2), "ms");
    setReadout("tau-i", i.toFixed(3), "A");
    setReadout("tau-p", share.toFixed(1), "%");
    paintFill(slider);
    chart.setData(
      [{ id: "i", label: "current", color: C.measured, data, glow: true, fmt: (v) => `${v.toFixed(3)} A` }],
      [
        { type: "hline", y: MOTOR.iStepFinal, color: "var(--grid-major)", label: "final 1.04 A", labelX: "right" },
        { type: "hline", y: 0.632 * MOTOR.iStepFinal, color: C.reference, label: "63.2 %", labelX: "right" },
        { type: "vline", x: t, color: atTau ? C.reference : C.ink, label: atTau ? "τ = 3.36 ms" : `${t.toFixed(2)} ms`, anchor: t > 11 ? "end" : "start", labelY: 50 },
        { type: "dot", x: t, y: i, color: atTau ? C.reference : "var(--ink)" },
      ],
    );
  };
  slider.addEventListener("input", draw);
  draw();
}

// ---------------------------------------------------------------- current loop
function initCurrent() {
  const KP = logMap(0.2, 6);
  const slider = $("kp"), designBtn = $("kp-design");
  const iRef = 5;
  slider.value = KP.toPos(LOOP.KpDesign);
  const chart = new Scope($("chart-current"), {
    aspect: 0.58, minHeight: 240, maxHeight: 360,
    x: { min: 0, max: 6, label: "time [ms]" },
    y: { min: 0, max: 8, label: "current [A]", ticks: [0, 2, 4, 6, 8] },
    tipX: (x) => `t = ${x.toFixed(2)} ms`,
    ariaLabel: "Closed-loop current step to 5 A: continuous design and sampled loop",
  });

  const draw = () => {
    let Kp = KP.toValue(+slider.value);
    if (Math.abs(Kp - LOOP.KpDesign) < 0.015) Kp = LOOP.KpDesign;
    const tau = tauClosedLoop(Kp);
    const sampled = digitalCurrentStep(Kp, { tEnd: 6e-3, iRef }).map((p) => ({ x: p.t * 1e3, y: p.i }));
    const ideal = [];
    for (let k = 0; k <= 240; k++) { const t = (6e-3 * k) / 240; ideal.push({ x: t * 1e3, y: currentStep(t, Kp, iRef) }); }
    const peak = Math.max(...sampled.map((p) => p.y));
    const tail = sampled.slice(-20);
    const unstable = peak > 3 * iRef || Math.max(...tail.map((p) => Math.abs(p.y - iRef))) > 0.5 * iRef;
    const overshoot = Math.max(0, (peak - iRef) / iRef) * 100;

    chart.setDomain({ y: unstable ? { min: -4, max: 14, ticks: [-4, 0, 4, 8, 12] } : { min: 0, max: 8, ticks: [0, 2, 4, 6, 8] } });
    const overlays = [{ type: "hline", y: iRef, color: C.reference, width: 2, label: "I* = 5 A", labelX: "right", under: true }];
    if (tau * 1e3 <= 6) overlays.push({ type: "vline", x: tau * 1e3, color: C.ink, label: `τcl ${(tau * 1e3).toFixed(2)} ms`, anchor: tau * 1e3 > 4.5 ? "end" : "start", labelY: 96 });
    chart.setData([
      { id: "ideal", label: "continuous design", color: C.muted, width: 1.5, data: ideal, fmt: (v) => `${v.toFixed(2)} A` },
      { id: "sampled", label: "sampled 0.5 ms", color: C.measured, data: sampled, glow: true, fmt: (v) => `${v.toFixed(2)} A` },
    ], overlays);

    $("kp-out").textContent = Kp.toFixed(2);
    setReadout("cur-kp", Kp.toFixed(2));
    setReadout("cur-tau", (tau * 1e3).toFixed(tau < 1e-3 ? 3 : 2), "ms");
    setReadout("cur-ratio", fmt.sig(tau / LOOP.Tpwm, 2));
    setReadout("cur-os", unstable ? "unstable" : overshoot.toFixed(overshoot < 10 ? 1 : 0), unstable ? "" : "%");
    if (unstable) setStatus("cur-status", "bad", "Unstable with 0.5 ms sampling (above Kp ≈ 3.9)");
    else if (overshoot < 2) setStatus("cur-status", "good", "Stable, no overshoot");
    else setStatus("cur-status", "warn", `Stable, ${overshoot.toFixed(0)} % overshoot because of the 0.5 ms sampling`);
    designBtn.setAttribute("aria-pressed", String(Kp === LOOP.KpDesign));
    paintFill(slider);
    valuesTable($("cur-values"), ["t [ms]", "continuous [A]", "sampled [A]"],
      [0, 0.5, 1, 1.5, 2, 3, 4, 5, 6].map((t) => [t.toFixed(1), currentStep(t / 1e3, Kp, iRef).toFixed(3), nearestByX(sampled, t).y.toFixed(3)]));
  };
  slider.addEventListener("input", draw);
  designBtn.addEventListener("click", () => { slider.value = KP.toPos(LOOP.KpDesign); draw(); });
  draw();
}

// ---------------------------------------------------------------- filter vs margin
function initFilter() {
  const FC = logMap(30, 5000);
  const slider = $("fc"), designBtn = $("fc-design");
  slider.value = FC.toPos(LOOP.filterCut);
  const raw = noisyCurrent({ tEnd: 0.04 });
  const base = { Kp: LOOP.KpDesign };
  const noFilter = bode(base);
  const xAxis = { min: 10, max: 1e4, log: true, fmt: fmt.pow10 };

  const mag = new Scope($("chart-mag"), {
    aspect: 0.4, minHeight: 170, maxHeight: 240, pad: { b: 22 },
    x: { ...xAxis }, y: { min: -60, max: 60, label: "magnitude [dB]", ticks: [-60, -30, 0, 30, 60] },
    tipX: (w) => `ω = ${fmt.sig(w, 3)} rad/s`, ariaLabel: "Bode magnitude of the current loop",
  });
  const phase = new Scope($("chart-phase"), {
    aspect: 0.44, minHeight: 190, maxHeight: 260,
    x: { ...xAxis, label: "frequency [rad/s]" }, y: { min: -190, max: -80, label: "phase [°]", ticks: [-180, -150, -120, -90] },
    tipX: (w) => `ω = ${fmt.sig(w, 3)} rad/s`, ariaLabel: "Bode phase of the current loop",
  });
  const noise = new Scope($("chart-noise"), {
    aspect: 0.48, minHeight: 200, maxHeight: 300,
    x: { min: 0, max: 40, label: "time [ms]" }, y: { min: 2, max: 7, label: "current [A]", ticks: [2, 3, 4, 5, 6, 7] },
    tipX: (x) => `t = ${x.toFixed(1)} ms`, ariaLabel: "Noisy current measurement and its filtered version",
  });

  valuesTable($("f-values"), ["cut [rad/s]", "PM [°]", "ωc [rad/s]", "noise left"],
    [100, 250, 500, 1000, 2000].map((fc) => {
      const m = margins({ ...base, fc });
      return [fc, m.pm.toFixed(1), Math.round(m.wc), `${(noiseLeft(lowPass(raw, fc)) * 100).toFixed(0)} %`];
    }));

  const draw = () => {
    let fc = FC.toValue(+slider.value);
    if (Math.abs(fc - LOOP.filterCut) < 4) fc = LOOP.filterCut;
    const opts = { ...base, fc };
    const b = bode(opts);
    const m = margins(opts);
    const phAtWc = -180 + m.pm;
    mag.setData([
      { id: "nf", label: "no filter", color: C.muted, width: 1.5, data: noFilter.map((p) => ({ x: p.w, y: p.magDb })), fmt: (v) => `${v.toFixed(1)} dB` },
      { id: "f", label: "with filter", color: C.measured, glow: true, data: b.map((p) => ({ x: p.w, y: p.magDb })), fmt: (v) => `${v.toFixed(1)} dB` },
    ], [
      { type: "hline", y: 0, color: "var(--grid-major)" },
      { type: "dot", x: m.wc, y: 0, color: "var(--ink)", label: `ωc ${Math.round(m.wc)}`, dy: -10 },
    ]);
    phase.setData([
      { id: "nf", label: "no filter", color: C.muted, width: 1.5, data: noFilter.map((p) => ({ x: p.w, y: p.phase })), fmt: (v) => `${v.toFixed(1)}°` },
      { id: "f", label: "with filter", color: C.measured, glow: true, data: b.map((p) => ({ x: p.w, y: p.phase })), fmt: (v) => `${v.toFixed(1)}°` },
    ], [
      { type: "hline", y: -180, color: C.alert, label: "−180°", labelX: "left" },
      { type: "bracket", x: m.wc, y0: -180, y1: phAtWc, color: "var(--ink)", label: `PM ${m.pm.toFixed(0)}°`, anchor: m.wc > 2500 ? "end" : "start" },
      { type: "dot", x: m.wc, y: phAtWc, color: "var(--ink)" },
    ]);
    const filtered = lowPass(raw, fc);
    const left = noiseLeft(filtered);
    noise.setData([
      { id: "raw", label: "raw", color: C.muted, width: 1, opacity: 0.75, data: filtered.map((p) => ({ x: p.t * 1e3, y: p.raw })), fmt: (v) => `${v.toFixed(2)} A` },
      { id: "flt", label: "filtered", color: C.measured, glow: true, data: filtered.map((p) => ({ x: p.t * 1e3, y: p.filtered })), fmt: (v) => `${v.toFixed(2)} A` },
    ], [{ type: "hline", y: 5, color: C.reference, width: 2, under: true }]);

    $("fc-out").textContent = `${Math.round(fc)} rad/s`;
    setReadout("f-cut", Math.round(fc), "rad/s");
    setReadout("f-wc", Math.round(m.wc), "rad/s");
    setReadout("f-pm", m.pm.toFixed(0), "°");
    setReadout("f-noise", (left * 100).toFixed(0), "%");
    if (m.pm >= 45) setStatus("f-status", "good", "Large margin, little filtering");
    else if (m.pm >= 20) setStatus("f-status", "warn", "Reduced margin, stable");
    else setStatus("f-status", "bad", "Very small margin. In the tests, a cut-off this low made the loop unstable");
    designBtn.setAttribute("aria-pressed", String(fc === LOOP.filterCut));
    paintFill(slider);
  };
  slider.addEventListener("input", draw);
  designBtn.addEventListener("click", () => { slider.value = FC.toPos(LOOP.filterCut); draw(); });
  draw();
}

// ---------------------------------------------------------------- speed from Hall edges
function initSpeed() {
  const slider = $("spd"), zoom = $("spd-zoom");
  const chart = new Scope($("chart-speed"), {
    aspect: 0.58, minHeight: 240, maxHeight: 360,
    x: { min: 0, max: 0.8, label: "time [s]" }, y: { min: 0, max: 320, label: "speed [rpm]", ticks: [0, 100, 200, 300] },
    tipX: (x) => `t = ${x.toFixed(3)} s`, ariaLabel: "True speed and the per-edge Hall estimate",
  });
  const draw = () => {
    const target = +slider.value;
    const zoomed = zoom.getAttribute("aria-pressed") === "true";
    chart.setDomain(zoomed
      ? { x: { min: 0, max: 0.1, label: "time [s]" }, y: { min: 0, max: Math.max(60, Math.ceil(target * 0.5 / 20) * 20), ticks: undefined } }
      : { x: { min: 0, max: 0.8, label: "time [s]" }, y: { min: 0, max: 320, ticks: [0, 100, 200, 300] } });
    const w = rpmToRadS(target);
    const speedOf = (t) => w * (1 - Math.exp(-t / 0.15));
    const sim = hallSpeedEstimate(speedOf, { tEnd: 0.8, dt: 2e-5 });
    const truth = sim.filter((_, i) => i % 100 === 0).map((p) => ({ x: p.t, y: radSToRpm(p.true) }));
    const est = [];
    for (const p of sim) {
      const y = radSToRpm(p.measured);
      if (!est.length || est[est.length - 1].y !== y) est.push({ x: p.t, y });
    }
    est.push({ x: 0.8, y: est[est.length - 1].y });
    chart.setData([
      { id: "true", label: "actual", color: C.reference, data: truth, fmt: (v) => `${v.toFixed(0)} rpm` },
      { id: "hall", label: "Hall estimate", color: C.measured, step: true, glow: true, data: est, fmt: (v) => `${v.toFixed(0)} rpm` },
    ]);
    const eps = hallEdgesPerSecond(target);
    $("spd-out").textContent = `${target} rpm`;
    setReadout("spd-target", target, "rpm");
    setReadout("spd-eps", fmt.sig(eps, 3));
    setReadout("spd-dt", fmt.sig(1000 / eps, 2), "ms");
    paintFill(slider);
    valuesTable($("spd-values"), ["t [s]", "actual [rpm]", "estimate [rpm]"],
      sample(sim, 9).map((p) => [p.t.toFixed(2), radSToRpm(p.true).toFixed(0), radSToRpm(p.measured).toFixed(0)]));
  };
  slider.addEventListener("input", draw);
  zoom.addEventListener("click", () => {
    const on = zoom.getAttribute("aria-pressed") !== "true";
    zoom.setAttribute("aria-pressed", String(on));
    zoom.textContent = on ? "Show the whole ramp" : "Zoom: first 100 ms";
    draw();
  });
  draw();
}

// ---------------------------------------------------------------- optional media
async function initMedia() {
  let manifest = {};
  try { manifest = await (await fetch("media/manifest.json", { cache: "no-cache" })).json(); } catch { /* no manifest: keep defaults */ }
  if (manifest.teaser) {
    const btn = $("play-teaser"), dlg = $("teaser-dialog"), vid = $("teaser-video");
    btn.hidden = false;
    btn.addEventListener("click", () => { vid.src = "media/teaser.mp4"; dlg.showModal(); vid.play().catch(() => {}); });
    dlg.addEventListener("close", () => vid.pause());
    // links from LinkedIn Featured use ?video=1 to open the summary straight away
    if (new URLSearchParams(location.search).has("video")) btn.click();
  }
  if (manifest.scooterVideo) document.querySelector('[data-slot="scooter-video"]').hidden = false;
  if (manifest.boardPhoto) document.querySelector('[data-slot="board-photo"]').hidden = false;
}

initHero();
initTau();
initCurrent();
initFilter();
initSpeed();
initMedia();
