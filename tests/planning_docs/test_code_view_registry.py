from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools" / "content_tools"))
from content_tools.doc_registry import DocumentRegistryError, build_registry  # noqa: E402


@pytest.fixture
def content(tmp_path):
    root = tmp_path / "content"
    root.mkdir()
    return root


def document(root, path, identifier=None, kind=None, target=None):
    file = root / path
    file.parent.mkdir(parents=True, exist_ok=True)
    fields = ["---", "title: Example"]
    if identifier:
        fields.append(f"id: {identifier}")
    if kind:
        fields.append(f"doc_type: {kind}")
    if target:
        fields.append(f"sop: {target}")
    file.write_text("\n".join(fields) + "\n---\n\n# Example\n", encoding="utf-8")


@pytest.mark.parametrize("target", ["sop.example", "content/sops/example.md"])
def test_code_view_resolves_the_canonical_sop(content, target):
    document(content, "sops/example.md", "sop.example", "sop")
    document(content, "code-views/example.md", "code-view.example", "code-view", target)
    registry = build_registry(content)
    view = registry.code_view_by_sop["sop.example"]
    assert view.id == "code-view.example"
    assert view.to_dict()["sop"] == target


@pytest.mark.parametrize("target, message", [
    (None, "missing frontmatter 'sop'"),
    ("sop.missing", "sop reference not found"),
])
def test_code_view_requires_an_existing_target(content, target, message):
    document(content, "code-views/example.md", "code-view.example", "code-view", target)
    with pytest.raises(DocumentRegistryError, match=message):
        build_registry(content)


def test_code_view_cannot_target_a_reference(content):
    document(content, "reference/example.md", "reference.example", "reference")
    document(content, "code-views/example.md", "code-view.example", "code-view", "reference.example")
    with pytest.raises(DocumentRegistryError, match="must target a SOP"):
        build_registry(content)


def test_code_view_cannot_target_itself(content):
    document(content, "code-views/example.md", "code-view.example", "code-view", "code-view.example")
    with pytest.raises(DocumentRegistryError, match="cannot target itself"):
        build_registry(content)


def test_different_references_cannot_create_two_views_for_one_sop(content):
    document(content, "sops/example.md", "sop.example", "sop")
    document(content, "code-views/first.md", "code-view.first", "code-view", "sop.example")
    document(content, "code-views/second.md", "code-view.second", "code-view", "content/sops/example.md")
    with pytest.raises(DocumentRegistryError, match="second code view"):
        build_registry(content)


def test_code_view_directory_inference_matches_its_generated_id(content):
    document(content, "sops/example.md", "sop.example", "sop")
    document(content, "code-views/example-code.md", target="sop.example")
    view = build_registry(content).code_view_by_sop["sop.example"]
    assert view.doc_type == "code-view"
    assert view.id == "code-view.example-code"
