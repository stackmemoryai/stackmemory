/**
 * Debug Trace Module - Comprehensive execution tracing for LLM debugging
 * 
 * This module provides detailed execution tracing to help LLMs understand
 * exactly what happened during code execution, making debugging much easier.
 */

import { performance } from 'perf_hooks';
import { logger } from '../monitoring/logger.js';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

export interface TraceConfig {
  enabled: boolean;
  verbosity: 'full' | 'errors' | 'summary';
  output: 'console' | 'file' | 'both';
  includeParams: boolean;
  includeResults: boolean;
  maskSensitive: boolean;
  performanceThreshold: number; // ms
  maxDepth: number;
  captureMemory: boolean;
}

interface TraceEntry {
  id: string;
  parentId?: string;
  type: 'command' | 'function' | 'step' | 'query' | 'api' | 'error';
  name: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  depth: number;
  params?: any;
  result?: any;
  error?: any;
  memory?: {
    before: NodeJS.MemoryUsage;
    after?: NodeJS.MemoryUsage;
    delta?: {
      rss: number;
      heapUsed: number;
    };
  };
  metadata?: Record<string, any>;
  children: TraceEntry[];
}

export class TraceContext {
  private static instance: TraceContext;
  private config: TraceConfig;
  private currentTrace: TraceEntry | null = null;
  private traceStack: TraceEntry[] = [];
  private allTraces: TraceEntry[] = [];
  private outputFile?: string;
  private startTime: number = Date.now();
  private sensitivePatterns: RegExp[] = [
    /api[_-]?key/i,
    /token/i,
    /secret/i,
    /password/i,
    /bearer/i,
    /authorization/i,
    /client[_-]?id/i,
    /client[_-]?secret/i,
  ];

  private constructor() {
    this.config = this.loadConfig();
    if (this.config.output === 'file' || this.config.output === 'both') {
      this.initializeOutputFile();
    }
  }

  static getInstance(): TraceContext {
    if (!TraceContext.instance) {
      TraceContext.instance = new TraceContext();
    }
    return TraceContext.instance;
  }

  private loadConfig(): TraceConfig {
    return {
      enabled: process.env.DEBUG_TRACE === 'true' || process.env.STACKMEMORY_DEBUG === 'true',
      verbosity: (process.env.TRACE_VERBOSITY as any) || 'full',
      output: (process.env.TRACE_OUTPUT as any) || 'console',
      includeParams: process.env.TRACE_PARAMS !== 'false',
      includeResults: process.env.TRACE_RESULTS !== 'false',
      maskSensitive: process.env.TRACE_MASK_SENSITIVE !== 'false',
      performanceThreshold: parseInt(process.env.TRACE_PERF_THRESHOLD || '100'),
      maxDepth: parseInt(process.env.TRACE_MAX_DEPTH || '20'),
      captureMemory: process.env.TRACE_MEMORY === 'true',
    };
  }

