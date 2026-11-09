"""Unit tests for the transcript analysis module (stdlib unittest only).

Run:  python -m unittest test_analysis -v
"""
import unittest

import analysis


class TestRepeatedWords(unittest.TestCase):
    def test_detects_double_word(self):
        result = analysis.count_repeated_words("I went to the the store today")
        self.assertEqual(result["count"], 1)
        self.assertEqual(result["examples"][0]["word"], "the")

    def test_multiple_and_tripled(self):
        result = analysis.count_repeated_words("I I I like like this")
        # "I I" counts, then skip; "like like" counts.
        self.assertEqual(result["count"], 2)

    def test_none(self):
        self.assertEqual(analysis.count_repeated_words("hello world")["count"], 0)


class TestRepeatedPhrases(unittest.TestCase):
    def test_detects_bigram_repeat(self):
        result = analysis.count_repeated_phrases("I want I want to go home")
        self.assertEqual(result["count"], 1)
        self.assertEqual(result["examples"][0]["phrase"], "i want")

    def test_longest_match_wins(self):
        result = analysis.count_repeated_phrases(
            "she said she said she said no"
        )
        # "she said she said" matches as a pair of 2-grams once.
        self.assertGreaterEqual(result["count"], 1)

    def test_no_false_positive_on_normal_text(self):
        result = analysis.count_repeated_phrases(
            "the cat sat on the mat and the dog ran"
        )
        self.assertEqual(result["count"], 0)


class TestFillers(unittest.TestCase):
    def test_counts_um_uh(self):
        result = analysis.count_fillers("um I uh think so")
        self.assertEqual(result["total"], 2)
        self.assertIn("um", result["counts"])

    def test_like_reported_separately(self):
        result = analysis.count_fillers("I like like pizza")
        self.assertEqual(result["total"], 0)          # strict fillers: none
        self.assertEqual(result["possibleLike"], 2)    # counted as possible filler

    def test_combined_total(self):
        result = analysis.count_fillers("um and I like it")
        self.assertEqual(result["combinedTotal"], 2)


class TestRateAndPauses(unittest.TestCase):
    def test_words_per_minute(self):
        # 30 words in 30 seconds -> 60 wpm
        self.assertEqual(analysis.speaking_rate(30, 30), 60.0)

    def test_missing_duration(self):
        self.assertIsNone(analysis.speaking_rate(30, None))
        self.assertIsNone(analysis.speaking_rate(30, 0))

    def test_pause_stats_from_utterances(self):
        utterances = [
            {"start": 0.0, "end": 2.0, "text": "hello"},
            {"start": 3.0, "end": 5.0, "text": "world"},
            {"start": 5.5, "end": 8.0, "text": "again"},
        ]
        stats = analysis.pause_stats(utterances)
        self.assertEqual(stats["gapCount"], 2)
        self.assertAlmostEqual(stats["totalPauseSec"], 1.5)
        self.assertAlmostEqual(stats["longestPauseSec"], 1.0)

    def test_pause_stats_requires_two(self):
        self.assertIsNone(analysis.pause_stats([{"start": 0, "end": 1}]))
        self.assertIsNone(analysis.pause_stats(None))


class TestFullAnalysis(unittest.TestCase):
    def test_shape_and_disclaimers(self):
        result = analysis.analyze_transcript(
            "I I went um to the the shop",
            duration_sec=10,
            utterances=[
                {"start": 0, "end": 4, "text": "I I went um to the"},
                {"start": 5, "end": 10, "text": "the shop"},
            ],
        )
        for key in (
            "wordCount",
            "speakingRateWpm",
            "repeatedWords",
            "repeatedPhrases",
            "fillers",
            "pauses",
            "disclaimer",
            "limitations",
            "isEstimate",
        ):
            self.assertIn(key, result)
        self.assertTrue(result["isEstimate"])
        self.assertIn("not a clinical measurement", result["disclaimer"])
        self.assertEqual(result["wordCount"], 8)

    def test_empty_text(self):
        result = analysis.analyze_transcript("   ")
        self.assertEqual(result["wordCount"], 0)
        self.assertIsNone(result["speakingRateWpm"])


