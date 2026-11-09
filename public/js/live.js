/* ============================================================
   live.js - Live Conversation section.

   Turn-based voice conversation: browser SpeechRecognition ->
   local backend -> Gemini -> SpeechSynthesis. It is not
   full-duplex: the app listens, processes, speaks, then listens
   again. Live interim transcripts stay visible while speaking.
   ============================================================ */

import {
  $, el, clear, toast, announce, emit,
  showConsentModal, consentGranted, requireConsentFor, appendMarkedTranscript,
} from "./ui.js";
import {
  getProfile, getSession, logSession, getSettings, saveSettings, hasConsent,
} from "./storage.js";
import { getActivePaths } from "./activities.js";
import { createEventLog, detectEvents } from "./detect.js";
import { createUtteranceRecorder, richerTranscript, transcribeBlob, waitForSpeechIdle } from "./speech.js";
import { generateSessionFeedback } from "./feedback.js";
import {
  CONVERSATION_LANGUAGES, LIVE_MODES, buildVoiceContext, collectResultParts,
  betterSpokenCandidate, requestChat, requestOpening, speakAgent,
  setInterimTranscript, clearInterimTranscript, recognitionLang, liveMode,
} from "./agent.js";

const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition || null;
const TTS_SUPPORTED = "speechSynthesis" in window;
const SILENCE_MS = 1500;

let root = null;
let state = "idle"; // idle | listening | processing | speaking
let conversationOn = false;
let recognition = null;
let pendingText = "";
let interimText = "";
let bestInterim = "";
let finalizeTimer = null;
let history = []; // {role:'user'|'assistant', text, mock?}
let autoListen = true;
let ttsEnabled = true;
let recorder = createUtteranceRecorder();
let boundEmail = null;
let lastStatusText = "Press “Start talking” to begin.";
let sessionDirty = false;
let eventLog = null;
let sessionStartMs = 0;
let languageId = "auto";
let conversationMode = "casual";
let els = {};

export function initLive() {
  root = $("#live-root");
  if (TTS_SUPPORTED) {
    window.speechSynthesis.onvoiceschanged = () => {};
    window.speechSynthesis.getVoices();
  }
  render();
}

function syncAccount() {
  const email = getSession()?.email || "";
  if (email === boundEmail) return false;
  boundEmail = email;
  conversationOn = false;
  history = [];
  pendingText = "";
  interimText = "";
  bestInterim = "";
  sessionDirty = false;
  eventLog = null;
  sessionStartMs = 0;
  clearTimeout(finalizeTimer);
  finalizeTimer = null;
  stopRecognition();
  recorder.release();
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  return true;
}

export function refreshLive() {
  if (root) render();
}

function currentLanguageId(profile) {
  return languageId || profile?.language || getSettings().conversationLanguage || "auto";
}

function currentModeId() {
  return conversationMode || getSettings().conversationMode || "casual";
}

function buildContext(opening = false) {
  const profile = getProfile() || {};
  const paths = getActivePaths(profile);
  return buildVoiceContext({
    profile,
    path: paths[0] || null,
    mode: currentModeId(),
    languageId: currentLanguageId(profile),
    opening,
  });
}

