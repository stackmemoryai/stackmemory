/**
 * Discovery MCP Tool Handlers
 * Intelligently discovers relevant files based on current context
 */

import { FrameManager } from '../../../core/context/index.js';
import { LLMContextRetrieval } from '../../../core/retrieval/index.js';
import { logger } from '../../../core/monitoring/logger.js';
import { execSync } from 'child_process';
import { existsSync, readFileSync, _readdirSync, _statSync } from 'fs';
import { join, _relative, _extname } from 'path';
import Database from 'better-sqlite3';

export interface DiscoveryDependencies {
  frameManager: FrameManager;
  contextRetrieval: LLMContextRetrieval;
  db: Database.Database;
  projectRoot: string;
}

interface DiscoveredFile {
  path: string;
  relevance: 'high' | 'medium' | 'low';
  reason: string;
  matchedKeywords?: string[];
  excerpt?: string;
}

interface DiscoveryResult {
  files: DiscoveredFile[];
  keywords: string[];
  contextSummary: string;
  mdContext: Record<string, string>;
}

export class DiscoveryHandlers {
  constructor(private deps: DiscoveryDependencies) {}

  /**
   * Discover relevant files based on current context
   */
  async handleDiscover(args: {
    query?: string;
    depth?: 'shallow' | 'medium' | 'deep';
    includePatterns?: string[];
    excludePatterns?: string[];
    maxFiles?: number;
  }): Promise<any> {
    try {
      const {
        query,
        depth = 'medium',
        includePatterns = ['*.ts', '*.tsx', '*.js', '*.md', '*.json'],
        excludePatterns = ['node_modules', 'dist', '.git', '*.min.js'],
        maxFiles = 20,
      } = args;

      logger.info('Starting discovery', { query, depth });

      // Step 1: Extract keywords from current context
      const keywords = this.extractContextKeywords(query);

      // Step 2: Parse .md files for additional context
      const mdContext = this.parseMdFiles();

      // Step 3: Get recently touched files from frames
      const recentFiles = this.getRecentFilesFromContext();

      // Step 4: Search codebase for relevant files
      const discoveredFiles = await this.searchCodebase(
        keywords,
        includePatterns,
        excludePatterns,
        depth,
        maxFiles
      );

      // Step 5: Merge and rank results
      const rankedFiles = this.rankFiles(
        discoveredFiles,
        recentFiles,
        keywords
      );

      // Step 6: Generate context summary
      const contextSummary = this.generateContextSummary(keywords, rankedFiles);

      const result: DiscoveryResult = {
        files: rankedFiles.slice(0, maxFiles),
        keywords,
        contextSummary,
        mdContext,
      };

      return {
        content: [
          {
            type: 'text',
            text: this.formatDiscoveryResult(result),
          },
        ],
        metadata: result,
      };
    } catch (error) {
      logger.error('Discovery failed', error);
      throw error;
    }
  }

  /**
   * Get related files to a specific file or concept
   */
  async handleRelatedFiles(args: {
    file?: string;
    concept?: string;
    maxFiles?: number;
  }): Promise<any> {
    try {
      const { file, concept, maxFiles = 10 } = args;

      if (!file && !concept) {
        throw new Error('Either file or concept is required');
      }

      let relatedFiles: DiscoveredFile[] = [];

      if (file) {
        // Find files that import/reference this file
        relatedFiles = this.findFileReferences(file, maxFiles);
      }

      if (concept) {
        // Search for files mentioning this concept
        const conceptFiles = this.searchForConcept(concept, maxFiles);
        relatedFiles = this.mergeAndDedupe(relatedFiles, conceptFiles);
      }

      return {
        content: [
          {
            type: 'text',
            text: this.formatRelatedFiles(relatedFiles, file, concept),
          },
        ],
        metadata: { relatedFiles },
      };
    } catch (error) {
      logger.error('Related files search failed', error);
      throw error;
    }
  }

  /**
   * Get session summary with actionable context
   */
  async handleSessionSummary(args: {
    includeFiles?: boolean;
    includeDecisions?: boolean;
  }): Promise<any> {
    try {
      const { includeFiles = true, includeDecisions = true } = args;

      const hotStack = this.deps.frameManager.getHotStackContext(50);
      const recentFiles = includeFiles ? this.getRecentFilesFromContext() : [];
      const decisions = includeDecisions ? this.getRecentDecisions() : [];

      const summary = {
        activeFrames: hotStack.length,
        currentGoal:
          hotStack[hotStack.length - 1]?.header?.goal || 'No active task',
        recentFiles: recentFiles.slice(0, 10),
        decisions: decisions.slice(0, 5),
        stackDepth: this.deps.frameManager.getStackDepth(),
      };

      return {
        content: [
          {
            type: 'text',
            text: this.formatSessionSummary(summary),
          },
        ],
        metadata: summary,
      };
    } catch (error) {
      logger.error('Session summary failed', error);
      throw error;
    }
  }

