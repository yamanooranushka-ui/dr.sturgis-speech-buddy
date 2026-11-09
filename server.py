"""
Dr. Sturgis - backend server (Python standard library only, no pip installs).

Responsibilities:
  * Serve the static frontend from ./public
  * /api/health    - tells the frontend whether an API key is configured
  * /api/chat      - Gemini-backed conversation replies (system prompt built here)
  * /api/transcribe- Gemini audio -> verbatim transcript (+ optional reply)
  * /api/analyze   - local, deterministic disfluency analysis (NO API call)
  * /api/detect    - local, timestamped candidate disfluency events (NO API call)

Security notes:
  * The Gemini API key is read from the environment or from a local .env file
    and is NEVER sent to the browser.
  * If no key is configured the server runs in clearly-labelled "demo mode"
    with simulated responses, so the app stays usable and testable offline.
"""
import json
import os
import re
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

import analysis

ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / "public"
MAX_BODY = 30 * 1024 * 1024  # 30 MB - allows short audio recordings as base64


# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------
def load_dotenv(path: Path) -> None:
    """Tiny .env reader (no dependency). Existing environment variables win."""
    if not path.exists():
        return
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


load_dotenv(ROOT / ".env")

API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
MODEL = os.environ.get("GEMINI_MODEL", "gemini-flash-lite-latest").strip()
PORT = int(os.environ.get("PORT", "8765"))
HOST = os.environ.get("HOST", "127.0.0.1")

GEMINI_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    + MODEL
    + ":generateContent"
)

DEMO_REPLIES = [
    "Thanks for sharing that with me. What made you want to practise that today?",
    "I'm listening. Take your time - there's no rush here. Want to try one more?",
    "That was clear and steady. Would you like to try a slightly longer sentence next?",
    "Got it. Tell me one more thing about your day, in your own words.",
    "Nice work. Remember, this is practice, not a test - how did that feel to you?",
]


# --------------------------------------------------------------------------
# Gemini helpers
# --------------------------------------------------------------------------
def gemini_request(payload: dict, timeout: int = 60) -> dict:
    """Call the Gemini generateContent endpoint. Raises RuntimeError on failure."""
    if not API_KEY:
        raise RuntimeError("NO_KEY")
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        GEMINI_URL,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "x-goog-api-key": API_KEY,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", "replace")[:500]
        except Exception:
            pass
        raise RuntimeError(f"Gemini HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Network error calling Gemini: {exc.reason}") from exc
    except TimeoutError as exc:
        raise RuntimeError("Gemini request timed out") from exc


def extract_text(response: dict) -> str:
    """Pull the concatenated text out of a generateContent response."""
    candidates = response.get("candidates") or []
    if not candidates:
        feedback = response.get("promptFeedback") or {}
        block = feedback.get("blockReason")
        if block:
            raise RuntimeError(f"Request blocked by Gemini ({block})")
        return ""
    parts = ((candidates[0].get("content") or {}).get("parts")) or []
    return "".join(p.get("text", "") for p in parts if isinstance(p, dict)).strip()


AGENT_PERSONAS = {
    "casual": (
        "Persona: a friendly, cheerful conversation partner. Speak like a relaxed friend: "
        "warm, natural, expressive, and genuinely interested. React to what the user said, "
        "ask one relevant follow-up, and encourage them to share more."
    ),
    "professional": (
        "Persona: a polished professional communication coach. Be articulate, composed and "
        "confident. Model clear workplace wording, help the user structure ideas, and give "
        "gentle feedback on clarity, confidence and sentence structure when it fits."
    ),
    "business": (
        "Persona: a senior business communication coach. Simulate realistic meetings, "
        "negotiations, presentations and client interactions. Challenge the user with "
        "specific scenarios, ask probing questions, and coach vocabulary, persuasion and "
        "articulation without sounding scripted."
    ),
    "interview": (
        "Persona: a realistic interviewer. Ask relevant questions, listen carefully, remember "
        "earlier answers, and ask follow-ups based on them. Coach the user toward stronger "
        "answers with hints and structure; do not simply give them the perfect answer."
    ),
    "expressive": (
        "Persona: an empathetic expressive-communication coach. Be patient, warm and "
        "supportive. Help the user communicate feelings, opinions and experiences naturally. "
        "Offer constructive phrasing suggestions only when helpful; never judge emotions."
    ),
    "public-speaking": (
        "Persona: a public-speaking coach. Encourage clear openings, structure, pacing and "
        "articulation. Ask audience-style questions, suggest stronger transitions, and help "
        "the user sound prepared without making the practice feel like a test."
    ),
    "supportive-fluency": (
        "Persona: a patient supportive-fluency companion. Keep the conversation unhurried, "
        "warm and pressure-free. Do not score stuttering or call attention to disfluencies; "
        "focus on confidence, ease and successful communication."
    ),
    "word-finding": (
        "Persona: a patient word-finding coach. Offer gentle cues, semantic associations and "
        "sentence frames when the user is stuck. Celebrate successful retrieval and keep "
        "turns short enough that the user is never overwhelmed."
    ),
    "articulation": (
        "Persona: a clear, precise articulation coach. Use short models, slow examples and "
        "gentle repetition prompts. Stay strictly within the clinician-provided material "
        "when present; never invent treatment or claim clinical validation."
    ),
    "sequencing": (
        "Persona: a careful sequencing coach. Help the user keep order, transitions and "
        "word order accurate. Repeat the clinician-selected sequence faithfully and avoid "
        "adding unrelated drills."
    ),
    "goal-coach": (
        "Persona: a supportive communication-goal coach. Keep practice tied to the user's "
        "clinician-defined goals, offer one small next step at a time, and avoid clinical "
        "claims or automatic difficulty changes."
    ),
    "child-play": (
        "Persona: a playful, gentle practice partner for a child. Use very short sentences, "
        "encouraging words, simple questions and caregiver-friendly pacing. Keep it light "
        "and never competitive."
    ),
}


