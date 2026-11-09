/* ============================================================
   charts.js - dependency-free SVG charts for Speech Insights.

   The project has no charting library (the existing sparklines are
   hand-rolled SVG), so these follow the same approach: small SVG
   builders styled with the app's CSS variables, native <title>
   tooltips, legends and axis labels. All data comes from stored
   sessions — nothing here is hardcoded or fabricated.

   Charts:
     lineChart        - metric over sessions (progress over time)
     barChart         - categorical breakdown (disfluency events)
     timelineChart    - events inside one session (time axis)
     comparisonChart  - selected sessions side by side
     consistencyChart - practice frequency/duration per day
   ============================================================ */

import { el, fmtDate, fmtNum } from "./ui.js";
import { EVENT_META } from "./detect.js";

const AXIS = "var(--muted)";
const GRID = "var(--line)";

function svgEl(width, height, label) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  svg.classList.add("chart-svg");
  return svg;
}

function make(width, height, label, children) {
  const svg = svgEl(width, height, label);
  for (const c of children) if (c) svg.append(c);
  return svg;
}

function svgNode(tag, attrs = {}, text = null) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    node.setAttribute(k, String(v));
  }
  if (text !== null) node.textContent = text;
  return node;
}

function legend(items) {
  // items: [{label, color}]
  return el("div", { class: "chart-legend" }, items.map((it) =>
    el("span", { class: "legend-item" }, [
      el("span", { class: "legend-swatch", style: `background:${it.color}` }),
      it.label,
    ])
  ));
}

function emptyState(text) {
  return el("div", { class: "chart-empty" }, [
    el("span", { class: "empty-icon", text: "📉" }),
    el("p", { text }),
  ]);
}

function niceTicks(min, max, count = 4) {
  if (min === max) { max = min + 1; }
  const span = max - min;
  const step = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step)));
  const norm = step / mag;
  const niceStep = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const start = Math.floor(min / niceStep) * niceStep;
  const ticks = [];
  for (let v = start; v <= max + niceStep * 0.5; v += niceStep) {
    ticks.push(Math.round(v * 1000) / 1000);
  }
  return ticks;
}

