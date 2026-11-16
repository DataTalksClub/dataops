import importlib.util
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "newsletter_to_relay.py"
spec = importlib.util.spec_from_file_location("newsletter_to_relay", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

ISSUE = """---
issue: 303
send_date: 2026-11-16
status: draft
subject: Subject line
preview: Preview line.
---

#303 · November 16, 2026

**This week:** a sponsor and two podcasts.

SPONSORED

## Sponsor title

Intro paragraph.

Plus:

- One
- Two

[Register now](https://example.com/register)

---

## Course

Course text.

[Apply](https://example.com/apply)

[Banner: AI Dev Tools Zoomcamp]

## Project 2

Do it. [criteria](https://example.com/c).

[Submit](https://example.com/s)

---

EVENTS

## Upcoming Events

Mon, November 16 · 5:00 PM CET · Launch stream

[Launch](https://luma.com/x) with Alexey

---

PODCAST

## Podcast: One

First.

[Listen](https://example.com/1)

## Podcast: Two

Second.

[Listen](https://example.com/2)
"""


def test_front_matter_and_dividers_never_reach_the_blocks():
    front, blocks = module.parse_issue(ISSUE)
    assert front["subject"] == "Subject line" and front["preview"] == "Preview line."
    assert not any("---" in str(data) for _, data in blocks)
    assert [kind for kind, _ in blocks] == [
        "intro", "sponsor", "course_promo", "course_update", "events_list", "podcast_episode", "podcast_episode"]
    assert blocks[0][1] == {"issue_label": "#303 · November 16, 2026", "summary": "This week: a sponsor and two podcasts."}


def test_sponsor_block_takes_the_graphic_bullets_and_button():
    _, blocks = module.parse_issue(ISSUE, sponsor_graphic="https://img.example/s.png")
    sponsor = dict(blocks)["sponsor"]
    assert sponsor["image_url"] == "https://img.example/s.png"
    assert sponsor["image_link"] == sponsor["cta_url"] == "https://example.com/register"
    assert sponsor["bullets"] == "One\nTwo" and sponsor["cta_text"] == "Register now"


def test_section_label_appears_once_per_section():
    _, blocks = module.parse_issue(ISSUE)
    podcasts = [data for kind, data in blocks if kind == "podcast_episode"]
    assert [p["kicker"] for p in podcasts] == ["PODCAST", "-"]
    events = dict(blocks)["events_list"]
    assert events["kicker"] == "-"
    assert events["events"] == "Mon, November 16 · 5:00 PM CET · Launch stream | Launch | https://luma.com/x | with Alexey"


def test_banner_becomes_course_image_and_images_map_by_title_prefix():
    _, blocks = module.parse_issue(ISSUE, images={"Podcast: Two": "https://img.example/p.png"})
    data = [d for k, d in blocks]
    assert data[3]["image_url"].startswith("https://mcusercontent.com/")
    assert data[6]["image_url"] == "https://img.example/p.png" and data[6]["image_link"] == "https://example.com/2"
