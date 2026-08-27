# deploy/terraform/aws/waf.tf
#
# Rate-based WAF rule for the unauthenticated auth-layer endpoints.
#
# /api/auth/device/code and /api/cli/token ship with the CLI-login work and are
# handled inside Next.js, never reaching the backend's workspace-keyed limiter.
# Behind the ALB the app-level limiter cannot trust X-Forwarded-For (the ALB
# appends to a spoofable header), so it degrades to a single global bucket.
# This ACL keys on the true client IP the ALB sees natively, which cannot be
# forged, and is the authoritative per-client limit; the in-process limiters
# stay as backstops. Until those endpoints deploy, the rule matches nothing and
# blocks nothing — attaching the ACL ahead of the app change is deliberate, so
# protection is live the moment the endpoints appear.
#
# The ACL is associated with the ALB via the wafv2-acl-arn ingress annotation
# (see ingress_values in traceroot.tf). An ALB carries at most one web ACL, so
# any future WAF needs should add rules here rather than create a second ACL —
# a new association silently replaces the old one. Disabling the flag detaches
# the annotation and then deletes the ACL; the delete retries while the ALB
# controller catches up on the disassociation, so a slow controller can make
# that apply fail once — rerun it.

resource "aws_wafv2_web_acl" "auth_rate_limit" {
  count = var.enable_auth_waf ? 1 : 0

  name  = "${var.name}-auth-rate-limit"
  scope = "REGIONAL" # must live in the same region as the ALB

  default_action {
    allow {} # everything except the matched auth paths passes untouched
  }

  # Same shape the app-level limiter returns, so the CLI sees one 429 contract
  # whether the WAF or the in-process backstop throttled it.
  custom_response_body {
    key          = "rate-limited"
    content      = "{\"error\":\"rate limited\"}"
    content_type = "APPLICATION_JSON"
  }

  rule {
    name     = "auth-paths-per-ip"
    priority = 1

    action {
      block {
        # WAF's default block status is 403, which the device-flow CLI treats
        # as a hard auth failure. 429 keeps throttling retryable per RFC 8628.
        custom_response {
          response_code            = 429
          custom_response_body_key = "rate-limited"
        }
      }
    }

    statement {
      rate_based_statement {
        limit              = var.auth_waf_rate_limit # per 5 minutes per IP
        aggregate_key_type = "IP"

        # The WAF sees the raw path while Next.js routes the decoded one, so
        # matching without transformations is bypassable via percent-encoding
        # (e.g. /api/cli/%74oken). Decode then normalize before comparing.
        # STARTS_WITH is deliberate: it also catches trailing-slash variants
        # and any future subpaths of these endpoints.
        #
        # The method match keeps non-POST noise out of the budget. Not a
        # security boundary — the bucket is per-IP, and an attacker's POSTs
        # cost them no more than GETs — but scanner sweeps are overwhelmingly
        # GET, and without it a scanner behind a shared NAT burns that NAT's
        # login budget for everyone on it. Both endpoints are POST-only.
        scope_down_statement {
          and_statement {
            statement {
              byte_match_statement {
                search_string         = "POST"
                positional_constraint = "EXACTLY"
                field_to_match {
                  method {}
                }
                text_transformation {
                  priority = 0
                  type     = "NONE"
                }
              }
            }
            statement {
              or_statement {
                statement {
                  byte_match_statement {
                    search_string         = "/api/auth/device/code"
                    positional_constraint = "STARTS_WITH"
                    field_to_match {
                      uri_path {}
                    }
                    text_transformation {
                      priority = 0
                      type     = "URL_DECODE"
                    }
                    text_transformation {
                      priority = 1
                      type     = "NORMALIZE_PATH"
                    }
                  }
                }
                statement {
                  byte_match_statement {
                    search_string         = "/api/cli/token"
                    positional_constraint = "STARTS_WITH"
                    field_to_match {
                      uri_path {}
                    }
                    text_transformation {
                      priority = 0
                      type     = "URL_DECODE"
                    }
                    text_transformation {
                      priority = 1
                      type     = "NORMALIZE_PATH"
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "auth-paths-per-ip"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "auth-rate-limit-acl"
    sampled_requests_enabled   = true
  }

  tags = local.tags
}

# Durable record of blocked requests. WAF's sampled requests are kept for only
# a few hours — too short for after-the-fact forensics or spotting a too-low
# limit throttling legitimate clients (request-volume analysis for tuning the
# limit down still comes from the rule's CloudWatch metrics, not these logs).
# Blocked-only via the logging filter: full request logging on this ACL would
# record every request through the ALB (it evaluates all traffic even though
# only the auth paths can match the rule), which is enormous volume for a
# trace-ingestion product and none of it useful here.
resource "aws_cloudwatch_log_group" "waf_auth_rate_limit" {
  count = var.enable_auth_waf ? 1 : 0

  # WAF logging requires the destination name to start with "aws-waf-logs-".
  name              = "aws-waf-logs-${var.name}-auth-rate-limit"
  retention_in_days = 30

  tags = local.tags
}

resource "aws_wafv2_web_acl_logging_configuration" "auth_rate_limit" {
  count = var.enable_auth_waf ? 1 : 0

  resource_arn            = aws_wafv2_web_acl.auth_rate_limit[0].arn
  log_destination_configs = [aws_cloudwatch_log_group.waf_auth_rate_limit[0].arn]

  # Today only the unauthenticated auth paths can be blocked and their secrets
  # travel in the (unlogged) body, but keep credentials out of the log record
  # regardless — this ACL is expected to grow rules.
  redacted_fields {
    single_header {
      name = "authorization"
    }
  }
  redacted_fields {
    single_header {
      name = "cookie"
    }
  }

  logging_filter {
    default_behavior = "DROP"

    filter {
      behavior    = "KEEP"
      requirement = "MEETS_ANY"

      condition {
        action_condition {
          action = "BLOCK"
        }
      }
    }
  }
}
