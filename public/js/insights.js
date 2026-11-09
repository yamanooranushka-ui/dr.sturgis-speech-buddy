/* ============================================================
   insights.js - Speech Insights section.

   * Disfluency-aware analysis of transcripts (via local backend,
     deterministic - no AI cost).
   * Personal speech FINGERPRINT: baseline built only from the
     user's own earlier sessions, compared only with themselves.
   * Every measurement is labelled experimental and explained,
     with explicit limits (no blocks / prolongations detection,
     no clinical claims, no population norms).
   ============================================================ */

import {
  $, el, clear, toast, explainDetails,
  fmtDate, fmtNum, fmtDuration, on, openModal,
} from "./ui.js";
import { getSessions, updateSession } from "./storage.js";
import {
  lineChart, barChart, timelineChart, comparisonChart, consistencyChart,
} from "./charts.js";
import {
  EVENT_META, summarizeSession, compareToHistory, recurringPatterns,
} from "./detect.js";

const analysedCache = new Set(); // session ids already analysed this page load
let dashboardError = null; // backend/detection failure notice
let renderSeq = 0; // concurrent-render guard (see renderInsights)

/* Dashboard UI state (persists across re-renders within a page load) */
const dashState = {
  metric: "rate", // rate | filler | repetition | comfort | events
  timelineSessionId: null,
  compareIds: [], // selected session ids for comparison
};

const METRIC_DEFS = {
  rate: { label: "Speaking rate", unit: " wpm", get: (s) => s.metrics?.speakingRateWpm },
  filler: { label: "Filler rate", unit: " /100w", get: (s) => s.metrics?.fillerRatePer100Words },
  repetition: { label: "Repetition rate", unit: " /100w", get: (s) => s.metrics?.repetitionRatePer100Words },
  comfort: { label: "Comfort (you rated)", unit: "/5", get: (s) => s.reflection?.comfort },
  events: { label: "Candidate events detected", unit: "", get: (s) => (s.events ? s.events.length : null) },
};

/* ------------------------------------------------------------------
   Render
------------------------------------------------------------------ */
export async function renderInsights() {
  // Guard against concurrent runs (boot calls this twice; the UI can also
  // re-render mid-await). Only the newest run appends to the DOM.
  const seq = ++renderSeq;
  const root = $("#insights-root");
  if (!root) return;
  clear(root);

  const sessions = getSessions();
  const withTranscript = sessions.filter((s) => s.transcript && s.transcript.trim());

  if (!sessions.length) {
    root.append(
      el("div", { class: "empty", style: "margin-top:14px" }, [
        el("span", { class: "empty-icon", text: "📊" }),
        el("p", { text: "No sessions yet. Talk in Live Conversation or finish a practice activity, and your insights will appear here." }),
        el("button", { class: "btn btn-primary", text: "Go to Live Conversation", attrs: { "data-goto": "live" } }),
      ])
    );
    return;
  }

  // Loading state while recent transcripts are analysed (local, free)
  if (withTranscript.length) {
    const loading = el("div", { class: "notice", attrs: { "aria-live": "polite" }, text:
      "Analysing your recent transcripts locally… (no data leaves your device for this step)" });
    root.append(loading);
    await ensureAnalysed(withTranscript.slice(-8));
    loading.remove();
  }
  if (seq !== renderSeq) return; // superseded by a newer render

  const analysed = getSessions().filter((s) => s.metrics);
  const latest = analysed[analysed.length - 1] || null;

  root.append(el("div", { style: "height:14px" }));

  /* ---- Latest snapshot ---- */
  root.append(el("h3", { text: "Latest practice snapshot" }));
  if (latest) root.append(renderSnapshot(latest));
  else {
    root.append(
      el("div", { class: "notice", text:
        "Your sessions so far have comfort notes but no transcript to analyse yet. " +
        "Use Live Conversation or a practice activity to capture one." })
    );
  }

  /* ---- Visual analytics dashboard (Feature 3) ---- */
  root.append(el("h3", { style: "margin-top:22px", text: "Visual analytics" }));
  root.append(renderDashboard(sessions, analysed));

  /* ---- Fingerprint ---- */
  root.append(el("h3", { style: "margin-top:22px", text: "Your personal speech fingerprint" }));
  root.append(renderFingerprint(analysed));

  /* ---- Trends ---- */
  if (analysed.length >= 2) {
    root.append(el("h3", { style: "margin-top:22px", text: "Your trends over time" }));
    root.append(renderTrends(analysed, sessions));
  }

  /* ---- Previous session summaries (Feature 2) ---- */
  root.append(el("h3", { style: "margin-top:22px", text: "Previous session summaries" }));
  root.append(renderSummaries(sessions));

  /* ---- Session table ---- */
  root.append(el("h3", { style: "margin-top:22px", text: "Session measurements" }));
  root.append(renderTable(analysed));

  /* ---- Explanations ---- */
  root.append(
    el("div", { class: "card", style: "margin-top:16px" }, [
      el("h3", { text: "What every measurement here means" }),
      explainDetails(
        "Speaking rate (words per minute)",
        "Estimated as: words in the transcript ÷ how long the session lasted × 60, when a duration was saved.",
        "Filler words may or may not be included depending on what the transcript captured. This is a rough self-reflection figure — it is not a clinical measure of fluency, intelligibility or stuttering severity, and there is no 'normal' range we compare against."
      ),
      explainDetails(
        "Possible repeated words & phrases",
        "Counts immediate repetitions found in the transcript: a word said twice in a row ('the the') and a phrase said twice in a row ('I want I want').",
        "Transcription errors can hide repeats or invent them, and a transcript cannot capture sound-level repetitions, blocks or prolongations. These counts are informal indicators only — never a clinical measurement of disfluency."
      ),
      explainDetails(
        "Possible filler words",
        "Counts common filled pauses (um, uh, er, ah, hmm) plus standalone uses of 'like', reported separately because 'like' is often an ordinary word.",
        "Speech recognition often drops fillers entirely, so real counts may be higher. This is a simple word count from a transcript — not a clinical measure."
      ),
      explainDetails(
        "Pause estimate",
        "Estimated from gaps between separate recognised utterances when timestamps are available.",
        "Pauses inside an utterance (including silent blocks) are invisible to this method, and recognition timing is approximate. Treat it as a rough indicator for your own reflection only."
      ),
      explainDetails(
        "How your fingerprint is built",
        "Your baseline is the typical range from your first few analysed sessions. Every later session is compared only with that baseline and your previous sessions.",
        "There is no comparison with fluent speakers, population standards, or any clinical norm — ever. Trends are shown descriptively, without good/bad scoring, because speech naturally varies day to day."
      ),
    ])
  );
}