function render() {
  if (!root) return;
  syncAccount();
  clear(root);
  els = {};

  if (!hasConsent()) {
    root.append(
      el("div", { class: "notice notice-warn", role: "alert" }, [
        el("strong", { text: "Consent needed before voice features. " }),
        document.createTextNode(
          "Recording and live conversation send audio/transcripts to an external AI service (Google Gemini). " +
          "You agreed to browse without recording."
        ),
        el("div", { class: "btn-row", style: "margin-top:10px" }, [
          el("button", {
            type: "button",
            class: "btn btn-primary",
            text: "Review & allow voice features",
            onclick: async () => {
              await showConsentModal();
              emit("patientai:consent", { granted: consentGranted() });
              render();
            },
          }),
        ]),
      ])
    );
    return;
  }

  const profile = getProfile();
  if (!profile) {
    root.append(
      el("div", { class: "empty" }, [
        el("span", { class: "empty-icon", text: "💬" }),
        el("p", { text: "Create a profile first so the conversation partner knows what to practise with you." }),
        el("button", { class: "btn btn-primary", text: "Go to My Profile", attrs: { "data-goto": "profile" } }),
      ])
    );
    return;
  }

  const settings = getSettings();
  languageId = profile.language || settings.conversationLanguage || languageId || "auto";
  conversationMode = settings.conversationMode || conversationMode || "casual";

  els.stateChip = el("span", { class: "state-chip", dataset: { state: "idle" } }, [
    el("span", { class: "state-dot", attrs: { "aria-hidden": "true" } }),
    el("span", { class: "state-text", text: "Idle" }),
  ]);
  const statusRow = el("div", {
    style: "display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:12px",
  }, [
    els.stateChip,
    el("span", { class: "muted small", id: "live-status-text", attrs: { "aria-live": "polite" },
      text: "Press “Start talking” to begin." }),
  ]);
  root.append(statusRow);

  els.log = el("div", { class: "log live-log", attrs: { role: "log", "aria-label": "Live conversation transcript" } });
  root.append(
    el("div", { class: "card" }, [
      el("div", { class: "card-head" }, [
        el("h3", { text: "Conversation" }),
        el("button", {
          type: "button", class: "btn btn-small", text: "Clear",
          onclick: () => {
            flushConversationSession();
            history = [];
            render();
            toast("Conversation cleared.");
          },
        }),
      ]),
      els.log,
    ])
  );
  renderLog();

  autoListen = settings.autoListen !== false;
  ttsEnabled = settings.tts !== false;
  const voiceSupported = !!SpeechRec;

  els.startBtn = el("button", {
    type: "button", class: "btn btn-primary btn-big", text: "🎙️ Start talking",
    onclick: startConversation,
  });
  els.stopBtn = el("button", {
    type: "button", class: "btn btn-danger btn-big", text: "⏹ Stop", attrs: { disabled: true },
    onclick: stopConversation,
  });
  els.interruptBtn = el("button", {
    type: "button", class: "btn btn-big", text: "✋ Interrupt AI", attrs: { disabled: true, hidden: true },
    onclick: interruptSpeech,
  });

  const autoToggle = el("input", { type: "checkbox" });
  autoToggle.checked = autoListen;
  autoToggle.addEventListener("change", () => {
    autoListen = autoToggle.checked;
    saveSettings({ autoListen });
  });
  const ttsToggle = el("input", { type: "checkbox" });
  ttsToggle.checked = ttsEnabled;
  ttsToggle.addEventListener("change", () => {
    ttsEnabled = ttsToggle.checked;
    saveSettings({ tts: ttsEnabled });
    if (!ttsEnabled && window.speechSynthesis) window.speechSynthesis.cancel();
  });

  const langSelect = el("select", { class: "input", attrs: { "aria-label": "Conversation language" } });
  for (const option of CONVERSATION_LANGUAGES) {
    langSelect.append(el("option", { text: option.label, attrs: { value: option.id } }));
  }
  langSelect.value = languageId;
  langSelect.addEventListener("change", () => {
    languageId = langSelect.value;
    saveSettings({ conversationLanguage: languageId });
    if (recognition) recognition.lang = recognitionLang({ language: languageId });
    toast(`Conversation language set to ${CONVERSATION_LANGUAGES.find((o) => o.id === languageId)?.label || languageId}.`);
  });

  const modeSelect = el("select", { class: "input", attrs: { "aria-label": "Conversation style" } });
  for (const mode of LIVE_MODES) {
    modeSelect.append(el("option", { text: mode.label, attrs: { value: mode.id } }));
  }
  modeSelect.value = conversationMode;
  modeSelect.addEventListener("change", () => {
    conversationMode = modeSelect.value;
    saveSettings({ conversationMode });
    toast(`Conversation style set to ${liveMode(conversationMode).label}.`);
  });

  els.heardLine = el("p", { class: "muted small", style: "min-height:1.2em;margin:8px 0 0", text: "" });

  const controls = el("div", { class: "card" }, [
    el("h3", { text: "Hands-free voice conversation" }),
    voiceSupported
      ? el("p", { class: "muted small", text:
          "Turn-based flow: it listens until you pause → sends what you said to the AI → the AI speaks its reply → it listens again. " +
          "Your interim words appear in the conversation while you speak." })
      : el("div", { class: "notice notice-warn" }, [
          el("strong", { text: "Hands-free recognition isn't available in this browser. " }),
          document.createTextNode("SpeechRecognition works best in Chrome or Edge and needs an internet connection."),
        ]),
    el("div", { class: "btn-row", style: "margin-top:10px" }, [
      voiceSupported ? els.startBtn : null,
      els.stopBtn,
      els.interruptBtn,
    ]),
    els.heardLine,
    el("div", { class: "btn-row", style: "margin-top:12px;align-items:center" }, [
      el("label", { class: "muted small", style: "margin:0;font-weight:600", text: "Language:" }), langSelect,
      el("label", { class: "muted small", style: "margin:0 0 0 12px;font-weight:600", text: "Style:" }), modeSelect,
    ]),
    el("div", { class: "chip-row", style: "margin-top:12px" }, [
      el("label", { class: "chip", style: "cursor:pointer" }, [autoToggle, " Auto-continue listening"]),
      el("label", { class: "chip", style: "cursor:pointer" }, [ttsToggle, " Speak replies aloud"]),
    ]),
  ]);
  root.append(controls);
  setState(state);
}

