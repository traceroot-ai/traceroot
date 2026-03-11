# deploy/terraform/aws/locals.tf

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_region" "current" {}

data "aws_caller_identity" "current" {}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, 2) # 2 AZs (simple)

  # Environment-derived names
  namespace     = "traceroot-${var.environment}"
  database_name = "traceroot_${replace(var.environment, "-", "_")}"
  clickhouse_ns = var.clickhouse_namespace != "" ? var.clickhouse_namespace : local.namespace

  # Ensure the environment namespace is always in the Fargate profile list
  fargate_namespaces = distinct(concat(var.fargate_profile_namespaces, [local.namespace]))

  tags = {
    Project     = var.name
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}
