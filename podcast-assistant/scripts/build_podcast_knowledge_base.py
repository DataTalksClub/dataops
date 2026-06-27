#!/usr/bin/env python
"""Build a normalized podcast knowledge base from exported .docx prep docs."""

from __future__ import annotations

import argparse
import csv
import json
import re
import shutil
from collections import Counter, defaultdict
from dataclasses import dataclass, asdict
from datetime import date
from pathlib import Path
from zipfile import ZipFile
import xml.etree.ElementTree as ET


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE_DIR = REPO_ROOT / "podcast_examples" / "Podcast"
DEFAULT_OUTPUT_DIR = REPO_ROOT / "knowledge_base"
DEFAULT_DATA_DIR = REPO_ROOT / "data"

WORD_NS = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}
REL_NS = {"rel": "http://schemas.openxmlformats.org/package/2006/relationships"}


SECTION_ALIASES = {
    "guest_tab": {
        "tab for the guest",
        "materials from the guest (for preparing questions)",
        "for preparing questions",
        "guest content",
        "vadim's content",
    },
    "general_questions": {"general questions"},
    "detailed_questions": {
        "more detailed questions",
        "optional data points or anecdotes",
        "seeds for deeper questions (in no particular order):",
    },
    "team_tab": {"tab for alexey and dtc team"},
    "rough_plan": {"rough plan"},
    "event_description": {"event description", "for preparing event description"},
    "speech": {"speech"},
    "bio": {"bio:", "bio", "about the speaker", "mini-bio"},
    "links": {"links:", "links", "background links", "social media links:"},
}

THEME_KEYWORDS = {
    "ai_engineering": ["ai engineering", "llm", "agent", "copilot", "generative ai", "chatbot", "eval", "judge"],
    "mlops_production": ["production", "mlops", "deployment", "ship", "infrastructure", "reliable", "scale"],
    "career_transition": ["career", "journey", "transition", "freelance", "job", "manager", "ic", "promotion"],
    "data_platforms": ["data engineering", "warehouse", "data trust", "data intensive", "analytics", "pipeline"],
    "applied_ml": ["machine learning", "model", "bert", "forecasting", "classification", "algorithm"],
    "human_centered_ai": ["human", "fairness", "speech", "linguistics", "trust", "decision", "society"],
    "domain_applications": ["health", "biotech", "bioinformatics", "retail", "finance", "supply chain", "enterprise"],
    "education_community": ["teaching", "community", "book", "learning", "students", "sharing knowledge"],
}

QUESTION_CATEGORY_KEYWORDS = {
    "background": ["background", "journey", "introduce", "career"],
    "current_focus": ["currently focused", "current focus", "working on", "projects"],
    "topic_selection": ["keen to cover", "topics", "skip", "avoid"],
    "story_moments": ["moment", "events", "stumbles", "taught", "path", "milestones"],
    "practical_advice": ["advice", "first step", "recommend", "gain", "skill", "listeners"],
    "resources": ["books", "resources", "recommend"],
    "reflection": ["remember one idea", "reflection", "if you could", "next week"],
}


@dataclass
class EpisodeRecord:
    id: str
    source_path: str
    status: str
    date: str | None
    date_raw: str | None
    guest_name: str
    topic: str
    title: str | None
    subtitle: str | None
    source_quality: str
    bio: str | None
    links: dict[str, str]
    themes: list[str]
    question_categories: list[str]
    questions: list[str]
    sections: dict[str, list[str]]
    raw_text: str


@dataclass
class QuestionRecord:
    episode_id: str
    guest_name: str
    topic: str
    question_text: str
    question_category: str
    question_order: int
    is_template_question: bool
    source_path: str


def slugify(value: str) -> str:
    value = value.lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-") or "episode"


def normalize_space(value: str) -> str:
    return re.sub(r"\s+", " ", value.replace("\u00a0", " ")).strip()