function renderLog() {
  if (!els.log) return;
  clear(els.log);
  if (!history.length) {
    els.log.append(el("p", { class: "muted small", text: "No messages yet. Press “Start talking” and speak." }));
  } else {
    for (const turn of history) {
      const isUser = turn.role === "user";
      const bubble = el("div", { class: "msg " + (isUser ? "msg-user" : "msg-ai") + (turn.mock ? " msg-demo" : "") });
      if (isUser) appendMarkedTranscript(bubble, turn.text);
      else bubble.append(document.createTextNode(turn.text));
      if (turn.mock) bubble.append(el("div", { class: "msg-meta", text: "demo mode — simulated reply" }));
      els.log.append(bubble);
    }
  }
  els.log.scrollTop = els.log.scrollHeight;
}

function setState(next, statusText) {
  state = next;
  if (statusText !== undefined && statusText !== null) lastStatusText = statusText;
  const labels = { idle: "Idle", listening: "Listening…", processing: "Processing…", speaking: "AI speaking…" };
  if (els.stateChip) {
    els.stateChip.dataset.state = next;
    els.stateChip.querySelector(".state-text").textContent = labels[next];
  }
  const status = $("#live-status-text");
  if (status) status.textContent = lastStatusText;
  if (els.startBtn) els.startBtn.disabled = next !== "idle" || conversationOn;
  if (els.stopBtn) els.stopBtn.disabled = next === "idle" && !conversationOn;
  if (els.interruptBtn) {
    els.interruptBtn.hidden = next !== "speaking";
    els.interruptBtn.disabled = next !== "speaking";
  }
  announce(labels[next]);
}

async function startConversation() {
  if (!SpeechRec || conversationOn) return;
  conversationOn = true;
  sessionStartMs = Date.now();
  if (!eventLog) eventLog = createEventLog();
  sessionDirty = false;
  setState("speaking", "Agent is saying hello…");
  try {
    const data = await requestOpening(buildContext(true));
    const greeting = data.reply || "Hi! I'm ready to talk with you. What would you like to chat about?";
    history.push({ role: "assistant", text: greeting, mock: !!data.mock });
    renderLog();
    if (ttsEnabled && TTS_SUPPORTED) await speakAgent(greeting, { languageId });
  } catch {
    const greeting = "Hi! I'm ready to talk with you. What would you like to chat about?";
    history.push({ role: "assistant", text: greeting, mock: true });
    renderLog();
    if (ttsEnabled && TTS_SUPPORTED) await speakAgent(greeting, { languageId });
  }
  await waitForSpeechIdle();
  if (conversationOn) beginListening("Listening — speak naturally, then pause when you're done.");
}

function stopConversation() {
  conversationOn = false;
  clearTimeout(finalizeTimer);
  finalizeTimer = null;
  pendingText = "";
  interimText = "";
  bestInterim = "";
  clearInterimTranscript(els.log);
  stopRecognition();
  recorder.release();
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  void flushConversationSession();
  setState("idle", "Stopped. Press “Start talking” whenever you're ready.");
}

function interruptSpeech() {
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  announce("AI speech interrupted.");
  if (conversationOn && autoListen) beginListening("Interrupted — listening again.");
  else setState("idle", "AI speech stopped.");
}

async function beginListening(statusText) {
  if (!SpeechRec || !conversationOn) return;
  setState("listening", statusText || "Listening — speak naturally, pause when you're done.");
  try { await recorder.arm(); recorder.start(); } catch { /* browser text still works */ }
  try {
    if (!recognition) {
      recognition = new SpeechRec();
      attachRecognitionHandlers();
    }
    recognition.lang = recognitionLang({ language: languageId });
    recognition.start();
  } catch (err) {
    console.warn("recognition.start", err);
  }
}

function stopRecognition() {
  if (!recognition) return;
  try { recognition.stop(); } catch { /* ignore */ }
}

function attachRecognitionHandlers() {
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.onresult = (event) => {
    if (!conversationOn || state !== "listening") return;
    const parts = collectResultParts(event);
    interimText = parts.interim;
    if (parts.interim && scoreInterim(parts.interim) >= scoreInterim(bestInterim)) bestInterim = parts.interim;
    const heard = (pendingText + " " + (bestInterim || interimText)).trim();
    setInterimTranscript(els.log, heard);
    if (els.heardLine) els.heardLine.textContent = heard ? `Live transcript: “${heard}”` : "";
    if (parts.finalChunk.trim()) {
      if (!pendingText) utteranceStartPlaceholder();
      const chosen = betterSpokenCandidate(parts.finalChunk, bestInterim || "");
      bestInterim = "";
      pendingText = (pendingText + " " + chosen).trim();
      clearTimeout(finalizeTimer);
      finalizeTimer = setTimeout(finalizeUtterance, SILENCE_MS);
    }
  };

  recognition.onerror = (event) => {
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      conversationOn = false;
      setState("idle", "Microphone blocked.");
      toast("Microphone permission was denied. Allow it in your browser's address bar, then try again.", { error: true, ms: 5000 });
    } else if (event.error === "network") {
      toast("Speech recognition needs an internet connection. Check that you're online, then try again.", { error: true, ms: 5000 });
    } else if (event.error === "no-speech") {
      if (conversationOn && state === "listening" && els.stateChip) {
        els.stateChip.querySelector(".state-text").textContent = "Listening… (no speech yet)";
      }
    } else if (event.error !== "aborted") {
      console.warn("speech recognition error", event.error);
    }
  };

  recognition.onend = () => {
    if (conversationOn && state === "listening" && !finalizeTimer) {
      try { recognition.start(); } catch { /* ignore */ }
    }
    if (!conversationOn && state === "listening") setState("idle", "Stopped.");
  };
}

