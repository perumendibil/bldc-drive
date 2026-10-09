// Oscilloscope-style SVG line charts with a crosshair tooltip.
// Used live on the page and, with { static: true }, by the video and carousel renderers.

const NS = "http://www.w3.org/2000/svg";
let uid = 0;

function svgEl(tag, attrs = {}, parent) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

export function niceTicks(min, max, count = 5) {
  const span = max - min;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(+v.toFixed(12));
  return ticks;
}

function logTicks(min, max) {
  const major = [], minor = [];
  for (let e = Math.floor(Math.log10(min)); e <= Math.ceil(Math.log10(max)); e++) {
    for (let m = 1; m < 10; m++) {
      const v = m * 10 ** e;
      if (v < min * 0.999 || v > max * 1.001) continue;
      (m === 1 ? major : minor).push(v);
    }
  }
  return { major, minor };
}

export const fmt = {
  sig(v, n = 3) {
    if (!isFinite(v)) return "—";
    if (v === 0) return "0";
    const a = Math.abs(v);
    if (a >= 1e4 || a < 1e-3) return v.toExponential(1);
    return (+v.toPrecision(n)).toString();
  },
  pow10(v) {
    const e = Math.round(Math.log10(v));
    return Math.abs(v - 10 ** e) < 1e-9 * v ? `10${"⁰¹²³⁴⁵⁶⁷⁸⁹"[e] ?? "^" + e}` : fmt.sig(v);
  },
};

export class Scope {
  /**
   * opts: { height, aspect, minHeight, maxHeight, width (static),
   *         x: { min, max, log, label, ticks, fmt }, y: { min, max, label, ticks, fmt },
   *         pad: { l, r, t, b }, static, tipX(x), fontScale }
   */
  constructor(container, opts) {
    this.c = container;
    this.o = opts;
    this.id = ++uid;
    this.series = [];
    this.overlays = [];
    this.c.classList.add("chart");
    this.svg = svgEl("svg", { role: "img" }, this.c);
    if (opts.ariaLabel) this.svg.setAttribute("aria-label", opts.ariaLabel);
    if (!opts.static) {
      this.tip = document.createElement("div");
      this.tip.className = "tip";
      this.c.appendChild(this.tip);
      new ResizeObserver(() => this.render()).observe(this.c);
    }
  }

  setData(series, overlays = []) {
    this.series = series;
    this.overlays = overlays;
    this.render();
  }

  setDomain({ x, y }) {
    if (x) Object.assign(this.o.x, x);
    if (y) Object.assign(this.o.y, y);
  }

  sx(x) {
    const { x: X } = this.o;
    const f = X.log
      ? (Math.log10(x) - Math.log10(X.min)) / (Math.log10(X.max) - Math.log10(X.min))
      : (x - X.min) / (X.max - X.min);
    return this.L + f * this.W;
  }

  sy(y) {
    const { y: Y } = this.o;
    const span = Y.max - Y.min;
    const yc = Math.min(Math.max(y, Y.min - 4 * span), Y.max + 4 * span);
    return this.T + (1 - (yc - Y.min) / span) * this.H;
  }

  invX(px) {
    const { x: X } = this.o;
    const f = (px - this.L) / this.W;
    return X.log ? 10 ** (Math.log10(X.min) + f * (Math.log10(X.max) - Math.log10(X.min))) : X.min + f * (X.max - X.min);
  }