def parse_filename(path: Path) -> dict[str, str | None]:
    stem = path.stem
    status = "template" if stem.lower().startswith("_template") else "archive" if "Archive" in path.parts else "current"
    if "cancelled" in stem.lower():
        status = "cancelled"
    parse_stem = re.sub(r"^_template\s+", "", stem, flags=re.I)

    match = re.match(r"(?P<date>\d{4}-\d{2}-\d{2})\s*-?\s*(?P<rest>.*)", parse_stem)
    if not match:
        return {
            "date": None,
            "date_raw": None,
            "guest_name": "Name" if status == "template" else stem.replace("_template", "Name").strip(" -"),
            "topic": "Topic",
            "status": status,
        }

    raw_date = match.group("date")
    parsed_date = None
    try:
        parsed_date = date.fromisoformat(raw_date).isoformat()
    except ValueError:
        parsed_date = None

    rest = normalize_space(match.group("rest").replace("_", ":"))
    parts = [normalize_space(part) for part in re.split(r"\s+-\s+|-\s+", rest, maxsplit=1) if normalize_space(part)]
    guest = parts[0] if parts else "Unknown Guest"
    topic = parts[1] if len(parts) > 1 else "Topic"
    if status == "template":
        guest = "Name"
        topic = "Topic"
    return {
        "date": parsed_date,
        "date_raw": raw_date,
        "guest_name": guest,
        "topic": topic,
        "status": status,
    }


def read_relationships(docx_path: Path) -> dict[str, str]:
    try:
        with ZipFile(docx_path) as archive:
            rels_xml = archive.read("word/_rels/document.xml.rels")
    except KeyError:
        return {}
    root = ET.fromstring(rels_xml)
    relationships = {}
    for rel in root.findall("rel:Relationship", REL_NS):
        rel_id = rel.attrib.get("Id")
        target = rel.attrib.get("Target")
        if rel_id and target and target.startswith(("http://", "https://")):
            relationships[rel_id] = target
    return relationships


def paragraph_text(paragraph: ET.Element, relationships: dict[str, str]) -> str:
    parts: list[str] = []
    for child in paragraph:
        if child.tag.endswith("}hyperlink"):
            rel_id = child.attrib.get(f"{{{WORD_NS['r']}}}id")
            text = "".join(node.text or "" for node in child.findall(".//w:t", WORD_NS))
            target = relationships.get(rel_id or "")
            if text and target and target not in text:
                parts.append(f"{text} ({target})")
            else:
                parts.append(text)
            continue
        for node in child.findall(".//w:t", WORD_NS):
            if node.text:
                parts.append(node.text)
    return normalize_space("".join(parts))


def extract_docx_paragraphs(docx_path: Path) -> list[str]:
    relationships = read_relationships(docx_path)
    with ZipFile(docx_path) as archive:
        document_xml = archive.read("word/document.xml")
    root = ET.fromstring(document_xml)
    paragraphs = []
    for paragraph in root.findall(".//w:p", WORD_NS):
        text = paragraph_text(paragraph, relationships)
        if text:
            paragraphs.append(text)
    return paragraphs


def canonical_section(line: str) -> str | None:
    clean = normalize_space(line).lower()
    for section, aliases in SECTION_ALIASES.items():
        if clean in aliases:
            return section
    if clean.startswith("template 1"):
        return "template_practical"
    if clean.startswith("template 2"):
        return "template_personal_story"
    return None


def split_sections(paragraphs: list[str]) -> dict[str, list[str]]:
    sections: dict[str, list[str]] = defaultdict(list)
    current = "unsectioned"
    for paragraph in paragraphs:
        section = canonical_section(paragraph)
        if section:
            current = section
            continue
        sections[current].append(paragraph)
    return dict(sections)


def extract_prefixed_value(paragraphs: list[str], prefix: str) -> str | None:
    prefix_lower = prefix.lower()
    for paragraph in paragraphs:
        if paragraph.lower().startswith(prefix_lower):
            value = paragraph.split(":", 1)[1] if ":" in paragraph else ""
            value = normalize_space(value)
            return value or None
    return None


def extract_title(paragraphs: list[str]) -> str | None:
    return extract_prefixed_value(paragraphs, "Title:")


def extract_subtitle(paragraphs: list[str]) -> str | None:
    return extract_prefixed_value(paragraphs, "Subtitle:")


