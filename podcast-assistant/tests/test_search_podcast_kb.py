from scripts.search_podcast_kb import score_text


def test_score_text_counts_query_terms() -> None:
    assert score_text(["ai", "agents"], "AI agents and AI systems") == 3


def test_score_text_returns_zero_for_no_match() -> None:
    assert score_text(["career"], "production systems") == 0
