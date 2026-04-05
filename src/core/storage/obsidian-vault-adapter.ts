/**
 * Obsidian Vault Adapter
 *
 * Serializes StackMemory frames as .md files with YAML frontmatter and
 * [[wiki-links]] into an Obsidian vault directory. Obsidian auto-detects
 * file changes — no plugin needed.
 *
 * Also watches a raw/ directory for web clipper output and ingests
 * new .md files as frames.
 *
 * Structure:
 *   vault/
 *     stackmemory/
 *       frames/           ← serialized frames
 *       index.md          ← auto-maintained index
 *       raw/              ← web clipper drops files here
 *       sessions/         ← session summaries
 */

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  watch,
} from 'fs';
import { join } from 'path';
import { logger } from '../monitoring/logger.js';
import { frameLifecycleHooks } from '../context/frame-lifecycle-hooks.js';
import type { Frame, Anchor, Event } from '../context/frame-types.js';
import { WikiCompiler } from '../wiki/wiki-compiler.js';

// ── Types ──

export interface ObsidianVaultConfig {
  /** Path to the Obsidian vault root */
  vaultPath: string;
  /** Subdirectory within vault for StackMemory data (default: "stackmemory") */
  subdir?: string;
  /** Watch raw/ for web clipper input (default: true) */
  watchRaw?: boolean;
  /** Auto-update index.md on frame changes (default: true) */
  autoIndex?: boolean;
  /** Include full event log in frame files (default: false — too verbose) */
  includeEvents?: boolean;
}

export interface IngestCallback {
  (
    file: string,
    content: string,
    metadata: Record<string, string>
  ): Promise<void>;
}

// ── Adapter ──

export class ObsidianVaultAdapter {
  private config: Required<ObsidianVaultConfig>;
  private dirs: {
    root: string;
    frames: string;
    raw: string;
    sessions: string;
    wiki: string;
  };
  private watcher: ReturnType<typeof watch> | null = null;
  private ingestCallback: IngestCallback | null = null;
  private seenRawFiles = new Set<string>();
  private unregisterCreate: (() => void) | null = null;
  private unregisterClose: (() => void) | null = null;
  private wikiCompiler: WikiCompiler | null = null;

  constructor(config: ObsidianVaultConfig) {
    this.config = {
      vaultPath: config.vaultPath,
      subdir: config.subdir ?? 'stackmemory',
      watchRaw: config.watchRaw ?? true,
      autoIndex: config.autoIndex ?? true,
      includeEvents: config.includeEvents ?? false,
    };

    const root = join(this.config.vaultPath, this.config.subdir);
    this.dirs = {
      root,
      frames: join(root, 'frames'),
      raw: join(root, 'raw'),
      sessions: join(root, 'sessions'),
      wiki: join(root, 'wiki'),
    };
  }

  /** Initialize vault directory structure and register lifecycle hooks */
  async initialize(): Promise<void> {
    // Create directories
    for (const dir of Object.values(this.dirs)) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    // Seed raw/ README
    const rawReadme = join(this.dirs.raw, 'README.md');
    if (!existsSync(rawReadme)) {
      writeFileSync(
        rawReadme,
        [
          '# Raw Ingest',
          '',
          'Drop .md files here (e.g., from Obsidian Web Clipper).',
          'StackMemory will auto-ingest them as frames.',
          '',
          '## Setup',
          '',
          '1. Install [Obsidian Web Clipper](https://obsidian.md/clipper)',
          '2. Set the clip destination to this folder',
          '3. StackMemory watches for new files and ingests them',
        ].join('\n')
      );
    }

    // Initialize wiki compiler
    this.wikiCompiler = new WikiCompiler({ wikiDir: this.dirs.wiki });
    await this.wikiCompiler.initialize();

    // Register frame lifecycle hooks
    this.unregisterCreate = frameLifecycleHooks.onFrameCreated(
      'obsidian-vault',
      async (frame) => {
        await this.writeFrame(frame);
      }
    );

    this.unregisterClose = frameLifecycleHooks.onFrameClosed(
      'obsidian-vault',
      async (data) => {
        await this.writeFrame(data.frame, data.events, data.anchors);
        if (this.config.autoIndex) {
          await this.updateIndex();
        }
      }
    );

    // Start watching raw/ for new files
    if (this.config.watchRaw) {
      this.startWatching();
    }

    // Write initial index
    if (this.config.autoIndex) {
      await this.updateIndex();
    }

    logger.info('Obsidian vault adapter initialized', {
      vault: this.config.vaultPath,
      subdir: this.config.subdir,
    });
  }