/* ------------------------------------------------------------------
   Lazy analysis (calls the local deterministic endpoint)
------------------------------------------------------------------ */
async function ensureAnalysed(sessions) {
  const pending = sessions.filter((s) => !s.metrics && !analysedCache.has(s.id));
  for (const session of pending) {
    analysedCache.add(session.id);
    try {
      const resp = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: session.transcript,
          durationSec: session.durationSec || null,
        }),
      });
      const metrics = await resp.json();
      if (resp.ok && metrics && metrics.wordCount !== undefined) {
        updateSession(session.id, { metrics });
        dashboardError = null;
      } else if (!resp.ok) {
        dashboardError = `The analysis backend responded with an error (${metrics.error || resp.status}).`;
      }
    } catch {
      dashboardError = "Cannot reach the local analysis backend — start server.py and reload.";
    }
  }
}

/* ------------------------------------------------------------------
   Snapshot cards
------------------------------------------------------------------ */
function renderSnapshot(session) {
  const m = session.metrics;
  const grid = el("div", { class: "grid-3" });

  const cards = [
    {
      label: "Speaking rate",
      value: m.speakingRateWpm != null ? `${fmtNum(m.speakingRateWpm)} wpm` : null,
      sub: m.speakingRateWpm != null
        ? `${m.wordCount} words in ${fmtDuration(m.durationSec)}`
        : "Duration unknown — unavailable for this session",
      what: "Words in the transcript divided by the recording duration.",
      limits: "Rough estimate only; not a clinical measure of fluency or intelligibility.",
    },
    {
      label: "Possible repeated words",
      value: String(m.repeatedWords.count),
      sub: m.repeatedWords.examples.slice(0, 2).map((e) => `“${e.context}”`).join("  ") || "No immediate repeats found",
      what: "Immediate single-word repetitions found in the transcript.",
      limits: "Transcripts can hide or invent repeats; blocks and prolongations are invisible here. Not a clinical measurement.",
    },
    {
      label: "Possible repeated phrases",
      value: String(m.repeatedPhrases.count),
      sub: m.repeatedPhrases.examples.slice(0, 2).map((e) => `“${e.context}”`).join("  ") || "No immediate phrase repeats found",
      what: "Immediate phrase repetitions found in the transcript (e.g. 'I want I want').",
      limits: "Depends entirely on transcription accuracy. Informal indicator only.",
    },
    {
      label: "Possible filler words",
      value: String(m.fillers.total + m.fillers.possibleLike),
      sub: describeFillers(m.fillers),
      what: "Counts of um/uh/er/ah/hmm plus standalone 'like' (shown separately).",
      limits: "Transcription often drops fillers; 'like' is often a normal word. Not a clinical measure.",
    },
    {
      label: "Pause estimate",
      value: m.pauses ? `${fmtNum(m.pauses.totalPauseSec)}s` : null,
      sub: m.pauses
        ? `${m.pauses.gapCount} gap(s), longest ${fmtNum(m.pauses.longestPauseSec)}s`
        : "No timestamps for this session",
      what: "Total silence estimated from gaps between recognised utterances.",
      limits: "Cannot see pauses inside an utterance or silent blocks. Rough indicator only.",
    },
    {
      label: "Comfort (you reported)",
      value: session.reflection?.comfort != null ? `${session.reflection.comfort}/5` : null,
      sub: session.reflection?.note ? `“${session.reflection.note}”` : "No note",
      what: "How comfortable you said the session felt — the only 'measurement' here that comes from you directly.",
      limits: "Self-reported and subjective by design. It is never converted into a score.",
    },
  ];

  for (const c of cards) {
    const card = el("div", { class: "metric" }, [
      el("div", { class: "metric-label" }, [
        document.createTextNode(c.label + " "),
        el("span", { class: "badge badge-experimental", text: "experimental" }),
      ]),
      el("div", { class: c.value ? "metric-value" : "metric-na", text: c.value || "n/a" }),
      el("div", { class: "metric-sub", text: c.sub }),
      explainDetails("What does this mean?", c.what, c.limits),
    ]);
    grid.append(card);
  }

  return el("div", {}, [
    el("p", { class: "muted small", text:
      `From: ${session.activityTitle || "session"} · ${fmtDate(session.ts)}` +
      (session.level ? ` · Level ${session.level}` : "") }),
    grid,
  ]);
}

