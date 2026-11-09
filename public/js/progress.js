/* ============================================================
   progress.js - Progress section: weekly summaries, session
   timeline, goals, and a downloadable report users can
   voluntarily share with their speech-language pathologist.
   ============================================================ */

import {
  $, el, clear, openModal, toast, explainDetails, on,
  fmtDate, fmtDateTime, fmtNum, fmtDuration, plural,
} from "./ui.js";
import { getSessions, getProfile, getLevels, updateSession } from "./storage.js";
import { downloadPdf } from "./pdf.js";
import { getActivePaths, levelInfo } from "./activities.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------
   Render
------------------------------------------------------------------ */
export function renderProgress() {
  const root = $("#progress-root");
  if (!root) return;
  clear(root);

  const sessions = getSessions();
  const profile = getProfile();

  if (!sessions.length && !profile) {
    root.append(
      el("div", { class: "empty" }, [
        el("span", { class: "empty-icon", text: "📈" }),
        el("p", { text: "Your practice history will appear here once you create a profile and start practising." }),
        el("button", { class: "btn btn-primary", text: "Go to My Profile", attrs: { "data-goto": "profile" } }),
      ])
    );
    return;
  }

  /* ---- Weekly summary ---- */
  root.append(renderWeekly(sessions));

  /* ---- Goals ---- */
  if (profile) root.append(renderGoals(profile, sessions));

  /* ---- Report ---- */
  root.append(
    el("div", { class: "card", style: "margin-top:14px" }, [
      el("h3", { text: "Speech insights report" }),
      el("p", { class: "muted", text:
        "Preview the same speaking notes you see in Speech Insights, then download them as a PDF." }),
      el("div", { class: "btn-row" }, [
        el("button", {
          type: "button", class: "btn btn-primary",
          text: "Preview & download report",
          onclick: openReport,
        }),
      ]),
    ])
  );

  /* ---- Timeline ---- */
  root.append(el("h3", { style: "margin-top:22px", text: "Session history" }));
  root.append(renderTimeline(sessions));
}

/* ------------------------------------------------------------------
   Weekly summary
------------------------------------------------------------------ */
function renderWeekly(sessions) {
  const cutoff = Date.now() - WEEK_MS;
  const week = sessions.filter((s) => s.ts >= cutoff);

  const activities = week.filter((s) => s.mode === "activity").length;
  const conversations = week.filter((s) => s.mode === "conversation" || s.mode === "record").length;
  const minutes = Math.round(
    week.reduce((sum, s) => sum + (s.durationSec || 0), 0) / 60
  );
  const comforts = week.map((s) => s.reflection?.comfort).filter((c) => c != null);
  const avgComfort = comforts.length
    ? comforts.reduce((a, b) => a + b, 0) / comforts.length
    : null;

  // Active days this week (for a simple streak)
  const days = new Set(week.map((s) => new Date(s.ts).toDateString()));

  const cards = el("div", { class: "grid-3" }, [
    statCard("Sessions this week", String(week.length), `${plural(days.size, "active day")} · ${plural(activities, "activity")} · ${plural(conversations, "conversation")}`),
    statCard("Practice time", minutes ? `${minutes} min` : "<1 min", "Timed sessions only (recordings & activities)"),
    statCard(
      "Average comfort",
      avgComfort != null ? `${fmtNum(avgComfort, 1)}/5` : "—",
      avgComfort != null
        ? `From ${plural(comforts.length, "self-rating")} — how you felt, not how you performed`
        : "Rate a session's reflection to see this"
    ),
  ]);

  return el("div", { class: "card" }, [
    el("h3", { text: "This week" }),
    el("p", { class: "muted small", text: fmtDate(Date.now() - WEEK_MS) + " → " + fmtDate(Date.now()) }),
    cards,
  ]);
}

function statCard(label, value, sub) {
  return el("div", { class: "metric" }, [
    el("div", { class: "metric-label", text: label }),
    el("div", { class: "metric-value", text: value }),
    el("div", { class: "metric-sub", text: sub }),
  ]);
}

