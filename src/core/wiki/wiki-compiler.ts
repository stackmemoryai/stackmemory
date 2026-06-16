/**
 * Wiki Compiler
 *
 * Incrementally builds and maintains a persistent wiki from accumulated
 * StackMemory context — frames, digests, entity states, anchors, and
 * session summaries. Follows Karpathy's LLM Knowledge Base pattern.
 *
 * Unlike frame-level hooks, the compiler operates on context *over time*:
 * - `create()` — initial wiki from all existing context
 * - `update()` — incremental update from context generated since last compile
 *
 * The wiki is the "reduce" step that RAG lacks — cross-references,
 * contradictions, and synthesis are pre-computed, not re-derived per query.
 *
 * Directory structure:
 *   wiki/
 *     index.md          <- article catalog with summaries
 *     log.md            <- chronological append-only timeline
 *     entities/         <- entity pages (services, people, libraries)
 *     concepts/         <- concept pages (patterns, techniques, decisions)
 *     sources/          <- source summaries (digests, sessions, raw ingest)
 *     synthesis/        <- cross-cutting analysis, comparisons
 */

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from 'fs';
import { join } from 'path';
import { logger } from '../monitoring/logger.js';

// ── Types ──

export interface WikiConfig {
  /** Root directory for wiki output (e.g., vault/stackmemory/wiki) */
  wikiDir: string;
  /** Maximum articles listed in index.md (default: 200) */
  indexLimit?: number;
  /** Maximum log entries kept in log.md (default: 500) */
  logLimit?: number;
}

export interface CompileResult {
  created: string[];
  updated: string[];
  totalArticles: number;
  compiledAt: number;
}

export interface WikiLintResult {
  orphans: string[];
  brokenLinks: Array<{ source: string; target: string }>;
  stale: string[];
  totalArticles: number;
}

/** A context-generated digest row from the database */
export interface DigestRow {
  frame_id: string;
  frame_name: string;
  frame_type: string;
  digest_text: string;
  created_at: number;
  closed_at: number | null;
}

/** An entity state row from the database */
export interface EntityStateRow {
  entity_name: string;
  relation: string;
  value: string;
  context: string | null;
  source_frame_id: string | null;
  valid_from: number;
  superseded_at: number | null;
}

/** An anchor row from the database */
export interface AnchorRow {
  anchor_id: string;
  frame_id: string;
  frame_name: string;
  type: string;
  text: string;
  priority: number;
  created_at: number;
}

/** Session summary from chronological digest */
export interface SessionDigest {
  period: string;
  content: string;
  generatedAt: number;
}

// ── Compiler ──

export class WikiCompiler {
  private config: Required<WikiConfig>;
  private dirs: {
    root: string;
    entities: string;
    concepts: string;
    sources: string;
    synthesis: string;
    sops: string;
  };

  constructor(config: WikiConfig) {
    this.config = {
      wikiDir: config.wikiDir,
      indexLimit: config.indexLimit ?? 200,
      logLimit: config.logLimit ?? 500,
    };

    this.dirs = {
      root: this.config.wikiDir,
      entities: join(this.config.wikiDir, 'entities'),
      concepts: join(this.config.wikiDir, 'concepts'),
      sources: join(this.config.wikiDir, 'sources'),
      synthesis: join(this.config.wikiDir, 'synthesis'),
      sops: join(this.config.wikiDir, 'sops'),
    };
  }

  /** Initialize wiki directory structure */
  async initialize(): Promise<void> {
    for (const dir of Object.values(this.dirs)) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    const indexPath = join(this.dirs.root, 'index.md');
    if (!existsSync(indexPath)) {
      writeFileSync(indexPath, this.generateEmptyIndex());
    }

    const logPath = join(this.dirs.root, 'log.md');
    if (!existsSync(logPath)) {
      writeFileSync(
        logPath,
        [
          '# Wiki Log',
          '',
          '> Chronological record of wiki operations. Parseable with grep.',
          '',
        ].join('\n')
      );
    }

    logger.info('Wiki compiler initialized', { wikiDir: this.config.wikiDir });
  }

  /**
   * Create the wiki from scratch using all available context.
   * Generates entity pages, concept pages, source digests, and a synthesis overview.
   */
  async create(ctx: {
    digests: DigestRow[];
    entities: EntityStateRow[];
    anchors: AnchorRow[];
    sessionDigest?: SessionDigest;
  }): Promise<CompileResult> {
    const created: string[] = [];

    // 1. Entity pages — one per unique entity, all states compiled
    const entitiesByName = this.groupBy(ctx.entities, (e) => e.entity_name);
    for (const [name, states] of entitiesByName) {
      const slug = this.slugify(name);
      const path = `entities/${slug}.md`;
      this.writeArticle(path, this.buildEntityArticle(name, states));
      created.push(path);
    }

    // 2. Concept pages — derived from anchor types (DECISION, FACT, CONSTRAINT, RISK)
    const conceptGroups = this.extractConceptGroups(ctx.anchors);
    for (const [concept, items] of conceptGroups) {
      const slug = this.slugify(concept);
      const path = `concepts/${slug}.md`;
      this.writeArticle(path, this.buildConceptArticle(concept, items));
      created.push(path);
    }

    // 3. Source pages — one per digest (frame summary)
    for (const digest of ctx.digests) {
      const slug = this.slugify(digest.frame_name);
      const path = `sources/${slug}.md`;
      this.writeArticle(path, this.buildSourceArticle(digest));
      created.push(path);
    }

    // 4. Synthesis overview — cross-cutting summary
    if (ctx.digests.length > 0 || ctx.entities.length > 0) {
      const overviewPath = 'synthesis/overview.md';
      this.writeArticle(
        overviewPath,
        this.buildSynthesisOverview(ctx.digests, ctx.entities, ctx.anchors)
      );
      created.push(overviewPath);
    }

    // 5. Session digest as source if provided
    if (ctx.sessionDigest) {
      const path = `sources/session-${this.slugify(ctx.sessionDigest.period)}.md`;
      this.writeArticle(path, this.buildSessionSource(ctx.sessionDigest));
      created.push(path);
    }

    // 6. Derived Company OS SOPs from anchors
    const derivedSops = this.generateDerivedSops(ctx.anchors);
    created.push(...derivedSops);

    this.updateIndex();
    this.appendLog(
      `## [${new Date().toISOString().slice(0, 10)}] create | full wiki`,
      `Created ${created.length} articles from ${ctx.digests.length} digests, ${ctx.entities.length} entity states, ${ctx.anchors.length} anchors`
    );

    return {
      created,
      updated: [],
      totalArticles: this.countArticles(),
      compiledAt: Date.now(),
    };
  }

