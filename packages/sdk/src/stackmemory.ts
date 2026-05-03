/**
 * StackMemory SDK — main entry point.
 *
 * Usage:
 *   import { StackMemory } from '@stackmemoryai/sdk';
 *   const sm = new StackMemory();
 *   sm.cache.put('hello world', 'test');
 *   sm.packs.list();
 *   sm.provenance.record({ ... });
 *   sm.close();
 */

import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { ContentCache } from './cache.js';
import { SkillPackRegistry } from './packs.js';
import { ProvenanceStore } from './provenance.js';
import { scoreConfidence } from './confidence-scorer.js';
import { createLogger, silentLogger } from './logger.js';
import type {
  StackMemoryConfig,
  ConfidenceScore,
  ConfidenceContext,
} from './types.js';
import type { Logger } from './logger.js';

function defaultDataDir(): string {
  const home = process.env['HOME'] || process.env['USERPROFILE'] || '/tmp';
  return join(home, '.stackmemory');
}

export class StackMemory {
  readonly cache: ContentCache;
  readonly packs: SkillPackRegistry;
  readonly provenance: ProvenanceStore;
  readonly dataDir: string;

  private cacheDb: Database.Database;
  private packsDb: Database.Database;
  private provenanceDb: Database.Database;
  private log: Logger;

  constructor(config: StackMemoryConfig = {}) {
    this.dataDir = config.dataDir ?? defaultDataDir();
    this.log =
      config.logLevel === 'silent'
        ? silentLogger
        : createLogger(config.logLevel);

    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }

    this.cacheDb = new Database(join(this.dataDir, 'content-cache.db'));
    this.cacheDb.pragma('journal_mode = WAL');
    this.cache = new ContentCache(this.cacheDb, this.log);

    this.packsDb = new Database(join(this.dataDir, 'skill-packs.db'));
    this.packsDb.pragma('journal_mode = WAL');
    this.packs = new SkillPackRegistry(this.packsDb, this.log);

    this.provenanceDb = new Database(join(this.dataDir, 'provenance.db'));
    this.provenanceDb.pragma('journal_mode = WAL');
    this.provenance = new ProvenanceStore(this.provenanceDb, this.log);

    this.log.info('StackMemory SDK initialized', { dataDir: this.dataDir });
  }

  /** Score text for decision confidence. */
  scoreConfidence(text: string, context?: ConfidenceContext): ConfidenceScore {
    return scoreConfidence(text, context);
  }

  /** Close all database connections. Call when done. */
  close(): void {
    this.cacheDb.close();
    this.packsDb.close();
    this.provenanceDb.close();
    this.log.info('StackMemory SDK closed');
  }
}
