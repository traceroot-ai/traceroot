# terraform/aws/outputs.tf

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
    agent   = aws_ecr_repository.services["agent"].repository_url
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
