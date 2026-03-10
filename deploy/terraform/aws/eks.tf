# deploy/terraform/aws/eks.tf

module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.0"

  cluster_name    = var.name
  cluster_version = var.kubernetes_version

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  # Public endpoint for kubectl access
  cluster_endpoint_public_access = true

  # Grant cluster creator admin access (required for kubectl)
  enable_cluster_creator_admin_permissions = true

  # Fargate profiles — no EC2 nodes to manage
  fargate_profiles = {
    for ns in var.fargate_profile_namespaces : ns => {
      selectors = [{ namespace = ns }]
    }
  }

  # EKS add-ons
  # EFS CSI driver: controller runs on Fargate, node DaemonSet won't schedule (no EC2 nodes).
  # That's fine — we use static provisioning (pre-created PVs in efs.tf) so only the
  # controller + CSI driver registration is needed. Fargate handles the actual EFS mount.
  cluster_addons = {
    coredns = {
      configuration_values = jsonencode({
        computeType = "Fargate"
      })
    }
    kube-proxy             = {}
    vpc-cni                = {}
    eks-pod-identity-agent = {}
    # aws-efs-csi-driver removed — Fargate DaemonSet incompatible.
    # Install via Helm with node.enabled=false instead (Step 4).
  }

  tags = local.tags
}

# Attach ECR pull policy to all Fargate pod execution roles
# Fargate default role only allows public ECR, we need private ECR access
resource "aws_iam_role_policy_attachment" "fargate_ecr" {
  for_each   = module.eks.fargate_profiles
  role       = each.value.iam_role_name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

# Configure kubectl access
provider "kubernetes" {
  host                   = module.eks.cluster_endpoint
  cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)

  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "aws"
    args        = ["eks", "get-token", "--cluster-name", module.eks.cluster_name]
  }
}

provider "helm" {
  kubernetes {
    host                   = module.eks.cluster_endpoint
    cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)

    exec {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "aws"
      args        = ["eks", "get-token", "--cluster-name", module.eks.cluster_name]
    }
  }
}