def infer_persona(context: dict) -> str:
    explicit = str((context or {}).get("agentPersona") or "").strip()
    if explicit in AGENT_PERSONAS:
        return explicit
    text = " ".join(
        str((context or {}).get(key) or "")
        for key in ("pathId", "pathTitle", "activityId", "activityTitle", "practicePrompt")
    ).lower()
    if "interview" in text:
        return "interview"
    if "business" in text or "meeting" in text or "negotiat" in text or "client" in text:
        return "business"
    if "public" in text or "speech" in text or "audience" in text or "present" in text:
        return "public-speaking"
    if "aphasia" in text or "word-finding" in text or "word finding" in text or "sentence construction" in text:
        return "word-finding"
    if "dysarthria" in text or "articulation" in text or "intelligibility" in text:
        return "articulation"
    if "apraxia" in text or "sequencing" in text:
        return "sequencing"
    if "abi" in text or "goal" in text:
        return "goal-coach"
    if "stutter" in text or "fluency" in text or "supportive conversation" in text:
        return "supportive-fluency"
    if "child" in text or "playful" in text or "caregiver" in text:
        return "child-play"
    return "casual"


def build_system_prompt(context: dict) -> str:
    """Build the conversation-partner system prompt from the user's own profile."""
    ctx = context or {}
    age_group = ctx.get("ageGroup") or "adult"
    needs = ctx.get("needs") or []
    goals = (ctx.get("goals") or "").strip()
    prefs = ctx.get("activities") or []
    comfort = ctx.get("comfort")
    path_title = (ctx.get("pathTitle") or "").strip()
    activity_title = (ctx.get("activityTitle") or "").strip()
    practice_prompt = (ctx.get("practicePrompt") or "").strip()
    level = ctx.get("level")
    language = (ctx.get("language") or "auto").strip() or "auto"
    persona_id = infer_persona(ctx)
    persona = AGENT_PERSONAS[persona_id]

    if age_group == "child":
        tone = "Use very short, warm, playful words a child would enjoy. Keep it simple."
    elif age_group == "teenager":
        tone = "Use relaxed, respectful, everyday language a teenager would relate to."
    else:
        tone = "Use natural, friendly adult conversation language."

    lines = [
        "You are 'Dr. Sturgis', a friendly conversation partner inside a student-prototype "
        "speech practice web app called Dr. Sturgis.",
        "STRICT RULES:",
        "- You are NOT a doctor, therapist or speech-language pathologist. Never diagnose, "
        "never give medical, clinical or treatment advice, never claim exercises are validated.",
        "- Self-selected practice interests are NOT diagnoses. Treat them only as practice topics.",
        "- Keep every reply short enough to speak aloud: usually 1-3 sentences, plain words, "
        "warm and encouraging. Ask at most one follow-up question per reply.",
        "- Be patient and unhurried: the user speaks at their own pace. Never rush them, never "
        "tell them to hurry, and give them room — you only ever reply after they have finished.",
        "- If the user seems stuck, offer a gentle prompt or an example sentence they can copy.",
        "- Never score, rank or judge the user's speech. No comments like 'you stuttered' unless "
        "the user brings it up, and then respond with kindness, not assessment.",
        "- If asked about progress, say the app only shows self-practice observations, not clinical "
        "measurements.",
        "- Redirect safety concerns (distress, medical questions) to a trusted adult or a "
        "speech-language pathologist.",
        f"TONE: {tone}",
        persona,
    ]

    if ctx.get("opening"):
        lines.append(
            "The user has just opened this conversation. Greet them naturally in character, "
            "say who you are in one short phrase, and invite them to begin. Do not ask them "
            "to type; assume they will answer aloud."
        )
    if language and language != "auto":
        lines.append(
            f"LANGUAGE: The user's preferred conversation language is '{language}'. "
            "Understand and reply in that language. If the user speaks Hindi, English, or a "
            "natural Hindi-English mix (Hinglish), understand the meaning and answer in the "
            "same style. Do not unnecessarily translate the whole conversation into English; "
            "preserve names, code-mixed phrases and the user's chosen language. If the user "
            "switches languages, follow the switch naturally."
        )
    else:
        lines.append(
            "LANGUAGE: Detect the language the user is speaking. Reply in that language. "
            "Support English, Hindi, and natural Hinglish/Hindi-English code-mixing; do not "
            "force translation into English. Preserve the user's wording and language choices."
        )
    if needs:
        lines.append(
            "Practice focus chosen by the user (self-selected, not a diagnosis): "
            + ", ".join(str(n) for n in needs)
        )
    if goals:
        lines.append(f"Personal goals: {goals}")
    if prefs:
        lines.append("Preferred activities: " + ", ".join(str(p) for p in prefs))
    if isinstance(comfort, (int, float)):
        lines.append(f"Current comfort level: {comfort}/5 (adapt your pace to this).")
    if path_title:
        lines.append(f"Current practice path: {path_title}")
    if activity_title:
        lines.append(f"Current activity: {activity_title}")
    if level:
        lines.append(f"Practice level: {level}/5 (keep tasks appropriate to this level).")
    if practice_prompt:
        lines.append(
            "Stay inside this speaking practice. Invite them to say it out loud, then reply "
            "warmly with one short follow-up. Do not ask them to type. Practice idea: "
            + practice_prompt
        )
    return "\n".join(lines)