  // ===============================
  // Private helper methods
  // ===============================

  private extractContextKeywords(query?: string): string[] {
    const keywords: Set<string> = new Set();

    // Add query terms
    if (query) {
      const queryWords = query
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2);
      queryWords.forEach((w) => keywords.add(w));
    }

    // Extract from current frames
    const hotStack = this.deps.frameManager.getHotStackContext(20);
    for (const frame of hotStack) {
      // Frame name/goal
      if (frame.header?.goal) {
        const goalWords = frame.header.goal
          .toLowerCase()
          .split(/[\s\-_]+/)
          .filter((w) => w.length > 2);
        goalWords.forEach((w) => keywords.add(w));
      }

      // Constraints
      frame.header?.constraints?.forEach((c: string) => {
        const words = c
          .toLowerCase()
          .split(/[\s\-_]+/)
          .filter((w) => w.length > 2);
        words.forEach((w) => keywords.add(w));
      });

      // Recent events
      frame.recentEvents?.forEach((evt: any) => {
        if (evt.data?.content) {
          const words = String(evt.data.content)
            .toLowerCase()
            .split(/[\s\-_]+/)
            .filter((w) => w.length > 3)
            .slice(0, 5);
          words.forEach((w) => keywords.add(w));
        }
      });
    }

    // Extract from recent files in events
    try {
      const fileEvents = this.deps.db
        .prepare(
          `
        SELECT DISTINCT data FROM events e
        JOIN frames f ON e.frame_id = f.frame_id
        WHERE e.type IN ('file_read', 'file_write', 'file_edit')
        ORDER BY e.timestamp DESC
        LIMIT 20
      `
        )
        .all() as Array<{ data: string }>;

      for (const evt of fileEvents) {
        try {
          const data = JSON.parse(evt.data || '{}');
          if (data.path) {
            // Extract meaningful parts from file path
            const pathParts = data.path.split('/').slice(-2);
            pathParts.forEach((part: string) => {
              const words = part
                .replace(/\.[^.]+$/, '')
                .split(/[\-_]+/)
                .filter((w) => w.length > 2);
              words.forEach((w) => keywords.add(w.toLowerCase()));
            });
          }
        } catch {}
      }
    } catch {}

    // Remove common stopwords
    const stopwords = new Set([
      'the',
      'and',
      'for',
      'with',
      'this',
      'that',
      'from',
      'have',
      'has',
      'been',
      'will',
      'can',
      'should',
      'would',
      'could',
      'function',
      'const',
      'let',
      'var',
      'import',
      'export',
      'return',
      'async',
      'await',
    ]);