function describeFillers(fillers) {
  const parts = [];
  for (const [word, count] of Object.entries(fillers.counts || {})) {
    parts.push(`${word} ×${count}`);
  }
  if (fillers.possibleLike) parts.push(`like ×${fillers.possibleLike} (possible)`);
  return parts.join(", ") || "None found in the transcript";
}

/* ------------------------------------------------------------------
   Visual analytics dashboard (all data from stored sessions)
------------------------------------------------------------------ */
function chartCard(title, sub, body, note) {
  return el("div", { class: "chart-card" }, [
    el("div", { class: "chart-title", text: title }),
    el("div", { class: "chart-sub", text: sub }),
    body,
    note ? el("p", { class: "muted small", style: "margin:8px 0 0", text: note }) : null,
  ]);
}

function renderDashboard(sessions, analysed) {
  const wrap = el("div", { class: "stack" });

  if (dashboardError) {
    wrap.append(
      el("div", { class: "notice notice-warn", role: "alert" }, [
        el("strong", { text: "Some data couldn't be analysed. " }),
        document.createTextNode(dashboardError + " Charts below show whatever sessions are available."),
      ])
    );
  }

  /* ---- 1. Progress over time (line chart, selectable metric) ---- */
  const metricRow = el("div", { class: "chip-row", style: "margin-bottom:10px", attrs: { role: "group", "aria-label": "Choose a metric" } });
  for (const [key, def] of Object.entries(METRIC_DEFS)) {
    const chip = el("button", {
      type: "button",
      class: "chip",
      text: def.label,
      attrs: { "aria-pressed": String(dashState.metric === key) },
      onclick: () => {
        dashState.metric = key;
        refreshDashboardOnly();
      },
    });
    metricRow.append(chip);
  }

  const def = METRIC_DEFS[dashState.metric];
  const points = sessions.map((s, i) => {
    const value = def.get(s);
    return {
      label: `${fmtDate(s.ts)} · ${s.activityTitle || "session"}`,
      short: new Date(s.ts).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      value: value == null ? null : Number(value),
      tip: `${fmtDate(s.ts)} — ${s.activityTitle || "session"}: ${fmtNum(value)}${def.unit}` +
        (value == null ? " (no data)" : ""),
    };
  });
  const withMetric = points.filter((p) => p.value != null).length;

  wrap.append(
    chartCard(
      "Progress over time",
      `${def.label} across your practice sessions, oldest → newest. Hover points for details.`,
      withMetric >= 2
        ? lineChart(points, { yLabel: def.label + def.unit, color: "var(--chart-1)" })
        : el("div", { class: "chart-empty" }, [
            el("span", { class: "empty-icon", text: "📈" }),
            el("p", { text: `Not enough sessions with “${def.label}” data yet — need at least two.` }),
          ]),
      "Descriptive only: up or down is never 'good' or 'bad'. Sessions with no value for this metric are skipped, leaving gaps."
    ),
    metricRow
  );

  /* ---- 2 + 3. Disfluency breakdown & speech timeline ---- */
  const eventSessions = sessions.filter((s) => Array.isArray(s.events) && s.events.length);
  const grid = el("div", { class: "grid-2" });

  // 2. Breakdown by category across ALL sessions
  const totals = {};
  for (const s of eventSessions) {
    for (const e of s.events) totals[e.category] = (totals[e.category] || 0) + 1;
  }
  const breakdownBars = ["repetition", "elongation", "filler", "block", "prolongation"].map((cat) => ({
    label: (EVENT_META[cat] || {}).label || cat,
    value: totals[cat] || 0,
    color: (EVENT_META[cat] || {}).color || "var(--chart-1)",
    tip: `${(EVENT_META[cat] || {}).label || cat}: ${totals[cat] || 0} across ${eventSessions.length} session(s)`,
  }));
  const anyEvents = breakdownBars.some((b) => b.value > 0);

  grid.append(
    chartCard(
      "Disfluency breakdown",
      `Candidate events detected across ${eventSessions.length} session(s) with monitoring.`,
      anyEvents
        ? barChart(breakdownBars, { yLabel: "events", emptyText: "No candidate events detected yet." })
        : el("div", { class: "chart-empty" }, [
            el("span", { class: "empty-icon", text: "🔍" }),
            el("p", { text: "No candidate events recorded yet. Events are detected silently during voice practice and Live Conversation." }),
          ]),
      "Blocks and prolongations are shown as 0 because transcript analysis CANNOT see them — a zero means 'not detectable', not 'none occurred'. These are AI-estimated candidates, never verified observations."
    )
  );

  // 3. Timeline for one selected session
  const timedSessions = eventSessions.filter((s) =>
    (s.events || []).some((e) => e.tSec != null)
  );
  if (timedSessions.length) {
    if (!dashState.timelineSessionId || !timedSessions.some((s) => s.id === dashState.timelineSessionId)) {
      dashState.timelineSessionId = timedSessions[timedSessions.length - 1].id;
    }
    const selected = timedSessions.find((s) => s.id === dashState.timelineSessionId);
    const select = el("select", {
      class: "input",
      attrs: { "aria-label": "Session for the speech timeline", style: "margin-bottom:8px" },
      onchange: (e) => {
        dashState.timelineSessionId = e.target.value;
        refreshDashboardOnly();
      },
    });
    for (const s of timedSessions.slice(-12)) {
      select.append(el("option", {
        text: `${fmtDate(s.ts)} · ${s.activityTitle || "session"}`,
        attrs: { value: s.id },
      }));
    }
    select.value = dashState.timelineSessionId;
    const dur = selected.durationSec || selected.wallDurationSec || null;
    grid.append(
      chartCard(
        "Speech timeline",
        "When candidate events occurred inside the selected session.",
        el("div", {}, [
          select,
          timelineChart(selected.events, dur),
        ]),
        `Times are approximate (interpolated within each recognised utterance). Session length: ${dur ? fmtDuration(dur) : "unknown"}.`
      )
    );
  } else {
    grid.append(
      chartCard(
        "Speech timeline",
        "When candidate events occurred inside a session.",
        el("div", { class: "chart-empty" }, [
          el("span", { class: "empty-icon", text: "⏱️" }),
          el("p", { text: "No timestamped events yet. Complete a voice practice or Live Conversation session first." }),
        ]),
        "Timeline data needs sessions where detection ran with known timing."
      )
    );
  }
  wrap.append(grid);

  /* ---- 4. Session comparison ---- */
  wrap.append(renderComparison(sessions));

  /* ---- 5. Practice consistency ---- */
  wrap.append(renderConsistency(sessions));

  /* ---- Recurring patterns (Feature 2) ---- */
  wrap.append(renderPatterns(sessions));

  return wrap;
}