def extract_links(paragraphs: list[str]) -> dict[str, str]:
    links = {}
    for paragraph in paragraphs:
        match = re.match(r"(?P<label>LinkedIn|Twitter|Github|GitHub|Website|YouTube|Instagram):\s*(?P<value>.+)", paragraph, re.I)
        if not match:
            continue
        value = normalize_space(match.group("value"))
        if value and value not in {"-", "TODO"}:
            links[match.group("label").lower()] = value
    return links


def extract_bio(sections: dict[str, list[str]], paragraphs: list[str]) -> str | None:
    candidates = []
    for key in ("bio", "event_description", "guest_tab", "unsectioned"):
        candidates.extend(sections.get(key, []))
    for index, paragraph in enumerate(paragraphs):
        if paragraph.lower() in {"bio:", "bio", "about the speaker", "mini-bio"}:
            following = paragraphs[index + 1:index + 3]
            return " ".join(following).strip() or None
    for paragraph in candidates:
        if paragraph.lower().startswith(("senior ", "data ", "machine learning ", "alexey ", "vadim ")):
            return paragraph
    return None


def classify_source_quality(status: str, paragraphs: list[str]) -> str:
    if status == "template":
        return "template"
    if status == "cancelled":
        return "cancelled"
    text = "\n".join(paragraphs).lower()
    todo_count = text.count("todo")
    if len(paragraphs) < 25:
        return "sparse"
    if todo_count >= 8:
        return "template_heavy"
    if len(paragraphs) < 55 or todo_count >= 3:
        return "partial"
    return "complete"


def clean_question_text(text: str) -> str | None:
    text = normalize_space(text)
    if not text:
        return None
    if text.lower().startswith(("what we get into", "we plan to cover", "outline:")):
        return None
    if text.endswith(":") and "?" not in text:
        return None

    if "?" in text:
        text = text.split("?", 1)[0] + "?"

    question_word_pattern = r"^(how|what|why|when|where|who|which|are|is|do|does|did|can|could|would|should)\b"
    conversational_prompt_pattern = r"^(tell us|walk us|let's talk|give us|share)\b"
    starts_like_question = re.match(question_word_pattern, text, re.I)
    starts_like_prompt = re.match(conversational_prompt_pattern, text, re.I)
    if starts_like_question and "?" not in text:
        return None
    if not starts_like_question and not starts_like_prompt:
        return None
    if len(text) < 8:
        return None
    return text


def extract_questions(paragraphs: list[str]) -> list[str]:
    questions = []
    seen = set()
    for paragraph in paragraphs:
        text = clean_question_text(paragraph)
        if not text:
            continue
        key = text.lower()
        if key in seen:
            continue
        seen.add(key)
        questions.append(text)
    return questions


def classify_question(question: str) -> str:
    question_lower = question.lower()
    for category, keywords in QUESTION_CATEGORY_KEYWORDS.items():
        if any(keyword in question_lower for keyword in keywords):
            return category
    if any(keyword in question_lower for keyword in ("architecture", "tool", "model", "data", "pipeline", "evaluate", "production")):
        return "technical_deep_dive"
    if any(keyword in question_lower for keyword in ("business", "metric", "customer", "stakeholder", "roi")):
        return "business_impact"
    if any(keyword in question_lower for keyword in ("company", "manager", "team", "enterprise", "organization")):
        return "organizational_reality"
    if any(keyword in question_lower for keyword in ("future", "trend", "next")):
        return "future_outlook"
    return "general"


def is_template_question(question: str) -> bool:
    template_stems = {
        "how would you like us to introduce you?",
        "what are you currently focused on—projects or themes you’d enjoy discussing?",
        "what are you currently focused on-projects or themes you’d enjoy discussing?",
        "which topics are you most keen to cover?",
        "are there any topics you’d rather skip or avoid discussing publicly?",
        "are there any books or other resources that you can recommend to the listeners?",
    }
    return question.lower() in template_stems