  private initializeOutputFile(): void {
    const traceDir = path.join(process.env.HOME || '.', '.stackmemory', 'traces');
    if (!fs.existsSync(traceDir)) {
      fs.mkdirSync(traceDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.outputFile = path.join(traceDir, `trace-${timestamp}.jsonl`);
  }

  private maskSensitiveData(obj: any): any {
    if (!this.config.maskSensitive) return obj;
    if (typeof obj !== 'object' || obj === null) return obj;

    const masked = Array.isArray(obj) ? [...obj] : { ...obj };
    
    for (const key in masked) {
      if (typeof key === 'string') {
        // Check if key matches sensitive patterns
        const isSensitive = this.sensitivePatterns.some(pattern => pattern.test(key));
        if (isSensitive) {
          masked[key] = '[MASKED]';
        } else if (typeof masked[key] === 'object') {
          masked[key] = this.maskSensitiveData(masked[key]);
        } else if (typeof masked[key] === 'string' && masked[key].length > 20) {
          // Check if value looks like a token/key
          if (/^[a-zA-Z0-9_-]{20,}$/.test(masked[key])) {
            masked[key] = masked[key].substring(0, 8) + '...[MASKED]';
          }
        }
      }
    }
    
    return masked;
  }

  private captureMemory(): NodeJS.MemoryUsage | undefined {
    if (!this.config.captureMemory) return undefined;
    return process.memoryUsage();
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms.toFixed(0)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
    return `${(ms / 60000).toFixed(2)}m`;
  }

  private formatMemory(bytes: number): string {
    const mb = bytes / 1024 / 1024;
    return `${mb.toFixed(2)}MB`;
  }

  private getIndent(depth: number): string {
    return '  '.repeat(depth);
  }

  private formatTraceEntry(entry: TraceEntry, includeChildren = true): string {
    const indent = this.getIndent(entry.depth);
    const duration = entry.duration ? ` [${this.formatDuration(entry.duration)}]` : '';
    const memory = entry.memory?.delta 
      ? ` (Δmem: ${this.formatMemory(entry.memory.delta.heapUsed)})`
      : '';
    
    let output = `${indent}→ [${entry.type.toUpperCase()}:${entry.id.substring(0, 8)}] ${entry.name}${duration}${memory}`;
    
    if (entry.error) {
      output += `\n${indent}  ✗ ERROR: ${entry.error.message || entry.error}`;
      if (entry.error.stack && this.config.verbosity === 'full') {
        output += `\n${indent}    Stack: ${entry.error.stack.split('\n')[1]?.trim()}`;
      }
    }
    
    if (this.config.includeParams && entry.params && Object.keys(entry.params).length > 0) {
      const maskedParams = this.maskSensitiveData(entry.params);
      output += `\n${indent}  ▸ Params: ${JSON.stringify(maskedParams, null, 2).replace(/\n/g, '\n' + indent + '    ')}`;
    }
    
    if (this.config.includeResults && entry.result !== undefined && !entry.error) {
      const maskedResult = this.maskSensitiveData(entry.result);
      const resultStr = JSON.stringify(maskedResult, null, 2);
      if (resultStr.length < 200) {
        output += `\n${indent}  ◂ Result: ${resultStr.replace(/\n/g, '\n' + indent + '    ')}`;
      } else {
        output += `\n${indent}  ◂ Result: [${typeof maskedResult}] ${resultStr.substring(0, 100)}...`;
      }
    }
    
    if (entry.duration && entry.duration > this.config.performanceThreshold) {
      output += `\n${indent}  ⚠ SLOW: Exceeded ${this.config.performanceThreshold}ms threshold`;
    }
    
    if (includeChildren && entry.children.length > 0) {
      for (const child of entry.children) {
        output += '\n' + this.formatTraceEntry(child, true);
      }
    }
    
    if (entry.endTime && entry.depth > 0) {
      output += `\n${indent}← [${entry.type.toUpperCase()}:${entry.id.substring(0, 8)}] completed`;
    }
    
    return output;
  }

  private outputTrace(entry: TraceEntry): void {
    if (!this.config.enabled) return;

    const formatted = this.formatTraceEntry(entry, false);
    
    if (this.config.output === 'console' || this.config.output === 'both') {
      console.log(formatted);
    }
    
    if ((this.config.output === 'file' || this.config.output === 'both') && this.outputFile) {
      const jsonLine = JSON.stringify({
        ...entry,
        formatted,
        timestamp: new Date().toISOString(),
      }) + '\n';
      fs.appendFileSync(this.outputFile, jsonLine);
    }
  }

  startTrace(type: TraceEntry['type'], name: string, params?: any, metadata?: Record<string, any>): string {
    if (!this.config.enabled) return '';

    const id = uuidv4();
    const parentId = this.currentTrace?.id;
    const depth = this.traceStack.length;

    if (depth > this.config.maxDepth) {
      return id; // Prevent infinite recursion
    }

    const entry: TraceEntry = {
      id,
      parentId,
      type,
      name,
      startTime: performance.now(),
      depth,
      params: this.config.includeParams ? params : undefined,
      metadata,
      children: [],
      memory: this.captureMemory() ? { before: this.captureMemory()! } : undefined,
    };

    if (this.currentTrace) {
      this.currentTrace.children.push(entry);
    } else {
      this.allTraces.push(entry);
    }

    this.traceStack.push(entry);
    this.currentTrace = entry;

    this.outputTrace(entry);

    return id;
  }

  endTrace(id: string, result?: any, error?: any): void {
    if (!this.config.enabled) return;

    const index = this.traceStack.findIndex(t => t.id === id);
    if (index === -1) return;

    const entry = this.traceStack[index];
    entry.endTime = performance.now();
    entry.duration = entry.endTime - entry.startTime;
    entry.result = this.config.includeResults && !error ? result : undefined;
    entry.error = error;

    if (entry.memory?.before) {
      entry.memory.after = this.captureMemory();
      if (entry.memory.after) {
        entry.memory.delta = {
          rss: entry.memory.after.rss - entry.memory.before.rss,
          heapUsed: entry.memory.after.heapUsed - entry.memory.before.heapUsed,
        };
      }
    }

    this.outputTrace(entry);

    // Remove from stack and update current
    this.traceStack.splice(index);
    this.currentTrace = this.traceStack[this.traceStack.length - 1] || null;
  }

  async traceAsync<T>(
    type: TraceEntry['type'],
    name: string,
    params: any,
    fn: () => Promise<T>
  ): Promise<T> {
    const id = this.startTrace(type, name, params);
    try {
      const result = await fn();
      this.endTrace(id, result);
      return result;
    } catch (error) {
      this.endTrace(id, undefined, error);
      throw error;
    }
  }

  traceSync<T>(
    type: TraceEntry['type'],
    name: string,
    params: any,
    fn: () => T
  ): T {
    const id = this.startTrace(type, name, params);
    try {
      const result = fn();
      this.endTrace(id, result);
      return result;
    } catch (error) {
      this.endTrace(id, undefined, error);
      throw error;
    }
  }

  async command<T>(name: string, options: any, fn: () => Promise<T>): Promise<T> {
    return this.traceAsync('command', name, options, fn);
  }

  async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return this.traceAsync('step', name, undefined, fn);
  }

  async query<T>(sql: string, params: any, fn: () => Promise<T>): Promise<T> {
    return this.traceAsync('query', sql.substring(0, 50), params, fn);
  }

  async api<T>(method: string, url: string, body: any, fn: () => Promise<T>): Promise<T> {
    return this.traceAsync('api', `${method} ${url}`, { body }, fn);
  }

  getExecutionSummary(): string {
    if (!this.config.enabled) return 'Tracing disabled';

    const totalDuration = Date.now() - this.startTime;
    const errorCount = this.countErrors(this.allTraces);
    const slowCount = this.countSlowOperations(this.allTraces);

    let summary = `\n${'='.repeat(80)}\n`;
    summary += `EXECUTION SUMMARY\n`;
    summary += `${'='.repeat(80)}\n`;
    summary += `Total Duration: ${this.formatDuration(totalDuration)}\n`;
    summary += `Total Operations: ${this.countOperations(this.allTraces)}\n`;
    summary += `Errors: ${errorCount}\n`;
    summary += `Slow Operations (>${this.config.performanceThreshold}ms): ${slowCount}\n`;

    if (this.config.captureMemory) {
      const memUsage = process.memoryUsage();
      summary += `Final Memory: RSS=${this.formatMemory(memUsage.rss)}, Heap=${this.formatMemory(memUsage.heapUsed)}\n`;
    }

    if (this.outputFile) {
      summary += `Trace Log: ${this.outputFile}\n`;
    }

    summary += `${'='.repeat(80)}`;

    return summary;
  }

  private countOperations(traces: TraceEntry[]): number {
    let count = traces.length;
    for (const trace of traces) {
      count += this.countOperations(trace.children);
    }
    return count;
  }

  private countErrors(traces: TraceEntry[]): number {
    let count = 0;
    for (const trace of traces) {
      if (trace.error) count++;
      count += this.countErrors(trace.children);
    }
    return count;
  }

  private countSlowOperations(traces: TraceEntry[]): number {
    let count = 0;
    for (const trace of traces) {
      if (trace.duration && trace.duration > this.config.performanceThreshold) count++;
      count += this.countSlowOperations(trace.children);
    }
    return count;
  }

  getLastError(): TraceEntry | null {
    const findLastError = (traces: TraceEntry[]): TraceEntry | null => {
      for (let i = traces.length - 1; i >= 0; i--) {
        const trace = traces[i];
        if (trace.error) return trace;
        const childError = findLastError(trace.children);
        if (childError) return childError;
      }
      return null;
    };
    return findLastError(this.allTraces);
  }

  exportTraces(): TraceEntry[] {
    return this.allTraces;
  }

  reset(): void {
    this.currentTrace = null;
    this.traceStack = [];
    this.allTraces = [];
    this.startTime = Date.now();
  }
}

// Singleton instance
export const trace = TraceContext.getInstance();

// Decorator for tracing class methods
export function Trace(type: TraceEntry['type'] = 'function') {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;
    const isAsync = originalMethod.constructor.name === 'AsyncFunction';

    if (isAsync) {
      descriptor.value = async function (...args: any[]) {
        const className = target.constructor.name;
        const methodName = `${className}.${propertyKey}`;
        return trace.traceAsync(type, methodName, args, async () => {
          return originalMethod.apply(this, args);
        });
      };
    } else {
      descriptor.value = function (...args: any[]) {
        const className = target.constructor.name;
        const methodName = `${className}.${propertyKey}`;
        return trace.traceSync(type, methodName, args, () => {
          return originalMethod.apply(this, args);
        });
      };
    }

    return descriptor;
  };
}

