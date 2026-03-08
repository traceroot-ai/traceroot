# deploy/terraform/aws/main.tf

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.tags
  }
}
