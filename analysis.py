"""
Transcript-based disfluency analysis for Dr. Sturgis.

IMPORTANT - what this is and is not:
  * This is a TEXT analysis of an automatic transcript. It looks for surface
    patterns: repeated words, repeated phrases and common filler words.
  * It CANNOT detect speech blocks, sound prolongations, tension, avoidance,
    or every real-world disfluency - those need audio/clinical observation.
  * Numbers produced here are ESTIMATES for self-reflection only. They are NOT
    clinical measurements and must never be presented as diagnosis or scoring.

Everything here is deterministic (no API calls, no dependencies).
"""
from __future__ import annotations

import json
import re
from statistics import median
from typing import Any, Dict, List, Optional

# Common filled pauses. "like" is listed separately because it is often a
# normal word - it is only counted when it stands alone in the transcript.
FILLERS = ["um", "uh", "uhh", "umm", "uhm", "er", "erm", "ah", "hmm", "mm", "mhm"]
CONTEXTUAL_FILLERS = ["like"]

WORD_RE = re.compile(r"[a-zA-Z']+")

LIMITATIONS = (
    "This is transcript-based analysis, not clinical assessment. From a transcript "
    "we can only spot repeated words, repeated phrases and written filler words. "
    "We cannot reliably detect speech blocks, sound prolongations, tension, "
    "avoidance, or every disfluency you may experience - and speech-recognition "
    "transcripts sometimes clean up or miss what was actually said. Treat every "
    "number here as an informal estimate for your own reflection, never as a "
    "clinical measurement."
)

DISCLAIMER = (
    "Experimental self-practice estimate - not a clinical measurement, "
    "not a diagnosis, not compared against any population standards."
)


def _words(text: str) -> List[str]:
    return [w.lower() for w in WORD_RE.findall(text)]


def _clean(word: str) -> str:
    return word.strip(".,!?;:").lower()


def count_repeated_words(text: str) -> Dict[str, Any]:
    """Find immediate single-word repetitions such as 'the the' or 'I I'."""
    tokens = [_clean(t) for t in re.findall(r"[a-zA-Z']+|[.,!?;:]", text)]
    words = [t for t in tokens if t and t not in ".,!?;:"]
    repeats: List[Dict[str, Any]] = []
    total = 0
    i = 1
    while i < len(words):
        if words[i] == words[i - 1] and len(words[i]) > 0:
            start = max(0, i - 2)
            context = " ".join(words[start: min(len(words), i + 3)])
            repeats.append({"word": words[i], "context": context})
            total += 1
            i += 2  # skip the matched pair
        else:
            i += 1
    return {"count": total, "examples": repeats[:8]}


def count_repeated_phrases(text: str) -> Dict[str, Any]:
    """Find immediately repeated phrases such as 'I want I want to go'.

    Greedy longest-match first (4, then 3, then 2 tokens) with overlap masking.
    """
    words = _words(text)
    n = len(words)
    consumed = [False] * n
    found: List[Dict[str, Any]] = []
    total_pairs = 0

    for size in (4, 3, 2):
        i = 0
        while i + 2 * size <= n:
            if any(consumed[i : i + 2 * size]):
                i += 1
                continue
            left = words[i : i + size]
            right = words[i + size : i + 2 * size]
            if left == right:
                phrase = " ".join(left)
                if phrase not in [f["phrase"] for f in found]:
                    context_start = max(0, i - 2)
                    context_end = min(n, i + 2 * size + 2)
                    found.append(
                        {
                            "phrase": phrase,
                            "context": " ".join(words[context_start:context_end]),
                        }
                    )
                total_pairs += 1
                for k in range(i, i + 2 * size):
                    consumed[k] = True
                i += 2 * size
            else:
                i += 1

    return {"count": total_pairs, "examples": found[:8]}


def count_fillers(text: str) -> Dict[str, Any]:
    """Count common filler words. 'like' is reported separately as *possible*."""
    words = _words(text)
    counts: Dict[str, int] = {}
    for w in words:
        if w in FILLERS:
            counts[w] = counts.get(w, 0) + 1
    contextual = sum(1 for w in words if w in CONTEXTUAL_FILLERS)
    strict_total = sum(counts.values())
    return {
        "counts": dict(sorted(counts.items(), key=lambda kv: -kv[1])),
        "total": strict_total,
        "possibleLike": contextual,
        # Combined figure used for rate calculations, clearly labelled upstream.
        "combinedTotal": strict_total + contextual,
    }


def speaking_rate(words: int, duration_sec: Optional[float]) -> Optional[float]:
    """Words per minute estimate. None when duration is unknown."""
    try:
        dur = float(duration_sec)
    except (TypeError, ValueError):
        return None
    if dur <= 0:
        return None
    return round(words / dur * 60.0, 1)


