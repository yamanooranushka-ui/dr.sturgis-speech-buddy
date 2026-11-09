/* Conversational practice agent opened from Practice Paths.
   Shares the Live Conversation architecture: persona-aware Gemini
   replies, live interim transcripts, spoken responses and session
   feedback. Picture-naming activities show real picture artwork and
   keep the answer hidden until the user has attempted it. */

import {
  $, el, clear, openModal, closeModal, toast, emit, explainDetails,
  showConsentModal, consentGranted, requireConsentFor, appendMarkedTranscript,
} from "./ui.js";
import {
  getProfile, getLevels, getSession, logSession, hasConsent,
  getSettings, saveSettings,
} from "./storage.js";
import { createUtteranceRecorder, richerTranscript, transcribeBlob, waitForSpeechIdle } from "./speech.js";
import { createEventLog, detectEvents } from "./detect.js";
import { generateSessionFeedback } from "./feedback.js";
import {
  CONVERSATION_LANGUAGES, buildVoiceContext, collectResultParts,
  betterSpokenCandidate, requestChat, requestOpening, speakAgent,
  setInterimTranscript, clearInterimTranscript, recognitionLang,
} from "./agent.js";
import { picturePool, pictureVisual } from "./pictures.js";

const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition || null;
const SILENCE_MS = 1500;

