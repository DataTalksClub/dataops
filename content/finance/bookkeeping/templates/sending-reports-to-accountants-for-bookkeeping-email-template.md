---
title: "Sending reports to accountants for bookkeeping - Email template"
summary: "Email template for sending dated bookkeeping reports and invoice files to accountants."
doc_type: template
source: "Processes/Bookkeeping & Invoices/Templates/Sending reports to accountants for bookkeeping - Email template.docx"
tags:
  - bookkeeping-invoices
systems: []
related_docs: []
---

# Sending reports to accountants for bookkeeping - Email template

## Usage

- Use when: the monthly tax/bookkeeping report has been reconciled, the ZIP package has been uploaded to the accountant handoff destination, and the accountant needs the report summary.
- Audience: accountant recipients, with Alexey copied.
- Required inputs: report month/year, copied monthly report table, upload/share confirmation, and any short notes about exclusions or follow-up questions.

## Template

Hello,

Here’s the report for \<DATE OF REPORT\> 2022

\<[ATTACHED REPORT FROM THE BOOKKEEPING SPREADSHEET](https://docs.google.com/spreadsheets/d/1jIBou5XvBY3uy7dsxDUVM4yiPZAgXUN5AZJN3bDJgHU/edit?usp=sharing)\>
(copy paste the table)

Also, the zip archive file has been uploaded to the server. Let us know if you have any questions.

Thanks,

(your name)

## Notes

- Capture the sent Gmail thread URL or sent-email proof on the DataOps `notify-accountants` task.
- Do not paste private accountant upload URLs, credentials, or sensitive report data into Git-backed templates.
