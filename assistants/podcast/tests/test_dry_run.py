from dry_run import podcast_job_dry_run_metadata


def test_podcast_job_dry_run_metadata_is_deterministic() -> None:
    payload = {
        "id": "assistant-job-1",
        "title": "Podcast prep",
        "inputRefs": [
            {"type": "task", "id": "task-1"},
            {"type": "url", "uri": "https://example.com/guest"},
        ],
    }

    first = podcast_job_dry_run_metadata(payload)
    second = podcast_job_dry_run_metadata(payload)

    assert first == second
    assert first["assistant_job_id"] == "assistant-job-1"
    assert first["assistant_type"] == "podcast"
    assert first["input_ref_count"] == 2
    assert first["runner"] == "podcast-dry-run"
    assert first["checksum"].startswith("sha256:")


def test_podcast_job_dry_run_accepts_export_field_names() -> None:
    metadata = podcast_job_dry_run_metadata({
        "assistant_job_id": "assistant-job-export",
        "title": "Exported job",
        "input_refs": [{"type": "bundle", "id": "bundle-1"}],
    })

    assert metadata["assistant_job_id"] == "assistant-job-export"
    assert metadata["input_ref_count"] == 1