def pause_stats(utterances: Optional[List[Dict[str, Any]]]) -> Optional[Dict[str, Any]]:
    """Estimate pauses from utterance-level timestamps when available.

    `utterances` = [{"start": sec, "end": sec, "text": "..."}].
    Only gaps between recognised utterances are visible here - pauses *within*
    an utterance (e.g. mid-sentence blocks) are NOT detectable from this data.
    """
    if not utterances or not isinstance(utterances, list):
        return None
    timed = []
    for u in utterances:
        try:
            start = float(u.get("start"))
            end = float(u.get("end"))
        except (TypeError, ValueError, AttributeError):
            continue
        if end >= start:
            timed.append((start, end))
    if len(timed) < 2:
        return None
    timed.sort()
    gaps = []
    for i in range(1, len(timed)):
        gap = timed[i][0] - timed[i - 1][1]
        if gap > 0.15:
            gaps.append(round(gap, 2))
    total_window = timed[-1][1] - timed[0][0]
    total_pause = round(sum(gaps), 2)
    return {
        "gapCount": len(gaps),
        "totalPauseSec": total_pause,
        "longestPauseSec": round(max(gaps), 2) if gaps else 0.0,
        "pauseRatio": round(total_pause / total_window, 3) if total_window > 0 else None,
        "windowSec": round(total_window, 2),
        "note": (
            "Pauses are estimated only from gaps between recognised utterances. "
            "Pauses inside an utterance are not visible to this method."
        ),
    }


# --------------------------------------------------------------------------
# Event detection (extensible detector registry)
# --------------------------------------------------------------------------
# DETECTORS is a registry so richer detectors (audio/ML models) can be added
# later without changing callers. Each detector is:
#   {"name": str, "categories": (str, ...), "detect": fn(text, t_start, t_end)}
# and must return a list of event dicts. The built-in detector works from the
# transcript only; it NEVER claims to see blocks or audio prolongations.
DETECTOR_NAME = "transcript-heuristic-v1"
# A word containing a letter run of 3+, e.g. "sooo", "weell".
ELONGATION_RE = re.compile(r"\b[A-Za-z]*([A-Za-z])\1{2,}[A-Za-z]*\b")

EVENT_UNDETECTABLE = [
    {
        "category": "block",
        "reason": (
            "Speech blocks are silent gaps inside speech. A text transcript has no "
            "timing inside an utterance, so blocks cannot be seen at all with this "
            "method. Detecting them would require an audio-timing model."
        ),
    },
    {
        "category": "prolongation",
        "reason": (
            "Sound prolongations (stretched sounds) need audio duration analysis. "
            "This detector only flags weak letter-stretches that survive in the "
            "transcript (e.g. 'sooo') as low-confidence 'elongation' candidates."
        ),
    },
]

DETECTORS: List[Dict[str, Any]] = []


def register_detector(name: str, categories: tuple, fn) -> None:
    """Register an event detector. Future audio/ML detectors plug in here."""
    DETECTORS.append({"name": name, "categories": tuple(categories), "detect": fn})


def _event_time(word_index: int, word_total: int, t_start, t_end) -> Optional[float]:
    """Interpolate an approximate session-relative time for a word position.

    Only possible when the caller supplied a time window for the utterance.
    The result is approximate - transcripts carry no per-word timestamps.
    """
    try:
        start = float(t_start)
        end = float(t_end)
    except (TypeError, ValueError):
        return None
    if word_total <= 0 or end < start:
        return None
    frac = min(max(word_index / word_total, 0.0), 1.0)
    return round(start + frac * (end - start), 1)


