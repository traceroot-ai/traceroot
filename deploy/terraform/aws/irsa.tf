# deploy/terraform/aws/irsa.tf
# IRSA (IAM Roles for Service Accounts) for application pods to access S3
# Following Langfuse pattern: pods assume IAM role via annotated ServiceAccount

# IRSA role for traceroot application pods
resource "aws_iam_role" "traceroot_irsa" {
  name = "${var.name}-app"
  path = "/kubernetes/"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRoleWithWebIdentity"
        Effect = "Allow"
        Principal = {
          Federated = module.eks.oidc_provider_arn
        }
        Condition = {
          StringLike = {
            "${module.eks.oidc_provider}:sub" = "system:serviceaccount:traceroot-*:traceroot"
            "${module.eks.oidc_provider}:aud" = "sts.amazonaws.com"
          }
        }
      }
    ]
  })

  tags = local.tags
}

# S3 access policy for the IRSA role
resource "aws_iam_role_policy" "traceroot_s3_access" {
  name = "s3-access"
  role = aws_iam_role.traceroot_irsa.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:ListBucket",
          "s3:DeleteObject"
        ]
        Resource = [
          aws_s3_bucket.traceroot.arn,
          "${aws_s3_bucket.traceroot.arn}/*"
        ]
      }
    ]
  })
}