  /**
   * Incrementally update the wiki with new context since last compile.
   * Updates existing articles or creates new ones as needed.
   */
  async update(ctx: {
    digests: DigestRow[];
    entities: EntityStateRow[];
    anchors: AnchorRow[];
    sessionDigest?: SessionDigest;
  }): Promise<CompileResult> {
    const created: string[] = [];
    const updated: string[] = [];

    // 1. Entity pages — merge new states into existing pages
    const entitiesByName = this.groupBy(ctx.entities, (e) => e.entity_name);
    for (const [name, states] of entitiesByName) {
      const slug = this.slugify(name);
      const path = `entities/${slug}.md`;
      const filepath = join(this.dirs.root, path);

      if (existsSync(filepath)) {
        const existing = readFileSync(filepath, 'utf-8');
        const merged = this.mergeEntityStates(existing, name, states);
        if (merged !== existing) {
          this.writeArticle(path, merged);
          updated.push(path);
        }
      } else {
        this.writeArticle(path, this.buildEntityArticle(name, states));
        created.push(path);
      }
    }

    // 2. Concept pages — append new anchors to existing concepts
    const conceptGroups = this.extractConceptGroups(ctx.anchors);
    for (const [concept, items] of conceptGroups) {
      const slug = this.slugify(concept);
      const path = `concepts/${slug}.md`;
      const filepath = join(this.dirs.root, path);

      if (existsSync(filepath)) {
        const existing = readFileSync(filepath, 'utf-8');
        const merged = this.mergeConceptAnchors(existing, items);
        if (merged !== existing) {
          this.writeArticle(path, merged);
          updated.push(path);
        }
      } else {
        this.writeArticle(path, this.buildConceptArticle(concept, items));
        created.push(path);
      }
    }

    // 3. New source pages for new digests
    for (const digest of ctx.digests) {
      const slug = this.slugify(digest.frame_name);
      const path = `sources/${slug}.md`;
      const filepath = join(this.dirs.root, path);

      if (!existsSync(filepath)) {
        this.writeArticle(path, this.buildSourceArticle(digest));
        created.push(path);
      }
    }

    // 4. Update synthesis overview if anything changed
    if (created.length > 0 || updated.length > 0) {
      const overviewPath = 'synthesis/overview.md';
      // Re-read all context for synthesis (it's a cross-cutting summary)
      const allDigests = this.readExistingSources();
      this.writeArticle(
        overviewPath,
        this.buildSynthesisFromExisting(allDigests, ctx.entities, ctx.anchors)
      );
      if (existsSync(join(this.dirs.root, overviewPath))) {
        updated.push(overviewPath);
      } else {
        created.push(overviewPath);
      }
    }

    // 5. Session digest
    if (ctx.sessionDigest) {
      const path = `sources/session-${this.slugify(ctx.sessionDigest.period)}.md`;
      this.writeArticle(path, this.buildSessionSource(ctx.sessionDigest));
      const filepath = join(this.dirs.root, path);
      if (existsSync(filepath)) updated.push(path);
      else created.push(path);
    }

    // 6. Derived Company OS SOPs from anchors
    const derivedSops = this.generateDerivedSops(ctx.anchors);
    created.push(...derivedSops);

    if (created.length > 0 || updated.length > 0) {
      this.updateIndex();
      this.appendLog(
        `## [${new Date().toISOString().slice(0, 10)}] update | incremental`,
        `${created.length} created, ${updated.length} updated from ${ctx.digests.length} digests, ${ctx.entities.length} entity states`
      );
    }

    return {
      created,
      updated,
      totalArticles: this.countArticles(),
      compiledAt: Date.now(),
    };
  }

