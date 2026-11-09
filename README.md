<<<<<< HEAD
# Dr. Sturgis — Speech Practice Companion

> **Student prototype. Not a medical device, not a diagnostic tool, and not a
> substitute for professional care.** Nothing in this app is a clinical
> measurement, diagnosis or treatment. Always consult a qualified
> speech-language pathologist.

Dr. Sturgis is a hands-free-friendly speech practice web app with personalized
practice paths, a real-time voice agent, silent AI-estimated stuttering-event
monitoring, a visual Speech Insights dashboard, disfluency-aware transcript
analysis, a private personal speech fingerprint, long-term progress tracking
and privacy controls.

---

## Quick start (Windows)

```bat
1. Double-click  start.bat
   (or run:  "C:\ProgramData\anaconda3\python.exe" server.py )

2. Open http://127.0.0.1:8765  in Chrome or Edge

3. Optional — real AI replies instead of demo mode:
      copy .env.example  →  .env
      add your Gemini key from https://aistudio.google.com/apikey
      restart the server
```

- **No pip installs, no database, no build step.** Backend = Python 3
  standard library only. Frontend = plain HTML/CSS/JS (ES modules).
- All personal data lives in your browser's `localStorage`. The server stores
  nothing.

## Project layout

```
patient-ai/
├── server.py            # static server + /api/chat, /api/transcribe,
│                        #   /api/analyze, /api/detect
├── analysis.py          # deterministic disfluency analysis + extensible
│                        #   candidate-event detector registry (no AI cost)
├── test_analysis.py     # 25 unit tests (python -m unittest test_analysis)
├── .env.example         # copy to .env and add GEMINI_API_KEY (never commit .env)
├── start.bat
└── public/
    ├── index.html       # 6 sections with fixed left-sidebar navigation:
    │                    #   Profile · Practice · Live · Insights · Progress · Privacy
    ├── assets/
    │   └── Heart Care App Icon.png   # logo + favicon (filename kept as-is)
    ├── styles.css       # Dr. Sturgis design system (pastel green, light/dark, responsive, accessible)
    └── js/
        ├── app.js       # navigation, consent, system banner, agent boot
        ├── ui.js        # DOM/modal/toast helpers, consent gate, explainers
        ├── storage.js   # localStorage persistence + export/delete
        ├── profile.js   # first-time setup (self-selected preferences, never diagnoses)
        ├── activities.js# practice paths, 5 levels, condition activities, runner
        ├── voiceagent.js# real-time voice agent (start/pause/resume/end, state machine)
        ├── detect.js    # client-side candidate-event log, history comparison, patterns
        ├── live.js      # turn-based voice chat + MediaRecorder fallback
        ├── insights.js  # visual analytics dashboard, session summaries, trends
        ├── charts.js    # dependency-free SVG charts (line/bar/timeline/compare/consistency)
        ├── progress.js  # weekly summary, timeline, downloadable report
        └── privacy.js   # consent, data controls, disclosures
```

## Features & how to test them

### 0. First run — consent
1. Open the app → a consent dialog appears before anything is recorded.
2. Click **“I understand and agree”** (voice features on) or
   **“Not now — browse without recording”** (everything except recording works).
3. You can change this any time in **Privacy → Review consent / Withdraw consent**.

### 1. My Profile (first-time setup)
1. Open **My Profile** (first-run default section).
2. Pick an age group, one or more practice interests, goals (or tap a goal chip),
   preferred activities and a comfort slider, tick the prototype acknowledgment,
   then **Create my profile**.
3. Try picking **Child** without ticking the caregiver box → you should see the
   caregiver-assisted validation error. Tick it and save → profile created.
4. **Edit profile** re-opens the form; changes take effect immediately.
5. Check: no name, birth date or exact age is ever asked for.

### 2. Practice Paths
1. Open **Practice Paths** — paths are built from your profile selections
   (+ “Everyday speech practice” for everyone, + child path for children).
2. Click any of the **5 levels** — your current level changes instantly and is
   remembered. Levels are optional; jump/skip any time.