/** Re-render only the dashboard (metric chips re-render whole insights). */
function refreshDashboardOnly() {
  renderInsights();
}

/* ---- 4. Session comparison ---- */
function renderComparison(sessions) {
  const candidates = [...sessions].reverse().slice(0, 12);
  if (candidates.length < 2) {
    return chartCard(
      "Session comparison",
      "Compare the current session with previous ones.",
      el("div", { class: "chart-empty" }, [
        el("span", { class: "empty-icon", text: "⚖️" }),
        el("p", { text: "You need at least two sessions to compare." }),
      ])
    );
  }

  // Default: latest two sessions
  if (dashState.compareIds.length < 2) {
    dashState.compareIds = candidates.slice(0, 2).map((s) => s.id);
  }

  const picker = el("div", { class: "chip-row", style: "margin-bottom:10px", attrs: { role: "group", "aria-label": "Sessions to compare" } });
  for (const s of candidates) {
    const on = dashState.compareIds.includes(s.id);
    picker.append(el("button", {
      type: "button",
      class: "chip",
      text: `${fmtDate(s.ts)} · ${(s.activityTitle || "session").slice(0, 24)}`,
      attrs: { "aria-pressed": String(on) },
      onclick: () => {
        if (dashState.compareIds.includes(s.id)) {
          dashState.compareIds = dashState.compareIds.filter((id) => id !== s.id);
        } else if (dashState.compareIds.length < 4) {
          dashState.compareIds = [...dashState.compareIds, s.id];
        } else {
          toast("You can compare up to four sessions at once.");
          return;
        }
        renderInsights();
      },
    }));
  }

  const chosen = dashState.compareIds
    .map((id) => sessions.find((s) => s.id === id))
    .filter(Boolean);

  const metrics = [
    { key: "rate", label: "Speaking rate (wpm)", unit: " wpm", get: (s) => s.metrics?.speakingRateWpm },
    { key: "filler", label: "Fillers /100 words", unit: "", get: (s) => s.metrics?.fillerRatePer100Words },
    { key: "rep", label: "Repeats /100 words", unit: "", get: (s) => s.metrics?.repetitionRatePer100Words },
    { key: "events", label: "Candidate events", unit: "", get: (s) => (s.events ? s.events.length : null) },
    { key: "comfort", label: "Comfort (1–5)", unit: "", get: (s) => s.reflection?.comfort },
    { key: "minutes", label: "Practice minutes", unit: "m", get: (s) => (s.durationSec || s.wallDurationSec ? Math.round((s.durationSec || s.wallDurationSec) / 60) : null) },
  ];

  const series = chosen.map((s) => ({
    label: `${fmtDate(s.ts)} · ${(s.activityTitle || "session").slice(0, 18)}`,
    values: Object.fromEntries(metrics.map((m) => [m.key, m.get(s) == null ? null : Number(m.get(s))])),
  }));

  return el("div", { class: "chart-card" }, [
    el("div", { class: "chart-title", text: "Session comparison" }),
    el("div", { class: "chart-sub", text: "Selected sessions side by side. Tap session chips to change the selection (2–4 sessions)." }),
    picker,
    chosen.length >= 2
      ? comparisonChart(series, metrics.map((m) => ({ key: m.key, label: m.label, unit: m.unit })))
      : el("div", { class: "chart-empty" }, [
          el("span", { class: "empty-icon", text: "⚖️" }),
          el("p", { text: "Select at least two sessions above to compare." }),
        ]),
    el("p", { class: "muted small", style: "margin:8px 0 0", text:
      "Every bar compares YOUR sessions with each other — never with other people. Missing values show as n/a rather than zero." }),
  ]);
}