  render() {
    const o = this.o;
    const fs = o.fontScale ?? 1;
    const width = o.width ?? this.c.clientWidth;
    if (!width) return;
    let height = o.height ?? width * (o.aspect ?? 0.56);
    if (o.minHeight) height = Math.max(height, o.minHeight);
    if (o.maxHeight) height = Math.min(height, o.maxHeight);
    const pad = { l: 46 * fs, r: 14 * fs, t: 22 * fs, b: 34 * fs, ...(o.pad || {}) };
    this.L = pad.l; this.T = pad.t;
    this.W = width - pad.l - pad.r; this.H = height - pad.t - pad.b;
    const svg = this.svg;
    svg.setAttribute("width", width);
    svg.setAttribute("height", height);
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.replaceChildren();

    const defs = svgEl("defs", {}, svg);
    const clipId = `clip-${this.id}`, glowId = `glow-${this.id}`;
    svgEl("rect", { x: this.L, y: this.T - 2, width: this.W, height: this.H + 4 }, svgEl("clipPath", { id: clipId }, defs));
    const filt = svgEl("filter", { id: glowId, x: "-10%", y: "-40%", width: "120%", height: "180%" }, defs);
    svgEl("feGaussianBlur", { stdDeviation: 3.2 * fs }, filt);

    // grid
    const grid = svgEl("g", {}, svg);
    const tickText = (x, y, txt, anchor) => {
      const t = svgEl("text", { x, y, "text-anchor": anchor }, svg);
      t.style.fontSize = `${11.5 * fs}px`;
      t.textContent = txt;
      return t;
    };
    const line = (x1, y1, x2, y2, color, w = 1, parent = grid) => {
      const l = svgEl("line", { x1, y1, x2, y2, "stroke-width": w, "shape-rendering": "crispEdges" }, parent);
      l.style.stroke = color;
      return l;
    };
    const xFmt = o.x.fmt ?? fmt.sig, yFmt = o.y.fmt ?? fmt.sig;
    if (o.x.log) {
      const { major, minor } = logTicks(o.x.min, o.x.max);
      minor.forEach((v) => line(this.sx(v), this.T, this.sx(v), this.T + this.H, "var(--grid)"));
      major.forEach((v) => {
        line(this.sx(v), this.T, this.sx(v), this.T + this.H, "var(--grid-major)");
        tickText(this.sx(v), this.T + this.H + 17 * fs, xFmt(v), "middle");
      });
    } else {
      (o.x.ticks ?? niceTicks(o.x.min, o.x.max, o.x.count ?? 6)).forEach((v) => {
        line(this.sx(v), this.T, this.sx(v), this.T + this.H, "var(--grid)");
        tickText(this.sx(v), this.T + this.H + 17 * fs, xFmt(v), "middle");
      });
    }
    (o.y.ticks ?? niceTicks(o.y.min, o.y.max, o.y.count ?? 4)).forEach((v) => {
      line(this.L, this.sy(v), this.L + this.W, this.sy(v), v === 0 ? "var(--grid-major)" : "var(--grid)");
      tickText(this.L - 7 * fs, this.sy(v) + 4 * fs, yFmt(v), "end");
    });
    const frame = svgEl("rect", { x: this.L, y: this.T, width: this.W, height: this.H, fill: "none", "shape-rendering": "crispEdges" }, grid);
    frame.style.stroke = "var(--grid-major)";
    if (o.x.label) {
      const t = tickText(this.L + this.W, this.T + this.H + 31 * fs, o.x.label, "end");
      t.classList.add("axis-label");
    }
    if (o.y.label) {
      const t = tickText(this.L - 7 * fs, this.T - 9 * fs, o.y.label, "start");
      t.classList.add("axis-label");
      t.setAttribute("x", 4 * fs);
    }

    const under = svgEl("g", {}, svg);
    for (const a of this.overlays.filter((a) => a.under)) this.drawOverlay(under, a, fs, line);

    // series
    const plot = svgEl("g", { "clip-path": `url(#${clipId})` }, svg);
    for (const s of this.series) {
      if (!s.data?.length) continue;
      let d = "";
      let prev = null;
      for (const p of s.data) {
        const X = this.sx(p.x), Y = this.sy(p.y);
        if (!isFinite(X) || !isFinite(Y)) continue;
        if (!d) d = `M${X.toFixed(1)},${Y.toFixed(1)}`;
        else if (s.step && prev) d += `L${X.toFixed(1)},${prev.toFixed(1)}L${X.toFixed(1)},${Y.toFixed(1)}`;
        else d += `L${X.toFixed(1)},${Y.toFixed(1)}`;
        prev = Y;
      }
      const w = (s.width ?? 2) * fs;
      if (s.glow) {
        const g = svgEl("path", { d, fill: "none", "stroke-width": w * 2.2, "stroke-linejoin": "round", "stroke-linecap": "round", filter: `url(#${glowId})`, opacity: 0.55 }, plot);
        g.style.stroke = s.color;
      }
      const path = svgEl("path", { d, fill: "none", "stroke-width": w, "stroke-linejoin": "round", "stroke-linecap": "round", opacity: s.opacity ?? 1 }, plot);
      path.style.stroke = s.color;
    }

    // overlays
    const ov = svgEl("g", {}, svg);
    for (const a of this.overlays.filter((a) => !a.under)) this.drawOverlay(ov, a, fs, line);

    if (!o.static) this.bindHover(svg, fs);
  }

