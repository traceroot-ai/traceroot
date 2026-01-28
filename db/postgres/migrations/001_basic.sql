-- PostgreSQL schema initialization
-- Auto-created tables for Traceroot

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR PRIMARY KEY,
    email VARCHAR UNIQUE,
    email_verified TIMESTAMP,
    name VARCHAR,
    password VARCHAR,
    image VARCHAR,
    admin BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- Organizations table
CREATE TABLE IF NOT EXISTS organizations (
    id VARCHAR PRIMARY KEY,
    name VARCHAR NOT NULL,
    created_at TIMESTAMP DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- Organization memberships table
CREATE TABLE IF NOT EXISTS organization_memberships (
    id VARCHAR PRIMARY KEY,
    org_id VARCHAR NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR NOT NULL,
    created_at TIMESTAMP DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW() NOT NULL,
    CONSTRAINT uq_org_user UNIQUE (org_id, user_id)
);
CREATE INDEX IF NOT EXISTS ix_membership_org_id ON organization_memberships(org_id);
CREATE INDEX IF NOT EXISTS ix_membership_user_id ON organization_memberships(user_id);

-- Projects table
CREATE TABLE IF NOT EXISTS projects (
    id VARCHAR PRIMARY KEY,
    org_id VARCHAR NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR NOT NULL,
    retention_days INTEGER,
    deleted_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_project_org_id ON projects(org_id);

-- API keys table
CREATE TABLE IF NOT EXISTS api_keys (
    id VARCHAR PRIMARY KEY,
    project_id VARCHAR NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    key_hash VARCHAR UNIQUE NOT NULL,
    key_prefix VARCHAR NOT NULL,
    name VARCHAR,
    expires_at TIMESTAMP,
    last_used_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_api_key_project_id ON api_keys(project_id);

-- Membership invitations table
CREATE TABLE IF NOT EXISTS membership_invitations (
    id VARCHAR PRIMARY KEY,
    email VARCHAR NOT NULL,
    org_id VARCHAR NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    org_role VARCHAR NOT NULL,
    invited_by_user_id VARCHAR REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW() NOT NULL,
    CONSTRAINT uq_invitation_email_org UNIQUE (email, org_id)
);
CREATE INDEX IF NOT EXISTS ix_invitation_org_id ON membership_invitations(org_id);

-- Accounts table (OAuth for NextAuth)
CREATE TABLE IF NOT EXISTS accounts (
    id VARCHAR PRIMARY KEY,
    user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR NOT NULL,
    provider VARCHAR NOT NULL,
    provider_account_id VARCHAR NOT NULL,
    refresh_token TEXT,
    access_token TEXT,
    expires_at INTEGER,
    token_type VARCHAR,
    scope VARCHAR,
    id_token TEXT,
    session_state VARCHAR,
    created_at TIMESTAMP DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW() NOT NULL,
    CONSTRAINT uq_provider_account UNIQUE (provider, provider_account_id)
);