  /** Set callback for when raw files are ingested */
  onIngest(callback: IngestCallback): void {
    this.ingestCallback = callback;
  }

  /** Write a frame as a .md file */
  async writeFrame(
    frame: Frame,
    events?: Event[],
    anchors?: Anchor[]
  ): Promise<string> {
    const filename = this.frameFilename(frame);
    const filepath = join(this.dirs.frames, filename);
    const content = this.serializeFrame(frame, events, anchors);

    writeFileSync(filepath, content);
    logger.debug('Wrote frame to vault', {
      frameId: frame.frame_id,
      file: filename,
    });

    return filepath;
  }

  /** Write a session summary */
  async writeSessionSummary(
    sessionId: string,
    summary: string,
    frames: Frame[]
  ): Promise<string> {
    const filename = `session-${sessionId.slice(0, 12)}.md`;
    const filepath = join(this.dirs.sessions, filename);

    const frameLinks = frames
      .map(
        (f) =>
          `- [[${this.frameFilename(f).replace('.md', '')}|${f.name}]] (${f.type})`
      )
      .join('\n');

    const content = [
      '---',
      `session_id: "${sessionId}"`,
      `created: ${new Date().toISOString()}`,
      `frame_count: ${frames.length}`,
      '---',
      '',
      `# Session ${sessionId.slice(0, 12)}`,
      '',
      summary,
      '',
      '## Frames',
      '',
      frameLinks,
    ].join('\n');

    writeFileSync(filepath, content);
    return filepath;
  }