/* ------------------------------------------------------------------
   Goals
------------------------------------------------------------------ */
function renderGoals(profile, sessions) {
  const card = el("div", { class: "card", style: "margin-top:14px" }, [
    el("h3", { text: "My goals" }),
  ]);

  if (profile.goals) {
    card.append(el("p", { text: profile.goals }));
  } else {
    card.append(el("p", { class: "muted", text: "No goals written yet — add them in My Profile." }));
  }

  const paths = getActivePaths(profile);
  const levels = getLevels();
  const rows = paths.map((path) => {
    const count = sessions.filter((s) => s.pathId === path.id).length;
    const level = levels[path.id] || 1;
    return el("tr", {}, [
      el("td", { text: path.title }),
      el("td", { text: `Level ${level} · ${levelInfo(level).name}` }),
      el("td", { text: plural(count, "session") }),
    ]);
  });

  if (rows.length) {
    card.append(
      el("div", { class: "table-wrap", style: "margin-top:8px" }, [
        el("table", { class: "data" }, [
          el("thead", {}, [el("tr", {}, ["Practice path", "Current level", "Sessions"]
            .map((h) => el("th", { text: h, attrs: { scope: "col" } })))]),
          el("tbody", {}, rows),
        ]),
      ])
    );
  }

  card.append(
    explainDetails(
      "How is goal progress shown?",
      "We show how much you've practised each path and where you've set your level — activity counts, not outcomes.",
      "Dr. Sturgis does not grade goal achievement. Whether a goal is being met is a conversation for you and your speech-language pathologist."
    )
  );
  return card;
}

/* ------------------------------------------------------------------
   Timeline
------------------------------------------------------------------ */
function renderTimeline(sessions) {
  if (!sessions.length) {
    return el("div", { class: "empty" }, [
      el("span", { class: "empty-icon", text: "🗓️" }),
      el("p", { text: "No sessions yet. Practise an activity or hold a conversation and it will show up here." }),
    ]);
  }

  const list = el("ul", { class: "timeline" });
  for (const s of [...sessions].reverse().slice(0, 40)) {
    const m = s.metrics;
    const bits = [];
    if (s.level) bits.push(`Level ${s.level}`);
    if (m?.speakingRateWpm != null) bits.push(`${fmtNum(m.speakingRateWpm)} wpm (est.)`);
    if (m) bits.push(`${m.repeatedWords.count + m.repeatedPhrases.count} possible repeats`);
    if (m) bits.push(`${m.fillers.total + m.fillers.possibleLike} possible fillers`);
    if (s.durationSec) bits.push(fmtDuration(s.durationSec));
    if (s.reflection?.comfort != null) bits.push(`comfort ${s.reflection.comfort}/5`);

    list.append(
      el("li", {}, [
        el("div", { class: "tl-title", text: s.activityTitle || s.pathTitle || "Session" }),
        el("div", { class: "tl-meta", text: fmtDateTime(s.ts) + (bits.length ? " · " + bits.join(" · ") : "") }),
        s.reflection?.note ? el("div", { class: "tl-note", text: `“${s.reflection.note}”` }) : null,
        m ? el("div", { class: "tl-meta", text: "Experimental transcript estimate — not a clinical measurement." }) : null,
      ])
    );
  }
  return list;
}

/* ------------------------------------------------------------------
   Report
------------------------------------------------------------------ */
async function ensureMetrics(sessions) {
  for (const session of sessions) {
    if (session.metrics || !session.transcript || !session.transcript.trim()) continue;
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
      }
    } catch { /* the report still lists the session without numbers */ }
  }
}

function fillerText(fillers) {
  if (!fillers) return "None noted";
  const parts = Object.entries(fillers.counts || {}).map(([word, count]) => `${word} x${count}`);
  if (fillers.possibleLike) parts.push(`like x${fillers.possibleLike}`);
  return parts.length ? parts.join(", ") : "None noted";
}

function exampleText(items) {
  const list = (items || []).slice(0, 3).map((item) => item.context || item.word).filter(Boolean);
  return list.length ? list.join("; ") : "None noted";
}

function rangeText(values, unit) {
  const nums = values.filter((v) => v != null && !Number.isNaN(v));
  if (!nums.length) return "not enough sessions yet";
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  if (min === max) return `${fmtNum(min)}${unit}`;
  return `${fmtNum(min)}-${fmtNum(max)}${unit}`;
}