def infer_themes(text: str) -> list[str]:
    text_lower = text.lower()
    scores = Counter()
    for theme, keywords in THEME_KEYWORDS.items():
        for keyword in keywords:
            if keyword in text_lower:
                scores[theme] += 1
    return [theme for theme, _ in scores.most_common()]


def infer_question_categories(questions: list[str]) -> list[str]:
    joined = "\n".join(questions).lower()
    scores = Counter()
    for category, keywords in QUESTION_CATEGORY_KEYWORDS.items():
        for keyword in keywords:
            if keyword in joined:
                scores[category] += 1
    return [category for category, _ in scores.most_common()]


def build_record(path: Path, source_root: Path) -> EpisodeRecord:
    meta = parse_filename(path)
    paragraphs = extract_docx_paragraphs(path)
    sections = split_sections(paragraphs)
    raw_text = "\n".join(paragraphs)
    guest_name = str(meta["guest_name"] or "Unknown Guest")
    record_id_parts = [meta["date_raw"] or "undated", guest_name]
    record_id = slugify("-".join(record_id_parts))
    title = extract_title(paragraphs)
    topic = title or str(meta["topic"] or "Topic")
    questions = extract_questions(paragraphs)
    status = str(meta["status"])
    return EpisodeRecord(
        id=record_id,
        source_path=str(path.relative_to(REPO_ROOT)),
        status=status,
        date=meta["date"],
        date_raw=meta["date_raw"],
        guest_name=guest_name,
        topic=topic,
        title=title,
        subtitle=extract_subtitle(paragraphs),
        source_quality=classify_source_quality(status, paragraphs),
        bio=extract_bio(sections, paragraphs),
        links=extract_links(paragraphs),
        themes=infer_themes(raw_text),
        question_categories=infer_question_categories(questions),
        questions=questions,
        sections=sections,
        raw_text=raw_text,
    )


def markdown_record(record: EpisodeRecord) -> str:
    lines = [
        "---",
        f"id: {record.id}",
        f"status: {record.status}",
        f"date: {record.date or ''}",
        f"date_raw: {record.date_raw or ''}",
        f"guest_name: {record.guest_name}",
        f"topic: {record.topic}",
        f"source_quality: {record.source_quality}",
        f"source_path: {record.source_path}",
        f"themes: {json.dumps(record.themes)}",
        f"question_categories: {json.dumps(record.question_categories)}",
        "---",
        "",
        f"# {record.guest_name} - {record.topic}",
        "",
    ]
    if record.subtitle:
        lines.extend(["## Subtitle", "", record.subtitle, ""])
    if record.bio:
        lines.extend(["## Bio", "", record.bio, ""])
    if record.links:
        lines.extend(["## Links", ""])
        for label, value in sorted(record.links.items()):
            lines.append(f"- {label}: {value}")
        lines.append("")
    if record.themes:
        lines.extend(["## Themes", "", ", ".join(record.themes), ""])
    if record.questions:
        lines.extend(["## Extracted Questions", ""])
        for question in record.questions:
            lines.append(f"- {question}")
        lines.append("")
    lines.extend(["## Sections", ""])
    for section, paragraphs in record.sections.items():
        lines.extend([f"### {section.replace('_', ' ').title()}", ""])
        for paragraph in paragraphs:
            lines.append(paragraph)
            lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def build_clusters(records: list[EpisodeRecord]) -> dict:
    by_theme = defaultdict(list)
    by_question_category = defaultdict(list)
    for record in records:
        for theme in record.themes or ["uncategorized"]:
            by_theme[theme].append(record.id)
        for category in record.question_categories or ["uncategorized"]:
            by_question_category[category].append(record.id)
    return {
        "themes": {key: sorted(values) for key, values in sorted(by_theme.items())},
        "question_categories": {key: sorted(values) for key, values in sorted(by_question_category.items())},
    }


