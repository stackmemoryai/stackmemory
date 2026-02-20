/**
 * Sweep Prompt Builder
 *
 * Builds prompts in the Sweep Next-Edit format with <|file_sep|> tokens.
 * Format based on Qwen2.5-Coder pretrained model structure.
 */

import { SweepPromptInput, DiffEntry } from './types.js';

/**
 * Build a Sweep-format prompt for next-edit prediction
 *
 * Format:
 *   <|file_sep|>{file}.diff
 *   original:
 *   {before}
 *   updated:
 *   {after}
 *   <|file_sep|>original/{file_path}
 *   {original_content}
 *   <|file_sep|>current/{file_path}
 *   {current_content}
 *   <|file_sep|>updated/{file_path}
 */
export function buildSweepPrompt(input: SweepPromptInput): string {
  const parts: string[] = [];

  // Add context files if provided
  if (input.contextFiles) {
    for (const [path, content] of Object.entries(input.contextFiles)) {
      parts.push(`<|file_sep|>${path}`);
      parts.push(content);
    }
  }

  // Add recent diffs section
  const diffSection = buildDiffSection(input.recentDiffs);
  if (diffSection) {
    parts.push(diffSection);
  }

  // Add original file state
  parts.push(`<|file_sep|>original/${input.filePath}`);
  parts.push(input.originalContent || input.currentContent);

  // Add current file state
  parts.push(`<|file_sep|>current/${input.filePath}`);
  parts.push(input.currentContent);

  // Add updated marker - model generates from here
  parts.push(`<|file_sep|>updated/${input.filePath}`);

  return parts.join('\n');
}

/**
 * Build the diff history section
 */
function buildDiffSection(diffs: DiffEntry[]): string {
  if (!diffs || diffs.length === 0) {
    return '';
  }

  const parts: string[] = [];

  for (const diff of diffs) {
    if (!diff.original && !diff.updated) {
      continue;
    }

    parts.push(`<|file_sep|>${diff.file_path}.diff`);
    parts.push('original:');
    parts.push(diff.original || '');
    parts.push('updated:');
    parts.push(diff.updated || '');
  }

  return parts.join('\n');
}

/**
 * Trim content around cursor position to fit token budget
 */
export function trimContentAroundCursor(
  lines: string[],
  cursorLine: number,
  cursorCol: number,
  maxTokens: number
): { lines: string[]; offset: number; didTrim: boolean } {
  // Estimate tokens: ~4 chars per token
  const totalChars = lines.join('\n').length;
  const estimatedTokens = Math.ceil(totalChars / 4);

  if (estimatedTokens <= maxTokens) {
    return { lines, offset: 0, didTrim: false };
  }

  // Calculate window size based on token budget
  const targetChars = maxTokens * 4;
  const avgLineLength = totalChars / lines.length;
  const windowSize = Math.floor(targetChars / avgLineLength);

  // Center window around cursor
  const halfWindow = Math.floor(windowSize / 2);
  let start = Math.max(0, cursorLine - halfWindow);
  const end = Math.min(lines.length, start + windowSize);

  // Adjust if we hit the end
  if (end === lines.length) {
    start = Math.max(0, end - windowSize);
  }

  return {
    lines: lines.slice(start, end),
    offset: start,
    didTrim: true,
  };
}

/**
 * Parse completion text from model output
 */
export function parseCompletion(
  completionText: string,
  originalLines: string[],
  windowStart: number,
  windowEnd: number
): { lines: string[]; startLine: number; endLine: number } | null {
  // Strip trailing stop tokens
  const text = completionText
    .replace(/<\|file_sep\|>$/, '')
    .replace(/<\/s>$/, '')
    .trimEnd();

  if (!text || text.trim().length === 0) {
    return null;
  }

  const newLines = text.split('\n');
  const oldLines = originalLines.slice(windowStart, windowEnd);
  const oldText = oldLines.join('\n').trimEnd();

  // No change if identical
  if (text === oldText) {
    return null;
  }

  return {
    lines: newLines,
    startLine: windowStart + 1, // Convert to 1-indexed
    endLine: windowEnd,
  };
}
