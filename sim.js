// Motor and control-loop model of the scooter BLDC drive.
// Every constant comes from the POPBL report, annex E (characterisation + PI tuning).
// Shared by the web page, the video renderer and the carousel, so all three agree.

const TWO_PI = 2 * Math.PI;

// --- Bench characterisation (annex E.2) ---------------------------------
const VIN_LOCKED = 0.483;          // V, DC voltage with the rotor locked
const I_LOCKED = 1.02;             // A, measured current
const R_LINE = VIN_LOCKED / I_LOCKED;
const TAU_E = 3.36e-3;             // s, scope: time to 63.2 % of the current step
const EMF_PERIOD = 15.2e-3 - (-26.4e-3); // s, back-EMF period between scope cursors
const EMF_AMP = 4.8;               // V, line back-EMF amplitude at that speed

export const MOTOR = {
  polePairs: 15,
  R: R_LINE,                       // 0.4735 ohm, measured
  Rs: (2 / 3) * R_LINE,            // 0.3157 ohm, phase value used in the model
  Ls: (2 / 3) * R_LINE * TAU_E,    // 1.0607 mH
  tauE: TAU_E,
  tauSim: 3.37e-3,                 // s, same test on the Simulink motor
  iStepFinal: 1.04,                // A, final value of the locked-rotor step
  Kem: EMF_AMP / (TWO_PI / EMF_PERIOD), // V·s/rad (electrical), 0.0318
  damping: 0.014,                  // N·m·s/rad, fitted against the tachometer
  wheelMass: 4, wheelRadius: 0.1,  // kg, m (characterization_values.m)
  riderMass: 80,                   // kg
  hallEdgesPerRev: 15 * 6,         // 90 sextant changes per mechanical turn
  tachometer: [                    // supply voltage -> measured speed (annex E.5)
    { volts: 8, rpm: 154 },
    { volts: 10, rpm: 194 },
    { volts: 15, rpm: 293 },
  ],
};
MOTOR.KemPhase = MOTOR.Kem / 2;
MOTOR.Kt = MOTOR.Kem * MOTOR.polePairs; // N·m/A, as in the acceleration feed-forward (J / (Kem·p))
MOTOR.Jwheel = 0.5 * MOTOR.wheelMass * MOTOR.wheelRadius ** 2;             // 0.02 kg·m²
MOTOR.Jrider = MOTOR.Jwheel + MOTOR.riderMass * MOTOR.wheelRadius ** 2;    // 0.82 kg·m²

// --- Current (torque) loop tuning (annex E.3, E.4) -----------------------
export const LOOP = {
  fInverter: 10e3,                 // Hz
  Tpwm: 1 / 10e3,                  // s, one PWM period
  Ts: 5e-4,                        // s, control sample time on the STM32 (sample_control)
  tauCl: 1e-3,                     // s, 10x the inverter period
  K: 1 / MOTOR.Rs,                 // plant DC gain, 3.1677
  Ti: MOTOR.Ls / MOTOR.Rs,         // = tau, pole-zero cancellation
  KpDesign: 1.0607,                // = Ls / tauCl
  filterCut: 250,                  // rad/s, low-pass on the measured current
  TiScooter: 20 * (MOTOR.Ls / MOTOR.Rs), // s, slower integral used on the real scooter
};
// Speed PI from characterization_values.m: error in rpm, output in A
export const SPEED = { Kp: LOOP.KpDesign / 60, Ti: LOOP.TiScooter * 30, Imax: 30, Vdc: 24, topSpeedKmh: 15 };

/** Closed-loop time constant of the unfiltered current loop for a given Kp. */
export function tauClosedLoop(Kp) {
  return LOOP.Ti / (Kp * LOOP.K); // = Ls / Kp
}

/** Locked-rotor current step: i(t) = Ifinal (1 - e^(-t/tau)). */
export function lockedRotorStep(t, tau = MOTOR.tauE, iFinal = MOTOR.iStepFinal) {
  return t <= 0 ? 0 : iFinal * (1 - Math.exp(-t / tau));
}

/** Unfiltered closed-loop current step (first order after pole-zero cancellation). */
export function currentStep(t, Kp, iRef = 1) {
  return t <= 0 ? 0 : iRef * (1 - Math.exp(-t / tauClosedLoop(Kp)));
}

/**
 * Open-loop gain of the current loop at w (rad/s).
 * L(jw) = Kp·K / (Ti·jw) · 1/(1 + jw/fc) · e^(-jw·Td)
 * fc = 0 means no filter. Phase is returned unwrapped, in degrees.
 */
export function openLoop(w, { Kp = LOOP.KpDesign, fc = 0, Td = 0 } = {}) {
  const k = (Kp * LOOP.K) / LOOP.Ti;
  let mag = k / w;
  let phase = -90;
  if (fc > 0) {
    mag /= Math.sqrt(1 + (w / fc) ** 2);
    phase -= (Math.atan(w / fc) * 180) / Math.PI;
  }
  phase -= (w * Td * 180) / Math.PI;
  return { mag, magDb: 20 * Math.log10(mag), phase };
}