def build_feedback_prompt(data: dict) -> str:
    transcript = str(data.get("transcript") or "")[:12000]
    metrics = data.get("metrics") or {}
    events = data.get("events") or []
    return (
        "You are Dr. Sturgis, a student-prototype speaking-practice coach. Write a concise "
        "session feedback report for the user's OWN practice session.\n\n"
        "STRICT RULES:\n"
        "- This is NOT clinical assessment, diagnosis, therapy, or a score compared with other people.\n"
        "- Base feedback only on the transcript/metrics provided. Do not invent audio details.\n"
        "- Do not infer psychological confidence or emotions as objective facts.\n"
        "- Pronunciation cannot be reliably assessed from text; say so and offer articulation "
        "practice ideas only as suggestions.\n"
        "- Keep language appropriate to the user's transcript language (English, Hindi, or Hinglish).\n\n"
        "Return STRICT JSON only with keys: overall, pace, fluency, pronunciation, fillers, "
        "vocabulary, sentenceConstruction, contextualCommunication, strengths (array), "
        "improvements (array), exercises (array), limitations (array). Each string should be "
        "short, actionable and honest.\n\n"
        f"Context: {json.dumps({k: data.get(k) for k in ('mode','pathTitle','activityTitle','level','durationSec','wallDurationSec')}, ensure_ascii=False)}\n"
        f"Metrics: {json.dumps(metrics, ensure_ascii=False)[:6000]}\n"
        f"Candidate events: {json.dumps(events[:80], ensure_ascii=False)[:5000]}\n"
        f"Transcript: {transcript}"
    )


