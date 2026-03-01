/**
 * Theory Skill — Maintains a living THEORY.MD at repo root
 *
 * Based on Theorist by @blader (MIT):
 * A narrative operating theory capturing problem thesis, mental model,
 * strategy, discoveries/pivots, and open questions.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { logger } from '../core/monitoring/logger.js';
import type { SkillContext, SkillResult } from './claude-skills.js';

const THEORY_FILE = 'THEORY.MD';
const MIN_CONTENT_LENGTH = 100;
const MAX_LINE_WARNING = 200;

const TEMPLATE_SECTIONS = [
  '## Problem',
  '## Operating Theory',
  '## Strategy',
  '## Key Discoveries',
  '## Open Questions',
];

function getGitRoot(): string | undefined {
  try {
    return execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
  } catch {
    return undefined;
  }
}

function generateTemplate(problemStatement: string): string {
  return `# THEORY.MD

## Problem

${problemStatement}

## Operating Theory

_What is your current mental model of how this system works or should work?_

## Strategy

_What approach are you taking and why?_

## Key Discoveries

_What have you learned that changed your thinking?_

## Open Questions

_What don't you know yet? What assumptions need validation?_
`;
}

export class TheorySkill {
  private rootDir: string;

  constructor(private context: SkillContext) {
    this.rootDir = getGitRoot() || process.cwd();
  }

  private get theoryPath(): string {
    return path.join(this.rootDir, THEORY_FILE);
  }

  show(): SkillResult {
    if (!fs.existsSync(this.theoryPath)) {
      return {
        success: false,
        message: `No ${THEORY_FILE} found. Run \`theory init "<problem>"\` to create one.`,
      };
    }

    const content = fs.readFileSync(this.theoryPath, 'utf-8');
    return {
      success: true,
      message: content,
      data: { path: this.theoryPath, length: content.length },
    };
  }

  init(problemStatement: string): SkillResult {
    if (!problemStatement || problemStatement.trim().length === 0) {
      return {
        success: false,
        message: 'A problem statement is required to initialize THEORY.MD.',
      };
    }

    if (fs.existsSync(this.theoryPath)) {
      return {
        success: false,
        message: `${THEORY_FILE} already exists at ${this.theoryPath}. Use \`theory update\` to modify it.`,
      };
    }

    const content = generateTemplate(problemStatement.trim());
    fs.writeFileSync(this.theoryPath, content, 'utf-8');

    logger.info('Created THEORY.MD', { path: this.theoryPath });

    return {
      success: true,
      message: `Created ${THEORY_FILE} at ${this.theoryPath}`,
      data: { path: this.theoryPath, sections: TEMPLATE_SECTIONS },
    };
  }

  update(content: string): SkillResult {
    if (!content || content.trim().length === 0) {
      return { success: false, message: 'Content is required for update.' };
    }

    if (content.trim().length < MIN_CONTENT_LENGTH) {
      return {
        success: false,
        message: `Content too short (${content.trim().length} chars). THEORY.MD should be at least ${MIN_CONTENT_LENGTH} characters to be meaningful.`,
      };
    }

    // Validate anti-patterns
    const warnings: string[] = [];
    if (/\[[ x]\]/i.test(content)) {
      warnings.push(
        'Contains checkboxes — THEORY.MD is narrative, not a checklist.'
      );
    }
    if (/\d{4}-\d{2}-\d{2}/.test(content)) {
      warnings.push(
        'Contains dates — THEORY.MD captures current thinking, not a changelog.'
      );
    }

    const lineCount = content.split('\n').length;
    if (lineCount > MAX_LINE_WARNING) {
      warnings.push(
        `${lineCount} lines is long. Consider distilling to keep THEORY.MD focused.`
      );
    }

    fs.writeFileSync(this.theoryPath, content, 'utf-8');

    // Record frame event if frameManager is available
    if (this.context.frameManager) {
      try {
        const frameId = this.context.frameManager.createFrame(
          'write',
          'theory-update',
          { source: THEORY_FILE, length: content.length }
        );
        this.context.frameManager.addEvent(
          'artifact',
          {
            type: 'theory-update',
            path: this.theoryPath,
            length: content.length,
            lineCount,
          },
          frameId
        );
        this.context.frameManager.closeFrame(frameId, {
          theory_updated: true,
        });
      } catch (err) {
        logger.warn('Failed to record theory update frame', { error: err });
      }
    }

    logger.info('Updated THEORY.MD', {
      path: this.theoryPath,
      length: content.length,
    });

    const message =
      warnings.length > 0
        ? `Updated ${THEORY_FILE}. Warnings:\n${warnings.map((w) => `  - ${w}`).join('\n')}`
        : `Updated ${THEORY_FILE} (${lineCount} lines)`;

    return {
      success: true,
      message,
      data: { path: this.theoryPath, lineCount, warnings },
    };
  }

  status(): SkillResult {
    if (!fs.existsSync(this.theoryPath)) {
      return {
        success: true,
        message: `No ${THEORY_FILE} found.`,
        data: { exists: false },
      };
    }

    const content = fs.readFileSync(this.theoryPath, 'utf-8');
    const lines = content.split('\n');
    const stat = fs.statSync(this.theoryPath);

    // Detect which sections are present
    const sections = TEMPLATE_SECTIONS.filter((s) => content.includes(s));

    return {
      success: true,
      message: `${THEORY_FILE}: ${lines.length} lines, ${sections.length}/${TEMPLATE_SECTIONS.length} sections`,
      data: {
        exists: true,
        path: this.theoryPath,
        lineCount: lines.length,
        charCount: content.length,
        sections,
        totalSections: TEMPLATE_SECTIONS.length,
        lastModified: stat.mtime.toISOString(),
      },
    };
  }
}