    return Array.from(keywords).filter((k) => !stopwords.has(k));
  }

  private parseMdFiles(): Record<string, string> {
    const mdContext: Record<string, string> = {};
    const mdFiles = ['CLAUDE.md', 'README.md', '.stackmemory/context.md'];

    for (const mdFile of mdFiles) {
      const fullPath = join(this.deps.projectRoot, mdFile);
      if (existsSync(fullPath)) {
        try {
          const content = readFileSync(fullPath, 'utf8');
          // Extract key sections
          const sections = this.extractMdSections(content);
          mdContext[mdFile] = sections;
        } catch {}
      }
    }

    // Also check ~/.claude/CLAUDE.md
    const homeClaude = join(process.env['HOME'] || '', '.claude', 'CLAUDE.md');
    if (existsSync(homeClaude)) {
      try {
        const content = readFileSync(homeClaude, 'utf8');
        mdContext['~/.claude/CLAUDE.md'] = this.extractMdSections(content);
      } catch {}
    }

    return mdContext;
  }

  private extractMdSections(content: string): string {
    // Extract meaningful sections (headers and their content)
    const lines = content.split('\n');
    const sections: string[] = [];
    let currentSection = '';
    let inCodeBlock = false;

    for (const line of lines) {
      if (line.startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        continue;
      }
      if (inCodeBlock) continue;

      if (line.startsWith('#')) {
        if (currentSection) sections.push(currentSection.trim());
        currentSection = line + '\n';
      } else if (currentSection && line.trim()) {
        currentSection += line + '\n';
      }
    }
    if (currentSection) sections.push(currentSection.trim());

    // Return condensed version (first 500 chars of each section)
    return sections
      .map((s) => (s.length > 500 ? s.slice(0, 500) + '...' : s))
      .join('\n\n');
  }

  private getRecentFilesFromContext(): string[] {
    const files: Set<string> = new Set();

    try {
      const fileEvents = this.deps.db
        .prepare(
          `
        SELECT DISTINCT data FROM events e
        JOIN frames f ON e.frame_id = f.frame_id
        WHERE e.type IN ('file_read', 'file_write', 'file_edit', 'tool_call')
        AND e.timestamp > ?
        ORDER BY e.timestamp DESC
        LIMIT 50
      `
        )
        .all(Math.floor(Date.now() / 1000) - 3600) as Array<{ data: string }>; // Last hour

      for (const evt of fileEvents) {
        try {
          const data = JSON.parse(evt.data || '{}');
          if (data.path) files.add(data.path);
          if (data.file) files.add(data.file);
          if (data.file_path) files.add(data.file_path);
        } catch {}
      }
    } catch {}

    // Also get from git status
    try {
      const gitStatus = execSync('git status --porcelain', {
        cwd: this.deps.projectRoot,
        encoding: 'utf8',
      });
      const modifiedFiles = gitStatus
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => l.slice(3).trim())
        .filter((f) => f);
      modifiedFiles.forEach((f) => files.add(f));
    } catch {}

    return Array.from(files);
  }

  private async searchCodebase(
    keywords: string[],
    includePatterns: string[],
    excludePatterns: string[],
    depth: 'shallow' | 'medium' | 'deep',
    _maxFiles: number
  ): Promise<DiscoveredFile[]> {
    const files: DiscoveredFile[] = [];
    const maxResults = depth === 'shallow' ? 10 : depth === 'medium' ? 25 : 50;

    // Build grep command for each keyword
    for (const keyword of keywords.slice(0, 10)) {
      try {
        const excludeArgs = excludePatterns
          .map((p) => `--exclude-dir=${p}`)
          .join(' ');
        const includeArgs = includePatterns
          .map((p) => `--include=${p}`)
          .join(' ');

        const cmd = `grep -ril ${excludeArgs} ${includeArgs} "${keyword}" . 2>/dev/null | head -${maxResults}`;
        const result = execSync(cmd, {
          cwd: this.deps.projectRoot,
          encoding: 'utf8',
          timeout: 5000,
        });

        const matchedFiles = result.split('\n').filter((f) => f.trim());
        for (const file of matchedFiles) {
          const cleanPath = file.replace(/^\.\//, '');
          const existing = files.find((f) => f.path === cleanPath);
          if (existing) {
            existing.matchedKeywords = existing.matchedKeywords || [];
            if (!existing.matchedKeywords.includes(keyword)) {
              existing.matchedKeywords.push(keyword);
            }
          } else {
            files.push({
              path: cleanPath,
              relevance: 'medium',
              reason: `Contains keyword: ${keyword}`,
              matchedKeywords: [keyword],
            });
          }
        }
      } catch {
        // Grep failed for this keyword, continue
      }
    }

    // Boost relevance for files with multiple keyword matches
    for (const file of files) {
      const matchCount = file.matchedKeywords?.length || 0;
      if (matchCount >= 3) {
        file.relevance = 'high';
        file.reason = `Matches ${matchCount} keywords: ${file.matchedKeywords?.slice(0, 3).join(', ')}`;
      }
    }

    return files;
  }

  private rankFiles(
    discovered: DiscoveredFile[],
    recent: string[],
    _keywords: string[]
  ): DiscoveredFile[] {
    const _recentSet = new Set(recent);

    // Add recent files with high relevance
    for (const recentFile of recent) {
      const existing = discovered.find((f) => f.path === recentFile);
      if (existing) {
        existing.relevance = 'high';
        existing.reason = 'Recently accessed + ' + existing.reason;
      } else {
        discovered.push({
          path: recentFile,
          relevance: 'high',
          reason: 'Recently accessed in context',
        });
      }
    }

    // Sort by relevance and match count
    return discovered.sort((a, b) => {
      const relevanceOrder = { high: 3, medium: 2, low: 1 };
      const relDiff = relevanceOrder[b.relevance] - relevanceOrder[a.relevance];
      if (relDiff !== 0) return relDiff;

      const aMatches = a.matchedKeywords?.length || 0;
      const bMatches = b.matchedKeywords?.length || 0;
      return bMatches - aMatches;
    });
  }

  private findFileReferences(file: string, maxFiles: number): DiscoveredFile[] {
    const results: DiscoveredFile[] = [];

    try {
      // Search for imports of this file
      const basename = file.replace(/\.[^.]+$/, '');
      const cmd = `grep -ril "from.*${basename}" . --include="*.ts" --include="*.tsx" --include="*.js" --exclude-dir=node_modules --exclude-dir=dist 2>/dev/null | head -${maxFiles}`;
      const result = execSync(cmd, {
        cwd: this.deps.projectRoot,
        encoding: 'utf8',
        timeout: 5000,
      });

      const files = result.split('\n').filter((f) => f.trim());
      for (const f of files) {
        results.push({
          path: f.replace(/^\.\//, ''),
          relevance: 'high',
          reason: `Imports ${file}`,
        });
      }
    } catch {}

    return results;
  }

  private searchForConcept(
    concept: string,
    maxFiles: number
  ): DiscoveredFile[] {
    const results: DiscoveredFile[] = [];

    try {
      const cmd = `grep -ril "${concept}" . --include="*.ts" --include="*.tsx" --include="*.md" --exclude-dir=node_modules --exclude-dir=dist 2>/dev/null | head -${maxFiles}`;
      const result = execSync(cmd, {
        cwd: this.deps.projectRoot,
        encoding: 'utf8',
        timeout: 5000,
      });

      const files = result.split('\n').filter((f) => f.trim());
      for (const f of files) {
        results.push({
          path: f.replace(/^\.\//, ''),
          relevance: 'medium',
          reason: `Contains "${concept}"`,
        });
      }
    } catch {}

    return results;
  }

  private mergeAndDedupe(
    a: DiscoveredFile[],
    b: DiscoveredFile[]
  ): DiscoveredFile[] {
    const pathSet = new Set(a.map((f) => f.path));
    const merged = [...a];

    for (const file of b) {
      if (!pathSet.has(file.path)) {
        merged.push(file);
        pathSet.add(file.path);
      }
    }

    return merged;
  }

  private getRecentDecisions(): any[] {
    try {
      const decisions = this.deps.db
        .prepare(
          `
        SELECT a.text, a.type, a.priority, f.name as frame_name, a.created_at
        FROM anchors a
        JOIN frames f ON a.frame_id = f.frame_id
        WHERE a.type IN ('DECISION', 'CONSTRAINT', 'FACT')
        ORDER BY a.created_at DESC
        LIMIT 10
      `
        )
        .all();
      return decisions;
    } catch {
      return [];
    }
  }

  private generateContextSummary(
    keywords: string[],
    files: DiscoveredFile[]
  ): string {
    const hotStack = this.deps.frameManager.getHotStackContext(5);
    const currentGoal = hotStack[hotStack.length - 1]?.header?.goal;

    let summary = '';
    if (currentGoal) {
      summary += `Current task: ${currentGoal}\n`;
    }
    summary += `Context keywords: ${keywords.slice(0, 10).join(', ')}\n`;
    summary += `Relevant files found: ${files.length}\n`;
    summary += `High relevance: ${files.filter((f) => f.relevance === 'high').length}`;

    return summary;
  }

  private formatDiscoveryResult(result: DiscoveryResult): string {
    let output = '# Discovery Results\n\n';

    output += '## Context Summary\n';
    output += result.contextSummary + '\n\n';

    output += '## Relevant Files\n\n';
    for (const file of result.files.slice(0, 15)) {
      const icon =
        file.relevance === 'high'
          ? '[HIGH]'
          : file.relevance === 'medium'
            ? '[MED]'
            : '[LOW]';
      output += `${icon} ${file.path}\n`;
      output += `      ${file.reason}\n`;
    }

    if (result.keywords.length > 0) {
      output += '\n## Keywords Used\n';
      output += result.keywords.slice(0, 15).join(', ') + '\n';
    }

    return output;
  }

  private formatRelatedFiles(
    files: DiscoveredFile[],
    file?: string,
    concept?: string
  ): string {
    let output = '# Related Files\n\n';

    if (file) output += `Related to file: ${file}\n`;
    if (concept) output += `Related to concept: ${concept}\n`;
    output += '\n';

    for (const f of files) {
      output += `- ${f.path}\n  ${f.reason}\n`;
    }

    return output;
  }

  private formatSessionSummary(summary: any): string {
    let output = '# Session Summary\n\n';

    output += `**Current Goal:** ${summary.currentGoal}\n`;
    output += `**Active Frames:** ${summary.activeFrames}\n`;
    output += `**Stack Depth:** ${summary.stackDepth}\n\n`;

    if (summary.recentFiles.length > 0) {
      output += '## Recent Files\n';
      for (const f of summary.recentFiles) {
        output += `- ${f}\n`;
      }
      output += '\n';
    }

    if (summary.decisions.length > 0) {
      output += '## Recent Decisions\n';
      for (const d of summary.decisions) {
        output += `- [${d.type}] ${d.text}\n`;
      }
    }

    return output;
  }
}
