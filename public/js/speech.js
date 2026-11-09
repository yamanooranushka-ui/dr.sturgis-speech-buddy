/* Shared speech helpers: a soft spoken voice, and a transcript
   that keeps fillers, repeats, and stutters from the recording. */

const SOFT_NAME = /aria|jenny|samantha|sonia|libby|zira|hazel|susan|google uk english female|natural|google us english/i;
const DEEP_NAME = /guy|daniel|brian|ryan|david|mark|george|rishi|alex/i;
const VOICE_LANGUAGE = {
  auto: null,
  "en-US": "en",
  "en-IN": "en",
  hinglish: "en",
  "hi-IN": "hi",
  "es-ES": "es",
  "fr-FR": "fr",
  "de-DE": "de",
};

export function disfluencyScore(text) {
  const raw = String(text || "");
  const words = raw.toLowerCase().match(/[a-z0-9']+/g) || [];
  let score = 0;
  for (let i = 1; i < words.length; i++) if (words[i] === words[i - 1]) score += 2;
  const fillers = raw.match(/\b(um+|uh+|er+|ah+|hmm+|erm|mmm)\b/gi);
  if (fillers) score += fillers.length * 2;
  const stutters = raw.match(/\b[a-z]{1,4}(?:-[a-z]{1,4})+-[a-z]+/gi);
  if (stutters) score += stutters.length * 3;
  return score;
}

export function richerTranscript(browserText, verbatimText) {
  const heard = String(browserText || "").trim();
  const verbatim = String(verbatimText || "").trim();
  if (!verbatim) return heard;
  if (!heard) return verbatim;
  // Prefer the recording transcript when it keeps at least as many
  // disfluencies as the browser's cleaned-up line.
  return disfluencyScore(verbatim) + 1 >= disfluencyScore(heard) ? verbatim : heard;
}

export function pickSoftVoice(languageId = "auto") {
  if (!("speechSynthesis" in window)) return null;
  const voices = window.speechSynthesis.getVoices() || [];
  const wanted = VOICE_LANGUAGE[languageId] || null;
  const langMatches = (voice) => {
    if (!wanted) return true;
    return String(voice.lang || "").toLowerCase().startsWith(wanted);
  };
  const exactLang = voices.filter((v) => langMatches(v) && String(v.lang || "").toLowerCase().startsWith(String(languageId).toLowerCase().slice(0, 2)));
  const sameFamily = voices.filter(langMatches);
  const pool = exactLang.length ? exactLang : sameFamily.length ? sameFamily : voices;
  const preferred =
    pool.find((v) => SOFT_NAME.test(v.name) && !DEEP_NAME.test(v.name)) ||
    pool.find((v) => /female|woman|zira|hazel|susan|aria|jenny|sonia|libby/i.test(v.name) && !DEEP_NAME.test(v.name)) ||
    pool.find((v) => !DEEP_NAME.test(v.name)) ||
    pool[0] ||
    null;
  return preferred;
}

/** Soft, natural-pace speech. Not slowed down. */
export function speakSoft(text, { languageId = "auto", rate = 1.03, pitch = 1.06, volume = 0.86 } = {}) {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window) || !text) {
      resolve();
      return;
    }
    const synth = window.speechSynthesis;
    synth.cancel();
    synth.resume();
    const utter = new SpeechSynthesisUtterance(text);
    const voice = pickSoftVoice(languageId);
    if (voice) utter.voice = voice;
    utter.lang = voice?.lang || recognitionLangFallback(languageId);
    utter.rate = rate;
    utter.pitch = pitch;
    utter.volume = volume;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(kick);
      resolve();
    };
    const kick = setInterval(() => {
      if (synth.paused) synth.resume();
    }, 400);
    utter.onend = finish;
    utter.onerror = finish;
    synth.speak(utter);
    setTimeout(finish, Math.min(24000, Math.max(2200, text.length * 52)));
  });
}

/** Wait until the browser has actually finished speaking, so the mic
    does not transcribe the AI's own voice as the user's speech. */
export function waitForSpeechIdle(timeoutMs = 6000) {
  return new Promise((resolve) => {
    const synth = window.speechSynthesis;
    if (!synth || (!synth.speaking && !synth.pending)) {
      resolve();
      return;
    }
    const started = Date.now();
    const tick = () => {
      if ((!synth.speaking && !synth.pending) || Date.now() - started >= timeoutMs) resolve();
      else setTimeout(tick, 80);
    };
    tick();
  });
}

function recognitionLangFallback(languageId) {
  if (languageId === "hinglish") return "en-IN";
  if (languageId === "auto") return navigator.language || "en-US";
  return languageId;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const raw = String(reader.result || "");
      const comma = raw.indexOf(",");
      resolve(comma >= 0 ? raw.slice(comma + 1) : raw);
    };
    reader.onerror = () => reject(reader.error || new Error("Could not read audio"));
    reader.readAsDataURL(blob);
  });
}

/** Gemini transcript of one utterance. Empty when the server is in demo mode. */
export async function transcribeBlob(blob, { language = "", context = null } = {}) {
  if (!blob || !blob.size) return "";
  const audio = await blobToBase64(blob);
  const resp = await fetch("/api/transcribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      audio,
      mimeType: (blob.type || "audio/webm").split(";")[0],
      respond: false,
      purpose: "analysis",
      language: language || undefined,
      context: context || undefined,
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.mock) return "";
  return String(data.transcript || "").trim();
}

export function createUtteranceRecorder() {
  let stream = null;
  let recorder = null;
  let chunks = [];
  let epoch = 0;

  async function arm() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") return false;
    if (!stream) {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true },
      });
    }
    return true;
  }

  function start() {
    epoch += 1;
    const mine = epoch;
    chunks = [];
    if (!stream) return;
    if (recorder && recorder.state !== "inactive") {
      try { recorder.stop(); } catch { /* ignore */ }
    }
    const types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
    const mimeType = types.find((type) => MediaRecorder.isTypeSupported(type)) || "";
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch {
      recorder = null;
      return;
    }
    recorder.ondataavailable = (event) => {
      if (mine !== epoch) return;
      if (event.data && event.data.size) chunks.push(event.data);
    };
    recorder.start();
  }

  function stop() {
    return new Promise((resolve) => {
      if (!recorder || recorder.state === "inactive") {
        resolve(null);
        return;
      }
      const rec = recorder;
      rec.addEventListener("stop", () => {
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        chunks = [];
        resolve(blob.size ? blob : null);
      }, { once: true });
      try {
        rec.stop();
      } catch {
        resolve(null);
      }
    });
  }

  function release() {
    try {
      if (recorder && recorder.state !== "inactive") recorder.stop();
    } catch { /* ignore */ }
    if (stream) stream.getTracks().forEach((track) => track.stop());
    stream = null;
    recorder = null;
    chunks = [];
  }

  return { arm, start, stop, release };
}
