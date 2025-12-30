# StackMemory Query Language Documentation

## Overview

The StackMemory Query Language provides multiple ways to retrieve context from your memory stack. It supports natural language queries, structured queries, query templates, and inline modifiers for maximum flexibility.

## Query Types

### 1. Natural Language Queries

Simple, human-readable queries that are automatically parsed into structured format.

```typescript
// Time-based queries
"provide context from the last day"
"show me what happened yesterday"
"get all work from last 3 weeks"
"what happened today"

// Topic-based queries
"find all authentication work"
"show database migration frames"
"get frames about the login bug"

// People-based queries
"show @alice's recent work"
"what did bob's changes include"
"get team work from today"

// Combined queries
"show @alice's auth work from last week"
"find critical bugs from yesterday"
```

### 2. Structured Queries

TypeScript interfaces for precise control over query parameters.

```typescript
interface StackMemoryQuery {
  time?: {
    last?: string;        // "1d", "3h", "1w", "2m"
    since?: Date;
    until?: Date;
    between?: [Date, Date];
    specific?: Date;
  };
  content?: {
    topic?: string[];
    files?: string[];
    errors?: string[];
    tools?: string[];
    keywords?: string[];
    excludeKeywords?: string[];
  };
  frame?: {
    type?: FrameType[];
    status?: FrameStatus[];
    score?: { min?: number; max?: number; };
    depth?: { min?: number; max?: number; };
  };
  people?: {
    owner?: string[];
    contributors?: string[];
    team?: string;
  };
  output?: {
    limit?: number;
    sort?: 'time' | 'score' | 'relevance';
    include?: ('digests' | 'events' | 'anchors')[];
    format?: 'full' | 'summary' | 'ids';
    groupBy?: 'frame' | 'time' | 'owner' | 'topic';
  };
}
```

### 3. Query Shortcuts

Pre-defined shortcuts for common queries:

- `today` - Last 24 hours
- `yesterday` - 48 hours ago to 24 hours ago
- `this week` - Last 7 days
- `last week` - 14 days ago to 7 days ago
- `this month` - Last 30 days
- `bugs` - Bug and debug frames
- `features` - Feature frames
- `architecture` - Architecture frames
- `refactoring` - Refactor frames
- `critical` - High priority (score >= 0.8)
- `recent` - Last 4 hours
- `stalled` - Stalled frames
- `my work` - Current user's frames
- `team work` - Current team's frames

### 4. Query Templates

Pre-built patterns for common workflows:

#### Daily Standup
```
standup for @alice
// Returns alice's work from last 24h, grouped by frame
```

#### Error Investigation
```
investigate errors in authentication
// Returns error/bug frames with auth keywords from last 48h
```

#### Feature Progress
```
progress on payment feature
// Returns open feature frames with payment keywords
```

#### Code Review
```
code review for auth.js
// Returns all changes to auth.js from last 24h

code review for authentication
// Returns all authentication-related changes from last 24h
```

#### Team Retrospective
```
retrospective for last sprint
// Returns team work from last 14 days grouped by owner
```

#### Performance Analysis
```
performance issues for dashboard
// Returns performance-related frames for dashboard from last 7d
```

#### Security Audit
```
security audit
// Returns all security-related frames with high priority

security audit for api
// Returns security frames specific to API
```

#### Deployment Readiness
```
deployment readiness
// Returns open deployment-related frames from last 48h

deployment readiness for v2.0
// Returns deployment frames for specific version
```

### 5. Inline Modifiers

Add modifiers to any query using the `+` prefix:

```
authentication bugs +last:7d +owner:alice +priority:high +sort:time +limit:20
```

