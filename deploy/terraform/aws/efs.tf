# deploy/terraform/aws/efs.tf
# EFS for ClickHouse persistent storage on Fargate

resource "aws_efs_file_system" "traceroot" {
  creation_token  = "${var.name}-efs"
  encrypted       = true
  throughput_mode = "elastic"

  tags = merge(local.tags, {
    Name = "${var.name}-efs"
  })
}

# Mount targets in each private subnet
resource "aws_efs_mount_target" "eks" {
  count           = length(module.vpc.private_subnets)
  file_system_id  = aws_efs_file_system.traceroot.id
  subnet_id       = module.vpc.private_subnets[count.index]
  security_groups = [aws_security_group.efs.id]
}

# Security group for EFS
resource "aws_security_group" "efs" {
  name_prefix = "${var.name}-efs-"
  description = "Security group for EFS"
  vpc_id      = module.vpc.vpc_id

  ingress {
    description = "NFS from VPC"
    from_port   = 2049
    to_port     = 2049
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.tags, {
    Name = "${var.name}-efs"
  })
}

# EFS CSI Driver IAM Policy
resource "aws_iam_policy" "efs" {
  name = "${var.name}-efs"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "elasticfilesystem:DescribeAccessPoints",
          "elasticfilesystem:DescribeFileSystems",
          "elasticfilesystem:DescribeMountTargets",
          "ec2:DescribeAvailabilityZones"
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "elasticfilesystem:CreateAccessPoint"
        ]
        Resource = "*"
        Condition = {
          StringLike = {
            "aws:RequestTag/efs.csi.aws.com/cluster" = "true"
          }
        }
      },
      {
        Effect   = "Allow"
        Action   = "elasticfilesystem:DeleteAccessPoint"
        Resource = "*"
        Condition = {
          StringLike = {
            "aws:ResourceTag/efs.csi.aws.com/cluster" = "true"
          }
        }
      }
    ]
  })

  tags = local.tags
}

# EFS CSI Driver IAM Role (IRSA)
resource "aws_iam_role" "efs" {
  name = "${var.name}-efs-csi"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = module.eks.oidc_provider_arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "${module.eks.oidc_provider}:sub" = "system:serviceaccount:kube-system:efs-csi-controller-sa"
          }
        }
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "efs" {
  policy_arn = aws_iam_policy.efs.arn
  role       = aws_iam_role.efs.name
}

# StorageClass for EFS (used by ClickHouse PVC)
resource "kubernetes_storage_class" "efs" {
  metadata {
    name = "efs"
  }
  storage_provisioner = "efs.csi.aws.com"
}

# EFS access points for ClickHouse replicas (isolation + POSIX user enforcement)
resource "aws_efs_access_point" "clickhouse" {
  count          = var.clickhouse_replica_count
  file_system_id = aws_efs_file_system.traceroot.id

  root_directory {
    path = "/clickhouse/${count.index}"
    creation_info {
      owner_gid   = 1001
      owner_uid   = 1001
      permissions = "0755"
    }
  }

  posix_user {
    gid = 1001
    uid = 1001
  }

  tags = merge(local.tags, {
    Name = "${var.name}-clickhouse-${count.index}"
  })
}

# Pre-provisioned PersistentVolumes for ClickHouse
# Static provisioning: Terraform creates PVs with claim_ref to match the exact PVC
# names the Bitnami ClickHouse chart creates. This avoids the PVC scheduling race
# on Fargate (Task 29) because the PV is already bound before the pod starts.
resource "kubernetes_persistent_volume" "clickhouse_data" {
  count = var.clickhouse_replica_count

  metadata {
    name = "clickhouse-data-${count.index}"
  }

  spec {
    capacity = {
      storage = var.clickhouse_storage_size
    }

    access_modes                     = ["ReadWriteOnce"]
    persistent_volume_reclaim_policy = "Retain"
    storage_class_name               = kubernetes_storage_class.efs.metadata[0].name

    persistent_volume_source {
      csi {
        driver        = "efs.csi.aws.com"
        volume_handle = "${aws_efs_file_system.traceroot.id}::${aws_efs_access_point.clickhouse[count.index].id}"
      }
    }

    # Pre-bind to the exact PVC name the Bitnami chart creates
    claim_ref {
      name      = "data-traceroot-clickhouse-shard0-${count.index}"
      namespace = var.clickhouse_namespace
    }
  }

  depends_on = [
    kubernetes_storage_class.efs,
    aws_efs_mount_target.eks,
  ]
}