/** Gain crossover and phase margin, like MATLAB margin(). */
export function margins(opts = {}) {
  let lo = 1e-1, hi = 1e7;
  for (let i = 0; i < 200; i++) {
    const mid = Math.sqrt(lo * hi);
    if (openLoop(mid, opts).mag > 1) lo = mid; else hi = mid;
  }
  const wc = Math.sqrt(lo * hi);
  return { wc, pm: 180 + openLoop(wc, opts).phase };
}

/** Bode arrays over a log-spaced band. */
export function bode(opts = {}, { wMin = 10, wMax = 1e4, n = 240 } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const w = wMin * (wMax / wMin) ** (i / (n - 1));
    out.push({ w, ...openLoop(w, opts) });
  }
  return out;
}

/**
 * Sampled current loop, as in the Simulink controller: PI with Ti = tau updated every
 * Ts = 0.5 ms, voltage held between samples (ZOH), exact discretisation of the R-L plant.
 * Returns samples of the current for a reference step.
 */
export function digitalCurrentStep(Kp, { tEnd = 6e-3, delaySamples = 0, iRef = 1, Ts = LOOP.Ts, Ti = LOOP.Ti } = {}) {
  const a = Math.exp(-Ts / MOTOR.tauE);
  const b = (1 - a) / MOTOR.Rs;
  const n = Math.round(tEnd / Ts);
  const queue = new Array(delaySamples).fill(0);
  let i = 0, integ = 0;
  const out = [{ t: 0, i: 0 }];
  for (let k = 0; k < n; k++) {
    const e = iRef - i;
    integ += (Ts / Ti) * e;
    queue.push(Kp * (e + integ));
    const v = queue.shift();
    // continuous current inside the sample, for a smooth trace
    for (let j = 1; j <= 10; j++) {
      const aj = Math.exp((-Ts * j) / 10 / MOTOR.tauE);
      out.push({ t: k * Ts + (Ts * j) / 10, i: aj * i + ((1 - aj) / MOTOR.Rs) * v });
    }
    i = a * i + b * v;
  }
  return out;
}

/** Deterministic pseudo-random generator, so the noise looks the same on every render. */
export function rng(seed = 7) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Illustrative Hall-sensor current measurement: 5 A DC with white noise and a dip at
 * each commutation, sampled at 10 kHz. Not measured data, it shows what the filter does.
 */
export function noisyCurrent({ tEnd = 0.06, iDc = 5, sigma = 0.45, commutationPeriod = 6e-3, seed = 11 } = {}) {
  const r = rng(seed);
  const gauss = () => {
    const u = Math.max(r(), 1e-9), v = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(TWO_PI * v);
  };
  const Ts = LOOP.Tpwm;
  const n = Math.round(tEnd / Ts);
  const out = [];
  for (let k = 0; k <= n; k++) {
    const t = k * Ts;
    const ph = ((t + commutationPeriod / 2) % commutationPeriod) / commutationPeriod;
    const dip = ph < 0.05 ? -2.2 * (1 - ph / 0.05) : 0;
    out.push({ t, raw: iDc + sigma * gauss() + dip });
  }
  return out;
}

/** First-order low-pass at fc (rad/s) applied to samples taken at the PWM rate. */
export function lowPass(samples, fc, key = "raw") {
  const alpha = 1 - Math.exp(-fc * LOOP.Tpwm);
  // start at the signal mean, as if the filter had been running already
  let y = samples.reduce((acc, s) => acc + s[key], 0) / Math.max(samples.length, 1);
  return samples.map((s) => {
    y += alpha * (s[key] - y);
    return { ...s, filtered: y };
  });
}

/** Ripple left after the filter, as a share of the raw ripple (both around the raw mean). */
export function noiseLeft(filtered) {
  const mean = filtered.reduce((acc, s) => acc + s.raw, 0) / filtered.length;
  const rms = (k) => Math.sqrt(filtered.reduce((acc, s) => acc + (s[k] - mean) ** 2, 0) / filtered.length);
  return rms("filtered") / rms("raw");
}

// --- Speed measurement from Hall edges (annex E.6) ------------------------
export const rpmToRadS = (rpm) => (rpm * TWO_PI) / 60;
export const radSToRpm = (w) => (w * 60) / TWO_PI;
export const hallEdgesPerSecond = (rpm) => (rpm / 60) * MOTOR.hallEdgesPerRev;

/**
 * Speed seen by the controller: updated only at each Hall edge,
 * w = (2π/90) / Δt, held between edges (the staircase in the Simulink plot).
 * `speedOf(t)` is the true mechanical speed in rad/s.
 */
export function hallSpeedEstimate(speedOf, { tEnd, dt = 1e-4 } = {}) {
  const step = TWO_PI / MOTOR.hallEdgesPerRev;
  let angle = 0, nextEdge = step, lastEdgeT = 0, estimate = 0;
  const out = [];
  for (let t = 0; t <= tEnd + 1e-12; t += dt) {
    angle += speedOf(t) * dt;
    while (angle >= nextEdge) {
      estimate = step / (t - lastEdgeT);
      lastEdgeT = t;
      nextEdge += step;
    }
    out.push({ t, true: speedOf(t), measured: estimate });
  }
  return out;
}
