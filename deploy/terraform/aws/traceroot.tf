# deploy/terraform/aws/traceroot.tf
# Helm release for the Traceroot application
# Following Langfuse pattern: all values inline from Terraform outputs

locals {
  app_url = var.domain != "" ? "https://${var.domain}" : ""

  # Core application values
  traceroot_values = <<-EOT
serviceAccount:
  create: true
  name: traceroot
  annotations:
    eks.amazonaws.com/role-arn: ${aws_iam_role.traceroot_irsa.arn}

imagePullPolicy: Always

web:
  image:
    repository: ${aws_ecr_repository.services["web"].repository_url}
    tag: ${var.image_tag}
  replicas: ${var.web_replicas}
  port: 3000
  resources:
    requests:
      cpu: "250m"
      memory: "512Mi"
    limits:
      cpu: "1"
      memory: "1Gi"

rest:
  image:
    repository: ${aws_ecr_repository.services["rest"].repository_url}
    tag: ${var.image_tag}
  replicas: ${var.rest_replicas}
  port: 8000
  resources:
    requests:
      cpu: "250m"
      memory: "512Mi"
    limits:
      cpu: "1"
      memory: "1Gi"

worker:
  image:
    repository: ${aws_ecr_repository.services["worker"].repository_url}
    tag: ${var.image_tag}
  replicas: ${var.worker_replicas}
  resources:
    requests:
      cpu: "250m"
      memory: "512Mi"
    limits:
      cpu: "1"
      memory: "1Gi"

billing:
  image:
    repository: ${aws_ecr_repository.services["billing"].repository_url}
    tag: ${var.image_tag}
  replicas: 1
  resources:
    requests:
      cpu: "128m"
      memory: "256Mi"
    limits:
      cpu: "500m"
      memory: "512Mi"

agent:
  image:
    repository: ${aws_ecr_repository.services["agent"].repository_url}
    tag: ${var.image_tag}
  replicas: 1
  port: 8100
  resources:
    requests:
      cpu: "250m"
      memory: "512Mi"
    limits:
      cpu: "1"
      memory: "1Gi"

migrations:
  postgres:
    image:
      repository: ${aws_ecr_repository.services["migrate-postgres"].repository_url}
      tag: ${var.image_tag}
  clickhouse:
    image:
      repository: ${aws_ecr_repository.services["migrate-clickhouse"].repository_url}
      tag: ${var.image_tag}

nextauth:
  url: "${local.app_url}"

postgresql:
  host: "${aws_rds_cluster.postgres.endpoint}"
  database: "${local.database_name}"
  existingSecret: "traceroot"
  secretKeys:
    databaseUrl: "database-url"
    password: "postgres-password"

redis:
  existingSecret: "traceroot"
  secretKeys:
    url: "redis-url"

s3:
  bucket: "${aws_s3_bucket.traceroot.id}"
  region: "${var.aws_region}"
  endpoint: ""
  forcePathStyle: false

clickhouse:
  deploy: true
  image:
    repository: bitnamilegacy/clickhouse
  auth:
    username: default
    existingSecret: "traceroot"
    existingSecretKey: "clickhouse-password"
  replicaCount: ${var.clickhouse_replica_count}
  shards: 1
  zookeeper:
    enabled: false
  persistence:
    enabled: true
    size: ${var.clickhouse_storage_size}
    storageClass: "efs"

secrets:
  existingSecret: "traceroot"
  keys:
    nextauthSecret: "nextauth-secret"
    internalApiSecret: "internal-api-secret"
    encryptionKey: "encryption-key"
EOT

  # Ingress values - conditional TLS
  ingress_values_https = <<-EOT
ingress:
  enabled: true
  className: alb
  host: "${var.domain}"
  annotations:
    alb.ingress.kubernetes.io/scheme: ${var.alb_scheme}
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTP":80},{"HTTPS":443}]'
    alb.ingress.kubernetes.io/ssl-redirect: "443"
    alb.ingress.kubernetes.io/certificate-arn: "${var.domain != "" ? aws_acm_certificate.app[0].arn : ""}"
EOT

  ingress_values_http = <<-EOT
ingress:
  enabled: true
  className: alb
  host: ""
  annotations:
    alb.ingress.kubernetes.io/scheme: ${var.alb_scheme}
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTP":80}]'
EOT

  ingress_values = var.domain != "" ? local.ingress_values_https : local.ingress_values_http

  # GitHub secret reference (conditional)
  github_values = var.github_app_id != "" ? "github:\n  existingSecret: \"traceroot-github\"" : ""

  # LLM keys secret reference (conditional)
  llm_values = (var.anthropic_api_key != "" || var.openai_api_key != "") ? "llmKeys:\n  existingSecret: \"traceroot-llm-keys\"" : ""

  # Stripe secret reference (conditional)
  stripe_values = var.stripe_secret_key != "" ? "stripe:\n  existingSecret: \"traceroot-stripe\"" : ""

  # Google OAuth secret reference (conditional)
  google_oauth_values = var.google_oauth_client_id != "" ? "googleOAuth:\n  existingSecret: \"traceroot-google-oauth\"" : ""

  # SMTP secret reference (conditional)
  smtp_values = var.smtp_url != "" ? "smtp:\n  existingSecret: \"traceroot-smtp\"" : ""

  # Enterprise license secret reference (conditional)
  enterprise_values = var.enterprise_license_key != "" ? "enterprise:\n  existingSecret: \"traceroot-enterprise\"" : ""

  # Feature flags
  feature_values = "enableBilling: \"${var.enable_billing}\""

  # Additional env vars (escape hatch)
  additional_env_values = length(var.additional_env) == 0 ? "" : <<EOT
additionalEnv:
%{for env in var.additional_env~}
    - name: ${env.name}
%{if env.value != null~}
      value: "${env.value}"
%{endif~}
%{if env.valueFrom != null~}
      valueFrom:
%{if env.valueFrom.secretKeyRef != null~}
        secretKeyRef:
          name: ${env.valueFrom.secretKeyRef.name}
          key: ${env.valueFrom.secretKeyRef.key}
%{endif~}
%{if env.valueFrom.configMapKeyRef != null~}
        configMapKeyRef:
          name: ${env.valueFrom.configMapKeyRef.name}
          key: ${env.valueFrom.configMapKeyRef.key}
%{endif~}
%{endif~}
%{endfor~}
EOT
}

resource "helm_release" "traceroot" {
  name      = "traceroot"
  chart     = var.traceroot_helm_chart_path
  namespace = kubernetes_namespace.app.metadata[0].name

  values = compact([
    local.traceroot_values,
    local.ingress_values,
    local.github_values,
    local.llm_values,
    local.stripe_values,
    local.google_oauth_values,
    local.smtp_values,
    local.enterprise_values,
    local.feature_values,
    local.additional_env_values,
  ])

  # Ensure global.security.allowInsecureImages is set for bitnamilegacy images
  set {
    name  = "global.security.allowInsecureImages"
    value = "true"
  }

  depends_on = [
    kubernetes_namespace.app,
    aws_iam_role.traceroot_irsa,
    aws_iam_role_policy.traceroot_s3_access,
    kubernetes_persistent_volume.clickhouse_data,
    helm_release.aws_lb_controller,
    kubernetes_secret.app,
    kubernetes_storage_class.efs,
    aws_acm_certificate_validation.app,
  ]
}
