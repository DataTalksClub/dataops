# scripts

Repository-local scripts for the private knowledge repository.

Current scaffolded script:

- `backup_to_s3.py` - creates a Git archive zip, a full Git bundle, a manifest,
  and checksums, then uploads them to private S3 only when the current commit
  differs from the latest uploaded backup manifest.

Dry-run from the repository root:

```bash
python scripts/backup_to_s3.py --dry-run
```

Production use is through `.github/workflows/backup-to-s3.yml` after the
private repository has AWS OIDC variables configured.