  /**
   * Compile a single raw ingest file into a source article.
   */
  async compileRawIngest(
    filename: string,
    content: string,
    metadata: Record<string, string>
  ): Promise<CompileResult> {
    const created: string[] = [];
    const title = metadata['title'] || filename.replace('.md', '');
    const sourceSlug = this.slugify(title);
    const sourcePath = `sources/${sourceSlug}.md`;

    const lines: string[] = [
      '---',
      `title: "${this.escapeYaml(title)}"`,
      `category: source`,
      `source_file: "${filename}"`,
      `created: ${new Date().toISOString()}`,
      `updated: ${new Date().toISOString()}`,
      metadata['source'] ? `url: "${metadata['source']}"` : '',
      `tags: [source, raw-ingest]`,
      '---',
      '',
      `# ${title}`,
      '',
      metadata['source'] ? `> Source: ${metadata['source']}` : '',
      '',
      '## Summary',
      '',
      this.extractSummary(content),
      '',
      '## Raw Content',
      '',
      content.slice(0, 2000),
      content.length > 2000 ? '\n_...truncated..._' : '',
    ].filter(Boolean);

    this.writeArticle(sourcePath, lines.join('\n'));
    created.push(sourcePath);

    this.updateIndex();
    this.appendLog(
      `## [${new Date().toISOString().slice(0, 10)}] ingest | ${title}`,
      `Raw file \`${filename}\` — 1 source article created`
    );

    return {
      created,
      updated: [],
      totalArticles: this.countArticles(),
      compiledAt: Date.now(),
    };
  }

  /**
   * Ingest a URL — fetch page content, convert to markdown, compile into wiki.
   * Supports single pages and basic site crawling (follows internal links up to maxPages).
   */
  async ingestUrl(
    url: string,
    opts?: { maxPages?: number; depth?: number }
  ): Promise<CompileResult> {
    const maxPages = opts?.maxPages ?? 20;
    const created: string[] = [];
    const visited = new Set<string>();
    const queue = [url];
    let baseHost: string;

    try {
      baseHost = new URL(url).hostname;
    } catch {
      return {
        created: [],
        updated: [],
        totalArticles: this.countArticles(),
        compiledAt: Date.now(),
      };
    }

    while (queue.length > 0 && visited.size < maxPages) {
      const pageUrl = queue.shift();
      if (!pageUrl || visited.has(pageUrl)) continue;
      visited.add(pageUrl);

      try {
        const { title, content, links } = await this.fetchPage(pageUrl);
        if (!content || content.length < 50) continue;

        // Create source article
        const slug = this.slugify(title || this.urlToSlug(pageUrl));
        const sourcePath = `sources/${slug}.md`;

        const article = [
          '---',
          `title: "${this.escapeYaml(title || pageUrl)}"`,
          `category: source`,
          `url: "${pageUrl}"`,
          `created: ${new Date().toISOString()}`,
          `updated: ${new Date().toISOString()}`,
          `tags: [source, web-ingest, ${baseHost}]`,
          '---',
          '',
          `# ${title || pageUrl}`,
          '',
          `> Source: ${pageUrl}`,
          '',
          content.slice(0, 8000),
          content.length > 8000 ? '\n\n_...truncated..._' : '',
          '',
        ].join('\n');

        this.writeArticle(sourcePath, article);
        created.push(sourcePath);

        // Queue internal links
        for (const link of links) {
          try {
            const parsed = new URL(link, pageUrl);
            if (parsed.hostname === baseHost && !visited.has(parsed.href)) {
              queue.push(parsed.href);
            }
          } catch {
            // skip invalid URLs
          }
        }
      } catch {
        // skip failed pages
      }
    }

    if (created.length > 0) {
      this.updateIndex();
      this.appendLog(
        `## [${new Date().toISOString().slice(0, 10)}] ingest-url | ${baseHost}`,
        `Crawled ${visited.size} pages from ${url} — ${created.length} articles created`
      );
    }

    return {
      created,
      updated: [],
      totalArticles: this.countArticles(),
      compiledAt: Date.now(),
    };
  }

  /**
   * Ingest a local file or directory into the wiki.
   */
  async ingestPath(filePath: string): Promise<CompileResult> {
    const created: string[] = [];
    const { statSync } = await import('fs');
    const stat = statSync(filePath);

    const processFile = (fp: string) => {
      if (!existsSync(fp)) return;
      const content = readFileSync(fp, 'utf-8');
      const basename = fp.split('/').pop() ?? fp;
      const ext = basename.split('.').pop() ?? '';

      if (
        ![
          'md',
          'txt',
          'json',
          'yaml',
          'yml',
          'toml',
          'ts',
          'js',
          'py',
        ].includes(ext)
      )
        return;

      const title = basename.replace(/\.[^.]+$/, '');
      const slug = this.slugify(title);
      const sourcePath = `sources/${slug}.md`;

      const article = [
        '---',
        `title: "${this.escapeYaml(title)}"`,
        `category: source`,
        `source_file: "${fp}"`,
        `created: ${new Date().toISOString()}`,
        `updated: ${new Date().toISOString()}`,
        `tags: [source, local-ingest]`,
        '---',
        '',
        `# ${title}`,
        '',
        `> Source: \`${fp}\``,
        '',
        content.slice(0, 8000),
        content.length > 8000 ? '\n\n_...truncated..._' : '',
        '',
      ].join('\n');

      this.writeArticle(sourcePath, article);
      created.push(sourcePath);
    };

    if (stat.isDirectory()) {
      const entries = readdirSync(filePath, { recursive: true }) as string[];
      for (const entry of entries) {
        processFile(join(filePath, entry));
      }
    } else {
      processFile(filePath);
    }

    if (created.length > 0) {
      this.updateIndex();
      this.appendLog(
        `## [${new Date().toISOString().slice(0, 10)}] ingest-path | ${filePath}`,
        `${created.length} articles from local path`
      );
    }

    return {
      created,
      updated: [],
      totalArticles: this.countArticles(),
      compiledAt: Date.now(),
    };
  }

