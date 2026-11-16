#!/usr/bin/env python3
"""Build a Relay newsletter issue from a DataOps Newsletter Markdown (issue.md).

Maps the issue sections to Relay newsletter blocks (docs/api.md "Newsletter blocks" in the
relay repo), so the email uses the same template as the Mailchimp weekly. Nothing is sent
and no campaign is assembled here: assemble and test-send stay explicit Relay steps.

  RELAY_KEY=... newsletter_to_relay.py issue.md weekly-303 \
      [--sponsor-graphic URL] [--image 'Title prefix=URL' ...]

Markdown shape: front matter (issue, send_date, subject, preview), the issue label and a
"**This week:**" summary, then sections separated by `---` and introduced by an upper-case
marker (SPONSORED, EVENTS, RECORDINGS, PODCAST, SURVEY, READ). `## Title` starts a card,
`[Banner: Course]` before a title adds the course banner, a trailing `[Text](url)` line is
the button. Only the first card of a section carries the section label; the later ones get
the Relay kicker "-" (no label).
"""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request

BASE = "https://relay.datatalks.club/api/newsletter-issues"
BANNERS = {
    "ai dev tools zoomcamp": (
        "https://mcusercontent.com/0d7822ab98152f5afc118c176/images/c39d593c-3435-b19e-3a98-d2d110924dc8.png",
        "https://github.com/DataTalksClub/ai-dev-tools-zoomcamp",
    ),
    "machine learning zoomcamp": (
        "https://mcusercontent.com/0d7822ab98152f5afc118c176/images/f6aee0bd-8307-6d8e-2e90-355ccb46929d.png",
        "https://github.com/DataTalksClub/machine-learning-zoomcamp",
    ),
}
EVENTS_FOOTER = (
    "[See all upcoming events](https://lu.ma/dtc-events) · [Add our events to your calendar]"
    "(https://calendar.google.com/calendar/?cid=ZjhxaWRqbnEwamhzY3A4ODA5azFlZ2hzNjBAZ3JvdXAuY2FsZW5kYXIuZ29vZ2xlLmNvbQ)"
)
BUTTON = re.compile(r"^\[([^\]]+)\]\((https?://[^)]+)\)$")
SECTION_TYPES = {"RECORDINGS": "recording", "PODCAST": "podcast_episode", "READ": "alexey_article", "SURVEY": "feature"}


def _cards(section):
    lines = section.split("\n")
    kicker = lines.pop(0).strip() if lines and re.fullmatch(r"[A-Z ]+", lines[0].strip()) else ""
    cards, banner = [], None
    for line in lines:
        text = line.strip()
        match = re.fullmatch(r"\[Banner: (.+)\]", text)
        if match:
            banner = match.group(1)
        elif text.startswith("## "):
            cards.append({"kicker": kicker if not cards else ("-" if kicker else ""),
                          "banner": banner, "title": text[3:].strip(), "lines": []})
            banner = None
        elif cards:
            cards[-1]["lines"].append(line)
    return kicker, cards


def _body(lines):
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", "\n".join(lines).strip()) if p.strip()]
    button = BUTTON.match(paragraphs.pop()).groups() if paragraphs and BUTTON.match(paragraphs[-1]) else None
    return paragraphs, button


def _events(card):
    rows = [line.strip() for line in card["lines"] if line.strip()]
    events = []
    for when, link in zip(rows[0::2], rows[1::2]):
        match = re.match(r"\[(.+?)\]\((https?://[^)]+)\)(?: (with .+))?$", link)
        events.append(" | ".join([when, match.group(1), match.group(2)] + ([match.group(3)] if match.group(3) else [])))
    return "\n".join(events)


def parse_issue(markdown, sponsor_graphic="", images=None):
    """Return (front matter dict, [(block type, data)])."""
    images = images or {}
    match = re.match(r"---\n(.*?)\n---\n(.*)", markdown, re.S)
    front = dict(line.split(": ", 1) for line in match.group(1).splitlines() if ": " in line)
    sections = [s.strip("\n") for s in re.split(r"\n---\n", match.group(2))]
    head = re.split(r"\n(?=[A-Z][A-Z ]+\n)", sections[0].strip(), maxsplit=1)
    sections = head + sections[1:]
    label, *rest = sections[0].strip().split("\n\n")
    summary = re.sub(r"^\*\*This week:\*\*\s*", "This week: ", "\n\n".join(rest).strip())
    blocks = [("intro", {"issue_label": label.strip(), "summary": summary})]
    for section in sections[1:]:
        kicker, cards = _cards(section)
        for card in cards:
            paragraphs, button = _body(card["lines"])
            data = {"kicker": card["kicker"], "title": card["title"]}
            if kicker == "SPONSORED":
                bullets = []
                if paragraphs and all(item.startswith("- ") for item in paragraphs[-1].split("\n")):
                    bullets = [item[2:] for item in paragraphs.pop().split("\n")]
                data.update(body="\n\n".join(paragraphs), bullets="\n".join(bullets))
                if sponsor_graphic:
                    data.update(image_url=sponsor_graphic, image_link=button[1])
                kind = "sponsor"
            elif kicker == "EVENTS" and card["title"] == "Upcoming Events":
                data = {"kicker": "-", "title": card["title"], "events": _events(card), "footer": EVENTS_FOOTER}
                kind, button = "events_list", None
            else:
                data["body"] = "\n\n".join(paragraphs)
                kind = SECTION_TYPES.get(kicker) or (
                    "event_spotlight" if kicker == "EVENTS" else "course_promo" if not card["banner"] else "course_update")
                if card["banner"]:
                    data["image_url"], data["image_link"] = BANNERS[card["banner"].lower()]
                for prefix, url in images.items():
                    if card["title"].startswith(prefix):
                        data.update(image_url=url, image_link=button[1] if button else "")
            if button:
                data.update(cta_text=button[0], cta_url=button[1])
            blocks.append((kind, {k: v for k, v in data.items() if v}))
    return front, blocks


def _api(token, method, path, body=None):
    request = urllib.request.Request(
        BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        sys.exit(f"Relay {method} {path} failed: HTTP {error.code} {error.read().decode()[:500]}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("issue_md")
    parser.add_argument("key", help="Relay issue key, e.g. weekly-303")
    parser.add_argument("--sponsor-graphic", default="")
    parser.add_argument("--image", action="append", default=[], metavar="TITLE_PREFIX=URL")
    args = parser.parse_args()
    token = os.environ["RELAY_KEY"]
    images = dict(item.split("=", 1) for item in args.image)
    with open(args.issue_md, encoding="utf-8") as handle:
        front, blocks = parse_issue(handle.read(), args.sponsor_graphic, images)
    fields = {"subject": front["subject"], "preview_text": front["preview"],
              "issue_number": int(front["issue"]), "publication_date": front["send_date"]}
    _api(token, "PUT", "/" + args.key, {"template": "blank", **fields})
    for block in _api(token, "GET", "/" + args.key)["issue"]["blocks"]:
        _api(token, "DELETE", f"/{args.key}/blocks/{block['id']}")
    for kind, data in blocks:
        _api(token, "POST", f"/{args.key}/blocks", {"type": kind, "data": data})
    _api(token, "PUT", "/" + args.key, fields)
    issue = _api(token, "GET", "/" + args.key)["issue"]
    print("blocks:", [(b["type"], b["problems"]) for b in issue["blocks"]], "issue problems:", issue["problems"])


if __name__ == "__main__":
    main()
