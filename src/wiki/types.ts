/**
 * Wiki Types
 *
 * Type definitions for the OMX wiki knowledge layer.
 */

export const WIKI_SCHEMA_VERSION = 1;

export type WikiCategory =
  | 'architecture'
  | 'decision'
  | 'pattern'
  | 'debugging'
  | 'environment'
  | 'session-log'
  | 'reference'
  | 'convention';

export interface WikiPageFrontmatter {
  title: string;
  tags: string[];
  created: string;
  updated: string;
  sources: string[];
  links: string[];
  category: WikiCategory;
  confidence: 'high' | 'medium' | 'low';
  schemaVersion: number;
  earliestDirectiveExpiry?: string;
}

export interface WikiPage {
  filename: string;
  frontmatter: WikiPageFrontmatter;
  content: string;
}

export interface WikiLogEntry {
  timestamp: string;
  operation: 'ingest' | 'query' | 'lint' | 'add' | 'delete' | 'session-start' | 'session-end';
  pagesAffected: string[];
  summary: string;
}

export interface WikiIngestInput {
  title: string;
  content: string;
  tags: string[];
  category: WikiCategory;
  sources?: string[];
  confidence?: 'high' | 'medium' | 'low';
}

export interface WikiIngestResult {
  created: string[];
  updated: string[];
  totalAffected: number;
}

export interface WikiQueryOptions {
  tags?: string[];
  category?: WikiCategory;
  limit?: number;
  logQuery?: boolean;
}

export interface WikiQueryMatch {
  page: WikiPage;
  snippet: string;
  score: number;
}

export type WikiLintSeverity = 'error' | 'warning' | 'info';

export type WikiLintIssueType =
  | 'orphan'
  | 'stale'
  | 'broken-ref'
  | 'low-confidence'
  | 'oversized'
  | 'structural-contradiction';

export interface WikiLintIssue {
  page: string;
  severity: WikiLintSeverity;
  type: WikiLintIssueType;
  message: string;
}

export interface WikiLintReport {
  issues: WikiLintIssue[];
  stats: {
    totalPages: number;
    orphanCount: number;
    staleCount: number;
    brokenRefCount: number;
    lowConfidenceCount: number;
    oversizedCount: number;
    contradictionCount: number;
  };
}

export interface WikiConfig {
  enabled: boolean;
  autoCapture: boolean;
  maxContextLines: number;
  staleDays: number;
  maxPageSize: number;
  feedProjectMemoryOnStart: boolean;
}

export const DEFAULT_WIKI_CONFIG: WikiConfig = {
  enabled: true,
  autoCapture: true,
  maxContextLines: 30,
  staleDays: 30,
  maxPageSize: 10_240,
  feedProjectMemoryOnStart: false,
};
