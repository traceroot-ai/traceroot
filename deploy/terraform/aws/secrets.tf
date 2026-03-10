# deploy/terraform/aws/secrets.tf

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

resource "random_id" "encryption_key" {
  byte_length = 32 # 32 bytes = 64 hex characters = 256 bits
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
    "redis-url"           = "rediss://:${random_password.redis.result}@${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379/0?ssl_cert_reqs=CERT_REQUIRED"
    "encryption-key"      = random_id.encryption_key.hex
  }

  depends_on = [module.eks]
}

# GitHub App secret (conditional — only if github_app_id is provided)
resource "kubernetes_secret" "staging_github" {
  count = var.github_app_id != "" ? 1 : 0

  metadata {
    name      = "traceroot-github"
    namespace = kubernetes_namespace.staging.metadata[0].name
  }

  data = {
    "github-app-id"             = var.github_app_id
    "github-app-name"           = var.github_app_name
    "github-app-client-id"      = var.github_app_client_id
    "github-app-client-secret"  = var.github_app_client_secret
    "github-app-private-key"    = var.github_app_private_key
    "github-oauth-redirect-uri" = var.domain != "" ? "https://${var.domain}/api/github/callback" : ""
  }

  depends_on = [module.eks]
}

# LLM API keys secret (conditional — only if any key is provided)
resource "kubernetes_secret" "staging_llm_keys" {
  count = var.anthropic_api_key != "" || var.openai_api_key != "" ? 1 : 0

  metadata {
    name      = "traceroot-llm-keys"
    namespace = kubernetes_namespace.staging.metadata[0].name
  }

  data = {
    "anthropic-api-key" = var.anthropic_api_key
    "openai-api-key"    = var.openai_api_key
    "daytona-api-key"   = var.daytona_api_key
  }

  depends_on = [module.eks]
}

# Stripe secret (conditional)
resource "kubernetes_secret" "staging_stripe" {
  count = var.stripe_secret_key != "" ? 1 : 0

  metadata {
    name      = "traceroot-stripe"
    namespace = kubernetes_namespace.staging.metadata[0].name
  }

  data = {
    "stripe-secret-key"             = var.stripe_secret_key
    "stripe-webhook-signing-secret" = var.stripe_webhook_signing_secret
    "stripe-price-id-starter"       = var.stripe_price_id_starter
    "stripe-price-id-pro"           = var.stripe_price_id_pro
    "stripe-price-id-startups"      = var.stripe_price_id_startups
  }

  depends_on = [module.eks]
}

# Google OAuth secret (conditional)
resource "kubernetes_secret" "staging_google_oauth" {
  count = var.google_oauth_client_id != "" ? 1 : 0

  metadata {
    name      = "traceroot-google-oauth"
    namespace = kubernetes_namespace.staging.metadata[0].name
  }

  data = {
    "google-client-id"     = var.google_oauth_client_id
    "google-client-secret" = var.google_oauth_client_secret
  }

  depends_on = [module.eks]
}

# SMTP secret (conditional)
resource "kubernetes_secret" "staging_smtp" {
  count = var.smtp_url != "" ? 1 : 0

  metadata {
    name      = "traceroot-smtp"
    namespace = kubernetes_namespace.staging.metadata[0].name
  }

  data = {
    "smtp-url"       = var.smtp_url
    "smtp-mail-from" = var.smtp_mail_from
  }

  depends_on = [module.eks]
}

# Enterprise license secret (conditional)
resource "kubernetes_secret" "staging_enterprise" {
  count = var.enterprise_license_key != "" ? 1 : 0

  metadata {
    name      = "traceroot-enterprise"
    namespace = kubernetes_namespace.staging.metadata[0].name
  }

  data = {
    "ee-license-key" = var.enterprise_license_key
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
    "redis-url"           = "rediss://:${random_password.redis.result}@${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379/0?ssl_cert_reqs=CERT_REQUIRED"
    "encryption-key"      = random_id.encryption_key.hex
  }

  depends_on = [module.eks]
}

# Production GitHub App secret
resource "kubernetes_secret" "production_github" {
  count = var.github_app_id != "" ? 1 : 0

  metadata {
    name      = "traceroot-github"
    namespace = kubernetes_namespace.production.metadata[0].name
  }

  data = {
    "github-app-id"             = var.github_app_id
    "github-app-name"           = var.github_app_name
    "github-app-client-id"      = var.github_app_client_id
    "github-app-client-secret"  = var.github_app_client_secret
    "github-app-private-key"    = var.github_app_private_key
    "github-oauth-redirect-uri" = var.domain != "" ? "https://${var.domain}/api/github/callback" : ""
  }

  depends_on = [module.eks]
}

# Production Stripe secret
resource "kubernetes_secret" "production_stripe" {
  count = var.stripe_secret_key != "" ? 1 : 0

  metadata {
    name      = "traceroot-stripe"
    namespace = kubernetes_namespace.production.metadata[0].name
  }

  data = {
    "stripe-secret-key"             = var.stripe_secret_key
    "stripe-webhook-signing-secret" = var.stripe_webhook_signing_secret
    "stripe-price-id-starter"       = var.stripe_price_id_starter
    "stripe-price-id-pro"           = var.stripe_price_id_pro
    "stripe-price-id-startups"      = var.stripe_price_id_startups
  }

  depends_on = [module.eks]
}

# Production Google OAuth secret
resource "kubernetes_secret" "production_google_oauth" {
  count = var.google_oauth_client_id != "" ? 1 : 0

  metadata {
    name      = "traceroot-google-oauth"
    namespace = kubernetes_namespace.production.metadata[0].name
  }

  data = {
    "google-client-id"     = var.google_oauth_client_id
    "google-client-secret" = var.google_oauth_client_secret
  }

  depends_on = [module.eks]
}

# Production SMTP secret
resource "kubernetes_secret" "production_smtp" {
  count = var.smtp_url != "" ? 1 : 0

  metadata {
    name      = "traceroot-smtp"
    namespace = kubernetes_namespace.production.metadata[0].name
  }

  data = {
    "smtp-url"       = var.smtp_url
    "smtp-mail-from" = var.smtp_mail_from
  }

  depends_on = [module.eks]
}

# Production Enterprise license secret
resource "kubernetes_secret" "production_enterprise" {
  count = var.enterprise_license_key != "" ? 1 : 0

  metadata {
    name      = "traceroot-enterprise"
    namespace = kubernetes_namespace.production.metadata[0].name
  }

  data = {
    "ee-license-key" = var.enterprise_license_key
  }

  depends_on = [module.eks]
}

# Production LLM API keys secret
resource "kubernetes_secret" "production_llm_keys" {
  count = var.anthropic_api_key != "" || var.openai_api_key != "" ? 1 : 0

  metadata {
    name      = "traceroot-llm-keys"
    namespace = kubernetes_namespace.production.metadata[0].name
  }

  data = {
    "anthropic-api-key" = var.anthropic_api_key
    "openai-api-key"    = var.openai_api_key
    "daytona-api-key"   = var.daytona_api_key
  }

  depends_on = [module.eks]
}
