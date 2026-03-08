# deploy/terraform/aws/examples/quickstart/main.tf
#
# Minimal example to deploy Traceroot on AWS.
#
# Usage:
#   cd terraform/aws
#   cp terraform.tfvars.example terraform.tfvars
#   # Edit terraform.tfvars with your settings
#   terraform init
#   terraform plan
#   terraform apply
# This example uses the root module directly.
# In production, you would reference it as a module source.
