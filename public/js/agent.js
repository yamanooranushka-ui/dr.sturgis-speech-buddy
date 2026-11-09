/* ============================================================
   agent.js - shared conversational-agent helpers.

   Keeps Live Conversation and Practice Paths on the same
   architecture: persona-aware prompts, multilingual hints,
   chat requests, spoken replies and live interim transcripts.
   ============================================================ */

import { appendMarkedTranscript, el } from "./ui.js";
import { getProfile, getSettings } from "./storage.js";
import { speakSoft } from "./speech.js";

export const CONVERSATION_LANGUAGES = [
  { id: "auto", label: "Auto-detect / device language", recognition: null, note: "Uses your browser's current language setting." },
  { id: "en-US", label: "English (US)", recognition: "en-US" },
  { id: "en-IN", label: "English (India) / Hinglish-friendly", recognition: "en-IN" },
  { id: "hinglish", label: "Hinglish (Hindi + English)", recognition: "en-IN" },
  { id: "hi-IN", label: "Hindi", recognition: "hi-IN" },
  { id: "es-ES", label: "Spanish", recognition: "es-ES" },
  { id: "fr-FR", label: "French", recognition: "fr-FR" },
  { id: "de-DE", label: "German", recognition: "de-DE" },
];

export function languageOption(id) {
  return CONVERSATION_LANGUAGES.find((item) => item.id === id) || CONVERSATION_LANGUAGES[0];
}

export function recognitionLangFor(id) {
  const option = languageOption(id);
  if (option.id === "auto") return navigator.language || "en-US";
  return option.recognition || option.id;
}

export function effectiveLanguageId(profile = getProfile()) {
  const settings = getSettings();
  return profile?.language || settings.conversationLanguage || "auto";
}

export function recognitionLang(profile = getProfile()) {
  return recognitionLangFor(effectiveLanguageId(profile));
}

export function languageContext(profile = getProfile(), overrideId = null) {
  const id = overrideId || effectiveLanguageId(profile);
  const option = languageOption(id);
  return {
    conversationLanguage: id,
    languageLabel: option.label,
    recognitionLang: recognitionLangFor(id),
    hinglish: id === "hinglish" || id === "en-IN",
  };
}

export const LIVE_MODES = [
  { id: "casual", label: "Casual conversation", persona: "casual" },
  { id: "professional", label: "Professional communication", persona: "professional" },
  { id: "business", label: "Business communication", persona: "business" },
  { id: "interview", label: "Interview practice", persona: "interview" },
  { id: "expressive", label: "Emotional & expressive", persona: "expressive" },
  { id: "public", label: "Public speaking", persona: "public-speaking" },
];

export function liveMode(id) {
  return LIVE_MODES.find((item) => item.id === id) || LIVE_MODES[0];
}

export function personaFor({ path, activity, mode, seed } = {}) {
  const text = `${path?.id || ""} ${path?.title || ""} ${activity?.id || ""} ${activity?.title || ""} ${seed || ""}`.toLowerCase();

  if (mode) {
    const found = LIVE_MODES.find((item) => item.id === mode);
    if (found) return { id: found.persona, label: found.label };
  }
  if (text.includes("interview")) return { id: "interview", label: "Interview practice" };
  if (text.includes("business") || text.includes("meeting") || text.includes("negotiat") || text.includes("client") || text.includes("presentation")) {
    return { id: "business", label: "Business communication" };
  }
  if (text.includes("public") || text.includes("speech") || text.includes("audience") || text.includes("present")) {
    return { id: "public-speaking", label: "Public speaking" };
  }
  if (text.includes("professional") || text.includes("workplace") || text.includes("work")) {
    return { id: "professional", label: "Professional communication" };
  }
  if (text.includes("feeling") || text.includes("emotion") || text.includes("opinion") || text.includes("express")) {
    return { id: "expressive", label: "Emotional & expressive communication" };
  }
  if (text.includes("aphasia") || text.includes("word-finding") || text.includes("word finding") || text.includes("sentence construction") || text.includes("word association")) {
    return { id: "word-finding", label: "Word-finding coach" };
  }
  if (text.includes("dysarthria") || text.includes("articulation") || text.includes("intelligibility")) {
    return { id: "articulation", label: "Articulation coach" };
  }
  if (text.includes("apraxia") || text.includes("sequencing")) {
    return { id: "sequencing", label: "Sequencing coach" };
  }
  if (text.includes("abi") || text.includes("goal")) {
    return { id: "goal-coach", label: "Communication-goal coach" };
  }
  if (text.includes("stutter") || text.includes("fluency") || text.includes("supportive conversation")) {
    return { id: "supportive-fluency", label: "Supportive fluency companion" };
  }
  if (text.includes("child") || text.includes("playful") || text.includes("caregiver") || text.includes("story time")) {
    return { id: "child-play", label: "Playful practice partner" };
  }
  return { id: "casual", label: "Casual conversation partner" };
}

