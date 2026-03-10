# Deploying Traceroot to AWS

Single-command infrastructure provisioning using Terraform + Helm on EKS Fargate.
Follows the [Langfuse AWS Terraform](https://github.com/langfuse/langfuse-terraform-aws) pattern.

## Prerequisites

- AWS CLI configured (`aws configure`)
- Terraform >= 1.5
- Docker (for building images)
- kubectl
- helm

## Step-by-step: First Deploy (from scratch)

### Step 1: Configure

```bash
cd deploy/terraform/aws
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your values (domain, API keys, etc.)
```

### Step 2: Create Route53 zone

Terraform creates a Route53 hosted zone for your domain, but DNS validation
(for the TLS certificate) requires your domain registrar to point NS records
at Route53 BEFORE the full apply. So we create the zone first:

```bash
terraform init
terraform apply --target aws_route53_zone.app
```

This outputs 4 nameservers. Copy them.

### Step 3: Set up DNS delegation

Go to your DNS provider (e.g. Cloudflare) and:

1. Delete any existing records for your domain (e.g. old CNAME to Vercel)
2. Add 4 NS records pointing your domain to the Route53 nameservers from Step 2

Wait for propagation:

```bash
dig staging.traceroot.ai NS
# Should return the 4 Route53 nameservers
```

### Step 4: Build & push Docker images

The Helm chart references private ECR images. Terraform creates the ECR
repositories, but they're empty. The Helm release will fail if images don't
exist (migration jobs run as pre-install hooks and will ImagePullBackOff).

**Build images BEFORE the full terraform apply:**

```bash
# Get your registry URL (from a previous partial apply, or hardcode your account ID)
export REGION=us-east-1
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export REGISTRY=$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com

# Login to ECR
aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $REGISTRY

# From repo root
cd /path/to/traceroot

# Build & push all images (linux/amd64 for Fargate)
for svc in web rest worker billing agent; do
  docker build --platform linux/amd64 -f docker/Dockerfile.$svc -t $REGISTRY/traceroot-$svc:latest .
  docker push $REGISTRY/traceroot-$svc:latest
done

# Migration images
docker build --platform linux/amd64 -f docker/Dockerfile.migrate-postgres -t $REGISTRY/traceroot-migrate-postgres:latest .
docker push $REGISTRY/traceroot-migrate-postgres:latest

docker build --platform linux/amd64 -f docker/Dockerfile.migrate-clickhouse -t $REGISTRY/traceroot-migrate-clickhouse:latest .
docker push $REGISTRY/traceroot-migrate-clickhouse:latest
```

**Note:** The ECR repos must exist before you can push. If this is a truly fresh
deploy, run `terraform apply --target aws_ecr_repository.services` first to
create them.

### Step 5: Full terraform apply

```bash
cd deploy/terraform/aws
terraform apply
```

This creates everything:
- VPC, subnets, NAT gateway
- EKS Fargate cluster
- RDS Aurora Serverless v2 (PostgreSQL)
- ElastiCache (Redis)
- S3 bucket (with IRSA — no static credentials)
- EFS + access points (ClickHouse storage)
- ACM certificate + DNS validation (instant if Step 3 is done)
- Kubernetes secrets (auto-generated passwords + your API keys)
- ALB Load Balancer Controller
- Helm release (ClickHouse, migrations, all app services)
- Route53 A record pointing domain to ALB

Takes ~20 minutes. The ACM cert validation should complete in seconds
(not 60+ minutes) because DNS is already delegated.

### Step 6: Verify

```bash
# Update kubeconfig
aws eks update-kubeconfig --name traceroot --region $REGION

# Check pods
kubectl get pods -n traceroot-staging

# Check ingress
kubectl get ingress -n traceroot-staging

# Hit the app
curl -I https://staging.traceroot.ai
```

## Subsequent Deploys

After the first deploy, you only need:

```bash
# If you changed terraform config
terraform apply

# If you changed app code (rebuild + restart)
docker build --platform linux/amd64 -f docker/Dockerfile.web -t $REGISTRY/traceroot-web:latest .
docker push $REGISTRY/traceroot-web:latest
kubectl rollout restart deployment/traceroot-web -n traceroot-staging
```

Once CI/CD is set up, the build/push/restart is automated on git push.

## Tear Down

```bash
cd deploy/terraform/aws
terraform destroy
```

**Warning:** This deletes everything including the database. Back up first.
