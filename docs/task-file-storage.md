# Task file storage

Required file proofs use the private `TaskFilesBucket` declared in the application
stack. The backend receives `TASK_FILES_BUCKET` and
`DATAOPS_FILE_STORAGE_PROVIDER=s3` from that stack. It never creates storage
resources. A missing bucket configuration fails explicitly instead of writing to
the Lambda filesystem.

Each upload gets an immutable, unique object key under `tasks/`, even when the
task and original filename match an earlier upload. File metadata records the
storage provider, object identity, original filename, MIME type, byte count, and
SHA-256 checksum. A metadata-write failure removes the current uploaded object;
a storage-delete failure preserves metadata so the operator can retry.

Uploads and downloads are limited to 4 MiB to fit the Lambda synchronous payload
limit after base64 encoding. Downloads return base64-encoded Lambda responses so
images, PDFs, and other binary proofs survive the HTTP boundary unchanged. The
API requires its normal authenticated actor and serves attachments with private
cache controls; the bucket has no public access.

The bucket is encrypted, versioned, retained on stack replacement/deletion, and
denies non-TLS access. Normal API deletion removes the current object while S3
versioning retains prior versions for recovery. Runtime IAM is scoped to
GetObject, PutObject, and DeleteObject under the task prefix.

Local filesystem storage is available only in explicit development/test modes,
and is always denied in production or Lambda. Tests cover binary round trips,
duplicate filenames, configuration failures, storage-boundary validation,
failed metadata writes, retryable deletions, and required-file task completion.