  /** Update the auto-maintained index.md */
  async updateIndex(): Promise<void> {
    const framesDir = this.dirs.frames;
    if (!existsSync(framesDir)) return;

    const files = readdirSync(framesDir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .reverse(); // newest first

    const frameLinks = files.slice(0, 100).map((f) => {
      const name = f.replace('.md', '');
      return `- [[frames/${name}]]`;
    });

    // Count by type
    const typeCounts: Record<string, number> = {};
    for (const f of files) {
      const match = f.match(/^(\w+)-/);
      if (match) {
        typeCounts[match[1]] = (typeCounts[match[1]] || 0) + 1;
      }
    }

    const typeStats = Object.entries(typeCounts)
      .map(([type, count]) => `| ${type} | ${count} |`)
      .join('\n');

    // Sessions
    const sessionsDir = this.dirs.sessions;
    const sessionFiles = existsSync(sessionsDir)
      ? readdirSync(sessionsDir).filter(
          (f) => f.endsWith('.md') && f !== 'README.md'
        )
      : [];
    const sessionLinks = sessionFiles
      .slice(0, 20)
      .map((f) => `- [[sessions/${f.replace('.md', '')}]]`);

    const content = [
      '---',
      `updated: ${new Date().toISOString()}`,
      `total_frames: ${files.length}`,
      '---',
      '',
      '# StackMemory Index',
      '',
      `> Auto-maintained by StackMemory. ${files.length} frames indexed.`,
      '',
      '## Frame Types',
      '',
      '| Type | Count |',
      '|------|-------|',
      typeStats,
      '',
      '## Recent Frames',
      '',
      ...frameLinks.slice(0, 30),
      files.length > 30 ? `\n_...and ${files.length - 30} more_` : '',
      '',
      sessionLinks.length > 0 ? '## Sessions\n' : '',
      ...sessionLinks,
      '',
      '## Raw Ingest',
      '',
      '[[raw/README|Drop web clipper files in raw/]]',
    ].join('\n');

    writeFileSync(join(this.dirs.root, 'index.md'), content);
  }

  /** Serialize a Frame to Obsidian-flavored markdown */
  private serializeFrame(
    frame: Frame,
    events?: Event[],
    anchors?: Anchor[]
  ): string {
    const lines: string[] = [];

    // YAML frontmatter
    lines.push('---');
    lines.push(`frame_id: "${frame.frame_id}"`);
    lines.push(`type: "${frame.type}"`);
    lines.push(`name: "${this.escapeYaml(frame.name)}"`);
    lines.push(`state: "${frame.state}"`);
    lines.push(`depth: ${frame.depth}`);
    lines.push(`project_id: "${frame.project_id}"`);
    lines.push(`run_id: "${frame.run_id}"`);
    lines.push(`created_at: ${frame.created_at}`);
    if (frame.closed_at) lines.push(`closed_at: ${frame.closed_at}`);
    if (frame.parent_frame_id)
      lines.push(`parent_frame_id: "${frame.parent_frame_id}"`);
    lines.push(`tags: [stackmemory, ${frame.type}]`);
    lines.push('---');
    lines.push('');

    // Title
    lines.push(`# ${frame.name}`);
    lines.push('');

    // Parent link
    if (frame.parent_frame_id) {
      lines.push(
        `Parent: [[${frame.type}-${frame.parent_frame_id.slice(0, 8)}]]`
      );
      lines.push('');
    }

    // Metadata
    lines.push(
      `**Type:** \`${frame.type}\` | **State:** \`${frame.state}\` | **Depth:** ${frame.depth}`
    );
    lines.push(`**Created:** ${new Date(frame.created_at).toISOString()}`);
    if (frame.closed_at) {
      const duration = Math.round((frame.closed_at - frame.created_at) / 1000);
      lines.push(
        `**Closed:** ${new Date(frame.closed_at).toISOString()} (${duration}s)`
      );
    }
    lines.push('');

    // Digest
    if (frame.digest_text) {
      lines.push('## Digest');
      lines.push('');
      lines.push(frame.digest_text);
      lines.push('');
    }

    // Inputs
    if (frame.inputs && Object.keys(frame.inputs).length > 0) {
      lines.push('## Inputs');
      lines.push('');
      lines.push('```json');
      lines.push(JSON.stringify(frame.inputs, null, 2));
      lines.push('```');
      lines.push('');
    }

    // Outputs
    if (frame.outputs && Object.keys(frame.outputs).length > 0) {
      lines.push('## Outputs');
      lines.push('');
      lines.push('```json');
      lines.push(JSON.stringify(frame.outputs, null, 2));
      lines.push('```');
      lines.push('');
    }

    // Anchors (DECISION, FACT, etc.)
    if (anchors && anchors.length > 0) {
      lines.push('## Anchors');
      lines.push('');
      for (const anchor of anchors) {
        lines.push(`### ${anchor.type}: ${this.escapeYaml(anchor.content)}`);
        lines.push('');
      }
    }

    // Events (optional, verbose)
    if (this.config.includeEvents && events && events.length > 0) {
      lines.push('## Events');
      lines.push('');
      for (const event of events.slice(-20)) {
        const ts = new Date(event.ts).toISOString().substring(11, 19);
        lines.push(
          `- \`${ts}\` **${event.event_type}** ${this.summarizePayload(event.payload)}`
        );
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /** Generate a filename for a frame */
  private frameFilename(frame: Frame): string {
    const id = frame.frame_id.slice(0, 8);
    const name = frame.name
      .replace(/[^a-zA-Z0-9-_]/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 40);
    return `${frame.type}-${id}-${name}.md`;
  }

  /** Escape special YAML characters */
  private escapeYaml(s: string): string {
    return s.replace(/"/g, '\\"').replace(/\n/g, ' ');
  }

  /** Summarize event payload for compact display */
  private summarizePayload(payload: Record<string, unknown>): string {
    const str = JSON.stringify(payload);
    return str.length > 120 ? str.slice(0, 117) + '...' : str;
  }

  // ── Raw File Watcher ──

  /** Watch raw/ directory for new .md files from web clipper */
  private startWatching(): void {
    if (!existsSync(this.dirs.raw)) return;

    // Index existing files
    for (const f of readdirSync(this.dirs.raw)) {
      this.seenRawFiles.add(f);
    }

    this.watcher = watch(this.dirs.raw, async (eventType, filename) => {
      if (!filename || !filename.endsWith('.md')) return;
      if (filename === 'README.md') return;
      if (this.seenRawFiles.has(filename)) return;

      // Debounce — wait for file to finish writing
      const filepath = join(this.dirs.raw, filename);
      if (!existsSync(filepath)) return;

      await new Promise((resolve) => setTimeout(resolve, 1000));

      if (!existsSync(filepath)) return;
      this.seenRawFiles.add(filename);

      logger.info('Raw file detected for ingest', { filename });

      try {
        const content = readFileSync(filepath, 'utf-8');
        const metadata = this.parseClipperMetadata(content);

        if (this.ingestCallback) {
          await this.ingestCallback(filename, content, metadata);
        }

        // Compile raw ingest into wiki articles
        if (this.wikiCompiler) {
          try {
            await this.wikiCompiler.compileRawIngest(
              filename,
              content,
              metadata
            );
          } catch (err) {
            logger.debug('Wiki compile on raw ingest failed', {
              error: (err as Error).message,
            });
          }
        }

        logger.info('Ingested raw file', {
          filename,
          source: metadata.source || 'unknown',
        });
      } catch (err) {
        logger.error('Failed to ingest raw file', {
          filename,
          error: (err as Error).message,
        });
      }
    });

    logger.info('Watching raw/ for web clipper files', { dir: this.dirs.raw });
  }

  /** Parse Obsidian Web Clipper YAML frontmatter */
  private parseClipperMetadata(content: string): Record<string, string> {
    const metadata: Record<string, string> = {};

    if (!content.startsWith('---')) return metadata;

    const end = content.indexOf('---', 3);
    if (end === -1) return metadata;

    const yaml = content.slice(3, end).trim();
    for (const line of yaml.split('\n')) {
      const match = line.match(/^(\w+):\s*(.+)/);
      if (match) {
        metadata[match[1]] = match[2].replace(/^["']|["']$/g, '');
      }
    }

    return metadata;
  }

  /** Stop watching and clean up */
  async cleanup(): Promise<void> {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    // Deregister hooks
    if (this.unregisterCreate) this.unregisterCreate();
    if (this.unregisterClose) this.unregisterClose();

    logger.info('Obsidian vault adapter cleaned up');
  }
}

// ── Auto-init singleton ──

let _instance: ObsidianVaultAdapter | null = null;

/**
 * Initialize the Obsidian vault adapter from StackMemory config.
 * Safe to call multiple times — only initializes once.
 * Returns null if obsidian is not configured.
 */
export async function initObsidianVault(): Promise<ObsidianVaultAdapter | null> {
  if (_instance) return _instance;

  try {
    const configPath = join(process.cwd(), '.stackmemory', 'config.yaml');
    if (!existsSync(configPath)) return null;

    const content = readFileSync(configPath, 'utf-8');
    // Simple YAML parse for obsidian.vaultPath
    const vaultMatch = content.match(
      /obsidian:\s*\n\s+vaultPath:\s*["']?([^\n"']+)/
    );
    if (!vaultMatch) return null;

    const vaultPath = vaultMatch[1].trim();
    if (!vaultPath || !existsSync(vaultPath)) {
      logger.warn('Obsidian vaultPath configured but directory not found', {
        vaultPath,
      });
      return null;
    }

    // Parse optional settings
    const subdirMatch = content.match(
      /obsidian:\s*\n(?:\s+\w+:.*\n)*\s+subdir:\s*["']?([^\n"']+)/
    );
    const watchRawMatch = content.match(
      /obsidian:\s*\n(?:\s+\w+:.*\n)*\s+watchRaw:\s*(true|false)/
    );
    const autoIndexMatch = content.match(
      /obsidian:\s*\n(?:\s+\w+:.*\n)*\s+autoIndex:\s*(true|false)/
    );

    _instance = new ObsidianVaultAdapter({
      vaultPath,
      subdir: subdirMatch?.[1]?.trim(),
      watchRaw: watchRawMatch ? watchRawMatch[1] === 'true' : undefined,
      autoIndex: autoIndexMatch ? autoIndexMatch[1] === 'true' : undefined,
    });

    await _instance.initialize();
    logger.info('Obsidian vault adapter auto-initialized', { vaultPath });
    return _instance;
  } catch (err) {
    logger.debug('Obsidian vault adapter not initialized', {
      error: (err as Error).message,
    });
    return null;
  }
}

/** Get the current adapter instance (null if not initialized) */
export function getObsidianVault(): ObsidianVaultAdapter | null {
  return _instance;
}
