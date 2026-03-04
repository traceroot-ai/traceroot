# terraform/aws/s3.tf

resource "aws_s3_bucket" "traceroot" {
  bucket_prefix = "${var.name}-"
  tags          = local.tags
}

resource "aws_s3_bucket_versioning" "traceroot" {
  bucket = aws_s3_bucket.traceroot.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "traceroot" {
  bucket = aws_s3_bucket.traceroot.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "traceroot" {
  bucket                  = aws_s3_bucket.traceroot.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
