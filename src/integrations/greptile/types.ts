/**
 * Greptile Integration Types
 * TypeScript interfaces for AI-powered code review
 */

export interface GreptileRepoRef {
  name: string;
  remote: 'github' | 'gitlab' | 'azure' | 'bitbucket';
  defaultBranch: string;
  remoteUrl?: string;
}

export interface GreptileReviewComment {
  id: string;
  body: string;
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
  hasSuggestion: boolean;
  suggestedCode?: string;
  addressed: boolean;
  sourceType: string;
  createdAt: string;
}

export interface GreptileCustomContext {
  id: string;
  body: string;
  type: 'CUSTOM_INSTRUCTION' | 'PATTERN';
  status: 'ACTIVE' | 'INACTIVE' | 'SUGGESTED';
  scopes?: Record<string, unknown>;
}

export interface GreptileMergeRequest {
  prNumber: number;
  title: string;
  state: 'open' | 'closed' | 'merged';
  sourceBranch?: string;
  authorLogin?: string;
}

export interface GreptileCodeReview {
  id: string;
  status: string;
  prNumber: number;
  body?: string;
}

export interface GreptileStatus {
  connected: boolean;
  error?: string;
}
