# 🏗️ StackMemory Multi-Project Architecture

## Current Architecture Analysis

### 📊 Project Identification
Currently, StackMemory identifies projects using:
1. **Git Remote URL** - Primary identifier
2. **Directory Name** - Fallback if not a git repo
3. **Manual projectId** - Can be overridden

```typescript
// Current: Simple project detection
projectId = git remote URL || directory name || "default"
```

### 🔍 Issues with Current Approach

1. **No Account Separation** - Personal vs Professional repos mixed
2. **Single Database** - All projects in one `.stackmemory/local.db`
3. **No Organization Support** - Can't group related projects
4. **Limited Context Isolation** - Projects can interfere
5. **No Cross-Project Learning** - Can't share patterns

## 🎯 Proposed Multi-Project Architecture

### 1. **Account-Based Segregation**

```yaml
~/.stackmemory/
├── accounts/
│   ├── personal/
│   │   ├── config.yml
│   │   ├── contexts.db
│   │   └── projects/
│   │       ├── side-project-1/
│   │       └── side-project-2/
│   └── work/
│       ├── config.yml
│       ├── contexts.db
│       └── projects/
│           ├── company-api/
│           └── company-frontend/
├── global/
│   ├── config.yml
│   └── shared-patterns.db
└── current -> accounts/personal  # Symlink to active account
```

### 2. **Project Configuration**

Create `.stackmemory.yml` in each project:

```yaml
# .stackmemory.yml
account: work  # or personal
project:
  id: company-api
  name: "Company API Service"
  organization: acme-corp
  tags: [backend, nodejs, production]
  
context:
  retention_days: 90
  max_size_mb: 100
  
integrations:
  linear:
    team: backend
    project: API-Development
  github:
    repo: acme/company-api
    
security:
  sensitive_patterns:
    - "api[_-]?key"
    - "password"
    - "secret"
  exclude_paths:
    - ".env"
    - "**/*.key"
```

### 3. **Enhanced Project Management Commands**

```bash
# Account management
stackmemory account create work --email work@company.com
stackmemory account switch work
stackmemory account list

# Project initialization
stackmemory init --account work --org acme-corp
stackmemory project link github.com/acme/api
stackmemory project clone-settings ../other-project

# Context management
stackmemory context save --scope project  # Current project only
stackmemory context save --scope org      # Share with organization
stackmemory context save --scope account  # All projects in account

# Cross-project operations
stackmemory sync --from project-a --to project-b
stackmemory patterns extract --org acme-corp
stackmemory context search "authentication" --account work
```

### 4. **Database Schema Updates**

```sql
-- accounts table
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  type TEXT CHECK(type IN ('personal', 'work', 'client')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  settings JSON
);

-- projects table  
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  organization_id TEXT,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  git_remote TEXT,
  tags JSON,
  config JSON,
  last_accessed DATETIME,
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

-- contexts table (updated)
CREATE TABLE contexts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  scope TEXT CHECK(scope IN ('project', 'org', 'account', 'global')),
  content TEXT NOT NULL,
  type TEXT,
  metadata JSON,
  embeddings BLOB,  -- For AI similarity search
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

-- shared_patterns table
CREATE TABLE shared_patterns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT,
  pattern_name TEXT,
  pattern_content TEXT,
  usage_count INTEGER DEFAULT 0,
  success_rate REAL,
  tags JSON
);
```

### 5. **Implementation Plan**

#### Phase 1: Account System (Week 1)
- [ ] Create account management CLI commands
- [ ] Implement account-based directory structure
- [ ] Add account switching mechanism
- [ ] Update database to support accounts

#### Phase 2: Project Configuration (Week 2)
- [ ] Design `.stackmemory.yml` schema
- [ ] Implement project detection with accounts
- [ ] Add organization support
- [ ] Create project linking commands

#### Phase 3: Enhanced Context (Week 3)
- [ ] Add scope levels (project/org/account/global)
- [ ] Implement context sharing rules
- [ ] Add security filters for sensitive data
- [ ] Create cross-project search

#### Phase 4: Intelligence Features (Week 4)
- [ ] Pattern extraction from successful projects
- [ ] Cross-project learning
- [ ] Organization-wide best practices
- [ ] AI embeddings for similarity search

### 6. **Security & Privacy**

```yaml
Security Levels:
  Personal Account:
    - Full access to all personal projects
    - Can share patterns globally (opt-in)
    - Local encryption optional
    
  Work Account:
    - Isolated from personal
    - Organization-wide sharing
    - Audit logging enabled
    - Encryption required
    
  Client Account:
    - Complete isolation
    - No cross-project sharing
    - Automatic cleanup after project end
    - Full encryption + audit
```

### 7. **Railway Deployment Updates**

For the Railway MCP server, add multi-tenancy:

```typescript
// Environment variables for Railway
TENANT_MODE=multi
ALLOWED_ACCOUNTS=personal,work
DEFAULT_ACCOUNT=personal
POSTGRES_SCHEMA_PER_ACCOUNT=true

// API endpoints
POST /api/:account/:project/context/save
GET /api/:account/:project/context/load
GET /api/:account/projects
POST /api/:account/switch
```

### 8. **Migration Strategy**

```bash
# Auto-migration script
stackmemory migrate --create-accounts

# Will:
1. Detect existing projects
2. Prompt for account assignment
3. Create account structure
4. Migrate contexts maintaining history
5. Update project configurations
```

### 9. **Benefits**

1. **Clear Separation** - Work vs Personal never mix
2. **Organization Support** - Share within teams
3. **Better Security** - Account-level isolation
4. **Cross-Project Learning** - Reuse successful patterns
5. **Scalability** - Handles hundreds of projects
6. **Compliance** - Audit trails for work accounts

### 10. **Example Workflow**

```bash
# Monday morning - switch to work
$ stackmemory account switch work
Switched to work account (12 projects)

# Start new project
$ cd ~/work/new-api
$ stackmemory init
Detected organization: acme-corp
Using work account settings
Importing 23 patterns from organization

# Save important decision
$ stackmemory context save "Using PostgreSQL for main DB" --scope org
Context saved and shared with acme-corp

# Friday - personal project
$ stackmemory account switch personal
$ cd ~/personal/side-project
$ stackmemory context load
Loading contexts from personal account only
```

## 🚀 Quick Start Implementation

```bash
# 1. Create account structure
mkdir -p ~/.stackmemory/accounts/{personal,work}

# 2. Add to your shell profile
echo 'export STACKMEMORY_ACCOUNT=personal' >> ~/.zshrc

# 3. Update StackMemory CLI
npm install -g @stackmemoryai/stackmemory@latest

# 4. Initialize accounts
stackmemory account init
```

---

This architecture provides professional-grade project management while maintaining simplicity for personal use.