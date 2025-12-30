/**
 * Optimized Streaming JSONL Parser
 * Memory-efficient parsing for large JSONL files with async streaming
 */

import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { Transform, pipeline } from 'stream';
import { promisify } from 'util';
import { logger } from '../monitoring/logger.js';

const pipelineAsync = promisify(pipeline);

export interface ParseOptions {
  maxLineLength?: number;
  batchSize?: number;
  filter?: (obj: any) => boolean;
  transform?: (obj: any) => any;
  onProgress?: (processed: number, total?: number) => void;
}

export class StreamingJSONLParser {
  private readonly DEFAULT_BATCH_SIZE = 100;
  private readonly DEFAULT_MAX_LINE_LENGTH = 1024 * 1024; // 1MB per line

  /**
   * Stream-parse a JSONL file with batching and backpressure handling
   */
  async* parseStream<T = any>(
    filePath: string,
    options: ParseOptions = {}
  ): AsyncGenerator<T[], void, unknown> {
    const {
      batchSize = this.DEFAULT_BATCH_SIZE,
      maxLineLength = this.DEFAULT_MAX_LINE_LENGTH,
      filter,
      transform,
      onProgress,
    } = options;

    const stream = createReadStream(filePath, {
      encoding: 'utf8',
      highWaterMark: 64 * 1024, // 64KB chunks
    });

    const rl = createInterface({
      input: stream,
      crlfDelay: Infinity,
      historySize: 0, // Disable history for memory efficiency
    });

    let batch: T[] = [];
    let lineCount = 0;
    let processedCount = 0;
    let errorCount = 0;

    try {
      for await (const line of rl) {
        lineCount++;

        if (line.length > maxLineLength) {
          logger.warn('Skipping oversized line', {
            lineNumber: lineCount,
            length: line.length,
            maxLength: maxLineLength,
          });
          errorCount++;
          continue;
        }

        if (!line.trim()) continue;

        try {
          let obj = JSON.parse(line);

          if (filter && !filter(obj)) continue;
          if (transform) obj = transform(obj);

          batch.push(obj as T);
          processedCount++;

          if (batch.length >= batchSize) {
            yield batch;
            batch = [];
            onProgress?.(processedCount);
          }
        } catch (parseError) {
          errorCount++;
          logger.debug('Failed to parse JSONL line', {
            lineNumber: lineCount,
            error: parseError,
            preview: line.substring(0, 100),
          });
        }
      }

      // Yield remaining items
      if (batch.length > 0) {
        yield batch;
        onProgress?.(processedCount);
      }
    } finally {
      rl.close();
      stream.destroy();

      logger.debug('JSONL parsing complete', {
        filePath,
        totalLines: lineCount,
        processed: processedCount,
        errors: errorCount,
      });
    }
  }

  /**
   * Parse entire file into memory (use for smaller files)
   */
  async parseAll<T = any>(
    filePath: string,
    options: Omit<ParseOptions, 'batchSize'> = {}
  ): Promise<T[]> {
    const results: T[] = [];

    for await (const batch of this.parseStream<T>(filePath, {
      ...options,
      batchSize: Number.MAX_SAFE_INTEGER,
    })) {
      results.push(...batch);
    }

    return results;
  }

  /**
   * Process JSONL file with a custom processor function
   */
  async process<T = any, R = void>(
    filePath: string,
    processor: (items: T[]) => Promise<R>,
    options: ParseOptions = {}
  ): Promise<R[]> {
    const results: R[] = [];

    for await (const batch of this.parseStream<T>(filePath, options)) {
      const result = await processor(batch);
      results.push(result);
    }

    return results;
  }

  /**
   * Create a transform stream for JSONL parsing
   */
  createTransformStream<T = any>(
    options: ParseOptions = {}
  ): Transform {
    const { filter, transform, maxLineLength = this.DEFAULT_MAX_LINE_LENGTH } = options;
    let buffer = '';
    let lineCount = 0;

    return new Transform({
      objectMode: true,
      transform(chunk: Buffer | string, encoding, callback) {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        
        // Keep incomplete line in buffer
        buffer = lines.pop() || '';

        for (const line of lines) {
          lineCount++;
          
          if (!line.trim()) continue;
          if (line.length > maxLineLength) {
            logger.warn('Skipping oversized line in transform', { lineCount });
            continue;
          }

          try {
            let obj = JSON.parse(line);
            
            if (filter && !filter(obj)) continue;
            if (transform) obj = transform(obj);
            
            this.push(obj);
          } catch (error) {
            logger.debug('Transform parse error', { lineCount, error });
          }
        }

        callback();
      },

      flush(callback) {
        // Process any remaining data
        if (buffer.trim()) {
          try {
            let obj = JSON.parse(buffer);
            if (!filter || filter(obj)) {
              if (transform) obj = transform(obj);
              this.push(obj);
            }
          } catch (error) {
            logger.debug('Flush parse error', { error });
          }
        }
        callback();
      }
    });
  }

  /**
   * Count lines in JSONL file without parsing
   */
  async countLines(filePath: string): Promise<number> {
    const stream = createReadStream(filePath, { encoding: 'utf8' });
    const rl = createInterface({ input: stream, historySize: 0 });
    
    let count = 0;
    for await (const _ of rl) {
      count++;
    }
    
    return count;
  }

  /**
   * Sample random lines from JSONL file
   */
  async* sampleLines<T = any>(
    filePath: string,
    sampleRate: number,
    options: Omit<ParseOptions, 'batchSize'> = {}
  ): AsyncGenerator<T, void, unknown> {
    if (sampleRate <= 0 || sampleRate > 1) {
      throw new Error('Sample rate must be between 0 and 1');
    }

    for await (const batch of this.parseStream<T>(filePath, options)) {
      for (const item of batch) {
        if (Math.random() < sampleRate) {
          yield item;
        }
      }
    }
  }
}