def _transcript_detect(text: str, t_start=None, t_end=None) -> List[Dict[str, Any]]:
    """Built-in detector: repetitions, fillers and transcript-visible elongation."""
    words = _words(text)
    n = len(words)
    events: List[Dict[str, Any]] = []
    consumed = [False] * n

    # 1. Repeated phrases first (longest match wins), e.g. "I want I want".
    for size in (4, 3, 2):
        i = 0
        while i + 2 * size <= n:
            if any(consumed[i : i + 2 * size]):
                i += 1
                continue
            left = words[i : i + size]
            right = words[i + size : i + 2 * size]
            if left == right:
                context_start = max(0, i - 2)
                context_end = min(n, i + 2 * size + 2)
                events.append(
                    {
                        "category": "repetition",
                        "subtype": "phrase",
                        "tSec": _event_time(i, n, t_start, t_end),
                        "excerpt": " ".join(words[context_start:context_end]),
                        "detail": '"' + " ".join(left) + '" said twice in a row',
                        "confidence": "high",
                        "source": DETECTOR_NAME,
                    }
                )
                for k in range(i, i + 2 * size):
                    consumed[k] = True
                i += 2 * size
            else:
                i += 1

    # 2. Repeated single words, e.g. "the the".
    i = 1
    while i < n:
        if consumed[i] or consumed[i - 1]:
            i += 1
            continue
        if words[i] == words[i - 1] and words[i]:
            start = max(0, i - 2)
            events.append(
                {
                    "category": "repetition",
                    "subtype": "word",
                    "tSec": _event_time(i, n, t_start, t_end),
                    "excerpt": " ".join(words[start : min(n, i + 3)]),
                    "detail": '"' + words[i] + '" said twice in a row',
                    "confidence": "high",
                    "source": DETECTOR_NAME,
                }
            )
            consumed[i - 1] = consumed[i] = True
            i += 2
        else:
            i += 1

    # 3. Filler words (ordinary hesitations - explicitly NOT stuttering-specific).
    for idx, w in enumerate(words):
        if consumed[idx]:
            continue
        if w in FILLERS:
            events.append(
                {
                    "category": "filler",
                    "subtype": "filled-pause",
                    "tSec": _event_time(idx, n, t_start, t_end),
                    "excerpt": " ".join(words[max(0, idx - 2) : min(n, idx + 3)]),
                    "detail": '"' + w + '" filler word',
                    "confidence": "high",
                    "source": DETECTOR_NAME,
                }
            )
        elif w in CONTEXTUAL_FILLERS:
            events.append(
                {
                    "category": "filler",
                    "subtype": "possible-like",
                    "tSec": _event_time(idx, n, t_start, t_end),
                    "excerpt": " ".join(words[max(0, idx - 2) : min(n, idx + 3)]),
                    "detail": '"like" (possible filler - often an ordinary word)',
                    "confidence": "low",
                    "source": DETECTOR_NAME,
                }
            )

    # 4. Weak elongation candidates visible in the transcript text itself.
    word_spans = [(m.start(), m.group(0).lower()) for m in WORD_RE.finditer(text)]
    for m in ELONGATION_RE.finditer(text):
        pos = m.start()
        idx = 0
        for span_start, _ in word_spans:
            if span_start <= pos:
                idx += 1
            else:
                break
        events.append(
            {
                "category": "elongation",
                "subtype": "transcript-letter-stretch",
                "tSec": _event_time(max(idx - 1, 0), n, t_start, t_end),
                "excerpt": m.group(0),
                "detail": 'transcript shows a letter stretch "' + m.group(0) + '" (weak signal)',
                "confidence": "low",
                "source": DETECTOR_NAME,
            }
        )

    return events


register_detector(DETECTOR_NAME, ("repetition", "filler", "elongation"), _transcript_detect)


def detect_events(
    text: str, t_start: Optional[float] = None, t_end: Optional[float] = None
) -> Dict[str, Any]:
    """Detect candidate disfluency events in a transcript fragment.

    Events carry approximate session-relative timestamps (tSec) when the
    caller provides a time window; otherwise tSec is null. This is an
    ESTIMATE from text only - see `undetectable` for what it cannot see.
    """
    events: List[Dict[str, Any]] = []
    used: List[str] = []
    for detector in DETECTORS:
        got = detector["detect"](text, t_start, t_end)
        if got:
            events.extend(got)
            used.append(detector["name"])
    # Timeline order (untimed events last)
    events.sort(key=lambda e: (e["tSec"] is None, e["tSec"] or 0.0))
    for i, event in enumerate(events):
        event["id"] = "e" + str(i)
    return {
        "events": events,
        "undetectable": EVENT_UNDETECTABLE,
        "detectorsUsed": used,
        "detector": DETECTOR_NAME,
        "isEstimate": True,
        "disclaimer": DISCLAIMER,
        "limitations": LIMITATIONS,
    }


def summarize_events(events: Optional[List[Dict[str, Any]]]) -> Dict[str, Any]:
    """Counts per category for a session-level summary."""
    counts: Dict[str, int] = {}
    for event in events or []:
        cat = str(event.get("category") or "unknown")
        counts[cat] = counts.get(cat, 0) + 1
    return {
        "total": sum(counts.values()),
        "byCategory": dict(sorted(counts.items())),
        "hasTimestamps": any(e.get("tSec") is not None for e in events or []),
    }


def analyze_transcript(
    text: str,
    duration_sec: Optional[float] = None,
    utterances: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Return a full analysis dict for one transcript."""
    words = _words(text)
    word_count = len(words)
    repeats = count_repeated_words(text)
    phrases = count_repeated_phrases(text)
    fillers = count_fillers(text)
    rate = speaking_rate(word_count, duration_sec)
    pauses = pause_stats(utterances)

    filler_rate = (
        round(fillers["combinedTotal"] / word_count * 100.0, 1) if word_count else 0.0
    )
    repetition_rate = (
        round((repeats["count"] + phrases["count"]) / word_count * 100.0, 1)
        if word_count
        else 0.0
    )

    return {
        "wordCount": word_count,
        "durationSec": float(duration_sec) if duration_sec else None,
        "speakingRateWpm": rate,
        "repeatedWords": repeats,
        "repeatedPhrases": phrases,
        "fillers": fillers,
        "fillerRatePer100Words": filler_rate,
        "repetitionRatePer100Words": repetition_rate,
        "pauses": pauses,
        "medianWordLength": round(median([len(w) for w in words]), 1) if words else None,
        "disclaimer": DISCLAIMER,
        "limitations": LIMITATIONS,
        "isEstimate": True,
    }


if __name__ == "__main":  # quick manual check
    sample = "I I went to um the the store and I I like wanted to to go home."
    print(json.dumps(analyze_transcript(sample, duration_sec=12.5), indent=2))
