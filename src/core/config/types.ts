/**
 * Configuration types for StackMemory
 */

export interface ScoringWeights {
  base: number;
  impact: number;
  persistence: number;
  reference: number;
}

export interface ToolScores {
  search?: number;
  grep?: number;
  edit?: number;
  write?: number;
  read?: number;
  bash?: number;
  test?: number;
  task_creation?: number;
  decision_recording?: number;
  context_retrieval?: number;
  [key: string]: number | undefined; // Allow custom tools
}

export interface RetentionConfig {
  local: {
    young: string; // e.g., "1d"
    mature: string; // e.g., "7d"
    old: string; // e.g., "30d"
    max_size: string; // e.g., "2GB"
  };
  remote: {
    enabled: boolean;
    endpoint?: string;
    retention: string; // e.g., "infinite"
  };
  generational_gc: {
    young_strategy: 'keep_all' | 'digest_only' | 'anchors_only';
    mature_strategy: 'keep_all' | 'digest_only' | 'anchors_only';
    old_strategy: 'keep_all' | 'digest_only' | 'anchors_only';
  };
}

export interface PerformanceConfig {
  max_stack_depth: number;
  max_frame_events: number;
  retrieval_timeout_ms: number;
  batch_upload_size: number;
}

export interface ProfileConfig {
  name: string;
  description?: string;
  scoring?: Partial<{
    weights: Partial<ScoringWeights>;
    tool_scores: Partial<ToolScores>;
  }>;
  retention?: Partial<RetentionConfig>;
  performance?: Partial<PerformanceConfig>;
}

export interface StackMemoryConfig {
  version: string;
  profile?: string; // Active profile name
  scoring: {
    weights: ScoringWeights;
    tool_scores: ToolScores;
  };
  retention: RetentionConfig;
  performance: PerformanceConfig;
  profiles?: Record<string, ProfileConfig>;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  base: 0.4,
  impact: 0.3,
  persistence: 0.2,
  reference: 0.1,
};

export const DEFAULT_TOOL_SCORES: ToolScores = {
  search: 0.95,
  task_creation: 0.9,
  decision_recording: 0.9,
  context_retrieval: 0.85,
  write: 0.75,
  edit: 0.5,
  test: 0.45,
  bash: 0.4,
  read: 0.25,
  grep: 0.15,
};

export const PRESET_PROFILES: Record<string, ProfileConfig> = {
  default: {
    name: 'default',
    description: 'Balanced configuration for general use',
    scoring: {
      weights: DEFAULT_WEIGHTS,
      tool_scores: DEFAULT_TOOL_SCORES,
    },
  },
  'security-focused': {
    name: 'security-focused',
    description: 'Prioritizes security decisions and audit trails',
    scoring: {
      weights: {
        base: 0.2,
        impact: 0.5,
        persistence: 0.2,
        reference: 0.1,
      },
      tool_scores: {
        decision_recording: 0.95,
        bash: 0.8, // Security-critical commands
        test: 0.7, // Security tests important
      },
    },
    retention: {
      local: {
        young: '7d',
        mature: '30d',
        old: '90d', // Keep security decisions longer
        max_size: '100MB',
      },
    },
  },
  'exploration-heavy': {
    name: 'exploration-heavy',
    description: 'Optimized for codebase exploration and learning',
    scoring: {
      weights: {
        base: 0.3,
        impact: 0.1,
        persistence: 0.1,
        reference: 0.5, // Discovery paths matter most
      },
      tool_scores: {
        search: 0.99,
        grep: 0.3, // Grep more valuable during exploration
        read: 0.4,
      },
    },
    performance: {
      retrieval_timeout_ms: 1000, // Allow deeper searches
    },
  },
  'production-system': {
    name: 'production-system',
    description: 'For production environments with stability focus',
    scoring: {
      weights: {
        base: 0.2,
        impact: 0.4,
        persistence: 0.3, // Permanent changes critical
        reference: 0.1,
      },
      tool_scores: {
        write: 0.9, // File changes very important
        edit: 0.85,
        test: 0.8, // Testing critical
        bash: 0.7, // Deploy commands
      },
    },
  },
};

export const DEFAULT_CONFIG: StackMemoryConfig = {
  version: '1.0',
  scoring: {
    weights: DEFAULT_WEIGHTS,
    tool_scores: DEFAULT_TOOL_SCORES,
  },
  retention: {
    local: {
      young: '1d',
      mature: '7d',
      old: '30d',
      max_size: '2GB',
    },
    remote: {
      enabled: true,
      endpoint: 'api.stackmemory.io',
      retention: 'infinite',
    },
    generational_gc: {
      young_strategy: 'keep_all',
      mature_strategy: 'digest_only',
      old_strategy: 'anchors_only',
    },
  },
  performance: {
    max_stack_depth: 10000,
    max_frame_events: 5000,
    retrieval_timeout_ms: 500,
    batch_upload_size: 100,
  },
  profiles: PRESET_PROFILES,
};