/* ------------------------------------------------------------------
   1. Line chart - one metric across sessions (progress over time)
   points: [{label, value, tip}]  (value may be null → gap)
------------------------------------------------------------------ */
export function lineChart(points, { yLabel = "", ariaLabel = "", color = "var(--chart-1)", emptyText = "Not enough data yet." } = {}) {
  const valid = points.filter((p) => p.value != null && !isNaN(p.value));
  if (valid.length < 2) return emptyState(emptyText);

  const W = 640, H = 260, PAD_L = 52, PAD_R = 18, PAD_T = 16, PAD_B = 44;
  const values = valid.map((p) => p.value);
  let min = Math.min(...values), max = Math.max(...values);
  const ticks = niceTicks(min, max);
  min = Math.min(min, ticks[0]);
  max = Math.max(max, ticks[ticks.length - 1]);
  if (min === max) { min -= 1; max += 1; }

  const x = (i) => PAD_L + (i / (points.length - 1)) * (W - PAD_L - PAD_R);
  const y = (v) => H - PAD_B - ((v - min) / (max - min)) * (H - PAD_T - PAD_B);

  const children = [];

  // Grid + y ticks
  for (const t of ticks) {
    children.push(svgNode("line", { x1: PAD_L, x2: W - PAD_R, y1: y(t), y2: y(t), stroke: GRID, "stroke-width": 1 }));
    children.push(svgNode("text", { x: PAD_L - 8, y: y(t) + 4, "text-anchor": "end", class: "axis-text" }, fmtNum(t)));
  }
  if (yLabel) {
    children.push(svgNode("text", { x: 4, y: 12, class: "axis-text" }, yLabel));
  }

  // X labels: first, middle, last (avoid clutter)
  const labelIdx = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
  for (const i of labelIdx) {
    children.push(svgNode("text", { x: x(i), y: H - PAD_B + 18, "text-anchor": "middle", class: "axis-text" }, points[i].short || `#${i + 1}`));
  }

  // Line path (breaks on null values)
  let d = "";
  let pen = false;
  points.forEach((p, i) => {
    if (p.value == null || isNaN(p.value)) { pen = false; return; }
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)} `;
    pen = true;
  });
  children.push(svgNode("path", { d: d.trim(), fill: "none", stroke: color, "stroke-width": 2.5, "stroke-linecap": "round", "stroke-linejoin": "round" }));

  // Points with native tooltips
  points.forEach((p, i) => {
    if (p.value == null || isNaN(p.value)) return;
    const c = svgNode("circle", { cx: x(i), cy: y(p.value), r: 4.5, fill: color, class: "chart-dot" });
    c.append(svgNode("title", {}, p.tip || `${p.label}: ${fmtNum(p.value)}`));
    children.push(c);
  });

  return el("div", {}, [
    make(W, H, ariaLabel || `Line chart of ${yLabel} across ${points.length} sessions`, children),
    legend([{ label: yLabel || "value", color }]),
  ]);
}

/* ------------------------------------------------------------------
   2. Bar chart - categorical breakdown (e.g. event categories)
   bars: [{label, value, color?, tip?}]
------------------------------------------------------------------ */
export function barChart(bars, { yLabel = "", ariaLabel = "", emptyText = "No data yet." } = {}) {
  const nonEmpty = bars.filter((b) => b.value != null);
  if (!nonEmpty.length || nonEmpty.every((b) => b.value === 0)) return emptyState(emptyText);

  const W = 640, H = 260, PAD_L = 52, PAD_R = 18, PAD_T = 16, PAD_B = 52;
  const maxVal = Math.max(...nonEmpty.map((b) => b.value), 1);
  const ticks = niceTicks(0, maxVal);
  const top = ticks[ticks.length - 1] || maxVal;

  const slotW = (W - PAD_L - PAD_R) / bars.length;
  const barW = Math.min(slotW * 0.6, 64);

  const y = (v) => H - PAD_B - (v / top) * (H - PAD_T - PAD_B);

  const children = [];
  for (const t of ticks) {
    children.push(svgNode("line", { x1: PAD_L, x2: W - PAD_R, y1: y(t), y2: y(t), stroke: GRID, "stroke-width": 1 }));
    children.push(svgNode("text", { x: PAD_L - 8, y: y(t) + 4, "text-anchor": "end", class: "axis-text" }, fmtNum(t, 0)));
  }
  if (yLabel) children.push(svgNode("text", { x: 4, y: 12, class: "axis-text" }, yLabel));

  bars.forEach((b, i) => {
    const cx = PAD_L + slotW * i + slotW / 2;
    const value = b.value || 0;
    const h = Math.max(value > 0 ? 3 : 0, H - PAD_B - y(value));
    const rect = svgNode("rect", {
      x: cx - barW / 2, y: y(value), width: barW, height: h,
      rx: 4, fill: b.color || "var(--chart-1)", class: "chart-bar",
    });
    rect.append(svgNode("title", {}, b.tip || `${b.label}: ${value}`));
    children.push(rect);
    // Value label above the bar
    children.push(svgNode("text", { x: cx, y: y(value) - 6, "text-anchor": "middle", class: "bar-value" }, String(value)));
    // Category label (wrapped to 2 lines)
    const words = b.label.split(" ");
    const l1 = words.length > 1 ? words.slice(0, Math.ceil(words.length / 2)).join(" ") : b.label;
    const l2 = words.length > 1 ? words.slice(Math.ceil(words.length / 2)).join(" ") : "";
    children.push(svgNode("text", { x: cx, y: H - PAD_B + 18, "text-anchor": "middle", class: "axis-text" }, l1));
    if (l2) children.push(svgNode("text", { x: cx, y: H - PAD_B + 32, "text-anchor": "middle", class: "axis-text" }, l2));
  });

  return el("div", {}, [
    make(W, H, ariaLabel || `Bar chart: ${yLabel}`, children),
  ]);
}

/* ------------------------------------------------------------------
   3. Timeline - events inside ONE session on a time axis
   events: [{tSec, category, detail, tSecLabel}]  durationSec: number
------------------------------------------------------------------ */
export function timelineChart(events, durationSec, { ariaLabel = "" } = {}) {
  const timed = (events || []).filter((e) => e.tSec != null && !isNaN(e.tSec));
  if (!timed.length) {
    return emptyState("No timestamped events for this session (detection needs a known duration).");
  }
  const dur = durationSec && durationSec > 0
    ? durationSec
    : Math.max(...timed.map((e) => e.tSec)) * 1.1 || 10;

  const cats = [...new Set(timed.map((e) => e.category))];
  const W = 640, H = 60 + cats.length * 26, PAD_L = 130, PAD_R = 24, PAD_T = 24;
  const x = (t) => PAD_L + (Math.min(t, dur) / dur) * (W - PAD_L - PAD_R);

  const children = [];
  // Baseline + time ticks
  const axisY = H - 26;
  children.push(svgNode("line", { x1: PAD_L, x2: W - PAD_R, y1: axisY, y2: axisY, stroke: AXIS, "stroke-width": 1.5 }));
  const tickCount = 4;
  for (let i = 0; i <= tickCount; i++) {
    const t = (dur / tickCount) * i;
    children.push(svgNode("line", { x1: x(t), x2: x(t), y1: axisY, y2: axisY + 5, stroke: AXIS }));
    children.push(svgNode("text", { x: x(t), y: axisY + 18, "text-anchor": "middle", class: "axis-text" }, `${Math.round(t)}s`));
  }

  // One lane per category present
  cats.forEach((cat, li) => {
    const laneY = PAD_T + li * 26;
    const meta = EVENT_META[cat] || { label: cat, color: "var(--chart-1)" };
    children.push(svgNode("line", { x1: PAD_L, x2: W - PAD_R, y1: laneY, y2: laneY, stroke: GRID, "stroke-dasharray": "3 4" }));
    children.push(svgNode("text", { x: PAD_L - 10, y: laneY + 4, "text-anchor": "end", class: "axis-text" }, meta.label));
    for (const e of timed.filter((ev) => ev.category === cat)) {
      const c = svgNode("circle", { cx: x(e.tSec), cy: laneY, r: 6, fill: meta.color, class: "chart-dot" });
      c.append(svgNode("title", {}, `~${Math.round(e.tSec)}s — ${e.detail || e.category}`));
      children.push(c);
    }
  });

  return el("div", {}, [
    make(W, H, ariaLabel || `Timeline of ${timed.length} detected events`, children),
    legend(cats.map((c) => ({ label: (EVENT_META[c] || {}).label || c, color: (EVENT_META[c] || {}).color || "var(--chart-1)" }))),
  ]);
}

/* ------------------------------------------------------------------
   4. Comparison - selected sessions side by side (grouped bars)
   sessions: [{label, values: {metricKey: number|null}}]
   metrics:  [{key, label, max?}]
------------------------------------------------------------------ */
export function comparisonChart(sessions, metrics, { ariaLabel = "" } = {}) {
  if (sessions.length < 2) return emptyState("Select at least two sessions to compare.");
  const colors = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)"];

  const groups = metrics.map((m) => {
    const max = m.max || Math.max(...sessions.map((s) => s.values[m.key] || 0), 1);
    return { metric: m, max, bars: sessions.map((s, i) => ({ label: s.label, value: s.values[m.key], color: colors[i % colors.length] })) };
  });

  const W = 640;
  const rowH = 78;
  const H = 24 + groups.length * rowH;
  const PAD_L = 150, PAD_R = 60;
  const children = [];

  groups.forEach((g, gi) => {
    const top = 24 + gi * rowH;
    children.push(svgNode("text", { x: 4, y: top + 4, class: "axis-text strong" }, g.metric.label));
    g.bars.forEach((b, bi) => {
      const by = top + 12 + bi * 16;
      const value = b.value;
      const bw = value == null ? 0 : Math.max(2, (value / g.max) * (W - PAD_L - PAD_R));
      if (value == null) {
        children.push(svgNode("text", { x: PAD_L, y: by + 10, class: "axis-text" }, `${b.label}: n/a`));
        return;
      }
      const rect = svgNode("rect", { x: PAD_L, y: by, width: bw, height: 12, rx: 3, fill: b.color, class: "chart-bar" });
      rect.append(svgNode("title", {}, `${b.label} — ${g.metric.label}: ${fmtNum(value)}${g.metric.unit || ""}`));
      children.push(rect);
      children.push(svgNode("text", { x: PAD_L + bw + 6, y: by + 10, class: "axis-text" }, `${fmtNum(value)}${g.metric.unit || ""}`));
    });
  });

  return el("div", {}, [
    make(W, H, ariaLabel || `Comparison of ${sessions.length} sessions`, children),
    legend(sessions.map((s, i) => ({ label: s.label, color: colors[i % colors.length] }))),
  ]);
}

/* ------------------------------------------------------------------
   5. Consistency - practice frequency + duration per day
   days: [{date: Date, label, sessions, minutes}]
------------------------------------------------------------------ */
export function consistencyChart(days, { ariaLabel = "" } = {}) {
  if (!days.length || days.every((d) => d.sessions === 0)) {
    return emptyState("No practice recorded in this period yet.");
  }
  const W = 640, H = 240, PAD_L = 44, PAD_R = 16, PAD_T = 16, PAD_B = 48;
  const maxMin = Math.max(...days.map((d) => d.minutes), 1);
  const ticks = niceTicks(0, maxMin);
  const top = ticks[ticks.length - 1] || maxMin;

  const slotW = (W - PAD_L - PAD_R) / days.length;
  const barW = Math.max(2, Math.min(slotW * 0.7, 30));
  const y = (v) => H - PAD_B - (v / top) * (H - PAD_T - PAD_B);

  const children = [];
  for (const t of ticks) {
    children.push(svgNode("line", { x1: PAD_L, x2: W - PAD_R, y1: y(t), y2: y(t), stroke: GRID }));
    children.push(svgNode("text", { x: PAD_L - 8, y: y(t) + 4, "text-anchor": "end", class: "axis-text" }, fmtNum(t, 0)));
  }
  children.push(svgNode("text", { x: 4, y: 12, class: "axis-text" }, "minutes"));

  days.forEach((d, i) => {
    const cx = PAD_L + slotW * i + slotW / 2;
    if (d.minutes > 0) {
      const h = Math.max(3, H - PAD_B - y(d.minutes));
      const rect = svgNode("rect", {
        x: cx - barW / 2, y: y(d.minutes), width: barW, height: h, rx: 3,
        fill: d.sessions > 1 ? "var(--chart-2)" : "var(--chart-1)", class: "chart-bar",
      });
      rect.append(svgNode("title", {}, `${d.label}: ${d.sessions} session${d.sessions === 1 ? "" : "s"}, ${d.minutes} min`));
      children.push(rect);
    } else {
      // Explicit zero-day marker so gaps read as "no practice", not missing data
      children.push(svgNode("line", { x1: cx - barW / 2, x2: cx + barW / 2, y1: H - PAD_B, y2: H - PAD_B, stroke: GRID, "stroke-width": 2 }));
    }
    // Date label every ~7 days or on first/last
    if (i % Math.ceil(days.length / 6) === 0 || i === days.length - 1) {
      children.push(svgNode("text", { x: cx, y: H - PAD_B + 18, "text-anchor": "middle", class: "axis-text" }, d.label));
    }
  });

  const activeDays = days.filter((d) => d.sessions > 0).length;
  const totalSessions = days.reduce((a, d) => a + d.sessions, 0);
  const totalMinutes = days.reduce((a, d) => a + d.minutes, 0);

  return el("div", {}, [
    make(W, H, ariaLabel || `Practice consistency over ${days.length} days`, children),
    legend([
      { label: "1 session that day", color: "var(--chart-1)" },
      { label: "2+ sessions that day", color: "var(--chart-2)" },
    ]),
    el("p", { class: "muted small", style: "margin:6px 0 0", text:
      `You practised on ${activeDays} of the last ${days.length} days — ` +
      `${totalSessions} session${totalSessions === 1 ? "" : "s"}, ${totalMinutes} minute${totalMinutes === 1 ? "" : "s"} total. ` +
      "Consistency and comfort matter as much as any single number." }),
  ]);
}
