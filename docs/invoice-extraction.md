# Invoice extraction

Invoice and receipt upload completion (portal and CLI) and imported email invoice attachments use the same finance reader. Fields include the document date, counterparty, document number, currency, gross (`amount`), `netAmount`, `vatAmount`, `vatRate`, and `reverseCharge`. The review page displays totals and extraction issues. Document evidence also lives on linked bookkeeping rows as `documentExtraction`.

The template registry in `backend/src/invoices/financeExtraction.ts` recognizes layout anchors for recurring invoices. Templates must supply a valid date, document number, issuer/recipient, currency, net, VAT, gross and rate, and pass arithmetic checks. Other layouts use the OpenAI document reader and an independent regex cross-check. Missing source facts remain unknown; no tax rate is inferred from a missing tax line. Reader errors, uncertainty, conflicting totals and arithmetic failures flag review. A review flag prevents copying extracted finance values into linked ledger fields. Existing bank amounts and operator corrections are retained.

The runtime reads `api_key` from the DataOps app secret `openai-invoice-extraction` using the Lambda identity. `DATAOPS_OPENAI_SECRET` changes the secret name; `DATAOPS_EXTRACTION_MODEL` changes the model (default `gpt-6-luna`, selected by field accuracy in the private corpus evaluation). Keys are never recorded in extraction metadata. Extraction does not attest payment or trigger publication to external destinations.

`grossAmountEur`, `netAmountEur` and `vatAmountEur` are indicative conversions using the ECB reference rate on or before the document date; `exchangeRate`, `exchangeRateDate`, and `exchangeRateSource` preserve provenance. `amountEur` remains the actual reviewed bank payment. An unavailable ECB rate is a review issue.

Run the private corpus evaluation from the repository root:

```
node --import tsx backend/scripts/extract-eval.ts --corpus /private/corpus --gold /private/gold.json --mode full --model gpt-6-luna --report /private/full.json
node --import tsx backend/scripts/extract-eval.ts --corpus /private/corpus --gold /private/gold.json --mode openai --model gpt-6-luna --report /private/openai.json
```

The corpus has `index.json` entries with `id`, `file` (PDF path), and `kind`, plus `text/<id>.txt`. Gold is an object keyed by document ID with expected reader fields. Each model runs on every document in pure OpenAI mode; full mode reports which documents use templates. The private cache stores model responses, usage and measured API latency. Accuracy is calculated only for explicitly labeled fields and documents; unlabeled inputs never count as correct. Amounts compare to the cent, legal names ignore punctuation and case. Cost uses standard uncached token prices, an upper-bound estimate when prompt caching applies. Private inputs, responses and per-document reports stay outside this public repository. CI uses synthetic documents and recorded reader responses in the invoice extraction tests, without live credentials.