def write_outputs(records: list[EpisodeRecord], output_dir: Path, data_dir: Path) -> None:
    episodes_dir = output_dir / "episodes"
    clusters_dir = output_dir / "clusters"
    episodes_dir.mkdir(parents=True, exist_ok=True)
    clusters_dir.mkdir(parents=True, exist_ok=True)
    data_dir.mkdir(parents=True, exist_ok=True)

    for old_file in episodes_dir.glob("*.md"):
        old_file.unlink()

    for record in records:
        (episodes_dir / f"{record.id}.md").write_text(markdown_record(record), encoding="utf-8")

    serializable = [asdict(record) for record in records]
    (data_dir / "podcast_episodes.json").write_text(json.dumps(serializable, indent=2, ensure_ascii=False), encoding="utf-8")
    with (data_dir / "podcast_episodes.jsonl").open("w", encoding="utf-8") as file:
        for item in serializable:
            file.write(json.dumps(item, ensure_ascii=False) + "\n")

    question_records = build_question_records(records)
    with (data_dir / "podcast_questions.csv").open("w", encoding="utf-8", newline="") as file:
        writer = csv.DictWriter(
            file,
            fieldnames=[
                "episode_id",
                "guest_name",
                "topic",
                "question_order",
                "question_category",
                "is_template_question",
                "question_text",
                "source_path",
            ],
        )
        writer.writeheader()
        for question in question_records:
            writer.writerow(asdict(question))
    with (data_dir / "podcast_questions.jsonl").open("w", encoding="utf-8") as file:
        for question in question_records:
            file.write(json.dumps(asdict(question), ensure_ascii=False) + "\n")

    clusters = build_clusters(records)
    (data_dir / "podcast_clusters.json").write_text(json.dumps(clusters, indent=2, ensure_ascii=False), encoding="utf-8")
    (clusters_dir / "themes.md").write_text(render_clusters_markdown(records, clusters), encoding="utf-8")


def build_question_records(records: list[EpisodeRecord]) -> list[QuestionRecord]:
    output = []
    for record in records:
        for index, question in enumerate(record.questions, 1):
            output.append(
                QuestionRecord(
                    episode_id=record.id,
                    guest_name=record.guest_name,
                    topic=record.topic,
                    question_text=question,
                    question_category=classify_question(question),
                    question_order=index,
                    is_template_question=is_template_question(question),
                    source_path=record.source_path,
                )
            )
    return output


def render_clusters_markdown(records: list[EpisodeRecord], clusters: dict) -> str:
    by_id = {record.id: record for record in records}
    lines = ["# Podcast Knowledge Base Clusters", ""]
    lines.extend(["## Episode Themes", ""])
    for theme, ids in clusters["themes"].items():
        lines.append(f"### {theme}")
        for record_id in ids:
            record = by_id[record_id]
            lines.append(f"- {record.guest_name} - {record.topic} (`{record.id}`)")
        lines.append("")
    lines.extend(["## Question Categories", ""])
    for category, ids in clusters["question_categories"].items():
        lines.append(f"### {category}")
        for record_id in ids:
            record = by_id[record_id]
            lines.append(f"- {record.guest_name} - {record.topic} (`{record.id}`)")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def maybe_unpack_zip(zip_path: Path | None, destination: Path) -> None:
    if zip_path is None:
        return
    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True, exist_ok=True)
    with ZipFile(zip_path) as archive:
        archive.extractall(destination)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--zip", type=Path, default=None, help="Optional uploaded Podcast zip to unpack before building.")
    parser.add_argument("--source-dir", type=Path, default=DEFAULT_SOURCE_DIR, help="Directory containing .docx files.")
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR, help="Markdown knowledge base output directory.")
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA_DIR, help="Structured data output directory.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.zip:
        maybe_unpack_zip(args.zip, REPO_ROOT / "podcast_examples")

    source_dir = args.source_dir
    docx_files = sorted(source_dir.rglob("*.docx"))
    if not docx_files:
        raise SystemExit(f"No .docx files found under {source_dir}")

    records = [build_record(path, source_dir) for path in docx_files]
    records.sort(key=lambda record: (record.date or record.date_raw or "", record.guest_name))
    write_outputs(records, args.output_dir, args.data_dir)
    print(f"Built {len(records)} podcast records")
    print(f"Markdown: {args.output_dir / 'episodes'}")
    print(f"Data: {args.data_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