export function openPracticeAgent(activity, path) {
  const profile = getProfile() || {};
  const level = getLevels()[path?.id] || 1;
  const settings = getSettings();
  let languageId = profile.language || settings.conversationLanguage || "auto";
  let running = false;
  let saved = false;
  let recognition = null;
  let pendingText = "";
  let interimText = "";
  let bestInterim = "";
  let finalizeTimer = null;
  let turns = [];
  let startedAt = 0;
  let utteranceStart = 0;
  let eventLog = null;
  let voiceState = "idle";
  const recorder = createUtteranceRecorder();

  const pictureItems = activity.type === "picture" && activity.mode === "naming"
    ? picturePool(activity, level)
    : [];
  const isPictureNaming = pictureItems.length > 0;
  let pictureIndex = 0;
  let awaitingPictureAnswer = false;

  const body = openModal(`${activity.title} · conversational practice`, null, {
    wide: true,
    onClose: () => stopPractice({ silent: true }),
  });

  const intro = el("div", { class: "practice-idea" }, [
    el("strong", { text: "Practice prompt: " }),
    document.createTextNode(activity.intro || activity.title),
  ]);
  const pictureStage = el("div", { class: "picture-stage" });
  const picturePrompt = el("p", { class: "muted", text: "" });
  const personaLine = el("p", { class: "muted small", text: "" });
  const stateChip = el("span", { class: "state-chip", dataset: { state: "idle" } }, [
    el("span", { class: "state-dot", attrs: { "aria-hidden": "true" } }),
    el("span", { class: "state-text", text: "Idle" }),
  ]);
  const status = el("p", { class: "muted", attrs: { "aria-live": "polite" }, text: "Press Start practice and talk naturally. Your words appear live." });
  const log = el("div", { class: "log practice-log", attrs: { role: "log", "aria-label": "Practice conversation" } });
  const startBtn = el("button", { type: "button", class: "btn btn-primary btn-big", text: "🎙️ Start practice" });
  const stopBtn = el("button", { type: "button", class: "btn btn-danger btn-big", text: "⏹ End practice", attrs: { disabled: true } });
  const langSelect = el("select", { class: "input", attrs: { "aria-label": "Practice language" } });
  for (const option of CONVERSATION_LANGUAGES) {
    langSelect.append(el("option", { text: option.label, attrs: { value: option.id } }));
  }
  langSelect.value = languageId;
  langSelect.addEventListener("change", () => {
    languageId = langSelect.value;
    saveSettings({ conversationLanguage: languageId });
    status.textContent = `Language set to ${CONVERSATION_LANGUAGES.find((o) => o.id === languageId)?.label || languageId}.`;
  });
  const typed = el("input", { class: "input", attrs: { placeholder: "Type a reply if the microphone is unavailable", "aria-label": "Type a practice reply" } });
  const sendBtn = el("button", { type: "button", class: "btn", text: "Send" });

  body.append(
    intro,
    ...(isPictureNaming ? [pictureStage, picturePrompt] : []),
    el("div", { class: "btn-row", style: "align-items:center;margin:8px 0" }, [stateChip, personaLine]),
    status,
    log,
    el("div", { class: "btn-row", style: "margin-top:12px" }, [startBtn, stopBtn]),
    el("div", { class: "chip-row", style: "margin-top:8px" }, [
      el("label", { class: "chip", style: "cursor:pointer" }, [langSelect, " Language"]),
    ]),
    el("div", { class: "btn-row", style: "margin-top:10px" }, [typed, sendBtn]),
    explainDetails(
      "How does this practice agent work?",
      "It is a turn-based speaking partner: the browser transcribes your speech, the local backend sends the text to Gemini with this activity's persona, and the reply is spoken back. It waits for a pause before replying and never intentionally talks over you.",
      "Browser speech recognition varies by device and language. Hinglish and Hindi are best-effort; the AI can understand code-mixed text, but transcription quality depends on the browser and microphone. This is practice feedback, not clinical assessment."
    )
  );

  function context(opening = false, seedOverride) {
    const seed = seedOverride === undefined ? practiceSeedFor(activity) : seedOverride;
    return buildVoiceContext({
      profile,
      path,
      activity,
      languageId,
      level,
      seed,
      opening,
    });
  }

  function paint() {
    clear(log);
    if (!turns.length) {
      log.append(el("p", { class: "muted small", text: "The conversation will appear here. Your live words are marked while you speak." }));
      return;
    }
    for (const turn of turns) {
      const bubble = el("div", { class: "msg " + (turn.role === "user" ? "msg-user" : "msg-ai") + (turn.mock ? " msg-demo" : "") });
      if (turn.role === "user") appendMarkedTranscript(bubble, turn.text);
      else bubble.append(document.createTextNode(turn.text));
      log.append(bubble);
    }
    log.scrollTop = log.scrollHeight;
  }
  paint();

  function setState(next, text) {
    voiceState = next;
    stateChip.dataset.state = next === "paused" ? "idle" : next;
    stateChip.querySelector(".state-text").textContent = {
      idle: "Idle", listening: "Listening…", processing: "Processing…", speaking: "Agent speaking…", paused: "Paused",
    }[next] || next;
    if (text) status.textContent = text;
    startBtn.disabled = running;
    stopBtn.disabled = !running;
  }

  function updatePersona() {
    const ctx = context();
    personaLine.textContent = `${ctx.agentPersonaLabel} · ${ctx.languageLabel}`;
  }
  updatePersona();
  if (isPictureNaming) showPicture();

  function currentHeard() {
    return (pendingText + " " + (bestInterim || interimText)).trim();
  }

  function currentPicture() {
    return pictureItems[pictureIndex] || null;
  }

  function showPicture() {
    clear(pictureStage);
    const item = currentPicture();
    if (!item) {
      pictureStage.append(
        el("div", { class: "empty" }, [
          el("span", { class: "empty-icon", text: "🎉" }),
          el("p", { text: "That's all the pictures. Tap End practice to save your session." }),
        ])
      );
      picturePrompt.textContent = "";
      awaitingPictureAnswer = false;
      return;
    }
    pictureStage.append(pictureVisual(item));
    picturePrompt.textContent = `Picture ${pictureIndex + 1} of ${pictureItems.length} — look at the picture and say its name.`;
    awaitingPictureAnswer = true;
  }

  function finishPictureNaming() {
    clear(pictureStage);
    pictureStage.append(
      el("div", { class: "empty" }, [
        el("span", { class: "empty-icon", text: "🎉" }),
        el("p", { text: "Picture naming complete. Tap End practice to save your feedback." }),
      ])
    );
    picturePrompt.textContent = "";
    awaitingPictureAnswer = false;
  }

  function attachRecognition() {
    if (recognition) return;
    recognition = new SpeechRec();
    recognition.lang = recognitionLang({ ...profile, language: languageId });
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      if (!running || voiceState !== "listening") return;
      const parts = collectResultParts(event);
      interimText = parts.interim;
      if (parts.interim && scoreInterim(parts.interim) >= scoreInterim(bestInterim)) bestInterim = parts.interim;
      const heard = currentHeard();
      setInterimTranscript(log, heard);
      if (parts.finalChunk.trim()) {
        if (!pendingText) utteranceStart = Date.now();
        const chosen = betterSpokenCandidate(parts.finalChunk, bestInterim || "");
        bestInterim = "";
        pendingText = (pendingText + " " + chosen).trim();
        clearTimeout(finalizeTimer);
        finalizeTimer = setTimeout(finalizeUtterance, SILENCE_MS);
      }
    };
    recognition.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        if (!isPictureNaming) running = false;
        setState("idle", "Microphone permission was denied. Allow it in the browser, or type your reply.");
        toast("Microphone permission was denied.", { error: true });
      } else if (event.error === "network") {
        status.textContent = "Speech recognition needs an internet connection. You can type instead.";
      } else if (event.error !== "aborted") {
        console.warn("practice recognition error", event.error);
      }
    };
    recognition.onend = () => {
      if (running && voiceState === "listening" && !finalizeTimer) {
        try { recognition.start(); } catch { /* already started */ }
      }
    };
  }

  function scoreInterim(text) {
    const words = String(text || "").toLowerCase().match(/[a-z0-9']+/g) || [];
    let score = 0;
    for (let i = 1; i < words.length; i++) if (words[i] === words[i - 1]) score += 2;
    if (/\b(um|uh|er|ah|hmm)\b/i.test(text)) score += 1;
    return score;
  }

  async function beginListening(text) {
    if (!running || !SpeechRec) return;
    setState("listening", text || "Listening — speak naturally, then pause when you finish.");
    try { await recorder.arm(); recorder.start(); } catch { /* typed/browser text still works */ }
    try {
      attachRecognition();
      recognition.lang = recognitionLang({ ...profile, language: languageId });
      recognition.start();
    } catch { /* recognition may already be active */ }
  }

  function stopRecognition() {
    try { recognition && recognition.stop(); } catch { /* ignore */ }
  }

  async function finalizeUtterance() {
    clearTimeout(finalizeTimer);
    finalizeTimer = null;
    const browserText = pendingText.trim();
    pendingText = "";
    interimText = "";
    bestInterim = "";
    clearInterimTranscript(log);
    setState("processing", "Writing down your words, including pauses and repeats…");
    stopRecognition();
    let text = browserText;
    const blob = await recorder.stop();
    if (blob && running) {
      try { text = richerTranscript(browserText, await transcribeBlob(blob, { language: languageId, context: { language: languageId } })); } catch { text = browserText; }
    }
    if (!text || !running) {
      if (running) beginListening();
      return;
    }
    if (eventLog) {
      const t1 = (Date.now() - (startedAt || Date.now())) / 1000;
      const t0 = Math.max(0, t1 - Math.max(2, text.split(/\s+/).length / 2.5));
      try {
        const result = await detectEvents(text, utteranceStart ? (utteranceStart - startedAt) / 1000 : t0, t1);
        eventLog.add(result);
      } catch { /* best effort */ }
    }
    await handleUserTurn(text);
  }

  async function sayAssistant(text) {
    if (!text) return;
    turns.push({ role: "assistant", text });
    paint();
    if (running) {
      setState("speaking", "Agent is speaking…");
      await speakAgent(text, { languageId });
      await waitForSpeechIdle();
    }
  }

  async function agentReply(userText, { seed, onSpoken } = {}) {
    turns.push({ role: "user", text: userText });
    paint();
    setState("processing", "Thinking about your reply…");
    let reply = null;
    try {
      const data = await requestChat({
        message: userText,
        context: context(false, seed),
        history: turns.slice(0, -1),
      });
      reply = data.reply || "Tell me a little more about that.";
      turns.push({ role: "assistant", text: reply, mock: !!data.mock });
      paint();
      if (running) {
        setState("speaking", "Agent is speaking — you can pause or end practice.");
        await speakAgent(reply, { languageId });
        await waitForSpeechIdle();
      }
    } catch (err) {
      turns.push({ role: "assistant", text: "I couldn't reach the backend just now. Check that server.py is running, then try again.", mock: true });
      paint();
      toast("Could not reach the AI backend.", { error: true });
    }
    if (running) {
      if (reply && onSpoken) await onSpoken(reply);
      else beginListening("Listening for your next reply…");
    }
    return reply;
  }

  async function handleUserTurn(text) {
    if (isPictureNaming) {
      if (awaitingPictureAnswer) await handlePictureAnswer(text);
      return;
    }
    await agentReply(text);
  }

  async function handlePictureAnswer(text) {
    const item = currentPicture();
    if (!item) return;
    awaitingPictureAnswer = false;
    const index = pictureIndex;
    const total = pictureItems.length;
    const reply = await agentReply(text, {
      seed: pictureAnswerSeed(item, index, total),
      onSpoken: async () => {
        if (index < total - 1) {
          pictureIndex = index + 1;
          showPicture();
          await sayAssistant("What do you see?");
          if (running) beginListening("Say the name of the picture, then pause.");
        } else {
          finishPictureNaming();
          if (running) setState("idle", "Practice complete — tap End practice to save feedback.");
        }
      },
    });
    if (!reply && running) awaitingPictureAnswer = true;
  }

  async function startPictureNaming() {
    running = true;
    saved = false;
    startedAt = Date.now();
    turns = [];
    eventLog = createEventLog();
    pendingText = "";
    interimText = "";
    bestInterim = "";
    pictureIndex = 0;
    awaitingPictureAnswer = false;
    paint();
    startBtn.disabled = true;
    stopBtn.disabled = false;
    showPicture();
    await sayAssistant("Hi, I'm Dr. Sturgis. What do you see?");
    if (running) beginListening("Say the name of the picture, then pause.");
  }

  async function start() {
    const ok = await requireConsentFor("practice voice agent");
    if (!ok || running) return;
    if (isPictureNaming) {
      await startPictureNaming();
      return;
    }
    if (!SpeechRec) {
      status.textContent = "Hands-free recognition is unavailable in this browser. Type a reply below.";
      return;
    }
    running = true;
    saved = false;
    startedAt = Date.now();
    turns = [];
    eventLog = createEventLog();
    pendingText = "";
    interimText = "";
    bestInterim = "";
    paint();
    startBtn.disabled = true;
    stopBtn.disabled = false;
    setState("speaking", "Agent is saying hello…");
    try {
      const data = await requestOpening(context(true));
      const greeting = data.reply || "Hi! I'm ready to practise with you. What would you like to talk about first?";
      turns.push({ role: "assistant", text: greeting, mock: !!data.mock });
      paint();
      await speakAgent(greeting, { languageId });
      await waitForSpeechIdle();
    } catch {
      const greeting = "Hi! I'm ready to practise with you. What would you like to talk about first?";
      turns.push({ role: "assistant", text: greeting, mock: true });
      paint();
      await speakAgent(greeting, { languageId });
      await waitForSpeechIdle();
    }
    if (running) beginListening("Listening — take your time, then pause when you're done.");
  }

  async function sendTyped() {
    const text = typed.value.trim();
    if (!text) return;
    typed.value = "";
    const ok = await requireConsentFor("practice voice agent");
    if (!ok) return;
    if (!running) {
      if (isPictureNaming) {
        await startPictureNaming();
      } else {
        running = true;
        startedAt = Date.now();
        eventLog = createEventLog();
        startBtn.disabled = true;
        stopBtn.disabled = false;
      }
    }
    await handleUserTurn(text);
  }

  async function stopPractice({ silent = false } = {}) {
    if (!running && silent) return;
    running = false;
    clearTimeout(finalizeTimer);
    finalizeTimer = null;
    pendingText = "";
    interimText = "";
    bestInterim = "";
    clearInterimTranscript(log);
    stopRecognition();
    recorder.release();
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    setState("idle", "Saving your practice session…");

    const transcript = turns.filter((t) => t.role === "user").map((t) => t.text).join(" ").trim();
    const durationSec = startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0;
    if (!saved && transcript) {
      saved = true;
      const draft = {
        mode: "voice-practice",
        pathId: path.id,
        pathTitle: path.title,
        activityId: activity.id,
        activityTitle: activity.title,
        level,
        durationSec,
        wallDurationSec: durationSec,
        transcript: transcript.slice(0, 12000),
        turnCount: turns.length,
        context: context(false),
        ...(eventLog ? eventLog.toSessionFields() : {}),
      };
      try {
        const feedback = await generateSessionFeedback(draft);
        logSession({ ...draft, feedback });
      } catch {
        logSession(draft);
      }
      emit("patientai:data");
      if (!silent) toast("Practice saved with session feedback.");
    } else if (!silent) {
      toast("Practice ended.");
    }
    closeModal();
  }

  startBtn.addEventListener("click", start);
  stopBtn.addEventListener("click", () => stopPractice({ silent: false }));
  sendBtn.addEventListener("click", sendTyped);
  typed.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); sendTyped(); }
  });
  if (!SpeechRec) {
    startBtn.disabled = true;
    status.textContent = "Hands-free recognition is unavailable in this browser. You can type practice replies below.";
  }
}

function practiceSeedFor(activity) {
  if (activity?.type === "picture" && activity?.mode === "naming") {
    return "Picture naming practice. Show one picture at a time, ask what the user sees, and confirm or gently hint only after they attempt.";
  }
  const content = activity.content || {};
  const pool = content[1] || content[Object.keys(content)[0]];
  if (Array.isArray(pool) && pool.length) {
    const first = pool[0];
    if (typeof first === "string") return first;
    if (first && first.emoji) return "Talk out loud about these pictures: " + pool.map((item) => item.emoji || item.word).filter(Boolean).join(" ");
  }
  if (pool && pool.prompt) return `Say words out loud that connect to “${pool.prompt}”.`;
  if (pool && pool.target) return `Say this sentence out loud: ${pool.target}`;
  return activity.intro || activity.title;
}

function pictureAnswerSeed(item, index, total) {
  const word = item?.word ? ` The correct object is "${item.word}".` : "";
  const ending = index >= total - 1
    ? " This is the final picture; after confirming, congratulate them and invite them to end the practice."
    : " Then invite them to continue to the next picture.";
  return `Picture naming practice.${word} The user has now attempted to name the picture. Confirm gently whether they matched it; if not, give a one-word hint without naming it repeatedly.${ending}`;
}
