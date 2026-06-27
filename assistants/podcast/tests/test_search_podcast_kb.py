from scripts.search_podcast_kb import score_text, search_actual_questions


def test_score_text_counts_query_terms() -> None:
    assert score_text(["ai", "agents"], "AI agents and AI systems") == 3


def test_score_text_returns_zero_for_no_match() -> None:
    assert score_text(["career"], "production systems") == 0


def test_search_actual_questions_missing_file_is_empty(tmp_path, monkeypatch) -> None:
    import scripts.search_podcast_kb as search

    monkeypatch.setattr(search, "DATA_DIR", tmp_path)

    assert search_actual_questions("ai", 3) == []