function insightBlocks(sessions, profile) {
  const analysed = sessions.filter((s) => s.metrics);
  const latest = analysed[analysed.length - 1] || null;
  const blocks = [
    { text: "Speech insights", bold: true, size: 18, gap: 26 },
    { text: `Prepared ${new Date().toLocaleString()}`, size: 11, gap: 16 },
    { text: profile ? `Age group: ${profile.ageGroup}` : "No profile saved yet.", size: 11, gap: 18 },
  ];
  if (!analysed.length) {
    blocks.push({
      text: "No analysed speaking sessions yet. Practise an activity or use Live Conversation, then open this report again.",
      size: 12, gap: 18,
    });
    return blocks;
  }

  const m = latest.metrics;
  blocks.push({ text: "Latest session", bold: true, size: 14, gap: 20 });
  blocks.push({
    text: `${fmtDate(latest.ts)} - ${latest.activityTitle || latest.pathTitle || "Session"}`,
    size: 11, gap: 16,
  });
  blocks.push({
    text: `Speaking rate: ${m.speakingRateWpm != null ? fmtNum(m.speakingRateWpm) + " words per minute" : "not available"} (${m.wordCount} words)`,
    size: 11, gap: 15,
  });
  blocks.push({
    text: `Repeated words: ${m.repeatedWords.count}. Examples: ${exampleText(m.repeatedWords.examples)}`,
    size: 11, gap: 15,
  });
  blocks.push({
    text: `Repeated phrases: ${m.repeatedPhrases.count}. Examples: ${exampleText(m.repeatedPhrases.examples)}`,
    size: 11, gap: 15,
  });
  blocks.push({
    text: `Filler words: ${m.fillers.total + m.fillers.possibleLike}. ${fillerText(m.fillers)}`,
    size: 11, gap: 15,
  });
  blocks.push({
    text: `Repeats per 100 words: ${fmtNum(m.repetitionRatePer100Words)}. Fillers per 100 words: ${fmtNum(m.fillerRatePer100Words)}.`,
    size: 11, gap: 18,
  });

  if (analysed.length >= 2) {
    const base = analysed.slice(0, 5);
    blocks.push({ text: "Your usual range", bold: true, size: 14, gap: 20 });
    blocks.push({
      text: `From your first ${base.length} analysed sessions, compared only with yourself.`,
      size: 11, gap: 15,
    });
    blocks.push({
      text: `Speaking rate: ${rangeText(base.map((s) => s.metrics.speakingRateWpm), " wpm")}`,
      size: 11, gap: 15,
    });
    blocks.push({
      text: `Repeated words and phrases: ${rangeText(base.map((s) => s.metrics.repetitionRatePer100Words), " per 100 words")}`,
      size: 11, gap: 15,
    });
    blocks.push({
      text: `Filler words: ${rangeText(base.map((s) => s.metrics.fillerRatePer100Words), " per 100 words")}`,
      size: 11, gap: 18,
    });
  }

  blocks.push({ text: "Each session", bold: true, size: 14, gap: 20 });
  for (const session of [...analysed].reverse()) {
    const metrics = session.metrics;
    blocks.push({
      text: `${fmtDate(session.ts)} - ${session.activityTitle || session.pathTitle || "Session"}`,
      bold: true, size: 12, gap: 16,
    });
    blocks.push({
      text: `Rate ${metrics.speakingRateWpm != null ? fmtNum(metrics.speakingRateWpm) + " wpm" : "n/a"} · repeats ${metrics.repeatedWords.count + metrics.repeatedPhrases.count} · fillers ${metrics.fillers.total + metrics.fillers.possibleLike}` +
        (session.reflection?.comfort != null ? ` · comfort ${session.reflection.comfort}/5` : ""),
      size: 11, gap: 14,
    });
    const repeats = exampleText([...(metrics.repeatedWords.examples || []), ...(metrics.repeatedPhrases.examples || [])]);
    if (repeats !== "None noted") {
      blocks.push({ text: `Heard again: ${repeats}`, size: 11, gap: 14 });
    }
    const fillers = fillerText(metrics.fillers);
    if (fillers !== "None noted") {
      blocks.push({ text: `Filler words: ${fillers}`, size: 11, gap: 16 });
    }
  }
  return blocks;
}

