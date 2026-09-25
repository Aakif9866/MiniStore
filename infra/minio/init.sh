#!/bin/sh
# Bootstraps MinIO for MiniStore. Idempotent: running it twice changes nothing.
set -eu

mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
mc ready local

# 1. The bucket. Private by default — no anonymous access.
mc mb --ignore-existing "local/$MINIO_BUCKET"

# 2. An IAM policy that only allows what the backend needs, only on this bucket.
#    ARN format: arn:aws:s3:::<bucket> is the bucket itself, <bucket>/* is every object in it.
cat > /tmp/ministore-app.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetBucketLocation", "s3:ListBucket", "s3:ListBucketMultipartUploads"],
      "Resource": ["arn:aws:s3:::$MINIO_BUCKET"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject",
                 "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
      "Resource": ["arn:aws:s3:::$MINIO_BUCKET/*"]
    }
  ]
}
EOF
mc admin policy create local ministore-app /tmp/ministore-app.json

# 3. The backend's own credentials, with that policy attached. The backend never gets root keys.
mc admin user add local "$MINIO_APP_ACCESS_KEY" "$MINIO_APP_SECRET_KEY"
mc admin policy attach local ministore-app --user "$MINIO_APP_ACCESS_KEY"

echo "MinIO ready: bucket=$MINIO_BUCKET app-user=$MINIO_APP_ACCESS_KEY"
