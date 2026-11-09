/* ============================================================
   detect.js - live disfluency event detection + history compare.

   * Detects CANDIDATE events from transcripts via the local
     /api/detect endpoint (deterministic, no AI cost, no audio
     leaves the device for detection).
   * Events are timestamped (session-relative seconds) so they can
     be drawn on a timeline and persisted with the session.
   * HONESTY: this is transcript-based. Blocks and audio-level
     prolongations are NOT detectable here - the endpoint returns
     an `undetectable` list saying so. Nothing here is a clinical
     observation; events are AI/heuristic estimates only.
   * EXTENSIBLE: analysis.py keeps a detector registry so an audio
     or ML model can be registered later without changing callers.

   Sessions store: { events: [...], eventSummary: {...} }
   ============================================================ */

import { getSessions } from "./storage.js";

/** Human labels for event categories (used by charts + summaries). */
export const EVENT_META = {
  repetition: { label: "Possible repetition", color: "var(--chart-1)" },
  elongation: { label: "Possible elongation", color: "var(--chart-3)" },
  filler: { label: "Filler word", color: "var(--chart-2)" },
  block: { label: "Possible block", color: "var(--chart-4)" },
  prolongation: { label: "Possible prolongation", color: "var(--chart-5)" },
};

export const EVENT_CATEGORIES = ["repetition", "elongation", "filler", "block", "prolongation"];

/**
 * Detect candidate events in one utterance fragment.
 * @param {string} text      transcript fragment
 * @param {number|null} tStart session-relative start seconds
 * @param {number|null} tEnd   session-relative end seconds
 * @returns {Promise<{events: Array, undetectable: Array, error: string|null}>}
 */
export async function detectEvents(text, tStart = null, tEnd = null) {
  const empty = { events: [], undetectable: [], detectorsUsed: [], error: null };
  if (!text || !text.trim()) return empty;
  try {
    const resp = await fetch("/api/detect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, tStart, tEnd }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "detection failed");
    return {
      events: Array.isArray(data.events) ? data.events : [],
      undetectable: Array.isArray(data.undetectable) ? data.undetectable : [],
      detectorsUsed: data.detectorsUsed || [],
      error: null,
    };
  } catch (err) {
    // Never fabricate events on failure - report the error and show nothing.
    return { ...empty, error: err.message || "detection unavailable" };
  }
}

/**
 * A per-session accumulator. Usage:
 *   const log = createEventLog();
 *   log.add(await detectEvents(text, t0, t1));   // per utterance
 *   session = { ...session, ...log.toSessionFields() };
 */
export function createEventLog() {
  const events = [];
  let undetectable = [];
  let error = null;
  return {
    add(result) {
      if (!result) return;
      if (result.error) error = result.error;
      if (Array.isArray(result.events)) events.push(...result.events);
      if (Array.isArray(result.undetectable) && result.undetectable.length) {
        undetectable = result.undetectable;
      }
    },
    get count() {
      return events.length;
    },
    get error() {
      return error;
    },
    summary() {
      return summarize(events, error);
    },
    toSessionFields() {
      if (!events.length && !error) return {};
      return { events: events.slice(0, 200), eventSummary: summarize(events, error) };
    },
  };
}

function summarize(events, error = null) {
  const byCategory = {};
  for (const e of events) {
    const cat = e.category || "unknown";
    byCategory[cat] = (byCategory[cat] || 0) + 1;
  }
  return {
    total: events.length,
    byCategory,
    hasTimestamps: events.some((e) => e.tSec != null),
    error,
    isEstimate: true,
  };
}

/** Summarise events already stored on a session (or empty). */
export function summarizeSession(session) {
  if (session?.eventSummary) return session.eventSummary;
  return summarize(session?.events || []);
}

/* ------------------------------------------------------------------
   Historical comparison (current session vs the user's own history)
------------------------------------------------------------------ */

/** Per-session event counts across all sessions that have events. */
export function eventHistory(sessions = getSessions()) {
  return sessions
    .filter((s) => Array.isArray(s.events) && s.events.length)
    .map((s) => ({
      id: s.id,
      ts: s.ts,
      title: s.activityTitle || s.pathTitle || "Session",
      summary: summarizeSession(s),
      session: s,
    }));
}

/**
 * Compare one session's event count (normalised per 100 words when
 * possible) with previous sessions. Returns neutral, descriptive text
 * only - never good/bad, never a clinical statement.
 */
export function compareToHistory(session, sessions = getSessions()) {
  const mine = summarizeSession(session);
  const previous = sessions.filter(
    (s) => s.id !== session.id && Array.isArray(s.events) && s.events.length
  );
  if (!previous.length) {
    return {
      enough: false,
      text: "This is your first session with detected events — future sessions will be compared against it.",
    };
  }
  const rate = (s) => {
    const words = s.metrics?.wordCount || 0;
    const sum = summarizeSession(s).total;
    return words > 0 ? (sum / words) * 100 : sum;
  };
  const prevRates = previous.map(rate);
  const min = Math.min(...prevRates);
  const max = Math.max(...prevRates);
  const myRate = rate(session);
  let text;
  if (myRate < min) text = "fewer candidate events per 100 words than any of your previous sessions";
  else if (myRate > max) text = "more candidate events per 100 words than in your previous sessions";
  else text = "within the range of your previous sessions";
  return {
    enough: true,
    text:
      `This session had ${mine.total} candidate event${mine.total === 1 ? "" : "s"} — ` +
      `${text}. Compared only with your own history, never with anyone else.`,
  };
}

/** Most recurring event categories across history (descriptive). */
export function recurringPatterns(sessions = getSessions()) {
  const byCategory = {};
  const byWord = {};
  let sessionsWithEvents = 0;
  for (const s of sessions) {
    const events = s.events;
    if (!Array.isArray(events) || !events.length) continue;
    sessionsWithEvents++;
    for (const e of events) {
      const cat = e.category || "unknown";
      byCategory[cat] = (byCategory[cat] || 0) + 1;
      if (e.category === "repetition" && e.subtype === "word") {
        const m = /"([^"]+)"/.exec(e.detail || "");
        if (m) byWord[m[1].toLowerCase()] = (byWord[m[1].toLowerCase()] || 0) + 1;
      }
    }
  }
  const topWords = Object.entries(byWord)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word, count]) => ({ word, count }));
  const topCategories = Object.entries(byCategory)
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => ({ category, count }));
  return { sessionsWithEvents, topCategories, topWords, total: Object.values(byCategory).reduce((a, b) => a + b, 0) };
}