/* ---- 5. Practice consistency ---- */
function renderConsistency(sessions) {
  // Last 28 days, one bucket per day
  const days = [];
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  for (let i = 27; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000);
    days.push({
      date: d,
      label: `${d.getMonth() + 1}/${d.getDate()}`,
      sessions: 0,
      minutes: 0,
    });
  }
  const byDay = new Map(days.map((d, i) => [d.date.toDateString(), i]));
  for (const s of sessions) {
    const idx = byDay.get(new Date(s.ts).toDateString());
    if (idx == null) continue;
    days[idx].sessions += 1;
    days[idx].minutes += Math.round((s.durationSec || s.wallDurationSec || 0) / 60);
  }

  return chartCard(
    "Practice consistency",
    "Sessions and minutes practised per day over the last 28 days.",
    consistencyChart(days),
    "Consistency is part of progress too — along with your comfort ratings and your own communication goals, it tells a fuller story than any single speech metric."
  );
}

/* ---- Recurring patterns across history ---- */
function renderPatterns(sessions) {
  const patterns = recurringPatterns(sessions);
  if (!patterns.sessionsWithEvents) {
    return chartCard(
      "Recurring patterns",
      "What shows up repeatedly across your sessions.",
      el("div", { class: "chart-empty" }, [
        el("span", { class: "empty-icon", text: "🔁" }),
        el("p", { text: "Complete a monitored voice session to start seeing patterns across your history." }),
      ])
    );
  }

  const chips = el("div", { class: "chip-row", style: "margin-top:6px" });
  for (const w of patterns.topWords) {
    chips.append(el("span", { class: "chip", style: "cursor:default", text: `“${w.word}” repeated ×${w.count}` }));
  }

  return chartCard(
    "Recurring patterns",
    `Based on ${patterns.sessionsWithEvents} monitored session(s), ${patterns.total} candidate event(s) total.`,
    el("div", {}, [
      el("p", { class: "muted small", style: "margin:0 0 6px", text: "Most frequent event categories in your history:" }),
      el("div", { class: "chip-row" }, patterns.topCategories.map((c) =>
        el("span", { class: "chip", style: "cursor:default",
          text: `${(EVENT_META[c.category] || {}).label || c.category} ×${c.count}` })
      )),
      patterns.topWords.length
        ? el("p", { class: "muted small", style: "margin:10px 0 0", text: "Words you repeated most often:" })
        : null,
      patterns.topWords.length ? chips : null,
    ]),
    "Patterns are computed only from your own sessions. Recurring words are often ordinary language habits, not stuttering — treat this as a reflection prompt, not a finding."
  );
}

/* ------------------------------------------------------------------
   Previous session summaries (click to open a full summary)
------------------------------------------------------------------ */
function renderSummaries(sessions) {
  if (!sessions.length) {
    return el("div", { class: "notice", text: "No sessions to summarise yet." });
  }
  const recent = [...sessions].reverse().slice(0, 10);
  const list = el("div", { class: "stack" });

  for (const s of recent) {
    const summary = summarizeSession(s);
    const comparison = compareToHistory(s, sessions);
    const row = el("div", { class: "notice", style: "display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap" }, [
      el("div", {}, [
        el("strong", { text: `${fmtDate(s.ts)} · ${s.activityTitle || s.pathTitle || "Session"}` }),
        el("p", { class: "muted small", style: "margin:3px 0 0", text:
          (s.metrics ? `rate ${s.metrics.speakingRateWpm != null ? fmtNum(s.metrics.speakingRateWpm) + " wpm" : "n/a"} · ` : "") +
          (summary.total ? `${summary.total} candidate event${summary.total === 1 ? "" : "s"} · ` : "no events · ") +
          (s.reflection?.comfort != null ? `comfort ${s.reflection.comfort}/5` : "no comfort rating") +
          (s.durationSec || s.wallDurationSec ? ` · ${fmtDuration(s.durationSec || s.wallDurationSec)}` : "") }),
      ]),
      el("button", {
        type: "button", class: "btn btn-small", text: "View summary",
        attrs: { "aria-label": `View summary of the session on ${fmtDate(s.ts)}` },
        onclick: () => openSessionSummary(s, sessions, comparison),
      }),
    ]);
    list.append(row);
  }
  return list;
}

