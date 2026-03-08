# deploy/terraform/aws/vpc.tf

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"

  name = "${var.name}-vpc"
  cidr = var.vpc_cidr

  azs             = local.azs
  private_subnets = [for k, v in local.azs : cidrsubnet(var.vpc_cidr, 4, k)]
  public_subnets  = [for k, v in local.azs : cidrsubnet(var.vpc_cidr, 8, k + 48)]

  enable_nat_gateway = true
  single_nat_gateway = true # Simple: single NAT to save cost

  # Required tags for EKS ALB discovery
  public_subnet_tags = {
    "kubernetes.io/role/elb" = 1
  }
  private_subnet_tags = {
    "kubernetes.io/role/internal-elb" = 1
  }

  tags = local.tags
}

# VPC Endpoints required for Fargate IRSA and S3 access

# STS endpoint — required for Fargate pods to assume IRSA roles
resource "aws_security_group" "vpc_endpoints" {
  name_prefix = "${var.name}-vpc-endpoints-"
  description = "Security group for VPC endpoints"
  vpc_id      = module.vpc.vpc_id

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  tags = local.tags
}

resource "aws_vpc_endpoint" "sts" {
  vpc_id             = module.vpc.vpc_id
  service_name       = "com.amazonaws.${data.aws_region.current.name}.sts"
  vpc_endpoint_type  = "Interface"
  subnet_ids         = module.vpc.private_subnets
  security_group_ids = [aws_security_group.vpc_endpoints.id]

  private_dns_enabled = true

  tags = merge(local.tags, {
    Name = "${var.name}-sts-endpoint"
  })
}

# S3 gateway endpoint — free, faster S3 access from private subnets
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = module.vpc.vpc_id
  service_name      = "com.amazonaws.${data.aws_region.current.name}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = module.vpc.private_route_table_ids

  tags = merge(local.tags, {
    Name = "${var.name}-s3-endpoint"
  })
}