  drawOverlay(g, a, fs, line) {
    const color = a.color ?? "var(--ink-2)";
    const label = (x, y, text, anchor = "start", cls = "ann") => {
      const t = svgEl("text", { x, y, "text-anchor": anchor }, g);
      t.classList.add(cls);
      t.style.fontSize = `${(a.size ?? 12.5) * fs}px`;
      if (a.labelColor) t.style.fill = a.labelColor;
      t.textContent = text;
      return t;
    };
    if (a.type === "hline") {
      const y = this.sy(a.y);
      line(this.L, y, this.L + this.W, y, color, a.width ?? 1, g);
      if (a.label) label(a.labelX === "left" ? this.L + 6 * fs : this.L + this.W - 6 * fs, y - 6 * fs, a.label, a.labelX === "left" ? "start" : "end");
    } else if (a.type === "vline") {
      const x = this.sx(a.x);
      line(x, this.T, x, this.T + this.H, color, a.width ?? 1, g);
      if (a.label) label(x + (a.anchor === "end" ? -6 : 6) * fs, this.T + (a.labelY ?? 14) * fs, a.label, a.anchor ?? "start");
    } else if (a.type === "dot") {
      const c = svgEl("circle", { cx: this.sx(a.x), cy: this.sy(a.y), r: (a.r ?? 5) * fs, "stroke-width": 2 * fs }, g);
      c.style.fill = color;
      c.style.stroke = "var(--surface)";
      if (a.label) label(this.sx(a.x) + (a.dx ?? 9) * fs, this.sy(a.y) + (a.dy ?? -9) * fs, a.label, a.anchor ?? "start");
    } else if (a.type === "bracket") {
      const x = this.sx(a.x), y0 = this.sy(a.y0), y1 = this.sy(a.y1);
      line(x, y0, x, y1, color, 2, g);
      line(x - 5 * fs, y0, x + 5 * fs, y0, color, 2, g);
      line(x - 5 * fs, y1, x + 5 * fs, y1, color, 2, g);
      if (a.label) label(x + (a.anchor === "end" ? -10 : 10) * fs, (y0 + y1) / 2 + 4 * fs, a.label, a.anchor ?? "start");
    } else if (a.type === "text") {
      label(this.sx(a.x), this.sy(a.y), a.text, a.anchor ?? "start", a.cls ?? "ann");
    } else if (a.type === "band") {
      const r = svgEl("rect", { x: this.L, y: this.sy(a.y1), width: this.W, height: Math.max(0, this.sy(a.y0) - this.sy(a.y1)), opacity: a.opacity ?? 0.08 }, g);
      r.style.fill = color;
    }
  }