function appendFeedbackReport(body, feedback) {
  if (!feedback || typeof feedback !== "object") return;
  const card = el("div", { class: "card", style: "margin-top:14px" }, [
    el("h3", { text: "Session feedback report" }),
    el("p", { class: "muted small", text: "Generated from this session's transcript and metrics. Qualitative notes are AI observations, not clinical measurements." }),
  ]);
  const rows = [
    ["Overall", feedback.overall],
    ["Pace", feedback.pace],
    ["Fluency", feedback.fluency],
    ["Fillers", feedback.fillers],
    ["Pronunciation", feedback.pronunciation],
    ["Vocabulary", feedback.vocabulary],
    ["Sentence construction", feedback.sentenceConstruction],
    ["Contextual communication", feedback.contextualCommunication],
  ];
  const table = el("table", { class: "data" }, [
    el("tbody", {}, rows.filter(([, value]) => value).map(([key, value]) =>
      el("tr", {}, [
        el("th", { text: key, attrs: { scope: "row" } }),
        el("td", { text: String(value) }),
      ])
    )),
  ]);
  card.append(table);
  const list = (title, items) => {
    if (!Array.isArray(items) || !items.length) return null;
    return el("div", { style: "margin-top:10px" }, [
      el("strong", { text: title }),
      el("ul", { class: "consent-list", style: "margin-top:4px" }, items.map((item) => el("li", { text: item }))),
    ]);
  };
  for (const node of [
    list("Strengths", feedback.strengths),
    list("Areas to improve", feedback.improvements),
    list("Next-session exercises", feedback.exercises),
    list("Limitations", feedback.limitations),
  ]) if (node) card.append(node);
  body.append(card);
}

function openSessionSummary(session, allSessions, comparison) {
  const m = session.metrics;
  const summary = summarizeSession(session);
  const body = el("div", {});

  body.append(
    el("p", { class: "muted small", text:
      `${fmtDate(session.ts)} · ${session.activityTitle || session.pathTitle || "Session"}` +
      (session.level ? ` · Level ${session.level}` : "") +
      (session.mode ? ` · ${session.mode}` : "") }),
    comparison ? el("div", { class: "notice" }, [document.createTextNode(comparison.text)]) : null
  );

  if (m) {
    body.append(
      el("div", { class: "grid-3", style: "margin-top:10px" }, [
        el("div", { class: "metric" }, [
          el("div", { class: "metric-label", text: "Speaking rate" }),
          el("div", { class: "metric-value", text: m.speakingRateWpm != null ? `${fmtNum(m.speakingRateWpm)} wpm` : "n/a" }),
        ]),
        el("div", { class: "metric" }, [
          el("div", { class: "metric-label", text: "Possible repeats" }),
          el("div", { class: "metric-value", text: String(m.repeatedWords.count + m.repeatedPhrases.count) }),
        ]),
        el("div", { class: "metric" }, [
          el("div", { class: "metric-label", text: "Fillers" }),
          el("div", { class: "metric-value", text: String(m.fillers.total + m.fillers.possibleLike) }),
        ]),
      ])
    );
  }

  if (session.feedback) appendFeedbackReport(body, session.feedback);

  if (Array.isArray(session.events) && session.events.length) {
    const ul = el("ul", { class: "timeline", style: "margin-top:10px" });
    for (const e of session.events.slice(0, 20)) {
      ul.append(el("li", {}, [
        el("span", { class: "tl-title", text: `${(EVENT_META[e.category] || {}).label || e.category}` }),
        el("span", { class: "tl-meta", text: e.tSec != null ? ` · ~${Math.round(e.tSec)}s` : " · time unknown" }),
        el("div", { class: "tl-note", text: e.detail || e.excerpt || "" }),
      ]));
    }
    body.append(el("h3", { style: "margin-top:14px", text: `Candidate events (${session.events.length})` }), ul);
    if (summary.error) {
      body.append(el("div", { class: "notice notice-warn", text: `Detection issue: ${summary.error}` }));
    }
  } else {
    body.append(el("p", { class: "muted small", style: "margin-top:10px", text: "No candidate events recorded for this session." }));
  }

  if (session.transcript) {
    body.append(
      el("h3", { style: "margin-top:14px", text: "Transcript (your words)" }),
      el("p", { class: "muted small", style: "white-space:pre-wrap;background:var(--primary-soft);padding:10px;border-radius:8px", text: session.transcript })
    );
  }
  if (session.reflection?.note) {
    body.append(
      el("h3", { style: "margin-top:14px", text: "Your reflection" }),
      el("p", { text: `“${session.reflection.note}”` })
    );
  }

  body.append(
    explainDetails(
      "How was this summary built?",
      "Metrics come from local deterministic analysis of the stored transcript. Candidate events come from the transcript heuristic detector that ran silently during your session.",
      "None of this is clinically verified. Blocks and prolongations cannot appear here because the method cannot detect them. Compare only with your own earlier sessions."
    )
  );

  openModal("Session summary", body, { wide: true });
}

