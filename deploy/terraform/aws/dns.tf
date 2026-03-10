# deploy/terraform/aws/dns.tf
# ACM certificate + Route53 DNS for custom domain with HTTPS
# Following Langfuse pattern: create the hosted zone, cert, and DNS records all in Terraform.
# After apply, point your domain registrar's NS records at the Route53 zone.

# Route53 hosted zone (created by Terraform, not pre-existing)
resource "aws_route53_zone" "app" {
  count = var.domain != "" ? 1 : 0
  name  = var.domain

  tags = local.tags
}

# ACM Certificate
resource "aws_acm_certificate" "app" {
  count             = var.domain != "" ? 1 : 0
  domain_name       = var.domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = local.tags
}

# DNS validation records
resource "aws_route53_record" "cert_validation" {
  for_each = var.domain != "" ? {
    for dvo in aws_acm_certificate.app[0].domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  } : {}

  zone_id         = aws_route53_zone.app[0].zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "app" {
  count                   = var.domain != "" ? 1 : 0
  certificate_arn         = aws_acm_certificate.app[0].arn
  validation_record_fqdns = [for record in aws_route53_record.cert_validation : record.fqdn]
}

# Discover the ALB created by AWS Load Balancer Controller
data "aws_lb" "ingress" {
  count = var.domain != "" ? 1 : 0

  tags = {
    "elbv2.k8s.aws/cluster"    = var.name
    "ingress.k8s.aws/resource" = "LoadBalancer"
  }

  depends_on = [helm_release.traceroot]
}

# Route53 A record pointing domain to ALB
resource "aws_route53_record" "app" {
  count   = var.domain != "" ? 1 : 0
  zone_id = aws_route53_zone.app[0].zone_id
  name    = var.domain
  type    = "A"

  alias {
    name                   = data.aws_lb.ingress[0].dns_name
    zone_id                = data.aws_lb.ingress[0].zone_id
    evaluate_target_health = true
  }
}
