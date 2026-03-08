# deploy/terraform/aws/ecr.tf

locals {
  services = ["web", "rest", "worker", "billing", "agent", "migrate-clickhouse", "migrate-postgres"]
}

resource "aws_ecr_repository" "services" {
  for_each = toset(local.services)

  name                 = "${var.name}-${each.key}"
  image_tag_mutability = "MUTABLE"
  force_delete         = true # Simple for now

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = local.tags
}

# Auto-delete old images (keep last 10)
resource "aws_ecr_lifecycle_policy" "services" {
  for_each   = aws_ecr_repository.services
  repository = each.value.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last 10 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}