  /** Fetch a web page and extract title, markdown content, and links */
  private async fetchPage(
    url: string
  ): Promise<{ title: string; content: string; links: string[] }> {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'StackMemory-Wiki/1.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { title: '', content: '', links: [] };

    const html = await res.text();

    // Extract title
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch?.[1]?.trim() ?? '';

    // Extract links
    const links: string[] = [];
    const linkRe = /href="([^"]+)"/g;
    let linkMatch;
    while ((linkMatch = linkRe.exec(html)) !== null) {
      const href = linkMatch[1] ?? '';
      if (
        href &&
        !href.startsWith('#') &&
        !href.startsWith('javascript:') &&
        !href.startsWith('mailto:')
      ) {
        links.push(href);
      }
    }

    // Convert HTML to markdown (simple extraction)
    const content = this.htmlToMarkdown(html);

    return { title, content, links };
  }

  /** Simple HTML to markdown conversion */
  private htmlToMarkdown(html: string): string {
    let text = html;

    // Remove script, style, nav, footer, header
    text = text.replace(
      /<(script|style|nav|footer|header|aside)[^>]*>[\s\S]*?<\/\1>/gi,
      ''
    );

    // Extract main/article content if present
    const mainMatch = text.match(
      /<(?:main|article)[^>]*>([\s\S]*?)<\/(?:main|article)>/i
    );
    if (mainMatch) text = mainMatch[1] ?? text;

    // Headings
    text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n');
    text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n');
    text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n');
    text = text.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n');

    // Paragraphs and line breaks
    text = text.replace(/<p[^>]*>/gi, '\n');
    text = text.replace(/<\/p>/gi, '\n');
    text = text.replace(/<br\s*\/?>/gi, '\n');

    // Lists
    text = text.replace(/<li[^>]*>/gi, '- ');
    text = text.replace(/<\/li>/gi, '\n');

    // Bold, italic
    text = text.replace(
      /<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi,
      '**$1**'
    );
    text = text.replace(/<(?:em|i)[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, '*$1*');

    // Code
    text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
    text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n');

    // Links
    text = text.replace(
      /<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
      '[$2]($1)'
    );

    // Strip remaining tags
    text = text.replace(/<[^>]+>/g, '');

    // Clean up entities
    text = text.replace(/&amp;/g, '&');
    text = text.replace(/&lt;/g, '<');
    text = text.replace(/&gt;/g, '>');
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/&#39;/g, "'");
    text = text.replace(/&nbsp;/g, ' ');

    // Clean up whitespace
    text = text.replace(/\n{3,}/g, '\n\n');
    text = text.trim();

    return text;
  }

  /** Convert URL path to a readable slug */
  private urlToSlug(url: string): string {
    try {
      const parsed = new URL(url);
      const path = parsed.pathname.replace(/^\/|\/$/g, '');
      return path
        ? this.slugify(path.replace(/\//g, '-'))
        : this.slugify(parsed.hostname);
    } catch {
      return this.slugify(url);
    }
  }

  /** Lint the wiki for health issues */
  async lint(): Promise<WikiLintResult> {
    const allArticles = this.listAllArticles();
    const orphans: string[] = [];
    const brokenLinks: Array<{ source: string; target: string }> = [];
    const stale: string[] = [];
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

    const inboundLinks = new Map<string, number>();
    for (const article of allArticles) {
      inboundLinks.set(article, 0);
    }

    for (const article of allArticles) {
      const filepath = join(this.dirs.root, article);
      if (!existsSync(filepath)) continue;

      const content = readFileSync(filepath, 'utf-8');
      const links = this.extractWikiLinks(content);

      for (const link of links) {
        if (allArticles.includes(link)) {
          inboundLinks.set(link, (inboundLinks.get(link) || 0) + 1);
        } else {
          brokenLinks.push({ source: article, target: link });
        }
      }

      const updatedMatch = content.match(/updated:\s*(.+)/);
      if (updatedMatch) {
        const updatedAt = new Date((updatedMatch[1] ?? '').trim()).getTime();
        if (updatedAt < thirtyDaysAgo) {
          stale.push(article);
        }
      }
    }

    for (const [article, count] of inboundLinks) {
      if (count === 0 && article !== 'index.md' && article !== 'log.md') {
        orphans.push(article);
      }
    }

    return { orphans, brokenLinks, stale, totalArticles: allArticles.length };
  }

  /** Search wiki articles by keyword */
  search(
    query: string
  ): Array<{ path: string; title: string; matches: number }> {
    const results: Array<{ path: string; title: string; matches: number }> = [];
    const allArticles = this.listAllArticles();
    const queryLower = query.toLowerCase();

    for (const article of allArticles) {
      const filepath = join(this.dirs.root, article);
      if (!existsSync(filepath)) continue;

      const content = readFileSync(filepath, 'utf-8').toLowerCase();
      const matches = content.split(queryLower).length - 1;

      if (matches > 0) {
        const titleMatch = content.match(/^#\s+(.+)/m);
        results.push({
          path: article,
          title: titleMatch?.[1] || article,
          matches,
        });
      }
    }

    return results.sort((a, b) => b.matches - a.matches);
  }

  /** Get wiki status summary */
  getStatus(): {
    totalArticles: number;
    byCategory: Record<string, number>;
    lastCompile: string | null;
  } {
    const byCategory: Record<string, number> = {};

    for (const [category, dir] of Object.entries(this.dirs)) {
      if (category === 'root') continue;
      if (!existsSync(dir)) {
        byCategory[category] = 0;
        continue;
      }
      byCategory[category] = readdirSync(dir).filter((f) =>
        f.endsWith('.md')
      ).length;
    }
    // Backfill categories that may not exist yet
    byCategory['entities'] ??= 0;
    byCategory['concepts'] ??= 0;
    byCategory['sources'] ??= 0;
    byCategory['synthesis'] ??= 0;
    byCategory['sops'] ??= 0;

    const logPath = join(this.dirs.root, 'log.md');
    let lastCompile: string | null = null;
    if (existsSync(logPath)) {
      const logContent = readFileSync(logPath, 'utf-8');
      const entries = logContent.match(/^## \[.+$/gm);
      if (entries && entries.length > 0) {
        lastCompile = entries[entries.length - 1] ?? null;
      }
    }

    return { totalArticles: this.countArticles(), byCategory, lastCompile };
  }

  /** Get timestamp of last compile from log.md */
  getLastCompileTime(): number | null {
    const logPath = join(this.dirs.root, 'log.md');
    if (!existsSync(logPath)) return null;

    const content = readFileSync(logPath, 'utf-8');
    const entries = content.match(/^## \[(\d{4}-\d{2}-\d{2})\]/gm);
    if (!entries || entries.length === 0) return null;

    const lastEntry = entries[entries.length - 1] ?? '';
    const dateMatch = lastEntry.match(/\[(\d{4}-\d{2}-\d{2})\]/);
    if (!dateMatch) return null;

    return new Date((dateMatch[1] ?? '') + 'T00:00:00Z').getTime() / 1000;
  }

  // ── Article builders ──

  private buildEntityArticle(name: string, states: EntityStateRow[]): string {
    const current = states.filter((s) => s.superseded_at === null);
    const historical = states.filter((s) => s.superseded_at !== null);

    const lines: string[] = [
      '---',
      `title: "${this.escapeYaml(name)}"`,
      `category: entity`,
      `created: ${new Date().toISOString()}`,
      `updated: ${new Date().toISOString()}`,
      `tags: [entity]`,
      '---',
      '',
      `# ${name}`,
      '',
    ];

    if (current.length > 0) {
      lines.push('## Current State', '');
      for (const s of current) {
        lines.push(`- **${s.relation}**: ${s.value}`);
        if (s.context) lines.push(`  - _Context: ${s.context}_`);
      }
      lines.push('');
    }

    if (historical.length > 0) {
      lines.push('## History', '');
      for (const s of historical.slice(-20)) {
        const from = new Date(s.valid_from * 1000).toISOString().slice(0, 10);
        const to = s.superseded_at
          ? new Date(s.superseded_at * 1000).toISOString().slice(0, 10)
          : 'current';
        lines.push(`- ${from} → ${to}: **${s.relation}** = ${s.value}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private buildConceptArticle(concept: string, anchors: AnchorRow[]): string {
    const lines: string[] = [
      '---',
      `title: "${this.escapeYaml(concept)}"`,
      `category: concept`,
      `created: ${new Date().toISOString()}`,
      `updated: ${new Date().toISOString()}`,
      `tags: [concept, ${concept.toLowerCase().replace(/\s+/g, '-')}]`,
      '---',
      '',
      `# ${concept}`,
      '',
    ];

    // Group by anchor type
    const byType = this.groupBy(anchors, (a) => a.type);
    for (const [type, items] of byType) {
      lines.push(`## ${type}s`, '');
      for (const a of items) {
        const date = new Date(a.created_at * 1000).toISOString().slice(0, 10);
        lines.push(
          `- ${a.text}`,
          `  - _${date} — from [[sources/${this.slugify(a.frame_name)}]]_`
        );
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private buildSourceArticle(digest: DigestRow): string {
    return [
      '---',
      `title: "${this.escapeYaml(digest.frame_name)}"`,
      `category: source`,
      `frame_id: "${digest.frame_id}"`,
      `frame_type: "${digest.frame_type}"`,
      `created: ${new Date(digest.created_at * 1000).toISOString()}`,
      `updated: ${new Date().toISOString()}`,
      `tags: [source, ${digest.frame_type}]`,
      '---',
      '',
      `# ${digest.frame_name}`,
      '',
      `> Frame \`${digest.frame_id.slice(0, 8)}\` | Type: ${digest.frame_type}`,
      '',
      '## Summary',
      '',
      digest.digest_text,
      '',
    ].join('\n');
  }

  private buildSessionSource(session: SessionDigest): string {
    return [
      '---',
      `title: "Session — ${session.period}"`,
      `category: source`,
      `period: "${session.period}"`,
      `created: ${new Date(session.generatedAt).toISOString()}`,
      `updated: ${new Date().toISOString()}`,
      `tags: [source, session]`,
      '---',
      '',
      `# Session — ${session.period}`,
      '',
      session.content,
      '',
    ].join('\n');
  }

  private buildSynthesisOverview(
    digests: DigestRow[],
    entities: EntityStateRow[],
    anchors: AnchorRow[]
  ): string {
    const uniqueEntities = new Set(entities.map((e) => e.entity_name));
    const decisions = anchors.filter((a) => a.type === 'DECISION');
    const risks = anchors.filter((a) => a.type === 'RISK');

    const lines: string[] = [
      '---',
      `title: "Synthesis Overview"`,
      `category: synthesis`,
      `created: ${new Date().toISOString()}`,
      `updated: ${new Date().toISOString()}`,
      `tags: [synthesis, overview]`,
      '---',
      '',
      '# Synthesis Overview',
      '',
      `> Auto-generated from ${digests.length} frame digests, ${uniqueEntities.size} entities, ${anchors.length} anchors.`,
      '',
    ];

    // Entity summary
    if (uniqueEntities.size > 0) {
      lines.push('## Key Entities', '');
      for (const name of Array.from(uniqueEntities).slice(0, 30)) {
        lines.push(`- [[entities/${this.slugify(name)}|${name}]]`);
      }
      lines.push('');
    }

    // Key decisions
    if (decisions.length > 0) {
      lines.push('## Key Decisions', '');
      for (const d of decisions.slice(-20)) {
        const date = new Date(d.created_at * 1000).toISOString().slice(0, 10);
        lines.push(`- ${d.text} _(${date})_`);
      }
      lines.push('');
    }

    // Risks
    if (risks.length > 0) {
      lines.push('## Open Risks', '');
      for (const r of risks.slice(-10)) {
        lines.push(`- ${r.text}`);
      }
      lines.push('');
    }

    // Activity timeline
    if (digests.length > 0) {
      lines.push('## Recent Activity', '');
      for (const d of digests.slice(-15)) {
        const date = new Date(d.created_at * 1000).toISOString().slice(0, 10);
        lines.push(
          `- ${date}: [[sources/${this.slugify(d.frame_name)}|${d.frame_name}]] (${d.frame_type})`
        );
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private buildSynthesisFromExisting(
    existingSources: Array<{ title: string; path: string }>,
    newEntities: EntityStateRow[],
    newAnchors: AnchorRow[]
  ): string {
    const uniqueEntities = new Set(newEntities.map((e) => e.entity_name));
    // Also read existing entity pages
    if (existsSync(this.dirs.entities)) {
      for (const f of readdirSync(this.dirs.entities)) {
        if (f.endsWith('.md')) {
          uniqueEntities.add(f.replace('.md', '').replace(/-/g, ' '));
        }
      }
    }

    const decisions = newAnchors.filter((a) => a.type === 'DECISION');

    const lines: string[] = [
      '---',
      `title: "Synthesis Overview"`,
      `category: synthesis`,
      `created: ${new Date().toISOString()}`,
      `updated: ${new Date().toISOString()}`,
      `tags: [synthesis, overview]`,
      '---',
      '',
      '# Synthesis Overview',
      '',
      `> ${existingSources.length} source articles, ${uniqueEntities.size} entities tracked.`,
      '',
    ];

    if (uniqueEntities.size > 0) {
      lines.push('## Key Entities', '');
      for (const name of Array.from(uniqueEntities).slice(0, 30)) {
        lines.push(`- [[entities/${this.slugify(name)}|${name}]]`);
      }
      lines.push('');
    }

    if (decisions.length > 0) {
      lines.push('## Recent Decisions', '');
      for (const d of decisions.slice(-10)) {
        lines.push(`- ${d.text}`);
      }
      lines.push('');
    }

    if (existingSources.length > 0) {
      lines.push('## Sources', '');
      for (const s of existingSources.slice(-20)) {
        lines.push(`- [[${s.path.replace('.md', '')}|${s.title}]]`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  // ── Merge helpers (for update) ──

  private mergeEntityStates(
    existing: string,
    _name: string, // reserved for future LLM-driven merge
    newStates: EntityStateRow[]
  ): string {
    let content = existing;

    for (const s of newStates) {
      const entry = `- **${s.relation}**: ${s.value}`;
      if (content.includes(s.value)) continue; // already present

      // Update timestamp
      content = content.replace(
        /updated:\s*.+/,
        `updated: ${new Date().toISOString()}`
      );

      if (s.superseded_at === null) {
        // Current state — add to Current State section
        const marker = '## Current State';
        const idx = content.indexOf(marker);
        if (idx !== -1) {
          const afterMarker = content.indexOf('\n\n', idx + marker.length);
          if (afterMarker !== -1) {
            content =
              content.slice(0, afterMarker) +
              '\n' +
              entry +
              (s.context ? `\n  - _Context: ${s.context}_` : '') +
              content.slice(afterMarker);
          }
        }
      } else {
        // Historical — append to History section
        const from = new Date(s.valid_from * 1000).toISOString().slice(0, 10);
        const to = new Date(s.superseded_at * 1000).toISOString().slice(0, 10);
        const histEntry = `- ${from} → ${to}: **${s.relation}** = ${s.value}`;

        if (!content.includes('## History')) {
          content = content.trimEnd() + '\n\n## History\n\n' + histEntry + '\n';
        } else {
          content = content.trimEnd() + '\n' + histEntry + '\n';
        }
      }
    }

    return content;
  }

  private mergeConceptAnchors(
    existing: string,
    newAnchors: AnchorRow[]
  ): string {
    let content = existing;

    for (const a of newAnchors) {
      if (content.includes(a.text)) continue;

      content = content.replace(
        /updated:\s*.+/,
        `updated: ${new Date().toISOString()}`
      );

      const date = new Date(a.created_at * 1000).toISOString().slice(0, 10);
      const entry = `- ${a.text}\n  - _${date} — from [[sources/${this.slugify(a.frame_name)}]]_`;

      const sectionHeader = `## ${a.type}s`;
      if (content.includes(sectionHeader)) {
        const idx = content.indexOf(sectionHeader);
        const nextSection = content.indexOf(
          '\n## ',
          idx + sectionHeader.length
        );
        const insertAt = nextSection !== -1 ? nextSection : content.length;
        content =
          content.slice(0, insertAt).trimEnd() +
          '\n' +
          entry +
          '\n' +
          content.slice(insertAt);
      } else {
        content =
          content.trimEnd() + '\n\n' + sectionHeader + '\n\n' + entry + '\n';
      }
    }

    return content;
  }

  // ── Concept extraction ──

  private extractConceptGroups(anchors: AnchorRow[]): Map<string, AnchorRow[]> {
    const groups = new Map<string, AnchorRow[]>();

    // Group anchors into concept pages by type
    const conceptMap: Record<string, string> = {
      DECISION: 'Decisions',
      FACT: 'Key Facts',
      CONSTRAINT: 'Constraints',
      RISK: 'Risks',
      TODO: 'Action Items',
      INTERFACE_CONTRACT: 'Interface Contracts',
    };

    for (const anchor of anchors) {
      const concept = conceptMap[anchor.type] || 'Notes';
      const list = groups.get(concept) || [];
      list.push(anchor);
      groups.set(concept, list);
    }

    return groups;
  }

  /**
   * Derive Company OS SOPs from recurring frame anchors.
   * Creates lightweight SOP drafts in wiki/sops/ for DECISION, CONSTRAINT, RISK, FACT anchors.
   */
  private generateDerivedSops(anchors: AnchorRow[]): string[] {
    const created: string[] = [];
    const derivedConfig: Array<{
      type: string;
      id: number;
      name: string;
      proseId: string;
      objective: string;
    }> = [
      {
        type: 'DECISION',
        id: 401,
        name: 'Decision-derived Process',
        proseId: 'E.9',
        objective:
          'Preserve recurring decisions as repeatable guidance so the team does not re-debate settled questions.',
      },
      {
        type: 'CONSTRAINT',
        id: 402,
        name: 'Constraint-derived Process',
        proseId: 'E.10',
        objective:
          'Preserve recurring constraints as repeatable guidance so the team respects known boundaries.',
      },
      {
        type: 'RISK',
        id: 403,
        name: 'Risk-derived Process',
        proseId: 'E.11',
        objective:
          'Preserve recurring risks as repeatable guidance so the team mitigates them consistently.',
      },
      {
        type: 'FACT',
        id: 404,
        name: 'Fact-derived Process',
        proseId: 'E.12',
        objective:
          'Preserve recurring facts as repeatable guidance so the team operates from shared knowledge.',
      },
    ];

    for (const config of derivedConfig) {
      const typeAnchors = anchors.filter((a) => a.type === config.type);
      if (typeAnchors.length === 0) continue;

      const path = `sops/SOP-${config.id}-${this.slugify(config.name)}.md`;
      const items = typeAnchors
        .slice(-20)
        .map((a) => {
          const date = new Date(a.created_at * 1000).toISOString().slice(0, 10);
          return `- ${a.text} _(observed ${date} in [[sources/${this.slugify(a.frame_name)}]])_`;
        })
        .join('\n');

      const article = [
        '---',
        `title: "SOP-${config.id} ${config.name}"`,
        `category: sop`,
        `derived_from: "${config.type} anchors"`,
        `created: ${new Date().toISOString()}`,
        `updated: ${new Date().toISOString()}`,
        `tags: [sop, derived, ${config.type.toLowerCase()}]`,
        '---',
        '',
        `# SOP-${config.id} ${config.name}`,
        '',
        '**Owner:** Derived from frame anchors  ',
        '**Status:** Active  ',
        `**Related PROSE Expectation:** [${config.proseId} ${config.name}](../../docs/specs/COMPANY-OS-PROSE.md)`,
        '',
        '## Objective',
        config.objective,
        '',
        '## Procedure',
        '',
        `1. **Review**`,
        `   - Review the latest ${config.type} anchors below before taking action.`,
        '',
        `2. **Apply**`,
        `   - Treat these ${config.type.toLowerCase()}s as guidance for current and future work.`,
        '',
        `3. **Update**`,
        `   - When a ${config.type.toLowerCase()} changes, record the new state in a frame so this SOP can be regenerated.`,
        '',
        '## Verification',
        '',
        `- Run \`stackmemory company-os audit ${config.type.toLowerCase()}-derived\``,
        `- Expected result: the derived ${config.type.toLowerCase()}s below are reflected in current work.`,
        '',
        '### Derived anchors',
        `${items}`,
        '',
        '## Non-compliance',
        '',
        `Ignoring or overriding these ${config.type.toLowerCase()}s without a new recorded decision is non-compliant.`,
        '',
      ].join('\n');

      this.writeArticle(path, article);
      created.push(path);
    }

    return created;
  }

  // ── Reading helpers ──

  private readExistingSources(): Array<{ title: string; path: string }> {
    const sources: Array<{ title: string; path: string }> = [];
    if (!existsSync(this.dirs.sources)) return sources;

    for (const f of readdirSync(this.dirs.sources)) {
      if (!f.endsWith('.md')) continue;
      const filepath = join(this.dirs.sources, f);
      const content = readFileSync(filepath, 'utf-8');
      const titleMatch = content.match(/^title:\s*"?([^"\n]+)"?\s*$/m);
      sources.push({
        title: titleMatch?.[1] || f.replace('.md', ''),
        path: `sources/${f}`,
      });
    }

    return sources;
  }

  // ── Shared helpers ──

  private writeArticle(articlePath: string, content: string): void {
    const filepath = join(this.dirs.root, articlePath);
    const dir = join(filepath, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(filepath, content);
  }

  private updateIndex(): void {
    const articles = this.listAllArticlesWithMeta();

    const grouped: Record<
      string,
      Array<{ path: string; title: string; summary: string }>
    > = {
      entities: [],
      concepts: [],
      sources: [],
      synthesis: [],
    };

    for (const a of articles) {
      const category = a.path.split('/')[0] || 'other';
      const group = grouped[category];
      if (group) group.push(a);
    }

    const lines: string[] = [
      '---',
      `updated: ${new Date().toISOString()}`,
      `total_articles: ${articles.length}`,
      '---',
      '',
      '# Wiki Index',
      '',
      `> ${articles.length} articles. Auto-maintained by StackMemory Wiki Compiler.`,
      '',
    ];

    for (const [category, items] of Object.entries(grouped)) {
      if (items.length === 0) continue;
      lines.push(
        `## ${category.charAt(0).toUpperCase() + category.slice(1)}`,
        ''
      );
      for (const item of items.slice(0, this.config.indexLimit)) {
        const link = item.path.replace('.md', '');
        lines.push(`- [[${link}|${item.title}]] — ${item.summary}`);
      }
      if (items.length > this.config.indexLimit) {
        lines.push(`_...and ${items.length - this.config.indexLimit} more_`);
      }
      lines.push('');
    }

    writeFileSync(join(this.dirs.root, 'index.md'), lines.join('\n'));
  }

  private appendLog(heading: string, detail: string): void {
    const logPath = join(this.dirs.root, 'log.md');
    if (!existsSync(logPath)) return;

    let content = readFileSync(logPath, 'utf-8');
    content += `\n${heading}\n${detail}\n`;

    const entries = content.match(/^## \[.+[\s\S]*?(?=^## \[|\Z)/gm);
    if (entries && entries.length > this.config.logLimit) {
      const header = content.split(/^## \[/m)[0] ?? '';
      const kept = entries.slice(-this.config.logLimit);
      content = header + kept.join('');
    }

    writeFileSync(logPath, content);
  }

  private listAllArticles(): string[] {
    const articles: string[] = [];
    for (const [category, dir] of Object.entries(this.dirs)) {
      if (category === 'root') continue;
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (f.endsWith('.md')) articles.push(`${category}/${f}`);
      }
    }
    return articles;
  }

  private listAllArticlesWithMeta(): Array<{
    path: string;
    title: string;
    summary: string;
  }> {
    const articles: Array<{ path: string; title: string; summary: string }> =
      [];

    for (const [category, dir] of Object.entries(this.dirs)) {
      if (category === 'root') continue;
      if (!existsSync(dir)) continue;

      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.md')) continue;
        const filepath = join(dir, f);
        const content = readFileSync(filepath, 'utf-8');

        const titleMatch = content.match(/^title:\s*"?([^"\n]+)"?\s*$/m);
        const title = titleMatch?.[1] || f.replace('.md', '');

        const body = content.replace(/^---[\s\S]*?---/, '').trim();
        const firstParagraph = body
          .split('\n')
          .find((l) => l.trim() && !l.startsWith('#') && !l.startsWith('>'));
        const summary = firstParagraph?.slice(0, 120) || '';

        articles.push({ path: `${category}/${f}`, title, summary });
      }
    }

    return articles;
  }

  private countArticles(): number {
    let count = 0;
    for (const [category, dir] of Object.entries(this.dirs)) {
      if (category === 'root') continue;
      if (!existsSync(dir)) continue;
      count += readdirSync(dir).filter((f) => f.endsWith('.md')).length;
    }
    return count;
  }

  private extractWikiLinks(content: string): string[] {
    const links: string[] = [];
    const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    let match;
    while ((match = re.exec(content)) !== null) {
      const target = (match[1] ?? '').trim();
      links.push(target.endsWith('.md') ? target : target + '.md');
    }
    return links;
  }

  private extractSummary(content: string): string {
    const body = content.replace(/^---[\s\S]*?---/, '').trim();
    const lines = body
      .split('\n')
      .filter((l) => l.trim() && !l.startsWith('#'));
    return (
      lines.slice(0, 3).join('\n').slice(0, 500) || 'No summary available.'
    );
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9-_\s]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 60)
      .replace(/-$/, '');
  }

  private escapeYaml(s: string): string {
    return s.replace(/"/g, '\\"').replace(/\n/g, ' ');
  }

  private groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
    const map = new Map<string, T[]>();
    for (const item of items) {
      const key = keyFn(item);
      const list = map.get(key) || [];
      list.push(item);
      map.set(key, list);
    }
    return map;
  }

  private generateEmptyIndex(): string {
    return [
      '---',
      `updated: ${new Date().toISOString()}`,
      'total_articles: 0',
      '---',
      '',
      '# Wiki Index',
      '',
      '> No articles yet. Run `stackmemory wiki create` to generate wiki from context.',
      '',
      '## Entities',
      '',
      '_No entity pages yet._',
      '',
      '## Concepts',
      '',
      '_No concept pages yet._',
      '',
      '## Sources',
      '',
      '_No source summaries yet._',
      '',
      '## Synthesis',
      '',
      '_No synthesis articles yet._',
      '',
    ].join('\n');
  }
}
