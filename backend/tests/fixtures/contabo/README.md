This synthetic Contabo proforma invoice reproduces the reference layout and
failure mode: all text except `VAT-ID: DE123456789` is drawn as vector outlines.
Customer name, address, customer number and invoice number are invented; bank
details are omitted. No source PDF, screenshot, or customer data is included.

Regenerate with `uv run --no-project --with fonttools generate.py` from this directory on a
machine with DejaVu Sans installed. The generator never reads the source invoice.
The font's notices are retained in `FONT-LICENSE.txt`.

The extractor preserves the existing first-labeled-VAT semantics. Here `vatId`
is the customer VAT ID `DE123456789`, not Contabo's footer USt-IdNr `DE267602842`.
The gross total is `70.44 EUR`, the invoice date is `2026-10-21`, and the invented proforma number is
`900001000P261021`. Amounts and dates do not establish payment evidence.