/* ------------------------------------------------------------------
   Personal fingerprint (baseline from own early sessions)
------------------------------------------------------------------ */
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function range(values) {
  if (!values.length) return null;
  return { min: Math.min(...values), max: Math.max(...values) };
}

function computeBaseline(analysed) {
  // Baseline = the user's own first up-to-5 analysed sessions.
  const base = analysed.slice(0, 5);
  const pick = (fn) => base.map(fn).filter((v) => v != null && !isNaN(v));
  return {
    size: base.length,
    rate: range(pick((s) => s.metrics.speakingRateWpm)),
    fillerRate: range(pick((s) => s.metrics.fillerRatePer100Words)),
    repetitionRate: range(pick((s) => s.metrics.repetitionRatePer100Words)),
    comfort: range(pick((s) => s.reflection?.comfort)),
  };
}

function describeRange(r, unit = "") {
  if (!r) return "not enough data yet";
  if (r.min === r.max) return `${fmtNum(r.min)}${unit}`;
  return `${fmtNum(r.min)}–${fmtNum(r.max)}${unit}`;
}

function compareNeutral(latest, baselineRange, unit, quickerWord, slowerWord) {
  if (latest == null || !baselineRange) return "Not enough of your own sessions yet to compare.";
  if (latest < baselineRange.min) return `a little ${slowerWord} than your usual range`;
  if (latest > baselineRange.max) return `a little ${quickerWord} than your usual range`;
  return "within your usual range";
}

function renderFingerprint(analysed) {
  const card = el("div", { class: "card" });
  if (analysed.length < 2) {
    card.append(
      el("p", { class: "muted", text:
        "Your fingerprint needs at least two analysed sessions. It is built only from your own data — " +
        "you are never compared with fluent speakers or population standards." })
    );
    return card;
  }

  const baseline = computeBaseline(analysed);
  const latest = analysed[analysed.length - 1];
  const m = latest.metrics;

  card.append(
    el("div", { class: "notice" }, [
      el("strong", { text: "Baseline: " }),
      document.createTextNode(
        `your first ${baseline.size} analysed session${baseline.size > 1 ? "s" : ""}. ` +
        "Every comparison below uses only your own data."
      ),
    ]),
    el("div", { class: "grid-3", style: "margin-top:12px" }, [
      el("div", { class: "metric" }, [
        el("div", { class: "metric-label", text: "Your usual speaking rate" }),
        el("div", { class: "metric-value", text: describeRange(baseline.rate, " wpm") }),
        el("div", { class: "metric-sub", text:
          `This session: ${m.speakingRateWpm != null ? fmtNum(m.speakingRateWpm) + " wpm — " : "n/a — "}` +
          compareNeutral(m.speakingRateWpm, baseline.rate, " wpm", "quicker", "slower") }),
      ]),
      el("div", { class: "metric" }, [
        el("div", { class: "metric-label", text: "Your usual filler rate" }),
        el("div", { class: "metric-value", text: describeRange(baseline.fillerRate, " /100w") }),
        el("div", { class: "metric-sub", text:
          `This session: ${fmtNum(m.fillerRatePer100Words)} /100 words — ` +
          compareNeutral(m.fillerRatePer100Words, baseline.fillerRate, "", "higher", "lower") +
          " (filler counts naturally vary day to day)" }),
      ]),
      el("div", { class: "metric" }, [
        el("div", { class: "metric-label", text: "Your usual repetition rate" }),
        el("div", { class: "metric-value", text: describeRange(baseline.repetitionRate, " /100w") }),
        el("div", { class: "metric-sub", text:
          `This session: ${fmtNum(m.repetitionRatePer100Words)} /100 words — ` +
          compareNeutral(m.repetitionRatePer100Words, baseline.repetitionRate, "", "higher", "lower") +
          " (transcript-based estimate)" }),
      ]),
    ]),
    explainDetails(
      "Why compare only with myself?",
      "Speech varies a lot from day to day, and there is no meaningful 'target' number for a person. Comparing you with your own earlier sessions shows personal trends without judging anyone against a standard.",
      "Dr. Sturgis never compares you with fluent speakers, age norms, or clinical populations — and never turns these numbers into a score or grade."
    )
  );
  return card;
}