3. Run activities: **Start** → interact → **Done** → rate comfort → **Save session**.
   - Supportive conversation / Reading / Role-play / Awareness → prompt runner
   - Picture naming → reveal hint, next picture
   - Word association → type connected words, “Show some ideas”
   - Sentence construction → tap words in order, “Check”
   - Child → picture story time + caregiver-supported games
4. **Clinician-configured paths** (dysarthria, apraxia of speech, acquired brain
   injury) are locked by default with a 🔒 notice. Click **Enter clinician
   configuration**, enter what your clinician gave you, save → activities unlock.
   Remove the configuration → path locks again.
5. After rating **at least 2 sessions** in a path, an *optional* level suggestion
   may appear based only on your comfort ratings — **Try** or **Keep my level**.
   Difficulty never increases because speech sounds more fluent.
6. **Voice agent (“Practise aloud with AI”)** sits above the path cards:
   1. Click **🎙️ Practise aloud with AI** on any path card (or **🎙️ Start
      speaking** in the agent itself) — the agent adapts to your profile
      (age group, practice interests, goals) *and* the selected path/level.
   2. State chip shows **Idle → Listening… → Processing… → AI speaking…** with
      **Start / Pause / Resume / End practice** controls. It is turn-based and
      patient: it waits ~1.8 s after you stop before replying, and never
      interrupts you mid-sentence.
   3. Chrome/Edge with a microphone give the hands-free flow (real Gemini
      replies spoken aloud). Without a microphone you get a clearly-labelled
      typed fallback that still runs the same conversation and saves the same
      kind of session.
   4. **End practice** opens the session reflection (comfort + optional note);
      the session — transcript, wall-clock duration, and any silently recorded
      candidate events — is saved to localStorage for Insights.
   5. Setup needed: `GEMINI_API_KEY` in `.env` for real replies (demo replies
      are clearly labelled without it), plus microphone permission in the
      browser for hands-free mode.

### 3. Live Conversation
1. Open **Live Conversation**. Chrome/Edge show hands-free mode; other browsers
   get a clear notice plus the fallbacks.
2. **Hands-free (turn-based, not full-duplex):** click **Start talking** → allow
   the microphone → state chip shows **Listening… → Processing… → AI speaking…**
   → speak → pause ~1.4 s → your words are sent → the AI replies aloud → it
   listens again. **Stop** ends the conversation; **✋ Interrupt AI** (visible
   while speaking) cuts the AI off immediately. Toggles: *Auto-continue
   listening*, *Speak replies aloud*.
3. **Record & send (fallback, every browser):** ⏺ Record → speak → ■ Stop →
   transcript + reply appear; the session is analysed and saved for Insights.
4. **Type a message** always works with no microphone at all.
5. Error handling to verify: deny the microphone → a clear toast explains how to
   fix it and the state returns to Idle; stop the backend → the chat shows a
   friendly error message instead of failing silently.

### 4. Speech Insights (visual analytics)
1. Complete a recording, conversation or voice-agent session, then open
   **Speech Insights**. Charts are built **only from sessions stored in your
   browser** — nothing is hardcoded, nothing is fetched from other people.
2. **Snapshot chips + “Progress over time” line chart** — switch the metric
   (speaking rate, filler rate, repetition rate, comfort, candidate events),
   each point a real session with axes, legend, hover tooltips and gaps where
   data is missing.
3. **Disfluency breakdown** bar chart — possible repetitions / fillers /
   elongations from your transcripts; blocks and prolongations are shown as 0
   with an explicit “not detectable from transcripts” note, never as “absent”.
4. **Speech timeline** — pick any session from the selector to see *when*
   candidate events were recorded (approximate timestamps within each
   utterance).
5. **Session comparison** — toggle 2–4 sessions with chips; metrics are shown
   side by side with your personal baseline for context (never compared
   against other people).
6. **Practice consistency** — days active per week plus a 28-day strip.
   Progress is never reduced to “stuttering frequency”: consistency and your
   own comfort ratings/comfort ratings sit alongside frequency-style metrics.
7. **Recurring patterns** — words/phrases that recur across *your* sessions
   (your own history only).
8. **Previous session summaries** — every session row has **View summary**
   with transcript, comfort, event timeline and a comparison notice.
9. Empty states tell you what to do next; a loading notice appears while
   local analysis runs; backend failures show a retry notice instead of fake
   data.
