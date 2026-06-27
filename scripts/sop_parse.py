#!/usr/bin/env python3
"""CLI wrapper for the SOP marker parser.

The canonical implementation lives in
`lambda-functions/src/lambda_functions/sop_parse.py` so deployed Lambda
handlers and local scripts can import the same code. This script just adds
that path to `sys.path` and delegates.
"""
from __future__ import annotations

import sys
from pathlib import Path

_LAMBDA_SRC = Path(__file__).resolve().parent.parent / "lambda-functions" / "src"
if str(_LAMBDA_SRC) not in sys.path:
    sys.path.insert(0, str(_LAMBDA_SRC))

from lambda_functions.sop_parse import (  # noqa: F401  re-export for sop_lint
    ATTR_RE,
    CAPTION_CLOSE_RE,
    CAPTION_OPEN_RE,
    GROUP_CLOSE_RE,
    GROUP_OPEN_RE,
    IMAGE_RE,
    ParseError,
    PROSE_CLOSE_RE,
    PROSE_OPEN_RE,
    REQUIRED_SECTIONS,
    SCREENSHOT_CLOSE_RE,
    SCREENSHOT_OPEN_RE,
    SECTION_CLOSE_RE,
    SECTION_OPEN_RE,
    STEP_CLOSE_RE,
    STEP_OPEN_RE,
    TODO_RE,
    main,
    parse,
    parse_frontmatter,
    split_frontmatter,
)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
