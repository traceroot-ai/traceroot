# deploy/terraform/aws/rds.tf

resource "random_password" "postgres" {
  length  = 32
  special = false # Avoid bash parsing issues
}

resource "aws_db_subnet_group" "postgres" {
  name       = "${var.name}-postgres"
  subnet_ids = module.vpc.private_subnets
  tags       = local.tags
}

resource "aws_security_group" "postgres" {
  name_prefix = "${var.name}-postgres-"
  vpc_id      = module.vpc.vpc_id

  ingress {
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  tags = local.tags
}

resource "aws_rds_cluster" "postgres" {
  cluster_identifier = "${var.name}-postgres"
  engine             = "aurora-postgresql"
  engine_mode        = "provisioned"
  engine_version     = "17.4"
  database_name      = "traceroot"
  master_username    = "traceroot"
  master_password    = random_password.postgres.result

  db_subnet_group_name   = aws_db_subnet_group.postgres.name
  vpc_security_group_ids = [aws_security_group.postgres.id]

  storage_encrypted       = true
  backup_retention_period = 7
  skip_final_snapshot     = true # Simple for now

  serverlessv2_scaling_configuration {
    min_capacity = var.postgres_min_capacity
    max_capacity = var.postgres_max_capacity
  }

  tags = local.tags
}

resource "aws_rds_cluster_instance" "postgres" {
  identifier         = "${var.name}-postgres-1"
  cluster_identifier = aws_rds_cluster.postgres.id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.postgres.engine
  engine_version     = aws_rds_cluster.postgres.engine_version

  tags = local.tags
}
