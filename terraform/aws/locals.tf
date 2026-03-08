# terraform/aws/locals.tf

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_region" "current" {}

data "aws_caller_identity" "current" {}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, 2) # 2 AZs (simple)

  tags = {
    Project   = var.name
    ManagedBy = "terraform"
  }
}
