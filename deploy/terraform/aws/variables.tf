# deploy/terraform/aws/variables.tf

variable "name" {
  description = "Name prefix for all resources"
  type        = string
  default     = "traceroot"
}

variable "aws_region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "us-east-1"
}

# --- VPC ---
variable "vpc_cidr" {
  description = "CIDR block for VPC"
  type        = string
  default     = "10.0.0.0/16"
}

# --- EKS ---
variable "kubernetes_version" {
  description = "Kubernetes version for EKS"
  type        = string
  default     = "1.32"
}

variable "fargate_profile_namespaces" {
  description = "Namespaces for Fargate profiles"
  type        = list(string)
  default     = ["kube-system", "traceroot-staging", "traceroot-production", "default"]
}

# --- RDS ---
variable "postgres_min_capacity" {
  description = "Aurora Serverless v2 minimum ACUs"
  type        = number
  default     = 0.5
}

variable "postgres_max_capacity" {
  description = "Aurora Serverless v2 maximum ACUs"
  type        = number
  default     = 2.0
}

# --- ElastiCache ---
variable "cache_node_type" {
  description = "ElastiCache node type"
  type        = string
  default     = "cache.t4g.micro"
}

# --- Helm ---
variable "traceroot_helm_chart_path" {
  description = "Path to the Traceroot Helm chart"
  type        = string
  default     = "../../helm"
}

# --- ClickHouse (EFS storage) ---
variable "clickhouse_replica_count" {
  description = "Number of ClickHouse replicas (each gets a separate EFS access point)"
  type        = number
  default     = 1
}

variable "clickhouse_storage_size" {
  description = "Storage size for each ClickHouse replica"
  type        = string
  default     = "20Gi"
}

variable "clickhouse_namespace" {
  description = "Kubernetes namespace where ClickHouse will be deployed"
  type        = string
  default     = "traceroot-staging"
}

# --- Custom Domain + TLS ---
variable "domain" {
  description = "Custom domain for the app (e.g. app.traceroot.ai). Empty = use ALB URL."
  type        = string
  default     = ""
}


# --- GitHub App ---
variable "github_app_id" {
  description = "GitHub App ID"
  type        = string
  default     = ""
}

variable "github_app_name" {
  description = "GitHub App name"
  type        = string
  default     = ""
}

variable "github_app_client_id" {
  description = "GitHub App Client ID"
  type        = string
  default     = ""
}

variable "github_app_client_secret" {
  description = "GitHub App Client Secret"
  type        = string
  sensitive   = true
  default     = ""
}

variable "github_app_private_key" {
  description = "GitHub App Private Key (PEM format)"
  type        = string
  sensitive   = true
  default     = ""
}

# --- LLM API Keys ---
variable "anthropic_api_key" {
  description = "Anthropic API key for system-provided models"
  type        = string
  sensitive   = true
  default     = ""
}

variable "openai_api_key" {
  description = "OpenAI API key for system-provided models"
  type        = string
  sensitive   = true
  default     = ""
}

variable "daytona_api_key" {
  description = "Daytona API key for sandbox execution"
  type        = string
  sensitive   = true
  default     = ""
}

# --- Stripe Billing ---
variable "stripe_secret_key" {
  description = "Stripe secret key"
  type        = string
  sensitive   = true
  default     = ""
}

variable "stripe_webhook_signing_secret" {
  description = "Stripe webhook signing secret"
  type        = string
  sensitive   = true
  default     = ""
}

variable "stripe_price_id_starter" {
  description = "Stripe price ID for Starter plan"
  type        = string
  default     = ""
}

variable "stripe_price_id_pro" {
  description = "Stripe price ID for Pro plan"
  type        = string
  default     = ""
}

variable "stripe_price_id_startups" {
  description = "Stripe price ID for Startups plan"
  type        = string
  default     = ""
}

variable "stripe_price_id_ai_usage" {
  description = "Stripe price ID for AI usage metering"
  type        = string
  default     = ""
}

# --- Google OAuth ---
variable "google_oauth_client_id" {
  description = "Google OAuth client ID"
  type        = string
  default     = ""
}

variable "google_oauth_client_secret" {
  description = "Google OAuth client secret"
  type        = string
  sensitive   = true
  default     = ""
}

# --- Email / SMTP ---
variable "smtp_url" {
  description = "SMTP URL (e.g. smtp://user:pass@host:port)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "smtp_mail_from" {
  description = "SMTP sender email address"
  type        = string
  default     = ""
}

# --- Enterprise License ---
variable "enterprise_license_key" {
  description = "Enterprise edition license key"
  type        = string
  sensitive   = true
  default     = ""
}

# --- Feature Flags ---
variable "enable_billing" {
  description = "Enable billing features (set false for self-hosted to unlock all features)"
  type        = string
  default     = "true"
}

# --- Replicas ---
variable "web_replicas" {
  description = "Number of web replicas"
  type        = number
  default     = 1
}

variable "rest_replicas" {
  description = "Number of REST API replicas"
  type        = number
  default     = 1
}

variable "worker_replicas" {
  description = "Number of Celery worker replicas"
  type        = number
  default     = 1
}

# --- ALB ---
variable "alb_scheme" {
  description = "ALB scheme: internet-facing or internal"
  type        = string
  default     = "internet-facing"
}

# --- Additional environment variables ---
# Catch-all for any env vars not covered above (Google OAuth, SMTP, Stripe, etc.)
# Following Langfuse pattern: each entry has either `value` (plain text) or `valueFrom` (secret ref).
#
# Example usage in terraform.tfvars:
#   additional_env = [
#     { name = "AUTH_GOOGLE_CLIENT_ID",     value = "123456.apps.googleusercontent.com" },
#     { name = "ENABLE_BILLING",            value = "true" },
#     { name = "STRIPE_SECRET_KEY", valueFrom = {
#       secretKeyRef = { name = "my-stripe-secret", key = "secret-key" }
#     }},
#   ]
variable "additional_env" {
  description = "Additional environment variables for all Traceroot pods"
  type = list(object({
    name  = string
    value = optional(string)
    valueFrom = optional(object({
      secretKeyRef = optional(object({
        name = string
        key  = string
      }))
      configMapKeyRef = optional(object({
        name = string
        key  = string
      }))
    }))
  }))
  default = []

  validation {
    condition = alltrue([
      for env in var.additional_env :
      (env.value != null && env.valueFrom == null) || (env.value == null && env.valueFrom != null)
    ])
    error_message = "Each environment variable must have either 'value' or 'valueFrom' specified, but not both."
  }
}
