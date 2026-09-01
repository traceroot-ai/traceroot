# deploy/terraform/aws/rds_alarms.tf
# RDS CloudWatch alarms + notification topic (SOC 2 monitoring).
#
# These were applied out-of-band earlier (present in state, absent from committed
# config), so a plain `terraform apply` wanted to delete them. Re-added here to
# match existing state exactly — same resource addresses, env-agnostic via
# var.name and the RDS instance — so the alarms are preserved, not dropped.

resource "aws_sns_topic" "postgres_alarms" {
  name = "${var.name}-postgres-alarms"
}

resource "aws_cloudwatch_metric_alarm" "postgres_cpu" {
  alarm_name          = "${var.name}-postgres-cpu-high"
  alarm_description   = "RDS ${aws_rds_cluster_instance.postgres.identifier} CPU utilization above 90% for 15 minutes."
  comparison_operator = "GreaterThanThreshold"
  metric_name         = "CPUUtilization"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = 90
  evaluation_periods  = 3
  dimensions          = { DBInstanceIdentifier = aws_rds_cluster_instance.postgres.identifier }
  alarm_actions       = [aws_sns_topic.postgres_alarms.arn]
  ok_actions          = [aws_sns_topic.postgres_alarms.arn]
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_metric_alarm" "postgres_freeable_memory" {
  alarm_name          = "${var.name}-postgres-freeable-memory-low"
  alarm_description   = "RDS ${aws_rds_cluster_instance.postgres.identifier} freeable memory below 256 MB for 15 minutes."
  comparison_operator = "LessThanThreshold"
  metric_name         = "FreeableMemory"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = 268435456
  evaluation_periods  = 3
  dimensions          = { DBInstanceIdentifier = aws_rds_cluster_instance.postgres.identifier }
  alarm_actions       = [aws_sns_topic.postgres_alarms.arn]
  ok_actions          = [aws_sns_topic.postgres_alarms.arn]
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_metric_alarm" "postgres_disk_queue_depth" {
  alarm_name          = "${var.name}-postgres-disk-queue-depth-high"
  alarm_description   = "RDS ${aws_rds_cluster_instance.postgres.identifier} disk queue depth above 15 (I/O saturation) for 15 minutes."
  comparison_operator = "GreaterThanThreshold"
  metric_name         = "DiskQueueDepth"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = 15
  evaluation_periods  = 3
  dimensions          = { DBInstanceIdentifier = aws_rds_cluster_instance.postgres.identifier }
  alarm_actions       = [aws_sns_topic.postgres_alarms.arn]
  ok_actions          = [aws_sns_topic.postgres_alarms.arn]
  treat_missing_data  = "notBreaching"
}