# --------------------------------------------------------------------------
# Handlers
# --------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "DrSturgis/1.0"

    # -- plumbing ---------------------------------------------------------
    def log_message(self, fmt, *args):  # quieter logs
        print("[dr-sturgis]", self.address_string(), fmt % args)

    def _send(self, status: int, body: bytes, ctype: str = "application/json; charset=utf-8") -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, status: int = 200) -> None:
        self._send(status, json.dumps(obj).encode("utf-8"))

    def _error(self, message: str, status: int = 400) -> None:
        self._json({"error": message}, status)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            raise ValueError("Missing request body")
        if length > MAX_BODY:
            raise ValueError("Request body too large")
        raw = self.rfile.read(length)
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("JSON object expected")
        return data

    # -- routing ----------------------------------------------------------
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/health":
            self._json(
                {
                    "ok": True,
                    "mock": not API_KEY,
                    "model": MODEL if API_KEY else None,
                    "speechRecognitionHint": "browser",
                }
            )
            return
        if path.startswith("/api/"):
            self._error("Not found", 404)
            return
        self._serve_static(path)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        try:
            if path == "/api/chat":
                return self._handle_chat()
            if path == "/api/feedback":
                return self._handle_feedback()
            if path == "/api/transcribe":
                return self._handle_transcribe()
            if path == "/api/analyze":
                return self._handle_analyze()
            if path == "/api/detect":
                return self._handle_detect()
            self._error("Not found", 404)
        except (ValueError, json.JSONDecodeError) as exc:
            self._error(f"Bad request: {exc}", 400)
        except RuntimeError as exc:
            msg = str(exc)
            if msg == "NO_KEY":
                self._error("NO_KEY", 503)
            else:
                self._error(msg, 502)
        except Exception as exc:  # pragma: no cover - safety net
            self._error(f"Unexpected server error: {exc}", 500)

    # -- static files -----------------------------------------------------
    def _serve_static(self, path: str):
        if path in ("", "/"):
            path = "/index.html"
        path = unquote(path)  # browsers percent-encode spaces in file names
        target = (PUBLIC_DIR / path.lstrip("/")).resolve()
        try:
            target.relative_to(PUBLIC_DIR)
        except ValueError:
            self._error("Forbidden", 403)
            return
        if not target.is_file():
            # SPA fallback: unknown non-file paths get the app shell
            if "." not in path.rsplit("/", 1)[-1]:
                target = PUBLIC_DIR / "index.html"
            else:
                self._error("Not found", 404)
                return
        ctype = self.guess_type(target)
        try:
            data = target.read_bytes()
        except OSError:
            self._error("Not found", 404)
            return
        self._send(200, data, ctype)

    @staticmethod
    def guess_type(path: Path) -> str:
        import mimetypes

        ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        return ctype

    # -- API endpoints ----------------------------------------------------
    def _handle_chat(self):
        data = self._read_json()
        message = str(data.get("message") or "").strip()
        opening = message == "__begin__"
        if opening:
            message = "Hi"
        if not message:
            self._error("message is required")
            return
        if len(message) > 8000:
            self._error("message too long")
            return
        context = dict(data.get("context") or {})
        if opening:
            context["opening"] = True
        history = data.get("history") or []
        system = build_system_prompt(context)

        if not API_KEY:
            if opening:
                reply = "Hi! I'm Dr. Sturgis — your practice partner. Whenever you're ready, just start speaking."
            else:
                reply = DEMO_REPLIES[abs(hash(message)) % len(DEMO_REPLIES)]
            self._json(
                {
                    "reply": reply + "  (demo mode - add GEMINI_API_KEY to .env for real replies)",
                    "mock": True,
                }
            )
            return

        contents = []
        for turn in history[-10:]:
            role = "model" if turn.get("role") == "assistant" else "user"
            text = str(turn.get("text") or "").strip()
            if text:
                contents.append({"role": role, "parts": [{"text": text}]})
        contents.append({"role": "user", "parts": [{"text": message}]})

        payload = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": contents,
            "generationConfig": {
                "maxOutputTokens": 400,
                "temperature": 0.85,
            },
        }
        response = gemini_request(payload, timeout=60)
        reply = extract_text(response)
        if not reply:
            self._error("Gemini returned an empty reply", 502)
            return
        self._json({"reply": reply, "mock": False})

    def _handle_feedback(self):
        data = self._read_json()
        transcript = str(data.get("transcript") or "").strip()
        if not transcript:
            self._error("transcript is required")
            return
        if len(transcript) > 30000:
            self._error("transcript too long")
            return
        if not API_KEY:
            self._json({"mock": True, "report": None})
            return
        prompt = build_feedback_prompt(data)
        payload = {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": 0.35,
                "maxOutputTokens": 1600,
                "response_mime_type": "application/json",
            },
        }
        response = gemini_request(payload, timeout=90)
        text = extract_text(response)
        parsed = None
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            match = re.search(r"\{.*\}", text, re.S)
            if match:
                try:
                    parsed = json.loads(match.group(0))
                except json.JSONDecodeError:
                    parsed = None
        if not isinstance(parsed, dict):
            self._error("Could not parse feedback response", 502)
            return
        self._json({"mock": False, "report": parsed})

    def _handle_transcribe(self):
        data = self._read_json()
        audio_b64 = data.get("audio")
        mime = str(data.get("mimeType") or "audio/webm").split(";")[0]
        if not audio_b64 or not isinstance(audio_b64, str):
            self._error("audio (base64) is required")
            return
        duration = data.get("durationSec")
        context = data.get("context") or {}
        respond = bool(data.get("respond", True))
        transcript_only = str(data.get("purpose") or "conversation") == "analysis"

        if not API_KEY:
            sample = (
                "I went to the store um and I bought some apples uh because we were "
                "out of fruit. The the oranges were on sale."
            )
            payload_out = {"transcript": sample, "mock": True}
            if duration is not None:
                try:
                    payload_out["durationSec"] = float(duration)
                except (TypeError, ValueError):
                    pass
            if respond and not transcript_only:
                payload_out["reply"] = (
                    "Thanks for recording that. (demo mode - add GEMINI_API_KEY to "
                    ".env for a real response)"
                )
            self._json(payload_out)
            return

        instruction = (
            "Transcribe this audio EXACTLY as spoken, word for word. Keep every "
            "disfluency in the transcript. Include filler words (um, uh, er, ah, hmm, "
            "like) exactly as said. Include whole-word repetitions (\"I I I want\"), "
            "phrase repetitions (\"I want I want\"), false starts, and part-word "
            "stutters written with hyphens (\"b-b-ball\", \"s-s-say\"). Do NOT clean "
            "up, summarize, or correct the speech. If speech is unintelligible, write "
            "[unintelligible]."
        )
        language = str(context.get("language") or data.get("language") or "").strip()
        if language and language != "auto":
            instruction += (
                f" The preferred conversation language is '{language}'. Understand English, "
                "Hindi, and natural Hindi-English code-mixing (Hinglish). Preserve the "
                "speaker's original language and code-mixed wording; do not force the "
                "transcript into English unless that is what was spoken."
            )
        else:
            instruction += (
                " Detect the spoken language. Preserve English, Hindi, Hindi script, romanized "
                "Hindi, and natural Hinglish/code-mixed wording exactly as spoken; do not "
                "translate or normalize the transcript into English."
            )
        if respond and not transcript_only:
            instruction += (
                " Then reply as a warm, brief conversation partner (1-3 sentences, no "
                "diagnosis, no medical advice, no judging the speech)."
            )
            instruction += ' Return strict JSON: {"transcript": "...", "reply": "..."}'
        else:
            instruction += ' Return strict JSON: {"transcript": "..."}'

        payload = {
            "contents": [
                {
                    "parts": [
                        {"inline_data": {"mime_type": mime, "data": audio_b64}},
                        {"text": instruction},
                    ]
                }
            ],
            "generationConfig": {
                "temperature": 0.2,
                "maxOutputTokens": 800,
                "response_mime_type": "application/json",
            },
        }
        response = gemini_request(payload, timeout=120)
        text = extract_text(response)
        parsed = None
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            match = re.search(r"\{.*\}", text, re.S)
            if match:
                try:
                    parsed = json.loads(match.group(0))
                except json.JSONDecodeError:
                    parsed = None
        if not isinstance(parsed, dict) or "transcript" not in parsed:
            self._error("Could not parse transcription response", 502)
            return
        parsed["mock"] = False
        if duration is not None:
            try:
                parsed["durationSec"] = float(duration)
            except (TypeError, ValueError):
                pass
        self._json(parsed)

    def _handle_analyze(self):
        data = self._read_json()
        text = str(data.get("text") or "")
        if not text.strip():
            self._error("text is required")
            return
        duration = data.get("durationSec")
        utterances = data.get("utterances")
        result = analysis.analyze_transcript(
            text,
            duration_sec=duration,
            utterances=utterances,
        )
        self._json(result)

    def _handle_detect(self):
        """Timestamped candidate disfluency events for ONE utterance fragment.

        Body: {"text": "...", "tStart": sec, "tEnd": sec} (times optional,
        session-relative). Deterministic and local - no Gemini call, no cost.
        """
        data = self._read_json()
        text = str(data.get("text") or "")
        if not text.strip():
            self._error("text is required")
            return
        result = analysis.detect_events(
            text,
            t_start=data.get("tStart"),
            t_end=data.get("tEnd"),
        )
        self._json(result)


def main():
    if not PUBLIC_DIR.is_dir():
        print(f"WARNING: {PUBLIC_DIR} does not exist - frontend will 404")
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    mode = "live Gemini mode" if API_KEY else "DEMO mode (no GEMINI_API_KEY set)"
    print("=" * 60)
    print(f"Dr. Sturgis running at http://{HOST}:{PORT}  [{mode}]")
    print("Ctrl+C to stop")
    print("=" * 60)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.server_close()


if __name__ == "__main__":
    main()
