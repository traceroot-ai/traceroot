# terraform/aws/secrets.tf

resource "random_password" "nextauth_secret" {
  length  = 64
  special = false
}

resource "random_password" "internal_api_secret" {
  length  = 32
  special = false
}

resource "random_password" "clickhouse" {
  length  = 32
  special = false
}

# Create namespaces
resource "kubernetes_namespace" "staging" {
  metadata { name = "traceroot-staging" }
  depends_on = [module.eks]
}

resource "kubernetes_namespace" "production" {
  metadata { name = "traceroot-production" }
  depends_on = [module.eks]
}

# Staging secrets
resource "kubernetes_secret" "staging" {
  metadata {
    name      = "traceroot"
    namespace = kubernetes_namespace.staging.metadata[0].name
  }

  data = {
    "postgres-password"   = random_password.postgres.result
    "redis-password"      = random_password.redis.result
    "nextauth-secret"     = random_password.nextauth_secret.result
    "internal-api-secret" = random_password.internal_api_secret.result
    "clickhouse-password" = random_password.clickhouse.result
    "database-url"        = "postgresql://traceroot:${random_password.postgres.result}@${aws_rds_cluster.postgres.endpoint}:5432/traceroot_staging"
    "redis-url"           = "rediss://:${random_password.redis.result}@${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379/0"
  }

  depends_on = [module.eks]
}

# Production secrets (same passwords, different database name)
resource "kubernetes_secret" "production" {
  metadata {
    name      = "traceroot"
    namespace = kubernetes_namespace.production.metadata[0].name
  }

  data = {
    "postgres-password"   = random_password.postgres.result
    "redis-password"      = random_password.redis.result
    "nextauth-secret"     = random_password.nextauth_secret.result
    "internal-api-secret" = random_password.internal_api_secret.result
    "clickhouse-password" = random_password.clickhouse.result
    "database-url"        = "postgresql://traceroot:${random_password.postgres.result}@${aws_rds_cluster.postgres.endpoint}:5432/traceroot_production"
    "redis-url"           = "rediss://:${random_password.redis.result}@${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379/0"
  }

  depends_on = [module.eks]
}