export function buildVoiceContext({ profile = getProfile(), path = null, activity = null, mode = null, seed = "", languageId = null, level = null, opening = false } = {}) {
  const persona = personaFor({ path, activity, mode, seed });
  const lang = languageContext(profile, languageId);
  return {
    ageGroup: profile?.ageGroup,
    needs: profile?.needs,
    goals: profile?.goals,
    activities: profile?.activities,
    comfort: profile?.comfort,
    language: lang.conversationLanguage,
    languageLabel: lang.languageLabel,
    agentPersona: persona.id,
    agentPersonaLabel: persona.label,
    conversationMode: mode || null,
    pathId: path?.id || null,
    pathTitle: path?.title || null,
    activityId: activity?.id || null,
    activityTitle: activity?.title || null,
    level,
    practicePrompt: seed || null,
    opening: !!opening,
  };
}

export async function requestChat({ message, context, history = [] }) {
  const resp = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      context,
      history: history.slice(-10),
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || "Request failed");
  return data;
}

export function requestOpening(context) {
  return requestChat({ message: "__begin__", context, history: [] });
}

export function speakAgent(text, { languageId = null } = {}) {
  return speakSoft(text, { languageId });
}

/** Pull final + interim pieces out of a SpeechRecognition result event. */
export function collectResultParts(event) {
  let finalChunk = "";
  let interim = "";
  for (let i = event.resultIndex; i < event.results.length; i++) {
    const result = event.results[i];
    const text = result[0]?.transcript || "";
    if (result.isFinal) finalChunk += text;
    else interim += text;
  }
  return { finalChunk, interim };
}

/** Prefer whichever candidate preserved more disfluency markers. */
export function betterSpokenCandidate(preferred, fallback) {
  const score = (text) => {
    const raw = String(text || "");
    const words = raw.toLowerCase().match(/[a-z0-9']+/g) || [];
    let value = 0;
    for (let i = 1; i < words.length; i++) if (words[i] === words[i - 1]) value += 2;
    if (/\b(um+|uh+|er+|ah+|hmm+|erm|mmm)\b/i.test(raw)) value += 2;
    if (/\b[a-z]{1,4}(?:-[a-z]{1,8})+\b/i.test(raw)) value += 3;
    return value;
  };
  return score(fallback) > score(preferred) ? fallback : preferred;
}

export function setInterimTranscript(log, text) {
  if (!log) return null;
  let node = log.querySelector(".msg-interim");
  if (!node) {
    node = el("div", { class: "msg msg-user msg-interim" });
    log.append(node);
    log.scrollTop = log.scrollHeight;
  }
  node.textContent = "";
  appendMarkedTranscript(node, text || "…");
  node.title = "Live transcript — still listening";
  log.scrollTop = log.scrollHeight;
  return node;
}

export function clearInterimTranscript(log) {
  const node = log?.querySelector(".msg-interim");
  if (node) node.remove();
}

export function apiHistory(history, { excludeLastUser = false } = {}) {
  const turns = history.filter((turn) => turn.role === "user" || turn.role === "assistant");
  return turns.slice(-10, excludeLastUser ? -1 : undefined).map((turn) => ({
    role: turn.role,
    text: turn.text,
  }));
}
