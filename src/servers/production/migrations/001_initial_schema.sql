-- Initial database schema for Runway StackMemory
-- PostgreSQL 15+ required

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";

-- User tiers enum
CREATE TYPE user_tier AS ENUM ('free', 'pro', 'enterprise');

-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sub VARCHAR(255) UNIQUE NOT NULL, -- Auth0/Clerk subject ID
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255),
    picture TEXT,
    tier user_tier DEFAULT 'free',
    auth_provider VARCHAR(50) NOT NULL,
    auth_id VARCHAR(255) NOT NULL,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_login TIMESTAMP WITH TIME ZONE,
    email_verified BOOLEAN DEFAULT FALSE,
    suspended BOOLEAN DEFAULT FALSE,
    suspension_reason TEXT,
    
    INDEX idx_users_sub (sub),
    INDEX idx_users_email (email),
    INDEX idx_users_tier (tier),
    INDEX idx_users_created_at (created_at)
);

-- Organizations table
CREATE TABLE organizations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(255) UNIQUE NOT NULL,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    settings JSONB DEFAULT '{}',
    tier user_tier DEFAULT 'free',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    INDEX idx_organizations_slug (slug),
    INDEX idx_organizations_owner (owner_id)
);

-- Organization members
CREATE TABLE organization_members (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL DEFAULT 'member', -- owner, admin, member
    permissions JSONB DEFAULT '[]',
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(organization_id, user_id),
    INDEX idx_org_members_org (organization_id),
    INDEX idx_org_members_user (user_id)
);

-- Projects table
CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(255) NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    settings JSONB DEFAULT '{}',
    metadata JSONB DEFAULT '{}',
    is_public BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_accessed TIMESTAMP WITH TIME ZONE,
    
    UNIQUE(user_id, slug),
    UNIQUE(organization_id, slug),
    INDEX idx_projects_user (user_id),
    INDEX idx_projects_org (organization_id),
    INDEX idx_projects_created_at (created_at)
);

-- Project collaborators
CREATE TABLE project_collaborators (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permissions JSONB DEFAULT '["read"]',
    added_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    added_by UUID REFERENCES users(id),
    
    UNIQUE(project_id, user_id),
    INDEX idx_project_collab_project (project_id),
    INDEX idx_project_collab_user (user_id)
);

-- Context storage (migrated from SQLite)
CREATE TABLE contexts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    type VARCHAR(50) DEFAULT 'general',
    embedding vector(1536), -- For semantic search (requires pgvector)
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    INDEX idx_contexts_project (project_id),
    INDEX idx_contexts_type (type),
    INDEX idx_contexts_created_at (created_at)
);

-- Tasks (migrated from SQLite)
CREATE TABLE tasks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    external_id VARCHAR(255), -- Linear/Jira ID
    title VARCHAR(500) NOT NULL,
    description TEXT,
    state VARCHAR(50) NOT NULL DEFAULT 'todo',
    priority VARCHAR(20) DEFAULT 'medium',
    assignee_id UUID REFERENCES users(id),
    estimated_effort INTEGER,
    actual_effort INTEGER,
    labels JSONB DEFAULT '[]',
    blocking_issues JSONB DEFAULT '[]',
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE,
    
    INDEX idx_tasks_project (project_id),
    INDEX idx_tasks_state (state),
    INDEX idx_tasks_assignee (assignee_id),
    INDEX idx_tasks_created_at (created_at),
    INDEX idx_tasks_external_id (external_id)
);

-- Analytics events
CREATE TABLE analytics_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_type VARCHAR(100) NOT NULL,
    event_data JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    INDEX idx_analytics_project (project_id),
    INDEX idx_analytics_user (user_id),
    INDEX idx_analytics_type (event_type),
    INDEX idx_analytics_created_at (created_at)
) PARTITION BY RANGE (created_at);

-- Create monthly partitions for analytics
CREATE TABLE analytics_events_2024_01 PARTITION OF analytics_events
    FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');

CREATE TABLE analytics_events_2024_02 PARTITION OF analytics_events
    FOR VALUES FROM ('2024-02-01') TO ('2024-03-01');

-- Continue creating partitions as needed...

-- API Keys table
CREATE TABLE api_keys (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    key_hash VARCHAR(255) NOT NULL UNIQUE,
    key_prefix VARCHAR(20) NOT NULL, -- First 8 chars for identification
    permissions JSONB DEFAULT '[]',
    rate_limit INTEGER DEFAULT 1000,
    last_used TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    revoked_at TIMESTAMP WITH TIME ZONE,
    
    INDEX idx_api_keys_user (user_id),
    INDEX idx_api_keys_prefix (key_prefix),
    INDEX idx_api_keys_hash (key_hash)
);