function scoreInterim(text) {
  const words = String(text || "").toLowerCase().match(/[a-z0-9']+/g) || [];
  let score = 0;
  for (let i = 1; i < words.length; i++) if (words[i] === words[i - 1]) score += 2;
  if (/\b(um|uh|er|ah|hmm)\b/i.test(text)) score += 1;
  return score;
}

function utteranceStartPlaceholder() {
  // Kept for readability; timestamps are derived in finalizeUtterance.
}

async function finalizeUtterance() {
  clearTimeout(finalizeTimer);
  finalizeTimer = null;
  const browserText = pendingText.trim();
  pendingText = "";
  interimText = "";
  bestInterim = "";
  clearInterimTranscript(els.log);
  if (els.heardLine) els.heardLine.textContent = "";
  setState("processing", "Writing down your words, including pauses and repeats…");
  stopRecognition();

  let text = browserText;
  const blob = await recorder.stop();
  if (blob) {
    try { text = richerTranscript(browserText, await transcribeBlob(blob, { language: languageId, context: { language: languageId } })); } catch { text = browserText; }
  }
  if (!text) {
    if (conversationOn && autoListen) beginListening("Listening — speak when you're ready.");
    return;
  }

  if (eventLog && sessionStartMs) {
    const t1 = (Date.now() - sessionStartMs) / 1000;
    const t0 = Math.max(0, t1 - Math.max(2, text.split(/\s+/).length / 2.5));
    try {
      const result = await detectEvents(text, t0, t1);
      eventLog.add(result);
    } catch { /* best-effort */ }
  }
  await handleUserMessage(text);
}

async function handleUserMessage(text) {
  history.push({ role: "user", text });
  sessionDirty = true;
  renderLog();
  setState("processing", "Thinking about your reply…");

  let reply = null;
  let mock = false;
  try {
    const data = await requestChat({
      message: text,
      context: buildContext(false),
      history: history.slice(0, -1),
    });
    reply = data.reply;
    mock = !!data.mock;
  } catch (err) {
    history.push({
      role: "assistant",
      text: "I couldn't reach the backend just now — please check that server.py is running, then try speaking again.",
      mock: true,
    });
    renderLog();
    setState(conversationOn && autoListen ? "listening" : "idle", "Backend error — see the message in the conversation.");
    toast("Could not reach the AI backend.", { error: true });
    return;
  }

  history.push({ role: "assistant", text: reply, mock });
  renderLog();

  if (ttsEnabled && TTS_SUPPORTED && reply) {
    setState("speaking", "Speaking the reply — press “Interrupt AI” to stop.");
    await speakAgent(reply, { languageId });
  }
  await waitForSpeechIdle();
  if (conversationOn && autoListen) beginListening("Listening for your reply…");
  else setState("idle", "Press “Start talking” to continue.");
}

async function logConversationSession() {
  const userText = history.filter((t) => t.role === "user").map((t) => t.text).join(" ");
  if (!userText.trim()) return;
  const draft = {
    mode: "conversation",
    pathId: "live",
    pathTitle: "Live Conversation",
    activityId: "conversation",
    activityTitle: "AI conversation",
    level: null,
    durationSec: null,
    wallDurationSec: sessionStartMs ? Math.round((Date.now() - sessionStartMs) / 1000) : null,
    transcript: userText.slice(0, 12000),
    turnCount: history.length,
    reflection: null,
    context: buildContext(false),
    ...(eventLog ? eventLog.toSessionFields() : {}),
  };
  try {
    const feedback = await generateSessionFeedback(draft);
    logSession({ ...draft, feedback });
  } catch {
    logSession(draft);
  }
  emit("patientai:data");
}

function flushConversationSession() {
  if (!sessionDirty) return;
  sessionDirty = false;
  void logConversationSession();
  eventLog = null;
  sessionStartMs = 0;
}

window.addEventListener("pagehide", flushConversationSession);