/* ------------------------------------------------------------------
   Trends (SVG sparklines - no chart dependency)
------------------------------------------------------------------ */
function sparkline(values, { baselineValues = null, label = "", unit = "" } = {}) {
  const points = values
    .map((v, i) => (v == null || isNaN(v) ? null : [i, v]))
    .filter(Boolean);

  const W = 320, H = 90, PAD = 8;
  if (points.length < 2) {
    return el("p", { class: "muted small", text: "Not enough points yet for a trend line." });
  }

  const allVals = [...values.filter((v) => v != null), ...(baselineValues || []).filter((v) => v != null)];
  let min = Math.min(...allVals);
  let max = Math.max(...allVals);
  if (min === max) { min -= 1; max += 1; }

  const x = (i) => PAD + (i / (values.length - 1)) * (W - 2 * PAD);
  const y = (v) => H - PAD - ((v - min) / (max - min)) * (H - 2 * PAD);

  const path = points.map(([i, v], idx) => `${idx ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const dots = points.map(([i, v]) => `<circle class="spark-dot" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3.2"/>`).join("");

  let baseLine = "";
  if (baselineValues && baselineValues.length) {
    const bv = baselineValues.filter((v) => v != null);
    if (bv.length) {
      const avg = bv.reduce((a, b) => a + b, 0) / bv.length;
      baseLine = `<line class="spark-base" x1="${PAD}" y1="${y(avg).toFixed(1)}" x2="${W - PAD}" y2="${y(avg).toFixed(1)}"/>`;
    }
  }

  const svg = el("div", {
    html:
      `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label} trend over ${points.length} sessions">` +
      baseLine +
      `<path class="spark-line" d="${path}"/>` +
      dots +
      `</svg>`,
  });

  const first = points[0][1];
  const last = points[points.length - 1][1];
  const delta = last - first;
  const direction =
    Math.abs(delta) < 0.01
      ? "steady across these sessions"
      : delta > 0
        ? `up ${fmtNum(Math.abs(delta))}${unit} since your first of these sessions`
        : `down ${fmtNum(Math.abs(delta))}${unit} since your first of these sessions`;

  return el("div", {}, [
    svg,
    el("p", { class: "muted small", style: "margin:2px 0 0",
      text: `${label}: ${fmtNum(first)}${unit} → ${fmtNum(last)}${unit} (${direction}). Descriptive only — no good or bad direction.` }),
  ]);
}

function renderTrends(analysed, allSessions) {
  const grid = el("div", { class: "grid-2" });

  const rateVals = analysed.map((s) => s.metrics.speakingRateWpm);
  const fillerVals = analysed.map((s) => s.metrics.fillerRatePer100Words);
  const repVals = analysed.map((s) => s.metrics.repetitionRatePer100Words);

  // Comfort trend includes any session with a self-rating
  const comfortSessions = allSessions.filter((s) => s.reflection?.comfort != null);
  const comfortVals = comfortSessions.map((s) => s.reflection.comfort);

  const mk = (title, sub, node) =>
    el("div", { class: "chart-card" }, [
      el("div", { class: "chart-title", text: title }),
      el("div", { class: "chart-sub", text: sub }),
      node,
    ]);

  grid.append(
    mk("Speaking rate", "Your own sessions, oldest → newest", sparkline(rateVals, { label: "Speaking rate", unit: " wpm" })),
    mk("Possible filler rate", "Per 100 transcript words", sparkline(fillerVals, { label: "Filler rate", unit: "" })),
    mk("Possible repetition rate", "Per 100 transcript words", sparkline(repVals, { label: "Repetition rate", unit: "" })),
    mk("Your comfort ratings", "Self-reported, 1–5", sparkline(comfortVals, { label: "Comfort", unit: "/5" }))
  );
  return grid;
}

/* ------------------------------------------------------------------
   Session table
------------------------------------------------------------------ */
function renderTable(analysed) {
  if (!analysed.length) {
    return el("div", { class: "notice", text: "No analysed sessions yet." });
  }
  const rows = [...analysed].reverse().slice(0, 25).map((s) => {
    const m = s.metrics;
    return el("tr", {}, [
      el("td", { text: fmtDate(s.ts) }),
      el("td", { text: s.activityTitle || s.pathTitle || "Session" }),
      el("td", { text: m.speakingRateWpm != null ? fmtNum(m.speakingRateWpm) : "—" }),
      el("td", { text: String(m.repeatedWords.count + m.repeatedPhrases.count) }),
      el("td", { text: String(m.fillers.total + m.fillers.possibleLike) }),
      el("td", { text: s.reflection?.comfort != null ? `${s.reflection.comfort}/5` : "—" }),
    ]);
  });

  return el("div", { class: "table-wrap" }, [
    el("table", { class: "data" }, [
      el("thead", {}, [
        el("tr", {}, [
          "Date", "Session", "Rate (wpm)", "Repeats", "Fillers", "Comfort",
        ].map((h) => el("th", { text: h, attrs: { scope: "col" } }))),
      ]),
      el("tbody", {}, rows),
    ]),
    el("p", { class: "muted small", style: "margin-top:8px", text:
      "All figures are experimental transcript-based estimates from your own sessions — not clinical measurements." }),
  ]);
}

// Re-render when other sections log data
on("patientai:data", () => {
  const section = $("#section-insights");
  if (section && !section.hidden) renderInsights();
});
