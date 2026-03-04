# terraform/aws/variables.tf

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
