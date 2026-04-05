#!/usr/bin/env node

/**
 * Wiki Update Hook
 *
 * Fires on session stop. Incrementally compiles new context (frames,
 * entity states, anchors) into the wiki since the last compile.
 *
 * Works in any repo with StackMemory initialized + Obsidian configured:
 *   - .stackmemory/context.db must exist
 *   - .stackmemory/config.yaml must have obsidian.vaultPath
 *
 * The hook is lightweight: reads last compile timestamp from wiki/log.md,
 * queries only new context, and writes updated .md articles.
 */

const fs = require('fs');
const path = require('path');

const HOME = process.env.HOME || '/tmp';

function main() {
  try {
    const cwd = process.cwd();

    // 1. Check if StackMemory is initialized
    const dbPath = path.join(cwd, '.stackmemory', 'context.db');
    if (!fs.existsSync(dbPath)) return;

    // 2. Check if Obsidian vault is configured
    const configPath = path.join(cwd, '.stackmemory', 'config.yaml');
    if (!fs.existsSync(configPath)) return;

    const configContent = fs.readFileSync(configPath, 'utf-8');
    const vaultMatch = configContent.match(
      /obsidian:\s*\n\s+vaultPath:\s*["']?([^\n"']+)/
    );
    if (!vaultMatch) return;

    const vaultPath = vaultMatch[1].trim();
    if (!fs.existsSync(vaultPath)) return;

    const subdirMatch = configContent.match(
      /obsidian:\s*\n(?:\s+\w+:.*\n)*\s+subdir:\s*["']?([^\n"']+)/
    );
    const subdir = subdirMatch ? subdirMatch[1].trim() : 'stackmemory';
    const wikiDir = path.join(vaultPath, subdir, 'wiki');

    // 3. Ensure wiki directory exists
    const dirs = [
      wikiDir,
      path.join(wikiDir, 'entities'),
      path.join(wikiDir, 'concepts'),
      path.join(wikiDir, 'sources'),
      path.join(wikiDir, 'synthesis'),
    ];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    // 4. Get last compile time from log.md
    const logPath = path.join(wikiDir, 'log.md');
    let sinceEpoch = 0;
    if (fs.existsSync(logPath)) {
      const logContent = fs.readFileSync(logPath, 'utf-8');
      const entries = logContent.match(/^## \[(\d{4}-\d{2}-\d{2})\]/gm);
      if (entries && entries.length > 0) {
        const last = entries[entries.length - 1];
        const dateMatch = last.match(/\[(\d{4}-\d{2}-\d{2})\]/);
        if (dateMatch) {
          sinceEpoch = Math.floor(
            new Date(dateMatch[1] + 'T00:00:00Z').getTime() / 1000
          );
        }
      }
    }

    // 5. Open database and query new context
    let Database;
    try {
      Database = require('better-sqlite3');
    } catch {
      // better-sqlite3 not available in this context
      return;
    }

    const db = new Database(dbPath, { readonly: true });

    const digests = db
      .prepare(
        `SELECT frame_id, name as frame_name, type as frame_type,
                digest_text, created_at, closed_at
         FROM frames
         WHERE state = 'closed' AND digest_text IS NOT NULL
           AND created_at >= ?
         ORDER BY created_at DESC
         LIMIT 100`
      )
      .all(sinceEpoch);

    const entities = db
      .prepare(
        `SELECT entity_name, relation, value, context,
                source_frame_id, valid_from, superseded_at
         FROM entity_states
         WHERE valid_from >= ?
         ORDER BY valid_from DESC
         LIMIT 500`
      )
      .all(sinceEpoch);

    const anchors = db
      .prepare(
        `SELECT a.anchor_id, a.frame_id, f.name as frame_name,
                a.type, a.text, a.priority, a.created_at
         FROM anchors a
         JOIN frames f ON f.frame_id = a.frame_id
         WHERE a.created_at >= ?
         ORDER BY a.created_at DESC
         LIMIT 500`
      )
      .all(sinceEpoch);

    db.close();

    // 6. Skip if nothing new
    if (digests.length === 0 && entities.length === 0 && anchors.length === 0) {
      return;
    }

    // 7. Write source articles for new digests
    let created = 0;
    let updated = 0;

    for (const d of digests) {
      const slug = slugify(d.frame_name);
      const filePath = path.join(wikiDir, 'sources', slug + '.md');
      if (fs.existsSync(filePath)) continue;

      const content = [
        '---',
        `title: "${escapeYaml(d.frame_name)}"`,
        `category: source`,
        `frame_id: "${d.frame_id}"`,
        `frame_type: "${d.frame_type}"`,
        `created: ${new Date(d.created_at * 1000).toISOString()}`,
        `updated: ${new Date().toISOString()}`,
        `tags: [source, ${d.frame_type}]`,
        '---',
        '',
        `# ${d.frame_name}`,
        '',
        `> Frame \`${d.frame_id.slice(0, 8)}\` | Type: ${d.frame_type}`,
        '',
        '## Summary',
        '',
        d.digest_text || 'No digest.',
        '',
      ].join('\n');

      fs.writeFileSync(filePath, content);
      created++;
    }

    // 8. Write/update entity pages
    const entitiesByName = {};
    for (const e of entities) {
      if (!entitiesByName[e.entity_name]) entitiesByName[e.entity_name] = [];
      entitiesByName[e.entity_name].push(e);
    }

    for (const [name, states] of Object.entries(entitiesByName)) {
      const slug = slugify(name);
      const filePath = path.join(wikiDir, 'entities', slug + '.md');

      if (!fs.existsSync(filePath)) {
        const current = states.filter((s) => s.superseded_at === null);
        const lines = [
          '---',
          `title: "${escapeYaml(name)}"`,
          `category: entity`,
          `created: ${new Date().toISOString()}`,
          `updated: ${new Date().toISOString()}`,
          `tags: [entity]`,
          '---',
          '',
          `# ${name}`,
          '',
          '## Current State',
          '',
        ];
        for (const s of current) {
          lines.push(`- **${s.relation}**: ${s.value}`);
          if (s.context) lines.push(`  - _Context: ${s.context}_`);
        }
        lines.push('');
        fs.writeFileSync(filePath, lines.join('\n'));
        created++;
      } else {
        // Append new states
        let content = fs.readFileSync(filePath, 'utf-8');
        let changed = false;
        for (const s of states) {
          if (content.includes(s.value)) continue;
          const entry = `- **${s.relation}**: ${s.value}`;
          content = content.trimEnd() + '\n' + entry + '\n';
          changed = true;
        }
        if (changed) {
          content = content.replace(
            /updated:\s*.+/,
            `updated: ${new Date().toISOString()}`
          );
          fs.writeFileSync(filePath, content);
          updated++;
        }
      }
    }

    // 9. Write/update concept pages from anchors
    const conceptMap = {
      DECISION: 'Decisions',
      FACT: 'Key Facts',
      CONSTRAINT: 'Constraints',
      RISK: 'Risks',
      TODO: 'Action Items',
      INTERFACE_CONTRACT: 'Interface Contracts',
    };

    const conceptGroups = {};
    for (const a of anchors) {
      const concept = conceptMap[a.type] || 'Notes';
      if (!conceptGroups[concept]) conceptGroups[concept] = [];
      conceptGroups[concept].push(a);
    }

    for (const [concept, items] of Object.entries(conceptGroups)) {
      const slug = slugify(concept);
      const filePath = path.join(wikiDir, 'concepts', slug + '.md');

      if (!fs.existsSync(filePath)) {
        const lines = [
          '---',
          `title: "${escapeYaml(concept)}"`,
          `category: concept`,
          `created: ${new Date().toISOString()}`,
          `updated: ${new Date().toISOString()}`,
          `tags: [concept]`,
          '---',
          '',
          `# ${concept}`,
          '',
        ];
        for (const a of items) {
          const date = new Date(a.created_at * 1000).toISOString().slice(0, 10);
          lines.push(
            `- ${a.text}`,
            `  - _${date} — from [[sources/${slugify(a.frame_name)}]]_`
          );
        }
        lines.push('');
        fs.writeFileSync(filePath, lines.join('\n'));
        created++;
      } else {
        let content = fs.readFileSync(filePath, 'utf-8');
        let changed = false;
        for (const a of items) {
          if (content.includes(a.text)) continue;
          const date = new Date(a.created_at * 1000).toISOString().slice(0, 10);
          const entry = `- ${a.text}\n  - _${date} — from [[sources/${slugify(a.frame_name)}]]_`;
          content = content.trimEnd() + '\n' + entry + '\n';
          changed = true;
        }
        if (changed) {
          content = content.replace(
            /updated:\s*.+/,
            `updated: ${new Date().toISOString()}`
          );
          fs.writeFileSync(filePath, content);
          updated++;
        }
      }
    }

    // 10. Update index.md
    updateIndex(wikiDir);

    // 11. Append to log.md
    if (created > 0 || updated > 0) {
      const now = new Date().toISOString().slice(0, 10);
      const logEntry = `\n## [${now}] auto-update | session stop\n${created} created, ${updated} updated from ${digests.length} digests, ${entities.length} entities, ${anchors.length} anchors\n`;

      if (fs.existsSync(logPath)) {
        fs.appendFileSync(logPath, logEntry);
      } else {
        fs.writeFileSync(
          logPath,
          '# Wiki Log\n\n> Chronological record of wiki operations.\n' +
            logEntry
        );
      }
    }
  } catch {
    // Silent fail — never block the agent
  }
}

function updateIndex(wikiDir) {
  const categories = ['entities', 'concepts', 'sources', 'synthesis'];
  const articles = [];

  for (const cat of categories) {
    const dir = path.join(wikiDir, cat);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const content = fs.readFileSync(path.join(dir, f), 'utf-8');
      const titleMatch = content.match(/^title:\s*"?([^"\n]+)"?\s*$/m);
      articles.push({
        path: `${cat}/${f}`,
        title: titleMatch ? titleMatch[1] : f.replace('.md', ''),
        category: cat,
      });
    }
  }

  const grouped = {};
  for (const a of articles) {
    if (!grouped[a.category]) grouped[a.category] = [];
    grouped[a.category].push(a);
  }

  const lines = [
    '---',
    `updated: ${new Date().toISOString()}`,
    `total_articles: ${articles.length}`,
    '---',
    '',
    '# Wiki Index',
    '',
    `> ${articles.length} articles. Auto-maintained by StackMemory.`,
    '',
  ];

  for (const [cat, items] of Object.entries(grouped)) {
    lines.push(`## ${cat.charAt(0).toUpperCase() + cat.slice(1)}`, '');
    for (const item of items.slice(0, 200)) {
      const link = item.path.replace('.md', '');
      lines.push(`- [[${link}|${item.title}]]`);
    }
    lines.push('');
  }

  fs.writeFileSync(path.join(wikiDir, 'index.md'), lines.join('\n'));
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9-_\s]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60)
    .replace(/-$/, '');
}

function escapeYaml(s) {
  return s.replace(/"/g, '\\"').replace(/\n/g, ' ');
}

main();
