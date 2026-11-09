/* ============================================================
   voiceagent.js - the REAL voice practice agent for Practice Paths.

   A reusable component mounted once in the Practice Paths section.
   It runs a genuine turn-based voice conversation:

     your speech -> Web Speech API -> POST /api/chat -> Gemini
     -> reply spoken back with SpeechSynthesis

   Controls: Start / Pause / Resume / End, with a clear state chip
   (Listening / Processing / AI speaking / Paused).

   Honesty rules:
   * TURN-BASED, not full-duplex: it listens, then thinks, then
     speaks, then listens again. It never talks over you, and it
     waits ~1.8s of silence after you finish before replying, so
     you can speak at your own pace.
   * Requires a real GEMINI_API_KEY for real replies; without one
     the backend returns clearly-labelled demo replies (banner).
   * While you speak, candidate disfluency events are recorded
     SILENTLY (never shown as corrections or interruptions) via
     the local /api/detect endpoint and saved with the session.

   The agent adapts to your profile: age group, practice interests,
   goals, comfort and the selected practice path + level are all
   sent as context so replies fit your path.
   ============================================================ */

import {
  $, el, clear, toast, announce, fmtDuration, emit,
  requireConsentFor, explainDetails, showConsentModal, consentGranted,
} from "./ui.js";
import { getProfile, getLevels, getSession, hasConsent } from "./storage.js";
import { getActivePaths } from "./activities.js";
import { createEventLog } from "./detect.js";
import { createUtteranceRecorder, richerTranscript, speakSoft, transcribeBlob } from "./speech.js";

// Looked up lazily so the agent picks up the browser's recognition API at
// the moment it is needed (and stays testable with an injected shim).
function getSpeechRec() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}
const TTS_SUPPORTED = "speechSynthesis" in window;
const SILENCE_MS = 1800; // patient pause before replying (your pace, not ours)

let mounted = false;
let root = null;
let els = {};

/* Agent state */
let state = "idle"; // idle | listening | processing | speaking | paused
let running = false;
let recognition = null;
let pendingText = "";
let finalizeTimer = null;
let history = [];
let autoListen = true;
let ttsEnabled = true;

/* Session bookkeeping */
let sessionStart = 0;
let utteranceStart = 0;
let eventLog = null;
let lastStateBeforePause = "listening";
let pathId = null; // selected practice path for this session
let recorder = createUtteranceRecorder();
let boundEmail = null;

/* ------------------------------------------------------------------
   Mount (called once from app.js)
------------------------------------------------------------------ */
export function initVoiceAgent() {
  root = $("#voice-agent-root");
  if (!root || mounted) return;
  mounted = true;
  render();
}

export function refreshVoiceAgent() {
  if (mounted && root) render();
}

/** Called by a path card's "Practise aloud" button. */
export function focusVoiceAgent(selectedPathId) {
  pathId = selectedPathId || pathId;
  if (mounted && root) {
    render();
    root.scrollIntoView({ behavior: "smooth", block: "start" });
    toast("Voice agent set to this path — press Start speaking when ready.");
  }
}

