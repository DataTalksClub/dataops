from __future__ import annotations

import io
import sys
import tarfile
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
LAMBDA_SRC = REPO_ROOT / "lambda-functions" / "src"
if str(LAMBDA_SRC) not in sys.path:
    sys.path.insert(0, str(LAMBDA_SRC))

from lambda_functions import github_store, process_quality  # noqa: E402


def _markdown_with_image(image_target: str) -> bytes:
    return f"""---
id: sop.ops.cached-image
title: Cached Image SOP
doc_type: sop
related_docs: []
---

# Cached Image SOP

![Cached screenshot]({image_target})
""".encode("utf-8")


def _tarball(entries: dict[str, bytes]) -> bytes:
    payload = io.BytesIO()
    with tarfile.open(fileobj=payload, mode="w:gz") as archive:
        for path, content in entries.items():
            info = tarfile.TarInfo(f"DataTalksClub-dataops-test/{path}")
            info.size = len(content)
            archive.addfile(info, io.BytesIO(content))
    return payload.getvalue()


class _TarballResponse(io.BytesIO):
    def __enter__(self) -> "_TarballResponse":
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        self.close()


def _hydrate_from_tarball(monkeypatch, cache_root: Path, entries: dict[str, bytes]) -> github_store.GitHubStore:
    tarball = _tarball(entries)

    def fake_urlopen(request: object, timeout: int) -> _TarballResponse:
        assert timeout == 30
        return _TarballResponse(tarball)

    monkeypatch.setattr(github_store.urllib.request, "urlopen", fake_urlopen)
    store = github_store.GitHubStore(cache_root)
    store.sync_markdown()
    return store


def test_github_store_tarball_hydrates_markdown_and_allowed_content_images(monkeypatch, tmp_path: Path) -> None:
    store = _hydrate_from_tarball(
        monkeypatch,
        tmp_path / "cache",
        {
            "content/ops/sops/example.md": b"# Example\n",
            "content/images/ops/example.png": b"png-bytes",
            "content/images/ops/photo.JPG": b"jpg-bytes",
            "content/images/ops/vector.svg": b"<svg></svg>",
            "content/images/ops/readme.txt": b"not hydrated",
            "content/files/ops/attachment.png": b"not an images asset",
            "README.md": b"not content",
            "frontend/src/app.js": b"not content",
            "content/../escape.md": b"invalid path",
        },
    )

    assert (store.root / "content" / "ops" / "sops" / "example.md").read_bytes() == b"# Example\n"
    assert (store.root / "content" / "images" / "ops" / "example.png").read_bytes() == b"png-bytes"
    assert (store.root / "content" / "images" / "ops" / "photo.JPG").read_bytes() == b"jpg-bytes"
    assert (store.root / "content" / "images" / "ops" / "vector.svg").read_bytes() == b"<svg></svg>"
    assert not (store.root / "content" / "images" / "ops" / "readme.txt").exists()
    assert not (store.root / "content" / "files" / "ops" / "attachment.png").exists()
    assert not (store.root / "README.md").exists()
    assert not (store.root / "frontend").exists()
    assert not (store.root / "escape.md").exists()


def test_process_quality_uses_hydrated_content_image_assets(monkeypatch, tmp_path: Path) -> None:
    store = _hydrate_from_tarball(
        monkeypatch,
        tmp_path / "cache",
        {
            "content/ops/sops/example.md": _markdown_with_image("../../images/ops/example.png"),
            "content/images/ops/example.png": b"png-bytes",
        },
    )

    report = process_quality.build_report(store.root, store.content_root)
    broken_assets = [finding for finding in report["findings"] if finding["category"] == "broken-asset-reference"]

    assert not any(finding.get("docPath") == "content/ops/sops/example.md" for finding in broken_assets)


def test_process_quality_still_warns_for_missing_content_images(monkeypatch, tmp_path: Path) -> None:
    store = _hydrate_from_tarball(
        monkeypatch,
        tmp_path / "cache",
        {
            "content/ops/sops/example.md": _markdown_with_image("../../images/ops/missing.png"),
        },
    )

    report = process_quality.build_report(store.root, store.content_root)

    assert any(
        finding["category"] == "broken-asset-reference" and finding.get("docPath") == "content/ops/sops/example.md"
        for finding in report["findings"]
    )


def test_github_store_ensure_file_still_lazily_fetches_static_assets(monkeypatch, tmp_path: Path) -> None:
    store = github_store.GitHubStore(tmp_path / "cache")
    store._tree = {"content/images/ops/lazy.png": {"type": "blob", "sha": "image-sha"}}
    monkeypatch.setattr(store, "blob_bytes", lambda sha: b"lazy-image" if sha == "image-sha" else b"")

    local_path = store.ensure_file("content/images/ops/lazy.png")

    assert local_path == store.root / "content" / "images" / "ops" / "lazy.png"
    assert local_path.read_bytes() == b"lazy-image"
