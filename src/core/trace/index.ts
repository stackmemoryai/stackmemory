/**
 * Trace Module Export
 * Central export for all tracing functionality
 */

import type { TraceConfig } from './debug-trace.js';

export {
  trace,
  TraceContext,
  Trace,
  TraceClass,
  TraceCritical,
  type TraceConfig,
} from './debug-trace.js';

export {
  wrapCommand,
  wrapProgram,
  traceStep,
  traceQuery,
  traceAPI,
} from './cli-trace-wrapper.js';

export {
  createTracedDatabase,
  wrapDatabase,
  getQueryStatistics,
  createTracedTransaction,
} from './db-trace-wrapper.js';

export {
  TraceLinearAPI,
  createTracedFetch,
  wrapGraphQLClient,
} from './linear-api-wrapper.js';

/**
 * Initialize tracing based on environment configuration
 */
export function initializeTracing(): void {
  const config = {
    // Main control
    DEBUG_TRACE: process.env.DEBUG_TRACE === 'true',
    STACKMEMORY_DEBUG: process.env.STACKMEMORY_DEBUG === 'true',
    
    // Output control
    TRACE_OUTPUT: process.env.TRACE_OUTPUT || 'console', // console|file|both
    TRACE_VERBOSITY: process.env.TRACE_VERBOSITY || 'full', // full|errors|summary
    
    // Content control
    TRACE_PARAMS: process.env.TRACE_PARAMS !== 'false', // Include parameters
    TRACE_RESULTS: process.env.TRACE_RESULTS !== 'false', // Include results
    TRACE_MASK_SENSITIVE: process.env.TRACE_MASK_SENSITIVE !== 'false', // Mask sensitive data
    
    // Performance
    TRACE_PERF_THRESHOLD: parseInt(process.env.TRACE_PERF_THRESHOLD || '100'), // ms
    TRACE_MEMORY: process.env.TRACE_MEMORY === 'true', // Track memory usage
    TRACE_MAX_DEPTH: parseInt(process.env.TRACE_MAX_DEPTH || '20'), // Max call depth
    
    // Database specific
    TRACE_DB: process.env.TRACE_DB === 'true', // Enable database tracing
    TRACE_DB_SLOW: parseInt(process.env.TRACE_DB_SLOW || '100'), // Slow query threshold
    
    // API specific
    TRACE_API: process.env.TRACE_API === 'true', // Enable API tracing
    TRACE_API_SLOW: parseInt(process.env.TRACE_API_SLOW || '1000'), // Slow API threshold
  };
  
  // Log configuration if debugging is enabled
  if (config.DEBUG_TRACE || config.STACKMEMORY_DEBUG) {
    console.log('🔍 Trace Configuration:', {
      enabled: true,
      output: config.TRACE_OUTPUT,
      verbosity: config.TRACE_VERBOSITY,
      includeParams: config.TRACE_PARAMS,
      includeResults: config.TRACE_RESULTS,
      maskSensitive: config.TRACE_MASK_SENSITIVE,
      performanceThreshold: config.TRACE_PERF_THRESHOLD,
      captureMemory: config.TRACE_MEMORY,
      maxDepth: config.TRACE_MAX_DEPTH,
      database: {
        enabled: config.TRACE_DB,
        slowThreshold: config.TRACE_DB_SLOW,
      },
      api: {
        enabled: config.TRACE_API,
        slowThreshold: config.TRACE_API_SLOW,
      },
    });
  }
}

/**
 * Helper to enable tracing for a specific scope
 */
export function withTracing<T>(
  fn: () => T,
  options?: Partial<TraceConfig>
): T {
  const originalEnv = process.env.DEBUG_TRACE;
  
  try {
    // Temporarily enable tracing
    process.env.DEBUG_TRACE = 'true';
    
    // Apply custom options if provided
    if (options) {
      if (options.output) process.env.TRACE_OUTPUT = options.output;
      if (options.verbosity) process.env.TRACE_VERBOSITY = options.verbosity;
      if (options.includeParams !== undefined) {
        process.env.TRACE_PARAMS = String(options.includeParams);
      }
      if (options.includeResults !== undefined) {
        process.env.TRACE_RESULTS = String(options.includeResults);
      }
      if (options.performanceThreshold !== undefined) {
        process.env.TRACE_PERF_THRESHOLD = String(options.performanceThreshold);
      }
    }
    
    return fn();
  } finally {
    // Restore original environment
    if (originalEnv === undefined) {
      delete process.env.DEBUG_TRACE;
    } else {
      process.env.DEBUG_TRACE = originalEnv;
    }
  }
}

/**
 * Quick enable/disable functions for debugging
 */
export const enableTracing = () => {
  process.env.DEBUG_TRACE = 'true';
  console.log('✅ Tracing enabled');
};

export const disableTracing = () => {
  delete process.env.DEBUG_TRACE;
  console.log('❌ Tracing disabled');
};

export const enableVerboseTracing = () => {
  process.env.DEBUG_TRACE = 'true';
  process.env.TRACE_VERBOSITY = 'full';
  process.env.TRACE_PARAMS = 'true';
  process.env.TRACE_RESULTS = 'true';
  process.env.TRACE_MEMORY = 'true';
  console.log('✅ Verbose tracing enabled');
};

export const enableMinimalTracing = () => {
  process.env.DEBUG_TRACE = 'true';
  process.env.TRACE_VERBOSITY = 'summary';
  process.env.TRACE_PARAMS = 'false';
  process.env.TRACE_RESULTS = 'false';
  process.env.TRACE_MEMORY = 'false';
  console.log('✅ Minimal tracing enabled');
};