function renderInsightPreview(sessions, profile) {
  const analysed = sessions.filter((s) => s.metrics);
  const wrap = el("div");
  if (!analysed.length) {
    wrap.append(el("p", { text: "No analysed speaking sessions yet. Practise an activity or use Live Conversation, then open this report again." }));
    return wrap;
  }
  const latest = analysed[analysed.length - 1];
  const m = latest.metrics;
  wrap.append(
    el("h3", { text: "Latest session" }),
    el("p", { class: "muted small", text: `${fmtDate(latest.ts)} · ${latest.activityTitle || latest.pathTitle || "Session"}` }),
    el("div", { class: "grid-3" }, [
      metric("Speaking rate", m.speakingRateWpm != null ? `${fmtNum(m.speakingRateWpm)} wpm` : "n/a", `${m.wordCount} words`),
      metric("Repeated words", String(m.repeatedWords.count), exampleText(m.repeatedWords.examples)),
      metric("Repeated phrases", String(m.repeatedPhrases.count), exampleText(m.repeatedPhrases.examples)),
      metric("Filler words", String(m.fillers.total + m.fillers.possibleLike), fillerText(m.fillers)),
      metric("Repeats / 100 words", fmtNum(m.repetitionRatePer100Words), "From this transcript"),
      metric("Fillers / 100 words", fmtNum(m.fillerRatePer100Words), "From this transcript"),
    ])
  );
  if (analysed.length >= 2) {
    const base = analysed.slice(0, 5);
    wrap.append(
      el("h3", { style: "margin-top:16px", text: "Your usual range" }),
      el("p", { class: "muted small", text: `From your first ${base.length} analysed sessions. Compared only with yourself.` }),
      el("div", { class: "grid-3" }, [
        metric("Speaking rate", rangeText(base.map((s) => s.metrics.speakingRateWpm), " wpm"), "Your own early sessions"),
        metric("Repeats", rangeText(base.map((s) => s.metrics.repetitionRatePer100Words), " /100w"), "Words and phrases"),
        metric("Fillers", rangeText(base.map((s) => s.metrics.fillerRatePer100Words), " /100w"), "um, uh, and similar words"),
      ])
    );
  }
  const list = el("div", { class: "stack", style: "margin-top:8px" });
  for (const session of [...analysed].reverse().slice(0, 12)) {
    const metrics = session.metrics;
    list.append(el("div", { class: "notice" }, [
      el("strong", { text: `${fmtDate(session.ts)} · ${session.activityTitle || session.pathTitle || "Session"}` }),
      el("p", { class: "muted small", style: "margin:4px 0 0", text:
        `Rate ${metrics.speakingRateWpm != null ? fmtNum(metrics.speakingRateWpm) + " wpm" : "n/a"} · ` +
        `repeats ${metrics.repeatedWords.count + metrics.repeatedPhrases.count} · ` +
        `fillers ${metrics.fillers.total + metrics.fillers.possibleLike}` }),
    ]));
  }
  wrap.append(el("h3", { style: "margin-top:16px", text: "Each session" }), list);
  if (profile?.ageGroup) {
    wrap.append(el("p", { class: "muted small", style: "margin-top:12px", text: `Age group: ${profile.ageGroup}` }));
  }
  return wrap;
}

function metric(label, value, sub) {
  return el("div", { class: "metric" }, [
    el("div", { class: "metric-label", text: label }),
    el("div", { class: "metric-value", text: value }),
    el("div", { class: "metric-sub", text: sub }),
  ]);
}

async function openReport() {
  const body = el("div", {}, [
    el("p", { class: "muted", text: "Gathering your speech insights…" }),
  ]);
  openModal("Speech insights report", body, { wide: true });
  await ensureMetrics(getSessions());
  const sessions = getSessions();
  const profile = getProfile();
  const blocks = insightBlocks(sessions, profile);
  clear(body);
  body.append(
    renderInsightPreview(sessions, profile),
    el("div", { class: "btn-row", style: "margin-top:14px" }, [
      el("button", {
        type: "button",
        class: "btn btn-primary",
        text: "Download PDF",
        onclick: () => {
          downloadPdf(
            `dr-sturgis-speech-insights-${new Date().toISOString().slice(0, 10)}.pdf`,
            blocks
          );
          toast("PDF downloaded to your device.");
        },
      }),
    ])
  );
}

// Re-render when other sections log data
on("patientai:data", () => {
  const section = $("#section-progress");
  if (section && !section.hidden) renderProgress();
});
