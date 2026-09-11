"""SQL Query Gateway services.

This package hosts the cloud-safe, project-scoped, read-only SQL gateway. The
curated public schema (:mod:`rest.services.sql.schema`) is the single source of
truth that downstream components (validator, rewriter, ClickHouse views, schema
endpoint, CLI) derive from.
"""