-- Audit log
CREATE TABLE audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
    project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
    action VARCHAR(100) NOT NULL,
    resource_type VARCHAR(50),
    resource_id UUID,
    changes JSONB DEFAULT '{}',
    ip_address INET,
    user_agent TEXT,
    request_id VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    INDEX idx_audit_user (user_id),
    INDEX idx_audit_org (organization_id),
    INDEX idx_audit_project (project_id),
    INDEX idx_audit_action (action),
    INDEX idx_audit_created_at (created_at)
) PARTITION BY RANGE (created_at);

-- Create monthly partitions for audit log
CREATE TABLE audit_log_2024_01 PARTITION OF audit_log
    FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');

-- Usage tracking
CREATE TABLE usage_metrics (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    metric_type VARCHAR(100) NOT NULL, -- api_calls, storage_bytes, compute_ms
    value BIGINT NOT NULL,
    metadata JSONB DEFAULT '{}',
    period_start TIMESTAMP WITH TIME ZONE NOT NULL,
    period_end TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    INDEX idx_usage_user (user_id),
    INDEX idx_usage_project (project_id),
    INDEX idx_usage_type (metric_type),
    INDEX idx_usage_period (period_start, period_end)
);

-- Billing records
CREATE TABLE billing_records (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    amount_cents INTEGER NOT NULL,
    currency VARCHAR(3) DEFAULT 'USD',
    description TEXT,
    stripe_invoice_id VARCHAR(255),
    stripe_payment_intent_id VARCHAR(255),
    status VARCHAR(50) NOT NULL DEFAULT 'pending', -- pending, paid, failed, refunded
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    paid_at TIMESTAMP WITH TIME ZONE,
    
    INDEX idx_billing_user (user_id),
    INDEX idx_billing_org (organization_id),
    INDEX idx_billing_status (status),
    INDEX idx_billing_period (period_start, period_end)
);

-- Functions for updated_at triggers
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create triggers for updated_at
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_organizations_updated_at BEFORE UPDATE ON organizations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_projects_updated_at BEFORE UPDATE ON projects
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_contexts_updated_at BEFORE UPDATE ON contexts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_tasks_updated_at BEFORE UPDATE ON tasks
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Row-level security policies
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE contexts ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

-- RLS policies for projects
CREATE POLICY projects_owner_policy ON projects
    FOR ALL
    USING (user_id = current_setting('app.current_user_id')::UUID);

CREATE POLICY projects_collaborator_policy ON projects
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM project_collaborators
            WHERE project_id = projects.id
            AND user_id = current_setting('app.current_user_id')::UUID
        )
    );

-- Indexes for performance
CREATE INDEX idx_contexts_content_trgm ON contexts USING gin(content gin_trgm_ops); -- Requires pg_trgm
CREATE INDEX idx_tasks_metadata ON tasks USING gin(metadata);
CREATE INDEX idx_analytics_events_data ON analytics_events USING gin(event_data);

-- Materialized view for user statistics
CREATE MATERIALIZED VIEW user_statistics AS
SELECT 
    u.id,
    u.email,
    u.tier,
    COUNT(DISTINCT p.id) as project_count,
    COUNT(DISTINCT t.id) as task_count,
    COUNT(DISTINCT ae.id) as event_count,
    MAX(p.last_accessed) as last_active,
    SUM(um.value) FILTER (WHERE um.metric_type = 'api_calls') as total_api_calls,
    SUM(um.value) FILTER (WHERE um.metric_type = 'storage_bytes') as total_storage_bytes
FROM users u
LEFT JOIN projects p ON u.id = p.user_id
LEFT JOIN tasks t ON p.id = t.project_id
LEFT JOIN analytics_events ae ON u.id = ae.user_id AND ae.created_at > NOW() - INTERVAL '30 days'
LEFT JOIN usage_metrics um ON u.id = um.user_id AND um.period_start > NOW() - INTERVAL '30 days'
GROUP BY u.id, u.email, u.tier;

CREATE UNIQUE INDEX idx_user_statistics_id ON user_statistics(id);

-- Function to refresh statistics (call periodically)
CREATE OR REPLACE FUNCTION refresh_user_statistics()
RETURNS void AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY user_statistics;
END;
$$ LANGUAGE plpgsql;

-- Grant permissions (adjust for your user)
GRANT ALL ON ALL TABLES IN SCHEMA public TO stackmemory_app;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO stackmemory_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO stackmemory_app;