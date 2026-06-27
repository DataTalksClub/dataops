from pathlib import Path

from scripts.build_podcast_knowledge_base import (
    clean_question_text,
    classify_question,
    classify_source_quality,
    parse_filename,
)


def test_parse_template_filename() -> None:
    meta = parse_filename(Path("podcast_examples/Podcast/_template 2024-01-00 - Name - Topic.docx"))

    assert meta["status"] == "template"
    assert meta["date_raw"] == "2024-01-00"
    assert meta["date"] is None
    assert meta["guest_name"] == "Name"
    assert meta["topic"] == "Topic"


def test_parse_archive_filename() -> None:
    meta = parse_filename(Path("podcast_examples/Podcast/Archive/2026-07-06 - Marina Zavgorodnyaya - Topic (Cancelled).docx"))

    assert meta["status"] == "cancelled"
    assert meta["date"] == "2026-07-06"
    assert meta["guest_name"] == "Marina Zavgorodnyaya"
    assert meta["topic"] == "Topic (Cancelled)"


def test_clean_question_text_cuts_answer_after_question_mark() -> None:
    text = clean_question_text("What vivid fact will hook listeners? This is the guest answer.")

    assert text == "What vivid fact will hook listeners?"


def test_clean_question_text_rejects_headings() -> None:
    assert clean_question_text("How to use these templates") is None
    assert clean_question_text("What we get into:") is None


def test_clean_question_text_allows_conversational_prompts() -> None:
    assert clean_question_text("Tell us about the system you built") == "Tell us about the system you built"


def test_classify_question() -> None:
    assert classify_question("How did your career journey start?") == "background"
    assert classify_question("How do you evaluate the model in production?") == "technical_deep_dive"
    assert classify_question("What business metric did this change?") == "business_impact"


def test_classify_source_quality() -> None:
    assert classify_source_quality("template", ["TODO"]) == "template"
    assert classify_source_quality("current", ["TODO"] * 10) == "sparse"
    assert classify_source_quality("current", ["paragraph"] * 60) == "complete"
