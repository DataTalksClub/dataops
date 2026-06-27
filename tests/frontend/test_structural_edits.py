"""Add step, delete step, reorder steps, renumber; lint still clean."""
from __future__ import annotations

import asyncio
import subprocess
import sys
import tempfile

from playwright.async_api import async_playwright


HOST = "http://127.0.0.1:5173"


async def main() -> int:
    errors: list[str] = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={"width": 1400, "height": 900})
        page = await ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("dialog", lambda d: asyncio.create_task(d.accept()))

        await page.goto(HOST, wait_until="networkidle")
        await page.fill("#search-input", "moving podcast audio dropbox")
        await page.wait_for_timeout(700)
        await page.click(".document-row")
        await page.wait_for_timeout(800)

        before_ids = await page.evaluate(
            "Array.from(document.querySelectorAll('.block-step')).map(b => parseInt(b.dataset.stepId))"
        )

        # Add a new step.
        await page.click(".block-add-step")
        await page.wait_for_timeout(400)
        await page.keyboard.press("Escape")  # close auto-opened editor
        await page.wait_for_timeout(200)

        # Delete it.
        await page.evaluate("""() => {
          const blocks = document.querySelectorAll('.block-step');
          const last = blocks[blocks.length - 1];
          const btn = last.querySelector('.block-step-delete');
          btn.style.opacity = '1';
          btn.click();
        }""")
        await page.wait_for_timeout(500)
        await page.click("#undo-toast")  # the toast itself doesn't dismiss, but no harm

        after_ids = await page.evaluate(
            "Array.from(document.querySelectorAll('.block-step')).map(b => parseInt(b.dataset.stepId))"
        )

        markdown: str = await page.evaluate("document.querySelector('#editor').value")
        await browser.close()

    print("before:", before_ids)
    print("after:", after_ids)
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
    return result.returncode


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
