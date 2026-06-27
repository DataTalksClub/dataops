from __future__ import annotations

import csv
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path

import openpyxl
from slugify import slugify


ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = ROOT / "Processes-20260519T133611Z-3-001.zip"
DOCS_DIR = ROOT / "docs"
IMAGES_DIR = ROOT / "assets" / "images"
MANIFEST = ROOT / "docs" / "_conversion-manifest.csv"


@dataclass(frozen=True)
class ConvertedPath:
    source: str
    output: Path
    title: str
    status: str = "converted"
    error: str = ""


def clean_title(path: Path) -> str:
    return re.sub(r"\s+", " ", path.stem.replace("_", " ")).strip()


def slug_parts(path: Path) -> list[str]:
    parts = list(path.parts)
    if parts and parts[0].lower() == "processes":
        parts = parts[1:]
    return [slugify(part, lowercase=True) or "untitled" for part in parts]


def output_markdown_path(source: Path) -> Path:
    parts = slug_parts(source.with_suffix(""))
    return DOCS_DIR.joinpath(*parts).with_suffix(".md")


def media_dir_for(markdown_path: Path) -> Path:
    rel = markdown_path.relative_to(DOCS_DIR).with_suffix("")
    return IMAGES_DIR / rel


def ensure_unique(path: Path) -> Path:
    if not path.exists():
        return path
    digest = hashlib.sha1(path.as_posix().encode("utf-8")).hexdigest()[:8]
    return path.with_name(f"{path.stem}-{digest}{path.suffix}")


def fix_image_paths(markdown_path: Path, media_dir: Path) -> None:
    text = markdown_path.read_text(encoding="utf-8")
    rel_media = Path(os.path.relpath(media_dir, markdown_path.parent)).as_posix()
    text = text.replace(media_dir.as_posix(), rel_media)
    text = text.replace(f"]({media_dir.as_posix()}/", f"]({rel_media}/")
    text = re.sub(r"\]\((?:\./)?media/", f"]({rel_media}/", text)
    text = re.sub(r'<img\s+src="([^"]+)"[^>]*?/?>', r"![](\1)", text)
    text = text.replace("<u>", "").replace("</u>", "")
    markdown_path.write_text(text, encoding="utf-8")


def add_frontmatter(markdown_path: Path, title: str, source: str) -> None:
    body = markdown_path.read_text(encoding="utf-8").strip() + "\n"
    frontmatter = (
        "---\n"
        f'title: "{title.replace(chr(34), chr(39))}"\n'
        f'source: "{source.replace(chr(34), chr(39))}"\n'
        "converted: 2026-05-19\n"
        "tags:\n"
        "  - migrated\n"
        "---\n\n"
    )
    markdown_path.write_text(frontmatter + body, encoding="utf-8")


def convert_docx(extracted_file: Path, source_name: str) -> ConvertedPath:
    source = Path(source_name)
    title = clean_title(source)
    markdown_path = ensure_unique(output_markdown_path(source))
    markdown_path.parent.mkdir(parents=True, exist_ok=True)
    media_dir = media_dir_for(markdown_path)
    media_dir.mkdir(parents=True, exist_ok=True)

    try:
        subprocess.run(
            [
                "pandoc",
                str(extracted_file),
                "--from=docx",
                "--to=gfm",
                "--wrap=none",
                f"--extract-media={media_dir}",
                "--output",
                str(markdown_path),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
    except subprocess.CalledProcessError as exc:
        error = (exc.stderr or exc.stdout or str(exc)).strip()
        markdown_path.write_text(
            f"# {title}\n\n"
            "This document could not be converted automatically.\n\n"
            f"- Source: `{source_name}`\n"
            f"- Error: `{error}`\n",
            encoding="utf-8",
        )
        add_frontmatter(markdown_path, title, source_name)
        return ConvertedPath(source_name, markdown_path, title, "failed", error)

    fix_image_paths(markdown_path, media_dir)
    add_frontmatter(markdown_path, title, source_name)
    return ConvertedPath(source_name, markdown_path, title)


def markdown_table(rows: list[list[str]]) -> str:
    if not rows:
        return ""
    width = max(len(row) for row in rows)
    normalized = [row + [""] * (width - len(row)) for row in rows]
    escaped = [[cell.replace("|", "\\|").replace("\n", "<br>") for cell in row] for row in normalized]
    header = escaped[0]
    separator = ["---"] * width
    lines = [
        "| " + " | ".join(header) + " |",
        "| " + " | ".join(separator) + " |",
    ]
    for row in escaped[1:]:
        lines.append("| " + " | ".join(row) + " |")
    return "\n".join(lines)


def convert_xlsx(extracted_file: Path, source_name: str) -> ConvertedPath:
    source = Path(source_name)
    markdown_path = ensure_unique(output_markdown_path(source))
    markdown_path.parent.mkdir(parents=True, exist_ok=True)
    title = clean_title(source)
    workbook = openpyxl.load_workbook(extracted_file, data_only=True)
    sections: list[str] = []

    for sheet in workbook.worksheets:
        rows: list[list[str]] = []
        for row in sheet.iter_rows(values_only=True):
            values = ["" if value is None else str(value) for value in row]
            if any(value.strip() for value in values):
                rows.append(values)
        if rows:
            sections.append(f"## {sheet.title}\n\n{markdown_table(rows)}")

    body = "\n\n".join(sections).strip() or "_No spreadsheet content found._"
    markdown_path.write_text(body + "\n", encoding="utf-8")
    add_frontmatter(markdown_path, title, source_name)
    return ConvertedPath(source_name, markdown_path, title)


def copy_standalone_asset(zf: zipfile.ZipFile, source_name: str) -> ConvertedPath:
    source = Path(source_name)
    parts = slug_parts(source.with_suffix(""))
    target = ensure_unique(IMAGES_DIR.joinpath(*parts).with_suffix(source.suffix.lower()))
    target.parent.mkdir(parents=True, exist_ok=True)
    with zf.open(source_name) as src, target.open("wb") as dst:
        shutil.copyfileobj(src, dst)
    return ConvertedPath(source_name, target, clean_title(source))


def write_manifest(rows: list[ConvertedPath]) -> None:
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    with MANIFEST.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["source", "output", "title", "status", "error"])
        for row in sorted(rows, key=lambda item: item.source.lower()):
            writer.writerow(
                [
                    row.source,
                    row.output.relative_to(ROOT).as_posix(),
                    row.title,
                    row.status,
                    row.error,
                ]
            )


def main() -> None:
    if not ARCHIVE.exists():
        raise SystemExit(f"Archive not found: {ARCHIVE}")

    converted: list[ConvertedPath] = []
    with tempfile.TemporaryDirectory(prefix="processes-") as tmp:
        tmp_path = Path(tmp)
        with zipfile.ZipFile(ARCHIVE) as zf:
            file_names = [name for name in zf.namelist() if not name.endswith("/")]
            for name in file_names:
                suffix = Path(name).suffix.lower()
                if suffix not in {".docx", ".xlsx", ".jpg", ".jpeg", ".png", ".gif", ".webp"}:
                    continue
                zf.extract(name, tmp_path)
                extracted_file = tmp_path / name
                if suffix == ".docx":
                    converted.append(convert_docx(extracted_file, name))
                elif suffix == ".xlsx":
                    converted.append(convert_xlsx(extracted_file, name))
                else:
                    converted.append(copy_standalone_asset(zf, name))

    write_manifest(converted)
    print(json.dumps({"converted": len(converted)}, indent=2))


if __name__ == "__main__":
    main()
