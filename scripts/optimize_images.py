from __future__ import annotations

import csv
import io
import os
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
DOCS_DIR = ROOT / "content"
IMAGES_DIR = ROOT / "content" / "images"
REPORT = ROOT / ".tmp" / "image-optimization-report.csv"

JPEG_QUALITY = 85
MIN_SAVINGS_RATIO = 0.15


def flatten_for_jpeg(image: Image.Image) -> Image.Image:
    if image.mode in {"RGBA", "LA"} or (image.mode == "P" and "transparency" in image.info):
        rgba = image.convert("RGBA")
        background = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        background.alpha_composite(rgba)
        return background.convert("RGB")
    return image.convert("RGB")


def jpeg_bytes(image: Image.Image) -> bytes:
    output = io.BytesIO()
    flatten_for_jpeg(image).save(
        output,
        format="JPEG",
        quality=JPEG_QUALITY,
        optimize=True,
        progressive=True,
    )
    return output.getvalue()


def markdown_replacement(markdown_path: Path, old_path: Path, new_path: Path) -> tuple[str, str]:
    old_rel = Path(os.path.relpath(old_path, markdown_path.parent)).as_posix()
    new_rel = Path(os.path.relpath(new_path, markdown_path.parent)).as_posix()
    return old_rel, new_rel


def rewrite_markdown_refs(replacements: dict[Path, Path]) -> int:
    changed = 0
    markdown_files = list(DOCS_DIR.rglob("*.md"))
    for markdown_path in markdown_files:
        text = markdown_path.read_text(encoding="utf-8")
        original = text
        for old_path, new_path in replacements.items():
            old_rel, new_rel = markdown_replacement(markdown_path, old_path, new_path)
            text = text.replace(old_rel, new_rel)
        if text != original:
            markdown_path.write_text(text, encoding="utf-8")
            changed += 1
    return changed


def optimize_png(path: Path) -> tuple[Path | None, int, int, str]:
    before = path.stat().st_size
    with Image.open(path) as image:
        image.load()
        encoded = jpeg_bytes(image)
        if len(encoded) >= before * (1 - MIN_SAVINGS_RATIO):
            image.save(path, format="PNG", optimize=True)
            after = path.stat().st_size
            return None, before, after, "optimized_png_kept"

    target = path.with_suffix(".jpg")
    suffix = 2
    while target.exists():
        target = path.with_name(f"{path.stem}-{suffix}.jpg")
        suffix += 1

    target.write_bytes(encoded)
    path.unlink()
    return target, before, target.stat().st_size, "converted_png_to_jpeg"


def main() -> None:
    replacements: dict[Path, Path] = {}
    rows: list[list[str | int]] = []

    for path in sorted(IMAGES_DIR.rglob("*")):
        if not path.is_file() or path.name == ".gitkeep":
            continue
        if path.suffix.lower() != ".png":
            continue

        target, before, after, status = optimize_png(path)
        if target is not None:
            replacements[path] = target
            output_path = target
        else:
            output_path = path
        rows.append(
            [
                path.relative_to(ROOT).as_posix(),
                output_path.relative_to(ROOT).as_posix(),
                before,
                after,
                before - after,
                status,
            ]
        )

    markdown_files_changed = rewrite_markdown_refs(replacements)

    REPORT.parent.mkdir(parents=True, exist_ok=True)
    with REPORT.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["source", "output", "before_bytes", "after_bytes", "saved_bytes", "status"])
        writer.writerows(rows)

    total_before = sum(int(row[2]) for row in rows)
    total_after = sum(int(row[3]) for row in rows)
    converted = sum(1 for row in rows if row[5] == "converted_png_to_jpeg")
    print(
        {
            "png_files_processed": len(rows),
            "converted_to_jpeg": converted,
            "markdown_files_changed": markdown_files_changed,
            "before_mb": round(total_before / 1024 / 1024, 1),
            "after_mb": round(total_after / 1024 / 1024, 1),
            "saved_mb": round((total_before - total_after) / 1024 / 1024, 1),
        }
    )


if __name__ == "__main__":
    main()
