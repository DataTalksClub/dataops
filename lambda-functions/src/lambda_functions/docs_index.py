import re
from pathlib import Path
from typing import Any

import frontmatter
from minsearch import Index

from lambda_functions.doc_registry import build_registry
from lambda_functions import sop_parse


TEXT_FIELDS = ["title", "summary", "description", "purpose", "headings", "body"]
KEYWORD_FIELDS = ["path", "id", "domain", "doc_type"]
BOOSTS = {
    "title": 4.0,
    "summary": 3.0,
    "description": 3.0,
    "purpose": 3.0,
    "headings": 2.0,
    "body": 1.0,
}

HEADING_RE = re.compile(r"^(#{1,6})\s+(.+)$", re.MULTILINE)
IMAGE_RE = re.compile(r"!\[[^\]]*\]\([^)]+\)")
LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]+\)")
CODE_BLOCK_RE = re.compile(r"```.*?```", re.DOTALL)
INLINE_CODE_RE = re.compile(r"`([^`]+)`")
HTML_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
HTML_TAG_RE = re.compile(r"<[^>]+>")
MARKDOWN_MARKERS_RE = re.compile(r"[*_>#~]")


def create_index(index_path: Path | str) -> Index:
    return Index.load(index_path)


def create_empty_index() -> Index:
    return Index(
        text_fields=TEXT_FIELDS,
        keyword_fields=KEYWORD_FIELDS,
    )


def build_index(docs_dir: Path, index_path: Path) -> int:
    build_registry(docs_dir)
    docs = list(iter_docs(docs_dir))
    index_path.parent.mkdir(parents=True, exist_ok=True)
    if index_path.exists():
        index_path.unlink()

    index = create_empty_index()
    index.fit(docs)
    index.save(index_path)
    return len(docs)


def iter_docs(docs_dir: Path) -> list[dict[str, Any]]:
    documents = []
    docs_root = docs_dir.resolve()
    repo_root = docs_root.parent
    for path in sorted(docs_root.rglob("*.md")):
        raw_text = path.read_text(encoding="utf-8", errors="replace")
        post = frontmatter.loads(raw_text)
        body = post.content
        headings = extract_headings(body)
        title = str(post.metadata.get("title") or (headings[0] if headings else path.stem.replace("-", " ").title()))
        relative_path = path.relative_to(repo_root).as_posix()
        doc_path = Path(relative_path)

        search_body = doc_to_search_text(raw_text, body)

        summary = scalar_frontmatter_value(post.metadata.get("summary"))
        description = scalar_frontmatter_value(post.metadata.get("description")) or summary

        documents.append(
            {
                "path": relative_path,
                "id": scalar_frontmatter_value(post.metadata.get("id")),
                "title": title,
                "domain": infer_domain(doc_path),
                "doc_type": scalar_frontmatter_value(post.metadata.get("doc_type")) or infer_doc_type(doc_path),
                "summary": summary,
                "description": description,
                "purpose": scalar_frontmatter_value(post.metadata.get("purpose")),
                "headings": "\n".join(headings),
                "body": search_body,
            }
        )

    return documents


def scalar_frontmatter_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, list):
        return ", ".join(str(item) for item in value)
    if isinstance(value, dict):
        return ", ".join(f"{key}: {item}" for key, item in value.items())
    return str(value)


def extract_headings(markdown: str) -> list[str]:
    return [clean_text(match.group(2)) for match in HEADING_RE.finditer(markdown)]


def doc_to_search_text(raw_text: str, fallback_body: str) -> str:
    """Build search text. For schema_version: 1 SOPs, use the structured parser
    so step bodies, prose, and captions get indexed without the marker noise.
    For everything else, strip markdown to readable text.
    """
    try:
        parsed = sop_parse.parse(raw_text)
    except sop_parse.ParseError:
        parsed = None

    if parsed and parsed.get("schema_version") in (1, "1"):
        return clean_text(_extract_structured_text(parsed))

    return markdown_to_search_text(fallback_body)


def _extract_structured_text(parsed: dict[str, Any]) -> str:
    chunks: list[str] = []
    for name, section in parsed.get("sections", {}).items():
        if name == "procedure" and not section.get("raw", False):
            chunks.extend(_extract_procedure_text(section))
        else:
            body = section.get("body_md", "")
            if body:
                chunks.append(body)
    return "\n".join(chunks)


def _extract_procedure_text(procedure: dict[str, Any]) -> list[str]:
    chunks: list[str] = []
    for group in procedure.get("groups", []) or []:
        if group.get("title"):
            chunks.append(group["title"])
        for step in group.get("steps", []) or []:
            chunks.extend(_extract_step_text(step))
    for step in procedure.get("flat_steps", []) or []:
        chunks.extend(_extract_step_text(step))
    for prose in procedure.get("prose", []) or []:
        body = prose.get("body_md", "")
        if body:
            chunks.append(body)
    for todo in procedure.get("todos", []) or []:
        if todo:
            chunks.append(todo)
    return chunks


def _extract_step_text(step: dict[str, Any]) -> list[str]:
    chunks: list[str] = []
    body = step.get("body_md", "")
    if body:
        chunks.append(body)
    for shot in step.get("screenshots", []) or []:
        caption = shot.get("caption", "")
        if caption:
            chunks.append(caption)
    return chunks


def markdown_to_search_text(markdown: str) -> str:
    text = CODE_BLOCK_RE.sub(" ", markdown)
    text = IMAGE_RE.sub(" ", text)
    text = LINK_RE.sub(r"\1", text)
    text = INLINE_CODE_RE.sub(r"\1", text)
    return clean_text(text)


def clean_text(text: str) -> str:
    text = HTML_COMMENT_RE.sub(" ", text)
    text = HTML_TAG_RE.sub(" ", text)
    text = MARKDOWN_MARKERS_RE.sub(" ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def infer_domain(path: Path) -> str:
    parts = path.parts
    if len(parts) >= 2 and parts[0] == "content":
        return parts[1]
    return "unknown"


def infer_doc_type(path: Path) -> str:
    parts = set(path.parts)
    if "sops" in parts:
        return "sop"
    if "templates" in parts:
        return "template"
    if "reference" in parts:
        return "reference"
    if "playbooks" in parts:
        return "playbook"
    if "prompts" in parts:
        return "prompt"
    if "archive" in parts:
        return "archive"
    return "doc"
