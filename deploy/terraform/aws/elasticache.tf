# deploy/terraform/aws/elasticache.tf

resource "random_password" "redis" {
  length  = 32
  special = false
}

resource "aws_elasticache_subnet_group" "redis" {
  name       = "${var.name}-redis"
  subnet_ids = module.vpc.private_subnets
}

resource "aws_security_group" "redis" {
  name_prefix = "${var.name}-redis-"
  vpc_id      = module.vpc.vpc_id

  ingress {
    from_port   = 6379
    to_port     = 6379
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  tags = local.tags
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id = var.name
  description          = "${var.name} Redis"
  node_type            = var.cache_node_type
  num_cache_clusters   = 1 # Simple: single node

  engine         = "redis"
  engine_version = "7.0"

  subnet_group_name  = aws_elasticache_subnet_group.redis.name
  security_group_ids = [aws_security_group.redis.id]

  auth_token                 = random_password.redis.result
  transit_encryption_enabled = true
  at_rest_encryption_enabled = false # Simple for now

  tags = local.tags
}