// Decorator for tracing entire classes
export function TraceClass(type: TraceEntry['type'] = 'function') {
  return function <T extends { new(...args: any[]): {} }>(constructor: T) {
    const prototype = constructor.prototype;
    const propertyNames = Object.getOwnPropertyNames(prototype);

    for (const propertyName of propertyNames) {
      if (propertyName === 'constructor') continue;

      const descriptor = Object.getOwnPropertyDescriptor(prototype, propertyName);
      if (!descriptor || typeof descriptor.value !== 'function') continue;

      Trace(type)(prototype, propertyName, descriptor);
      Object.defineProperty(prototype, propertyName, descriptor);
    }

    return constructor;
  };
}

// Helper for critical operations
export function TraceCritical(target: any, propertyKey: string, descriptor: PropertyDescriptor) {
  const originalMethod = descriptor.value;
  
  descriptor.value = async function (...args: any[]) {
    const className = target.constructor.name;
    const methodName = `${className}.${propertyKey} [CRITICAL]`;
    
    // Store context before execution
    const contextBefore = {
      memory: process.memoryUsage(),
      timestamp: new Date().toISOString(),
      args: trace['maskSensitiveData'](args),
    };
    
    try {
      return await trace.traceAsync('function', methodName, contextBefore, async () => {
        return originalMethod.apply(this, args);
      });
    } catch (error: any) {
      // Enhanced error logging for critical operations
      logger.error(`Critical operation failed: ${methodName}`, error, {
        context: contextBefore,
        stack: error.stack,
      });
      throw error;
    }
  };
  
  return descriptor;
}