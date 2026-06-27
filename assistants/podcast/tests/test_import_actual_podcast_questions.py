from scripts.import_actual_podcast_questions import clean_question, is_actual_question


def test_clean_question_removes_bracket_notes() -> None:
    assert clean_question("What is this? [chuckles]") == "What is this?"


def test_is_actual_question_requires_question_mark() -> None:
    assert is_actual_question("What is DuckDB?") is True
    assert is_actual_question("This is a statement") is False