Available modifiers:
- `+last:` - Time period (e.g., `+last:3d`)
- `+since:` - Start date (e.g., `+since:2024-12-20`)
- `+until:` - End date (e.g., `+until:2024-12-25`)
- `+owner:` - Frame owner (e.g., `+owner:alice`)
- `+team:` - Team name (e.g., `+team:backend`)
- `+topic:` - Topic filter (e.g., `+topic:auth`)
- `+file:` - File filter (e.g., `+file:*.js`)
- `+sort:` - Sort order (`time`, `score`, `relevance`)
- `+limit:` - Result limit (e.g., `+limit:100`)
- `+format:` - Output format (`full`, `summary`, `ids`)
- `+group:` - Grouping (`frame`, `time`, `owner`, `topic`)
- `+status:` - Frame status (`open`, `closed`, `stalled`)
- `+priority:` - Priority level (`critical`, `high`, `medium`, `low`)

## Query Expansion

The parser automatically expands queries with synonyms:

- `auth` → `authentication, oauth, login, session, jwt, authorization, sso`
- `bug` → `error, issue, problem, fix, defect, fault, crash`
- `database` → `db, sql, postgres, mysql, mongodb, migration, schema, query`
- `test` → `testing, spec, unit, integration, e2e, test-case, qa`
- `feature` → `functionality, enhancement, capability, addition`
- `performance` → `perf, speed, optimization, efficiency, latency`
- `security` → `vulnerability, exploit, protection, encryption, auth`
- `api` → `endpoint, rest, graphql, service, interface`
- `config` → `configuration, settings, environment, env, setup`
- `deployment` → `deploy, release, rollout, production, staging`

## Advanced Features

### Keyword Inclusion/Exclusion
```
"find auth work include \"jwt token\" exclude \"refresh token\""
```

### File Pattern Matching
```
"show changes to *.ts and auth.js files today"
```

### Tool and Error Tracking
```
"frames using webpack tool"
"TypeError error in last 3 days"
```

### Complex Time Ranges
```
"work between 2024-12-20 and 2024-12-25"
"changes since yesterday until now"
```

### Priority Ranges
```
"medium priority tasks" // score 0.4-0.7
"low priority items"    // score < 0.4
```

## Query Response

Every query returns a `QueryResponse` object:

```typescript
interface QueryResponse {
  original: string;                  // Original query as provided
  interpreted: StackMemoryQuery;     // Parsed structured query
  expanded: StackMemoryQuery;        // Query with synonym expansion
  suggestions?: string[];            // Helpful suggestions for refinement
  validationErrors?: string[];       // Any validation errors found
}
```

## Best Practices

1. **Start broad, then refine**: Begin with simple queries and add filters as needed
2. **Use shortcuts**: Leverage pre-defined shortcuts for common queries
3. **Combine approaches**: Mix natural language with inline modifiers for flexibility
4. **Check suggestions**: The parser provides helpful suggestions for better queries
5. **Use templates**: For recurring workflows, use query templates
6. **Group results**: Use `groupBy` for organized output
7. **Limit results**: Set appropriate limits to avoid overwhelming output

## Examples

### Finding Recent Bugs
```
// Natural language
"find critical bugs from last week"

// With inline modifiers
"bugs +last:7d +priority:critical +sort:score"

// Structured
{
  time: { last: '7d' },
  frame: { 
    type: ['bug', 'debug'],
    score: { min: 0.8 }
  },
  output: { sort: 'score' }
}
```

### Team Standup
```
// Template
"standup for @alice"

// Natural language with modifiers
"alice's work today +format:summary +group:frame"

// Structured
{
  people: { owner: ['alice'] },
  time: { last: '24h' },
  output: {
    format: 'summary',
    groupBy: 'frame'
  }
}
```

### Security Review
```
// Template
"security audit for api"

// Natural language
"find high priority security issues in api from last month"

// With modifiers
"security work +topic:api +priority:high +last:30d +format:full"
```

## Validation

The parser validates queries and provides error messages for:
- Invalid time ranges (since > until)
- Invalid score ranges (min > max)
- Output limits outside 1-1000 range
- Conflicting parameters

## Performance Tips

1. Use time filters to limit search scope
2. Specify frame types when possible
3. Use `format: 'ids'` for large result sets
4. Apply score thresholds for relevance
5. Use `excludeKeywords` to filter noise