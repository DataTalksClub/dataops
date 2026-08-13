---
title: "Knowledge repository access and token rotation"
summary: How the portal reads and writes the private dataops-knowledge repository, and how to rotate the access token before it expires.
doc_type: reference
schema_version: 1
tags:
  - operations
  - security
systems:
  - github
  - aws
related_docs: []
---

# Knowledge repository access and token rotation

## Summary

- Private repository: `DataTalksClub/dataops-knowledge`
- Secret: `dataops-v1/knowledge/github-token` (AWS Secrets Manager, `eu-west-1`)
- Token expires: **2027-08-14**
- Manage the token: <https://github.com/settings/personal-access-tokens/18189773>

## Why the token needs write access

The portal does not only read process documents. Its document editor creates,
renames and deletes files and images through the GitHub Contents API:

- `GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1` — listing
- `PUT /repos/{owner}/{repo}/contents/{path}` — create and update
- `DELETE /repos/{owner}/{repo}/contents/{path}` — delete and rename

A read-only token looks healthy on the surface: browsing and search work, and
the failure only appears when an operator saves an edit. The token therefore
needs **Contents: read and write**.

## Token settings

| Setting | Value |
| - | - |
| Type | Fine-grained personal access token |
| Resource owner | `DataTalksClub` |
| Repository access | Only select repositories → `dataops-knowledge` |
| Repository permissions | Contents: Read and write |
| Repository permissions | Metadata: Read-only (added automatically) |

## Rotating the token

Regenerating keeps the same name, repository selection and permissions, so
there is nothing to reconfigure on the GitHub side.

1. Open <https://github.com/settings/personal-access-tokens/18189773> and choose
   **Regenerate token**. Set the new expiry.
2. Copy the new `github_pat_…` value.
3. Store it, from a terminal so the value never lands in a transcript or log:

   ```bash
   aws secretsmanager put-secret-value \
     --secret-id dataops-v1/knowledge/github-token \
     --secret-string 'github_pat_…'
   ```

4. Update the tag so the secret still records its own expiry. The portal
   warning needs no update; it reads the live value from GitHub.

   ```bash
   aws secretsmanager tag-resource \
     --secret-id dataops-v1/knowledge/github-token \
     --tags Key=ExpiresOn,Value=YYYY-MM-DD
   ```

5. Confirm the new token reaches the repository:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' \
     -H "Authorization: Bearer github_pat_…" \
     https://api.github.com/repos/DataTalksClub/dataops-knowledge/git/trees/main
   ```

   A `200` means the token works. A `404` usually means the repository was not
   selected in the token's repository access list rather than a missing repo.

No redeploy is needed. The Lambda resolves the secret at runtime, so a new
value is picked up on the next cold start.

## Expiry reminder

The portal reports this itself; nothing is configured and no date is recorded
in CI. GitHub returns the expiry on every authenticated response:

```
github-authentication-token-expiration: 2027-08-14 06:23:04 UTC
```

`githubStore` records that header, and `/docs/process-quality` raises a finding
from 60 days out, escalating to an error inside 14 days or once expired. Because
the value is observed rather than configured, rotating the token updates the
warning on its own.
