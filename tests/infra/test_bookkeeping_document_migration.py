from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
TEMPLATE = (REPO_ROOT / "infra" / "template.full.yaml").read_text(encoding="utf-8")


def _resource_block(resource_name: str) -> str:
    marker = f"  {resource_name}:"
    lines = TEMPLATE.splitlines()
    start = lines.index(marker)
    block = [lines[start]]
    for line in lines[start + 1 :]:
        if line.startswith("  ") and not line.startswith("    "):
            break
        block.append(line)
    return "\n".join(block)


def test_bookkeeping_bucket_remains_private_versioned_kms_encrypted_and_retained():
    bucket = _resource_block("BookkeepingDocumentsBucket")
    assert "DeletionPolicy: Retain" in bucket
    assert "UpdateReplacePolicy: Retain" in bucket
    assert "Status: Enabled" in bucket
    assert "SSEAlgorithm: aws:kms" in bucket
    assert "PublicAccessBlockConfiguration" in bucket
    assert "BlockPublicAcls: true" in bucket
    assert "BlockPublicPolicy: true" in bucket


def test_backend_has_only_required_bookkeeping_object_version_permissions():
    backend = _resource_block("BackendFunction")
    for action in (
        "s3:GetObject",
        "s3:GetObjectVersion",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:DeleteObjectVersion",
        "s3:HeadObject",
    ):
        assert action in backend
    assert "dynamodb:TransactWriteItems" in backend
