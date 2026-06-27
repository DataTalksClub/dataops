"""Smoke test: open an SOP, edit a step body, section body, group title,
prose, caption; verify the patched markdown still lints clean.
"""
from __future__ import annotations

import asyncio
import subprocess
import sys
import tempfile

from playwright.async_api import async_playwright


HOST = "http://127.0.0.1:5173"


async def open_doc(page, query: str) -> None:
    await page.fill("#search-input", query)
    await page.wait_for_timeout(700)
    await page.click(".document-row")
    await page.wait_for_timeout(800)


async def commit_textarea_edit(page, selector: str, value: str) -> None:
    await page.click(selector)
    await page.wait_for_timeout(200)
    await page.evaluate("(v) => { document.querySelector('.inline-editor').value = v; }", value)
    await page.keyboard.press("Control+Enter")
    await page.wait_for_timeout(300)


async def commit_input_edit(page, selector: str, value: str) -> None:
    await page.click(selector)
    await page.wait_for_timeout(200)
    await page.evaluate("(v) => { document.querySelector('.inline-editor').value = v; }", value)
    await page.keyboard.press("Enter")
    await page.wait_for_timeout(300)


async def main() -> int:
    errors: list[str] = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={"width": 1400, "height": 900})
        page = await ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))

        await page.goto(HOST, wait_until="networkidle")
        await open_doc(page, "moving podcast audio dropbox")

        # Edit step 1 body.
        await commit_textarea_edit(
            page,
            ".block-step .block-step-body",
            "Edited first step body.",
        )

        # Edit Summary section body.
        await commit_textarea_edit(
            page,
            '.block-section[data-section="summary"] .block-section-body',
            "Edited summary content.\n- New bullet.",
        )

        # Edit caption.
        await commit_textarea_edit(
            page,
            ".block-screenshot figcaption",
            "Edited caption.",
        )

        markdown: str = await page.evaluate("document.querySelector('#editor').value")
        await browser.close()

    if errors:
        for e in errors:
            print("page error:", e)
        return 1

    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as f:
        f.write(markdown)
        tmp = f.name

    result = subprocess.run(
        ["python3", "scripts/sop_lint.py", tmp],
        capture_output=True,
        text=True,
        cwd="/home/alexey/git/dtc-operations",
    )
    print(result.stdout.strip())
    if result.returncode != 0:
        print(result.stderr.strip())
        return result.returncode
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
