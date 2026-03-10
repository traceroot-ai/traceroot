# deploy/terraform/aws/outputs.tf

output "aws_region" {
  description = "AWS region"
  value       = var.aws_region
}

output "cluster_name" {
  description = "EKS cluster name"
  value       = module.eks.cluster_name
}

output "cluster_endpoint" {
  description = "EKS cluster endpoint"
  value       = module.eks.cluster_endpoint
}

output "ecr_repositories" {
  description = "ECR repository URLs"
  value = {
    web     = aws_ecr_repository.services["web"].repository_url
    rest    = aws_ecr_repository.services["rest"].repository_url
    worker  = aws_ecr_repository.services["worker"].repository_url
    billing = aws_ecr_repository.services["billing"].repository_url
    agent              = aws_ecr_repository.services["agent"].repository_url
    migrate-postgres   = aws_ecr_repository.services["migrate-postgres"].repository_url
    migrate-clickhouse = aws_ecr_repository.services["migrate-clickhouse"].repository_url
  }
}

output "rds_endpoint" {
  description = "RDS cluster endpoint"
  value       = aws_rds_cluster.postgres.endpoint
}

output "redis_endpoint" {
  description = "ElastiCache endpoint"
  value       = aws_elasticache_replication_group.redis.primary_endpoint_address
}

output "s3_bucket" {
  description = "S3 bucket name"
  value       = aws_s3_bucket.traceroot.id
}

# EFS for ClickHouse storage (static provisioning - no CSI controller needed)
output "efs_file_system_id" {
  description = "EFS file system ID for ClickHouse storage"
  value       = aws_efs_file_system.traceroot.id
}

output "clickhouse_pv_names" {
  description = "Pre-provisioned PersistentVolume names for ClickHouse"
  value       = [for pv in kubernetes_persistent_volume.clickhouse_data : pv.metadata[0].name]
}

output "irsa_role_arn" {
  description = "IRSA role ARN for application pods (S3 access)"
  value       = aws_iam_role.traceroot_irsa.arn
}

output "app_url" {
  description = "Application URL (custom domain or ALB)"
  value       = var.domain != "" ? "https://${var.domain}" : "See ALB URL via: kubectl get ingress -n traceroot-staging"
}

output "nameservers" {
  description = "Route53 nameservers — point your domain registrar here"
  value       = var.domain != "" ? aws_route53_zone.app[0].name_servers : []
}

output "helm_release_status" {
  description = "Helm release status"
  value       = helm_release.traceroot.status
}