class TestEventDetection(unittest.TestCase):
    def test_repetition_word_event_with_time(self):
        result = analysis.detect_events(
            "I went to the the store", t_start=0.0, t_end=10.0
        )
        reps = [e for e in result["events"] if e["category"] == "repetition"]
        self.assertTrue(reps)
        word_rep = next(e for e in reps if e["subtype"] == "word")
        self.assertEqual(word_rep["detail"], '"the" said twice in a row')
        # Timestamp interpolated inside the window and ordered.
        self.assertIsNotNone(word_rep["tSec"])
        self.assertGreaterEqual(word_rep["tSec"], 0.0)
        self.assertLessEqual(word_rep["tSec"], 10.0)

    def test_phrase_event(self):
        result = analysis.detect_events("I want I want to go home")
        phrase = next(
            e for e in result["events"]
            if e["category"] == "repetition" and e["subtype"] == "phrase"
        )
        self.assertIn("i want", phrase["detail"])

    def test_filler_and_like_events(self):
        result = analysis.detect_events("um I really like it today")
        cats = {(e["category"], e["subtype"]) for e in result["events"]}
        self.assertIn(("filler", "filled-pause"), cats)
        self.assertIn(("filler", "possible-like"), cats)

    def test_elongation_candidate_low_confidence(self):
        result = analysis.detect_events("that was sooo good")
        elong = next(e for e in result["events"] if e["category"] == "elongation")
        self.assertEqual(elong["confidence"], "low")

    def test_no_time_window_gives_null_timestamps(self):
        result = analysis.detect_events("the the cat")
        self.assertTrue(result["events"])
        self.assertIsNone(result["events"][0]["tSec"])

    def test_undetectable_categories_documented(self):
        result = analysis.detect_events("the the cat")
        cats = {u["category"] for u in result["undetectable"]}
        self.assertEqual(cats, {"block", "prolongation"})
        for u in result["undetectable"]:
            self.assertTrue(u["reason"])

    def test_events_are_ordered_by_time(self):
        result = analysis.detect_events(
            "um the the cat and I want I want food", t_start=0.0, t_end=20.0
        )
        times = [e["tSec"] for e in result["events"] if e["tSec"] is not None]
        self.assertEqual(times, sorted(times))

    def test_empty_text(self):
        result = analysis.detect_events("   ")
        self.assertEqual(result["events"], [])

    def test_extensible_registry(self):
        def fake_detect(text, t_start=None, t_end=None):
            return [
                {
                    "category": "block",
                    "subtype": "audio-model",
                    "tSec": 1.0,
                    "excerpt": "x",
                    "detail": "example",
                    "confidence": "high",
                    "source": "fake-detector",
                }
            ]

        analysis.register_detector("fake-detector", ("block",), fake_detect)
        try:
            result = analysis.detect_events("hello")
            self.assertTrue(any(e["source"] == "fake-detector" for e in result["events"]))
            self.assertIn("fake-detector", result["detectorsUsed"])
        finally:
            analysis.DETECTORS[:] = [
                d for d in analysis.DETECTORS if d["name"] != "fake-detector"
            ]

    def test_summarize_events(self):
        summary = analysis.summarize_events(
            [
                {"category": "repetition", "tSec": 1.0},
                {"category": "repetition", "tSec": None},
                {"category": "filler", "tSec": 2.0},
            ]
        )
        self.assertEqual(summary["total"], 3)
        self.assertEqual(summary["byCategory"], {"filler": 1, "repetition": 2})
        self.assertTrue(summary["hasTimestamps"])
        self.assertEqual(analysis.summarize_events(None)["total"], 0)


if __name__ == "__main__":
    unittest.main()
