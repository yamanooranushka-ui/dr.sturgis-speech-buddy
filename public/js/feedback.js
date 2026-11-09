/* Session feedback reports for voice/conversation practice.
   Combines deterministic transcript metrics with an optional
   Gemini qualitative report. Everything is labelled as an
   estimate/observation, never a clinical measurement. */

function postJson(path, body) {
  return fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (resp) => {
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || "Request failed");
    return data;
  });
}

function cleanList(value, limit = 6) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean).slice(0, limit);
}

function fallbackReport({ transcript, metrics, events, durationSec, mode, pathTitle, activityTitle }) {
  const words = metrics?.wordCount || String(transcript || "").trim().split(/\s+/).filter(Boolean).length;
  const fillers = (metrics?.fillers?.total || 0) + (metrics?.fillers?.possibleLike || 0);
  const repeats = (metrics?.repeatedWords?.count || 0) + (metrics?.repeatedPhrases?.count || 0);
  const rate = metrics?.speakingRateWpm;
  const strengths = [];
  const improvements = [];
  const exercises = [];

  if (words >= 25) strengths.push("You produced a sustained spoken response with enough material to practise from.");
  if (repeats === 0) strengths.push("No immediate repeated words or phrases were detected in the transcript.");
  if (fillers <= Math.max(1, Math.round(words / 80))) strengths.push("Filler-word use was relatively light in the transcript.");
  if (rate != null && rate >= 90 && rate <= 160) strengths.push(`Your estimated pace was ${rate} wpm, inside a comfortable conversational range.`);

  if (fillers > 0) improvements.push(`${fillers} possible filler word${fillers === 1 ? "" : "s"} appeared in the transcript; pausing silently for a beat can sound more natural.`);
  if (repeats > 0) improvements.push(`${repeats} possible repeat${repeats === 1 ? "" : "s"} were detected; slowing slightly before the repeated word can help the phrase land cleanly.`);
  if (rate != null && rate > 180) improvements.push(`The estimated pace was ${rate} wpm; try grouping ideas into shorter sentences and leaving small pauses.`);
  if (rate != null && rate < 70) improvements.push(`The estimated pace was ${rate} wpm; adding a little energy and clearer phrase endings can make the answer feel more engaged.`);
  if (!strengths.length) strengths.push("You completed a speaking turn; the transcript is available for reflection.");
  if (!improvements.length) improvements.push("Keep the same pace and structure, then try one slightly longer answer next time.");

  exercises.push("Repeat one answer, then say it once more while deliberately pausing instead of using fillers.");
  exercises.push("Answer the same prompt in two sentences: first the main point, then one supporting detail.");
  exercises.push("Record a 30-second version of the same topic and listen only for pace and fillers.");

  return {
    overall: `Transcript-based practice feedback for ${activityTitle || pathTitle || mode || "this session"}.`,
    pace: rate != null ? `${rate} estimated words per minute from ${words} transcript words${durationSec ? ` over ${Math.round(durationSec)}s` : ""}.` : "Speaking pace could not be estimated because duration was unavailable.",
    fluency: `${repeats} possible repeat${repeats === 1 ? "" : "s"} and ${fillers} possible filler${fillers === 1 ? "" : "s"} were found in the transcript.`,
    pronunciation: "Pronunciation was not clinically assessed. The browser transcript can miss articulation details; practise clear syllables and final consonants aloud.",
    fillers: fillers ? `${fillers} possible filler${fillers === 1 ? "" : "s"} (${metrics?.fillers?.counts ? Object.entries(metrics.fillers.counts).map(([w, n]) => `${w}×${n}`).join(", ") : "see transcript"}).` : "No common filler words were detected in the transcript.",
    vocabulary: "Vocabulary range can be reviewed from the transcript; the AI report may suggest alternatives when available.",
    sentenceConstruction: "Sentence construction was observed only through the transcript; no grammar score is assigned.",
    contextualCommunication: "Relevance and structure are qualitative observations, not objective scores.",
    strengths,
    improvements,
    exercises,
    limitations: [
      "Transcript heuristics cannot reliably detect blocks, prolongations, tension, or every disfluency.",
      "Speech-recognition output can clean up or alter what was actually said.",
      "This is self-practice feedback, not a clinical assessment or diagnosis.",
    ],
    sources: { transcriptMetrics: !!metrics, aiReport: false },
    isEstimate: true,
  };
}

function normaliseAiReport(raw, fallback) {
  if (!raw || typeof raw !== "object") return fallback;
  return {
    overall: String(raw.overall || fallback.overall),
    pace: String(raw.pace || fallback.pace),
    fluency: String(raw.fluency || fallback.fluency),
    pronunciation: String(raw.pronunciation || fallback.pronunciation),
    fillers: String(raw.fillers || fallback.fillers),
    vocabulary: String(raw.vocabulary || fallback.vocabulary),
    sentenceConstruction: String(raw.sentenceConstruction || fallback.sentenceConstruction),
    contextualCommunication: String(raw.contextualCommunication || fallback.contextualCommunication),
    strengths: cleanList(raw.strengths).length ? cleanList(raw.strengths) : fallback.strengths,
    improvements: cleanList(raw.improvements).length ? cleanList(raw.improvements) : fallback.improvements,
    exercises: cleanList(raw.exercises).length ? cleanList(raw.exercises) : fallback.exercises,
    limitations: cleanList(raw.limitations).length ? cleanList(raw.limitations) : fallback.limitations,
    sources: { transcriptMetrics: true, aiReport: true },
    isEstimate: true,
  };
}

export async function generateSessionFeedback(session = {}) {
  const transcript = String(session.transcript || "").trim();
  if (!transcript) return null;

  let metrics = session.metrics || null;
  if (!metrics) {
    try {
      const data = await postJson("/api/analyze", {
        text: transcript,
        durationSec: session.durationSec || null,
        utterances: session.utterances || null,
      });
      if (data && data.wordCount !== undefined) metrics = data;
    } catch {
      metrics = null;
    }
  }

  const fallback = fallbackReport({
    transcript,
    metrics,
    events: session.events,
    durationSec: session.durationSec,
    mode: session.mode,
    pathTitle: session.pathTitle,
    activityTitle: session.activityTitle,
  });

  try {
    const data = await postJson("/api/feedback", {
      transcript: transcript.slice(0, 12000),
      metrics,
      events: (session.events || []).slice(0, 80),
      durationSec: session.durationSec || null,
      wallDurationSec: session.wallDurationSec || null,
      mode: session.mode,
      pathTitle: session.pathTitle,
      activityTitle: session.activityTitle,
      level: session.level,
      context: session.context || {},
    });
    if (data?.report) return { ...normaliseAiReport(data.report, fallback), metrics };
  } catch {
    /* deterministic fallback below */
  }

  return { ...fallback, metrics };
}
