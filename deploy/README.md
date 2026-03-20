# Deploying Traceroot to AWS

Single-command infrastructure provisioning using Terraform + Helm on EKS Fargate.

## Multi-Environment Setup

Staging and production use the **same Terraform code** with different configuration:

```
deploy/terraform/aws/
├── terraform.tfvars.example   # template (checked in)
├── staging.tfvars             # staging config (gitignored)
├── production.tfvars          # production config (gitignored)
```

**Terraform workspaces** isolate state per environment — each gets its own VPC, EKS
cluster, RDS, Redis, etc. No shared infrastructure, no shared secrets.

| What differs            | Staging example              | Production example          |
|------------------------|------------------------------|-----------------------------|
| `name`                 | `"traceroot-staging"`        | `"traceroot-prod"`          |
| `environment`          | `"staging"`                  | `"production"`              |
| `domain`               | `"staging.traceroot.ai"`     | `"app.traceroot.ai"`       |
| `image_tag`            | `"latest"`                   | `"sha-abc1234"`             |
| Stripe keys            | test keys (`sk_test_...`)    | live keys (`sk_live_...`)   |
| Replicas               | 1                            | 2+                          |
| Kubernetes namespace   | `traceroot-staging`          | `traceroot-production`      |
| Database name          | `traceroot_staging`          | `traceroot_production`      |

> **Important:** `name` must differ between environments because AWS resources (EKS cluster,
> RDS, ElastiCache, IAM roles, EFS, S3) are named using this prefix and must be globally
> unique within an AWS account.

## Prerequisites

- AWS CLI configured (`aws configure`)
- Terraform >= 1.5
- Docker (for building images)
- kubectl
- helm

## Step-by-step: First Deploy (from scratch)

These steps are the same for staging and production — just swap the workspace name
and tfvars file.

### Step 1: Configure

```bash
cd deploy/terraform/aws

# Create your environment config
cp terraform.tfvars.example staging.tfvars
# Edit staging.tfvars: set environment="staging", domain, API keys, etc.
```

> **Production:** `cp terraform.tfvars.example production.tfvars` and set
> `environment = "production"`, your production domain, live Stripe keys, etc.

### Step 2: Initialize and create workspace

```bash
terraform init

# Create a workspace for this environment
terraform workspace new staging
```

> **Production:** `terraform workspace new production`

### Step 3: Create Route53 zone

Terraform creates a Route53 hosted zone for your domain, but DNS validation
(for the TLS certificate) requires your domain registrar to point NS records
at Route53 BEFORE the full apply. So we create the zone first:

```bash
terraform apply -var-file=staging.tfvars --target aws_route53_zone.app
```

This outputs 4 nameservers. Copy them.

> **Production:** `terraform apply -var-file=production.tfvars --target aws_route53_zone.app`

### Step 4: Set up DNS delegation

Go to your DNS provider (e.g. Cloudflare) and:

1. Add NS records pointing your subdomain to the Route53 nameservers from Step 3
2. Delete any conflicting records (e.g. old CNAME to Vercel)

Wait for propagation:

```bash
dig staging.traceroot.ai NS
# Should return the 4 Route53 nameservers
```

### Step 5: Build & push Docker images

The Helm chart references private ECR images. Terraform creates the ECR
repositories, but they're empty. The Helm release will fail if images don't
exist (migration jobs run as pre-install hooks and will ImagePullBackOff).

**Create ECR repos first (if fresh deploy):**

```bash
terraform apply -var-file=staging.tfvars --target aws_ecr_repository.services
```

**Build and push all images:**

```bash
export REGION=us-east-1
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export REGISTRY=$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com
export TAG=$(git rev-parse --short HEAD)

# Login to ECR
aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $REGISTRY

# From repo root — build & push all images (linux/amd64 for Fargate)
for svc in web rest worker billing agent; do
  docker build --platform linux/amd64 -f docker/Dockerfile.$svc -t $REGISTRY/traceroot-$svc:$TAG .
  docker push $REGISTRY/traceroot-$svc:$TAG
done

# Migration images
for svc in migrate-postgres migrate-clickhouse; do
  docker build --platform linux/amd64 -f docker/Dockerfile.$svc -t $REGISTRY/traceroot-$svc:$TAG .
  docker push $REGISTRY/traceroot-$svc:$TAG
done
```

> **Tip:** Set `image_tag` in your tfvars to match `$TAG` (e.g. `image_tag = "sha-abc1234"`).

### Step 6: Full terraform apply

```bash
terraform apply -var-file=staging.tfvars
```

This creates everything:
- VPC, subnets, NAT gateway
- EKS Fargate cluster
- RDS Aurora Serverless v2 (PostgreSQL)
- ElastiCache (Redis)
- S3 bucket (with IRSA — no static credentials)
- EFS + access points (ClickHouse storage)
- ACM certificate + DNS validation (instant if Step 4 is done)
- Kubernetes secrets (auto-generated passwords + your API keys)
- ALB Load Balancer Controller
- Helm release (ClickHouse, migrations, all app services)
- Route53 A record pointing domain to ALB

Takes ~20 minutes. The ACM cert validation should complete in seconds
(not 60+ minutes) because DNS is already delegated.

> **Production:** `terraform apply -var-file=production.tfvars`

### Step 7: Verify

```bash
# Update kubeconfig
aws eks update-kubeconfig --name traceroot --region $REGION

# Check pods (namespace matches your environment)
kubectl get pods -n traceroot-staging

# Check ingress
kubectl get ingress -n traceroot-staging

# Hit the app
curl -I https://staging.traceroot.ai
```

> **Production:** Replace `traceroot-staging` with `traceroot-production`
> and the domain with your production URL.

## Subsequent Deploys

After the first deploy, you only need:

```bash
# Switch to the right workspace
terraform workspace select staging  # or: production

# If you changed terraform config
terraform apply -var-file=staging.tfvars

# If you changed app code — rebuild with git SHA tag
export TAG=sha-$(git rev-parse --short HEAD)

for svc in web rest worker billing agent migrate-postgres migrate-clickhouse; do
  docker build --platform linux/amd64 -f docker/Dockerfile.$svc -t $REGISTRY/traceroot-$svc:$TAG .
  docker push $REGISTRY/traceroot-$svc:$TAG
done

# Edit staging.tfvars: image_tag = "sha-<TAG>"
terraform apply -var-file=staging.tfvars
```

Once CI/CD is set up, the build/push/apply is automated on git push.

## Switching Between Environments

```bash
# List workspaces
terraform workspace list

# Always use the matching tfvars file!
terraform workspace select staging  && terraform apply -var-file=staging.tfvars
terraform workspace select production && terraform apply -var-file=production.tfvars
```

## Tear Down

```bash
terraform workspace select staging  # or: production

# 1. Destroy everything (including Route53 zone)
terraform destroy -var-file=staging.tfvars

# --- rebuild images, update image_tag in tfvars (see Subsequent Deploys above) ---

# 2. Full apply — creates a new Route53 zone with new nameservers
terraform apply -var-file=staging.tfvars
```

> **Production:** replace `staging.tfvars` accordingly.

**Warning:** Destroying recreates the Route53 zone with new nameservers. After apply,
update your DNS registrar (e.g. Cloudflare) with the new nameservers shown in the
`nameservers` output. The `terraform import` approach to preserve nameservers does NOT
work reliably because the kubernetes/helm providers need a known EKS endpoint at plan
time (empty state = unknown values).

Each workspace is independent — destroying staging does not affect production.