  bindHover(svg, fs) {
    const hit = svgEl("rect", { x: this.L, y: this.T, width: this.W, height: this.H, fill: "transparent", tabindex: 0 }, svg);
    hit.classList.add("plot-hit");
    hit.setAttribute("aria-label", "Chart values: use left and right arrows");
    const cross = svgEl("g", { visibility: "hidden" }, svg);
    const vl = svgEl("line", { y1: this.T, y2: this.T + this.H, "stroke-width": 1 }, cross);
    vl.style.stroke = "var(--ink-2)";
    const tracked = this.series.filter((s) => s.tooltip !== false && s.data?.length);
    const dots = tracked.map((s) => {
      const c = svgEl("circle", { r: 4.5 * fs, "stroke-width": 2 * fs }, cross);
      c.style.fill = s.color;
      c.style.stroke = "var(--surface)";
      return c;
    });
    let px = this.L + this.W / 2;

    const show = (clientX) => {
      if (clientX !== undefined) {
        const box = svg.getBoundingClientRect();
        px = clientX - box.left;
      }
      px = Math.min(Math.max(px, this.L), this.L + this.W);
      const xv = this.invX(px);
      if (!tracked.length) return;
      const nearest = tracked.map((s) => nearestByX(s.data, xv));
      const snapX = this.sx(nearest[0].x);
      vl.setAttribute("x1", snapX); vl.setAttribute("x2", snapX);
      nearest.forEach((p, i) => {
        dots[i].setAttribute("cx", this.sx(p.x));
        dots[i].setAttribute("cy", this.sy(p.y));
      });
      cross.setAttribute("visibility", "visible");
      this.tip.replaceChildren();
      const head = document.createElement("div");
      head.className = "x";
      head.textContent = (this.o.tipX ?? ((x) => fmt.sig(x)))(nearest[0].x);
      this.tip.appendChild(head);
      tracked.forEach((s, i) => {
        const row = document.createElement("div");
        row.className = "row";
        const key = document.createElement("span");
        key.className = "key";
        key.style.background = s.color;
        const val = document.createElement("b");
        val.textContent = (s.fmt ?? fmt.sig)(nearest[i].y);
        const lab = document.createElement("span");
        lab.textContent = s.label;
        row.append(key, val, lab);
        this.tip.appendChild(row);
      });
      const cw = this.c.clientWidth;
      const tw = this.tip.offsetWidth || 140;
      let left = snapX + 12;
      if (left + tw > cw) left = snapX - tw - 12;
      this.tip.style.left = `${Math.max(0, left)}px`;
      this.tip.style.top = `${this.T + 4}px`;
      this.tip.classList.add("on");
    };
    const hide = () => { cross.setAttribute("visibility", "hidden"); this.tip.classList.remove("on"); };
    hit.addEventListener("pointermove", (e) => show(e.clientX));
    hit.addEventListener("pointerdown", (e) => show(e.clientX));
    hit.addEventListener("pointerleave", hide);
    hit.addEventListener("focus", () => show());
    hit.addEventListener("blur", hide);
    hit.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") { px += this.W / 60; show(); e.preventDefault(); }
      if (e.key === "ArrowLeft") { px -= this.W / 60; show(); e.preventDefault(); }
    });
  }
}

export function nearestByX(data, x) {
  let lo = 0, hi = data.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (data[mid].x < x) lo = mid; else hi = mid;
  }
  return Math.abs(data[lo].x - x) <= Math.abs(data[hi].x - x) ? data[lo] : data[hi];
}

/** Fills a <details> table with a handful of evenly spaced rows. */
export function valuesTable(details, columns, rows) {
  const table = document.createElement("table");
  const head = table.createTHead().insertRow();
  columns.forEach((c) => { const th = document.createElement("th"); th.textContent = c; head.appendChild(th); });
  const body = table.createTBody();
  rows.forEach((r) => {
    const tr = body.insertRow();
    r.forEach((v) => { tr.insertCell().textContent = v; });
  });
  details.querySelector("table")?.remove();
  details.appendChild(table);
}

export function sample(data, n) {
  if (data.length <= n) return data;
  const out = [];
  for (let i = 0; i < n; i++) out.push(data[Math.round((i * (data.length - 1)) / (n - 1))]);
  return out;
}