10. Check the metric-card *“What does this mean?”* explainers — each states
    exactly how the number is computed, that it is an **experimental
    AI-estimated value (not clinical)**, and what it cannot detect.
11. **Personal speech fingerprint** shows *your* usual range from *your* first
    sessions, and how the latest session compares — never against other people.
12. Red-banner limitations: transcript analysis cannot reliably detect blocks,
    sound prolongations or all disfluencies.

### 4b. Silent candidate-event monitoring
1. During voice-agent conversations, Live conversations and recordings, a
   local heuristic detector records **possible** repetitions, fillers and
   elongations with timestamps — silently. It **never interrupts or corrects
   you mid-conversation**; the count appears only after the session.
2. Sessions store the raw events (`events[]`) and a summary
   (`eventSummary`) flagged `isEstimate: true`. Insights labels them
   AI-estimated throughout and distinguishes them from clinical observation.
3. The detector registry in `analysis.py` (`register_detector`) is designed so
   future models can be added without touching the storage or UI layers.

### 5. Progress
1. Open **Progress** → *This week* summary (sessions, minutes, average comfort).
2. Goals table shows your paths, current levels and session counts.
3. Session history timeline with your own reflection notes.
4. **Preview & download report** → Markdown report you can voluntarily share
   with your speech-language pathologist (review it before sending).

### 6. Privacy & Data
1. **Export all data (JSON)** → downloads everything stored in this browser.
2. **Delete session history only** → confirm → history gone, profile kept.
3. **Delete everything** → type `DELETE` → app returns to first-run state
   (there is no server-side copy — Dr. Sturgis has no database).
4. Review the “what's stored / what leaves your device” table and the
   children's-data note.

### Backend & analysis tests
```bat
python -m unittest test_analysis -v      # 25 tests, all pass
```
Manual API checks (with the server running):
```powershell
Invoke-RestMethod http://127.0.0.1:8765/api/health
Invoke-RestMethod http://127.0.0.1:8765/api/chat -Method Post `
  -ContentType application/json -Body '{"message":"hello","context":{}}'
Invoke-RestMethod http://127.0.0.1:8765/api/detect -Method Post `
  -ContentType application/json -Body '{"text":"I I went um to the store"}'
```

## Honest limitations (please read)

- **Demo mode:** without `GEMINI_API_KEY` in `.env`, chat and transcription
  replies are clearly labelled simulations. The app tells you this in a banner.
- **Turn-based, not full-duplex:** the app listens → thinks → speaks → listens.
  It does not stream audio or overlap with the AI. It never claims otherwise.
  The voice agent is the same: patient, turn-based, ~1.8 s of quiet before it
  replies, and it never interrupts you while you are speaking.
- **SpeechRecognition** is a browser API (Chrome/Edge) that needs a microphone
  and usually an internet connection; recognition quality varies with speech
  patterns. **Record & send** and **typed messages** are the universal
  fallbacks (the voice agent also accepts typed messages).
- **Silent event monitoring is AI-estimated, not clinical:** the detector
  records *possible* repetitions, fillers and elongations from transcripts with
  approximate timestamps. It does not detect blocks, prolongations or tension,
  it will miss some events, and a transcript may differ from what was actually
  said. It never corrects you during a conversation, and its outputs must
  never be read as a diagnosis or as clinical observations.
- **Transcript-based analysis only:** no acoustic analysis is claimed. Blocks,
  prolongations, tension and some disfluencies cannot be detected from text.
  Every number is labelled an *experimental estimate — not a clinical
  measurement*.
- **Self-practice vs clinician-configured:** dysarthria, apraxia of speech and
  acquired-brain-injury activities run only from a configuration you or your
  clinician entered. Nothing here is claimed to be clinically validated, and
  the app never diagnoses.
- **Privacy:** profile, sessions and reflections stay in browser localStorage
  (export/delete anytime). Audio and text are sent to Google Gemini only when
  you use recording/conversation features — your API key never reaches the
  browser.

## Environment variables (`.env`, optional)

| Key | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | *(none → demo mode)* | Google AI Studio key, server-side only |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Gemini model override |
| `PORT` | `8765` | Server port |
