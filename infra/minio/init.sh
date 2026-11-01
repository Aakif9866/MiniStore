#!/bin/sh
# Bootstraps MinIO for MiniStore. Idempotent: running it twice changes nothing.
set -eu

mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
mc ready local

TEST_BUCKET="$MINIO_BUCKET-test" # tests get their own bucket: their cleanup must never touch real data

for b in "$MINIO_BUCKET" "$TEST_BUCKET"; do
  # 1. The bucket. Private by default — no anonymous access.
  mc mb --ignore-existing "local/$b"

  # 1b. Versioning (Phase 6): every overwrite keeps the previous bytes as a "noncurrent" version,
  #     and a plain DELETE only adds a delete marker. Once enabled it can be suspended, never removed.
  mc version enable "local/$b"

  # 1c. Lifecycle (Phase 7). Only for things Postgres does NOT track — anything Postgres tracks is
  #     expired by the app, or rows would point at deleted bytes. Import replaces the whole config,
  #     so re-running is idempotent. (Abandoned multipart uploads: MinIO removes them itself after
  #     24h — `stale_uploads_expiry` — and rejects the AbortIncompleteMultipartUpload rule.)
  echo '{"Rules":[{"ID":"expire-orphan-delete-markers","Status":"Enabled","Filter":{"Prefix":""},
    "Expiration":{"ExpiredObjectDeleteMarker":true}}]}' | mc ilm rule import "local/$b" >/dev/null
done

# 2. An IAM policy that only allows what the backend needs, only on this bucket.
#    ARN format: arn:aws:s3:::<bucket> is the bucket itself, <bucket>/* is every object in it.
cat > /tmp/ministore-app.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetBucketLocation", "s3:ListBucket", "s3:ListBucketMultipartUploads",
                 "s3:ListBucketVersions"],
      "Resource": ["arn:aws:s3:::$MINIO_BUCKET", "arn:aws:s3:::$TEST_BUCKET"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject",
                 "s3:GetObjectVersion", "s3:DeleteObjectVersion",
                 "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
      "Resource": ["arn:aws:s3:::$MINIO_BUCKET/*", "arn:aws:s3:::$TEST_BUCKET/*"]
    }
  ]
}
EOF
mc admin policy create local ministore-app /tmp/ministore-app.json

# 3. The backend's own credentials, with that policy attached. The backend never gets root keys.
mc admin user add local "$MINIO_APP_ACCESS_KEY" "$MINIO_APP_SECRET_KEY"
mc admin policy attach local ministore-app --user "$MINIO_APP_ACCESS_KEY"

echo "MinIO ready: buckets=$MINIO_BUCKET,$TEST_BUCKET app-user=$MINIO_APP_ACCESS_KEY"