/* ------------------------------------------------------------------
   Render
------------------------------------------------------------------ */
function render() {
  if (!root) return;
  const email = getSession()?.email || "";
  if (email !== boundEmail) {
    boundEmail = email;
    running = false;
    history = [];
    pendingText = "";
    clearTimeout(finalizeTimer);
    finalizeTimer = null;
    stopRecognition();
    recorder.release();
    if (TTS_SUPPORTED) window.speechSynthesis.cancel();
  }
  clear(root);
  els = {};

  /* Consent gate */
  if (!hasConsent()) {
    root.append(
      el("div", { class: "notice notice-warn", role: "alert" }, [
        el("strong", { text: "Voice practice needs your consent. " }),
        document.createTextNode(
          "Speaking with the agent sends your voice/transcript to Google Gemini (external AI). " +
          "You can browse everything else without it."
        ),
        el("div", { class: "btn-row", style: "margin-top:10px" }, [
          el("button", {
            type: "button", class: "btn btn-primary", text: "Review & allow voice features",
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
      el("div", { class: "notice" }, [
        el("strong", { text: "Create a profile first. " }),
        document.createTextNode("The voice agent uses your profile to adapt its conversation."),
        " ",
        el("button", { type: "button", class: "btn btn-small", text: "Go to My Profile", attrs: { "data-goto": "profile" } }),
      ])
    );
    return;
  }

  const paths = getActivePaths(profile);
  if (!pathId || !paths.some((p) => p.id === pathId)) pathId = paths[0]?.id || null;
  const selectedPath = paths.find((p) => p.id === pathId) || null;
  const level = pathId ? getLevels()[pathId] || 1 : 1;

  /* Card */
  const card = el("div", { class: "card voice-card", attrs: { "data-voice-agent": "true" } });

  card.append(
    el("div", { class: "card-head" }, [
      el("div", {}, [
        el("h3", { text: "🎙️ Voice practice agent" }),
        el("p", { class: "muted small", style: "margin:4px 0 0", text:
          "Talk out loud with a patient AI partner, adapted to your path and level. " +
          "Turn-based: it listens until you pause, replies, then listens again — it never talks over you." }),
      ]),
    ])
  );

  /* Path selector (integrates the agent with your practice paths) */
  const pathSelect = el("select", {
    class: "input",
    attrs: { "aria-label": "Practice path for the voice agent", style: "max-width:340px" },
  });
  for (const p of paths) {
    pathSelect.append(el("option", { text: `${p.title} · Level ${getLevels()[p.id] || 1}`, attrs: { value: p.id } }));
  }
  if (selectedPath) pathSelect.value = selectedPath.id;
  pathSelect.addEventListener("change", () => {
    pathId = pathSelect.value;
    render();
  });
  els.pathSelect = pathSelect;

  card.append(
    el("div", { class: "btn-row", style: "margin-bottom:10px" }, [
      el("label", { class: "muted small", style: "margin:0;font-weight:600", text: "Practice path:" }),
      pathSelect,
    ])
  );

  /* State chip + status line */
  els.stateChip = el("span", { class: "state-chip", dataset: { state: "idle" } }, [
    el("span", { class: "state-dot", attrs: { "aria-hidden": "true" } }),
    el("span", { class: "state-text", text: "Idle" }),
  ]);
  els.statusText = el("span", {
    class: "muted small", attrs: { "aria-live": "polite" },
    text: "Press “Start speaking” to begin.",
  });
  els.timerText = el("span", { class: "muted small", text: "" });
  els.eventLine = el("span", { class: "muted small", text: "" });

  card.append(
    el("div", { style: "display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:10px" }, [
      els.stateChip, els.statusText, els.timerText, els.eventLine,
    ])
  );

  /* Conversation log */
  els.log = el("div", { class: "log", attrs: { role: "log", "aria-label": "Voice practice conversation" } });
  card.append(els.log);
  renderLog();

  /* Controls */
  els.startBtn = el("button", {
    type: "button", class: "btn btn-primary btn-big", text: "🎙️ Start speaking",
    onclick: () => {
      // If a session is already running (auto-continue off), just resume the mic.
      if (running) {
        setState("listening", "Listening — speak whenever you're ready.");
        beginListening();
        return;
      }
      startSession();
    },
  });
  els.pauseBtn = el("button", {
    type: "button", class: "btn btn-big", text: "⏸ Pause", attrs: { disabled: true },
    onclick: pauseSession,
  });
  els.resumeBtn = el("button", {
    type: "button", class: "btn btn-primary btn-big", text: "▶ Resume", attrs: { disabled: true, hidden: true },
    onclick: resumeSession,
  });
  els.endBtn = el("button", {
    type: "button", class: "btn btn-danger btn-big", text: "⏹ End practice", attrs: { disabled: true },
    onclick: endSession,
  });

  const autoToggle = el("input", { type: "checkbox" });
  autoToggle.checked = autoListen;
  autoToggle.addEventListener("change", () => { autoListen = autoToggle.checked; });
  const ttsToggle = el("input", { type: "checkbox" });
  ttsToggle.checked = ttsEnabled;
  ttsToggle.addEventListener("change", () => {
    ttsEnabled = ttsToggle.checked;
    if (!ttsEnabled && TTS_SUPPORTED) window.speechSynthesis.cancel();
  });

  card.append(
    el("div", { class: "btn-row", style: "margin-top:12px" }, [
      els.startBtn, els.pauseBtn, els.resumeBtn, els.endBtn,
    ]),
    el("div", { class: "chip-row", style: "margin-top:10px" }, [
      el("label", { class: "chip", style: "cursor:pointer" }, [autoToggle, " Auto-continue listening"]),
      el("label", { class: "chip", style: "cursor:pointer" }, [ttsToggle, " Speak replies aloud"]),
    ])
  );

  /* Fallbacks: typed message always works */
  const input = el("input", {
    class: "input",
    attrs: { placeholder: "Type instead — works without a microphone", "aria-label": "Type a message to the voice agent" },
  });
  const send = el("button", {
    type: "button", class: "btn", text: "Send",
    onclick: () => {
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      sendTyped(text);
    },
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); send.click(); }
  });
  card.append(
    el("div", { class: "btn-row", style: "margin-top:10px" }, [input, send])
  );

  /* Browser support + honesty notes */
  if (!getSpeechRec()) {
    card.append(
      el("div", { class: "notice notice-warn", style: "margin-top:10px" }, [
        el("strong", { text: "Hands-free recognition isn't available in this browser. " }),
        document.createTextNode(
          "Use Chrome or Edge (desktop/Android) with a microphone for hands-free practice. " +
          "Typing still works here, and Live Conversation has a Record & send fallback."
        ),
      ])
    );
    els.startBtn.disabled = true;
  }

  card.append(
    explainDetails(
      "Is this a real voice agent?",
      "Yes — it is a real conversation: your browser's speech recognition turns your speech into text, " +
      "the local backend sends it to Google Gemini with your path/level/profile context, and the reply is " +
      "spoken back with your browser's speech synthesis. A GEMINI_API_KEY must be configured in .env on the " +
      "server; without it you get clearly-labelled demo replies (see the banner at the top).",
      "It is turn-based (listen → think → speak → listen), not full-duplex streaming: the AI does not listen " +
      "while it is speaking, and it never interrupts you. It waits about 1.8 seconds after you stop speaking " +
      "before replying, so you can take your time. This is practice support, not therapy, not assessment."
    ),
    explainDetails(
      "What is recorded while I speak?",
      "After each of your turns, the transcript is checked locally by a heuristic detector that records " +
      "possible repetitions, fillers and elongations with timestamps. These are SILENT: nothing is shown or " +
      "said during the conversation, and no correction is ever given.",
      "Transcript heuristics cannot see speech blocks or sound prolongations (they need audio analysis), " +
      "and recognition errors affect counts. Everything recorded is an AI-estimated candidate event, never a " +
      "clinically verified observation — see Speech Insights for the full limitations."
    )
  );

  root.append(card);
  setState(state);
}

function renderLog() {
  if (!els.log) return;
  clear(els.log);
  if (!history.length) {
    els.log.append(el("p", { class: "muted small", text: "No messages yet. Press Start speaking and talk at your own pace." }));
    return;
  }
  for (const turn of history) {
    const isUser = turn.role === "user";
    els.log.append(
      el("div", { class: "msg " + (isUser ? "msg-user" : "msg-ai") + (turn.mock ? " msg-demo" : "") }, [
        document.createTextNode(turn.text),
        turn.mock ? el("div", { class: "msg-meta", text: "demo mode — simulated reply" }) : null,
      ])
    );
  }
  els.log.scrollTop = els.log.scrollHeight;
}

/* ------------------------------------------------------------------
   State chip + control visibility
------------------------------------------------------------------ */
function setState(next, statusText) {
  state = next;
  const labels = {
    idle: "Idle",
    listening: "Listening…",
    processing: "Processing…",
    speaking: "AI speaking…",
    paused: "Paused",
  };
  if (els.stateChip) {
    els.stateChip.dataset.state = next === "paused" ? "idle" : next;
    els.stateChip.querySelector(".state-text").textContent = labels[next];
  }
  if (els.statusText && statusText) els.statusText.textContent = statusText;

  if (els.startBtn) els.startBtn.disabled = next !== "idle";
  // Pause is available whenever a session is running — including the
  // between-turns "idle" chip state (auto-continue off) and while paused.
  if (els.pauseBtn) {
    els.pauseBtn.disabled = !running || next === "paused";
    els.pauseBtn.hidden = !running || next === "paused";
  }
  if (els.resumeBtn) {
    els.resumeBtn.disabled = next !== "paused";
    els.resumeBtn.hidden = next !== "paused";
  }
  // End + path selector depend on the SESSION (running), not the turn state:
  // a session stays active between turns even when the chip shows "Idle"
  // (auto-continue off), so it must remain endable then.
  if (els.endBtn) els.endBtn.disabled = !running;
  if (els.pathSelect) els.pathSelect.disabled = running;

  announce(labels[next]);
}

function updateTimer() {
  if (!els.timerText) return;
  if (!sessionStart) { els.timerText.textContent = ""; return; }
  els.timerText.textContent = `· ${fmtDuration((Date.now() - sessionStart) / 1000)}`;
}

function updateEventLine() {
  if (!els.eventLine) return;
  if (!eventLog) { els.eventLine.textContent = ""; return; }
  const n = eventLog.count;
  els.eventLine.textContent = n
    ? `· silent monitoring: ${n} candidate event${n === 1 ? "" : "s"} recorded (shown after the session)`
    : "· silent monitoring active (nothing is shown or said during practice)";
}

/* ------------------------------------------------------------------
   Session controls: start / pause / resume / end
------------------------------------------------------------------ */
async function startSession() {
  const ok = await requireConsentFor("voice practice");
  if (!ok) return;
  if (!getSpeechRec()) return;

  running = true;
  history = [];
  eventLog = createEventLog();
  sessionStart = Date.now();
  pendingText = "";
  renderLog();
  updateEventLine();
  setState("listening", "Starting the microphone — speak whenever you're ready.");
  startTimer();
  beginListening();
}

function pauseSession() {
  if (!running || state === "paused") return;
  lastStateBeforePause = state === "speaking" ? "speaking" : "listening";
  clearTimeout(finalizeTimer);
  finalizeTimer = null;
  stopRecognition();
  if (TTS_SUPPORTED) window.speechSynthesis.cancel();
  setState("paused", "Paused — nothing is listening. Press Resume when you're ready.");
  announce("Practice paused.");
}

function resumeSession() {
  if (!running || state !== "paused") return;
  if (lastStateBeforePause === "speaking") {
    // The AI reply was cut off by the pause; just go back to listening.
    setState("listening", "Listening — take your time.");
    beginListening();
  } else {
    setState("listening", "Listening — take your time.");
    beginListening();
  }
  announce("Practice resumed.");
}

function endSession() {
  if (!running) return;
  running = false;
  clearTimeout(finalizeTimer);
  finalizeTimer = null;
  pendingText = "";
  stopTimer();
  stopRecognition();
  recorder.release();
  if (TTS_SUPPORTED) window.speechSynthesis.cancel();

  const durationSec = sessionStart ? Math.round((Date.now() - sessionStart) / 1000) : 0;
  const transcript = history
    .filter((t) => t.role === "user")
    .map((t) => t.text)
    .join(" ")
    .trim();

  setState("idle", "Session ended. Well done — take a breath.");
  sessionStart = 0;
  updateTimer();

  const done = () => {
    history = [];
    eventLog = null;
    renderLog();
    updateEventLine();
  };

  if (!transcript) {
    toast("Session ended — nothing was spoken, so nothing was saved.");
    done();
    return;
  }

  // Hand off to the existing reflection + session logging flow.
  onSessionEnd({
    transcript,
    durationSec,
    turnCount: history.length,
    pathId,
    eventFields: eventLog ? eventLog.toSessionFields() : {},
    onSaved: done,
    onCancel: done,
  });
}

/* Provided by activities.js via setSessionHandler to reuse the
   existing reflection modal + logSession flow (no duplication). */
let sessionHandler = null;
export function setVoiceSessionHandler(fn) {
  sessionHandler = fn;
}

function onSessionEnd(data) {
  if (sessionHandler) {
    sessionHandler(data);
  } else {
    // Fallback: save without reflection if the handler isn't wired.
    import("./storage.js").then(({ logSession }) => {
      logSession({
        mode: "voice-agent",
        pathId: data.pathId || "live",
        pathTitle: "Voice practice",
        activityId: "voice-agent",
        activityTitle: "Voice practice with AI",
        level: data.pathId ? getLevels()[data.pathId] || 1 : null,
        durationSec: null,
        wallDurationSec: data.durationSec,
        transcript: data.transcript.slice(0, 1200),
        turnCount: data.turnCount,
        ...(data.eventFields || {}),
      });
      emit("patientai:data");
      toast("Voice practice session saved.");
      data.onSaved && data.onSaved();
    });
  }
}

/* ------------------------------------------------------------------
   Timer
------------------------------------------------------------------ */
let timerTick = null;
function startTimer() {
  stopTimer();
  timerTick = setInterval(updateTimer, 500);
}
function stopTimer() {
  clearInterval(timerTick);
  timerTick = null;
}

/* ------------------------------------------------------------------
   Speech recognition
------------------------------------------------------------------ */
async function beginListening() {
  const SR = getSpeechRec();
  if (!SR || !running || state === "paused") return;
  setState("listening", "Listening — speak naturally, pause when you're done.");
  try { await recorder.arm(); recorder.start(); } catch { /* browser text still works */ }
  try {
    if (!recognition) {
      recognition = new SR();
      recognition.lang = navigator.language || "en-US";
      recognition.continuous = true;
      recognition.interimResults = true;
      attachRecognitionHandlers();
    }
    recognition.start();
  } catch (err) {
    console.warn("voice agent recognition.start", err);
  }
}

function stopRecognition() {
  if (!recognition) return;
  try { recognition.stop(); } catch { /* ignore */ }
}

function attachRecognitionHandlers() {
  recognition.onresult = (event) => {
    if (!running || state === "paused") return;
    let interim = "";
    let finalChunk = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const text = result[0].transcript;
      if (result.isFinal) finalChunk += text;
      else interim += text;
    }
    if (finalChunk.trim()) {
      if (!pendingText) utteranceStart = Date.now();
      pendingText = (pendingText + " " + finalChunk).trim();
      clearTimeout(finalizeTimer);
      finalizeTimer = setTimeout(finalizeUtterance, SILENCE_MS);
    }
    if (els.statusText && (pendingText || interim)) {
      els.statusText.textContent = `Heard: “${(pendingText + " " + interim).trim()}”`;
    }
  };

  recognition.onerror = (event) => {
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      running = false;
      stopTimer();
      setState("idle", "Microphone blocked.");
      toast("Microphone permission was denied. Allow it in your browser's address bar, then try again.", { error: true, ms: 5000 });
    } else if (event.error === "network") {
      toast("Speech recognition needs an internet connection. You can type your reply instead.", { error: true, ms: 5000 });
    } else if (event.error === "no-speech") {
      if (running && state === "listening" && els.statusText) {
        els.statusText.textContent = "Listening… (no speech yet — I'm waiting for you, no rush)";
      }
    } else if (event.error !== "aborted") {
      console.warn("voice agent recognition error", event.error);
    }
  };

  recognition.onend = () => {
    // Chrome sometimes ends recognition on its own - restart if still practicing
    if (running && state === "listening" && !finalizeTimer) {
      try { recognition.start(); } catch { /* ignore */ }
    }
    if (!running && state === "listening") setState("idle", "Stopped.");
  };
}

async function finalizeUtterance() {
  clearTimeout(finalizeTimer);
  finalizeTimer = null;
  const browserText = pendingText.trim();
  pendingText = "";
  stopRecognition();
  let text = browserText;
  const blob = await recorder.stop();
  if (blob && running) {
    setState("processing", "Writing down your words, including pauses and repeats…");
    try {
      text = richerTranscript(browserText, await transcribeBlob(blob));
    } catch {
      text = browserText;
    }
  }
  if (!text || !running) {
    if (running && autoListen) beginListening();
    return;
  }

  // Silent event detection for this turn (never interrupts the flow).
  if (eventLog) {
    const t0 = utteranceStart ? (utteranceStart - sessionStart) / 1000 : null;
    const t1 = (Date.now() - sessionStart) / 1000;
    import("./detect.js")
      .then(({ detectEvents }) => detectEvents(text, t0, t1))
      .then((result) => {
        eventLog && eventLog.add(result);
        updateEventLine();
      })
      .catch(() => { /* detection is best-effort */ });
  }

  await handleUserMessage(text);
}

/* ------------------------------------------------------------------
   Chat pipeline (same real backend as Live Conversation)
------------------------------------------------------------------ */
function buildContext() {
  const profile = getProfile() || {};
  const paths = getActivePaths(profile);
  const selected = paths.find((p) => p.id === pathId) || null;
  const level = pathId ? getLevels()[pathId] || 1 : null;
  return {
    ageGroup: profile.ageGroup,
    needs: profile.needs,
    goals: profile.goals,
    activities: profile.activities,
    comfort: profile.comfort,
    pathTitle: selected ? selected.title : paths[0]?.title,
    activityTitle: selected ? `Voice practice · Level ${level}` : "Voice practice",
  };
}

async function handleUserMessage(text) {
  history.push({ role: "user", text });
  renderLog();
  setState("processing", "Thinking about your reply…");

  let reply = null;
  let mock = false;
  try {
    const resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text,
        context: buildContext(),
        history: history.slice(-6, -1),
      }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "Request failed");
    reply = data.reply;
    mock = !!data.mock;
  } catch (err) {
    history.push({
      role: "assistant",
      text: "I couldn't reach the backend just now — check that server.py is running, then press Resume (or type your reply).",
      mock: true,
    });
    renderLog();
    if (running) setState("listening", "Backend error — see the message above.");
    toast("Could not reach the AI backend.", { error: true });
    return;
  }

  if (!running) return; // ended while waiting for the reply
  if (state === "paused") return;
  history.push({ role: "assistant", text: reply, mock });
  renderLog();

  const speakIt = ttsEnabled && TTS_SUPPORTED && reply;
  if (speakIt && running && state !== "paused") {
    setState("speaking", "Speaking — press Pause or End to stop.");
    await speak(reply);
  }

  if (!running || state === "paused") return;
  if (autoListen) {
    beginListening();
  } else {
    // Auto-continue off: wait for the user to type or press Start speaking.
    stopRecognition();
    setState("idle", "Turn done — auto-continue is off. Type a reply or press Start speaking.");
  }
}

function speak(text) {
  if (!TTS_SUPPORTED) return Promise.resolve();
  return speakSoft(text);
}

async function sendTyped(text) {
  if (!hasConsent()) {
    const ok = await requireConsentFor("voice practice");
    if (!ok) return;
  }
  if (!running) {
    // Typed messages work even before starting a session.
    running = true;
    sessionStart = sessionStart || Date.now();
    if (!eventLog) eventLog = createEventLog();
    startTimer();
    updateEventLine();
    if (els.endBtn) els.endBtn.disabled = false;
    if (els.pathSelect) els.pathSelect.disabled = true;
  }
  await handleUserMessage(text);
}

// Save/flush state if the tab closes mid-practice
window.addEventListener("pagehide", () => {
  if (running && sessionStart) {
    const transcript = history.filter((t) => t.role === "user").map((t) => t.text).join(" ").trim();
    if (transcript && sessionHandler) {
      sessionHandler({
        transcript,
        durationSec: Math.round((Date.now() - sessionStart) / 1000),
        turnCount: history.length,
        pathId,
        eventFields: eventLog ? eventLog.toSessionFields() : {},
        onSaved: () => {},
        onCancel: () => {},
        silent: true,
      });
    }
  }
});
