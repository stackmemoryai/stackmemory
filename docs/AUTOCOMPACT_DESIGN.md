# StackMemory Autocompaction Handling Design

## Problem Statement

Claude Code performs automatic context compaction when approaching token limits (~180K tokens). During compaction:
- Earlier messages are compressed/summarized
- Tool call details and results may be lost
- Important context decisions disappear
- File paths, error messages, and specific details are reduced to summaries

This is problematic for StackMemory which needs to preserve:
1. **Tool call sequences** - What tools were called in what order
2. **File operations** - Which files were read, edited, created
3. **Decision points** - Architecture decisions, approach choices
4. **Error patterns** - What failed and how it was resolved
5. **Context anchors** - Critical facts that must persist

## Detection Strategy

### 1. Token Monitoring
```typescript
interface CompactionDetector {
  estimatedTokens: number;
  warningThreshold: 150000;  // 150K tokens
  criticalThreshold: 170000; // 170K tokens
  
  // Monitor message sizes
  trackMessage(content: string): void;
  
  // Detect when approaching limits
  isApproachingCompaction(): boolean;
  
  // Check if compaction likely occurred
  detectCompactionEvent(): boolean;
}
```

### 2. Message Pattern Analysis
```typescript
// Detect compaction signatures
const compactionIndicators = [
  'Earlier in this conversation',
  'Previously discussed',
  'As mentioned before',
  'summarized for brevity',
  // Missing specific tool results
  /tool_use id="\w+" but no corresponding result/
];
```

## Persistence Strategy

### 1. Pre-Compaction Anchoring
Before compaction occurs (at warning threshold):

```typescript
interface CriticalContextAnchor {
  anchor_id: string;
  type: 'COMPACTION_PRESERVE';
  priority: 10; // Highest priority
  content: {
    tool_calls: ToolCallSummary[];
    decisions: DecisionPoint[];
    file_operations: FileOperation[];
    error_resolutions: ErrorPattern[];
  };
  created_at: number;
  token_count: number;
}

interface ToolCallSummary {
  tool: string;
  timestamp: number;
  key_inputs: Record<string, any>;
  key_outputs: Record<string, any>;
  files_affected: string[];
  success: boolean;
  error?: string;
}
```

### 2. Frame-Based Preservation
Each frame automatically preserves its critical context:

```typescript
interface FrameCompactionDigest {
  frame_id: string;
  preservation_level: 'full' | 'critical' | 'summary';
  
  // Always preserved
  critical: {
    goal: string;
    outcome: string;
    tool_sequence: string[]; // Ordered list of tools
    files_modified: string[];
    decisions: string[];
    errors_resolved: string[];
  };
  
  // Preserved if space allows
  extended?: {
    tool_details: ToolCallDetail[];
    conversation_highlights: string[];
    code_snippets: CodeContext[];
  };
}
```

### 3. Active Reconstruction
When compaction is detected, actively reconstruct context:

```typescript
class CompactionRecovery {
  // Detect what was lost
  detectLostContext(): LostContext {
    // Compare current context with preserved anchors
    // Identify gaps in tool call sequences
    // Find missing file operations
  }
  
  // Reconstruct from persistence
  reconstructContext(): ReconstructedContext {
    // Load frame digests
    // Rebuild tool call history
    // Restore file operation log
    // Rehydrate decision points
  }
  
  // Inject back into conversation
  async restoreContext(): Promise<void> {
    // Create restoration frame
    // Add synthetic events for lost tool calls
    // Rebuild file operation history
    // Re-establish decision anchors
  }
}
```

## Implementation Plan

### Phase 1: Detection (Immediate)
1. Add token counting to MCP server
2. Monitor for compaction indicators
3. Log when compaction likely occurred

### Phase 2: Preservation (High Priority)
1. Create `CompactionAnchor` type
2. Auto-anchor at 150K tokens
3. Preserve tool sequences per frame
4. Store file operation history

### Phase 3: Recovery (Medium Priority)
1. Detect compaction events
2. Load preserved anchors
3. Reconstruct context
4. Inject restoration frame

## Tool Call Preservation Format

```typescript
interface PreservedToolCall {
  // Minimal format for post-compaction
  id: string;
  tool: string;
  timestamp: number;
  
  // Key preservation
  preserved_inputs: {
    file_path?: string;
    command?: string;
    query?: string;
    // Only most critical inputs
  };
  
  preserved_outputs: {
    success: boolean;
    error?: string;
    files_created?: string[];
    files_modified?: string[];
    // Only most critical outputs
  };
  
  // Compression metadata
  original_size: number;
  compressed_size: number;
  compression_ratio: number;
}
```

## MCP Integration

### 1. New MCP Tools
```typescript
// Check compaction status
tools.push({
  name: 'check_compaction_status',
  description: 'Check if approaching or past compaction',
  returns: {
    tokens_used: number,
    compaction_risk: 'low' | 'medium' | 'high' | 'occurred',
    preserved_anchors: number
  }
});

// Force preservation
tools.push({
  name: 'preserve_critical_context',
  description: 'Force preservation of current context',
  parameters: {
    level: 'critical' | 'extended' | 'full'
  }
});

// Restore after compaction
tools.push({
  name: 'restore_compacted_context',
  description: 'Restore context lost to compaction',
  parameters: {
    depth: 'recent' | 'session' | 'full'
  }
});
```

### 2. Automatic Behaviors
- At 150K tokens: Auto-preserve critical context
- At 170K tokens: Create full preservation anchor
- On compaction detection: Auto-restore critical context
- Every 10K tokens: Update preservation anchors

## Benefits

1. **Continuity** - Maintain context across compaction boundaries
2. **Tool History** - Never lose track of what tools were called
3. **File Tracking** - Always know what files were touched
4. **Decision Memory** - Preserve architectural decisions
5. **Error Learning** - Remember what failed and how it was fixed

## Metrics

Track effectiveness:
- Context preservation rate
- Successful reconstructions
- Token efficiency (preserved info / tokens used)
- User experience continuity

## Next Steps

1. Implement token counting in MCP server
2. Add compaction detection logic
3. Create preservation anchor system
4. Build reconstruction mechanism
5. Test with long conversations