#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export interface Contributor {
  displayName: string;
  login?: string;
  url?: string;
}

interface CompareCommit {
  author?: {
    login?: string;
    html_url?: string;
  } | null;
  commit?: {
    author?: {
      name?: string;
    } | null;
  } | null;
}

interface CompareResponse {
  commits?: CompareCommit[];
}

interface GenerateReleaseBodyOptions {
  templatePath: string;
  outPath: string;
  currentTag?: string;
  previousTag?: string;
  repo?: string;
  githubToken?: string;
  cwd?: string;
}

function usage(): never {
  console.error('Usage: node scripts/generate-release-body.mjs --template <path> --out <path> [--current-tag <tag>] [--previous-tag <tag>] [--repo <owner/name>]');
  process.exit(1);
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function runGit(args: string[], cwd: string, allowFailure = false): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: 'pipe',
  });
  if (result.status !== 0) {
    if (allowFailure) return '';
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`.trim());
  }
  return String(result.stdout || '').trim();
}

function resolveRepositoryFromRemote(cwd: string): string | undefined {
  const remote = runGit(['config', '--get', 'remote.origin.url'], cwd, true);
  if (!remote) return undefined;
  const httpsMatch = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
  return httpsMatch?.[1];
}

export function resolveCurrentTag(cwd: string, explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.GITHUB_REF_NAME) return process.env.GITHUB_REF_NAME;
  const described = runGit(['describe', '--tags', '--exact-match'], cwd, true);
  if (described) return described;
  throw new Error('unable to determine current release tag; pass --current-tag or set GITHUB_REF_NAME');
}

export function resolvePreviousTag(cwd: string, currentTag: string, explicit?: string): string | undefined {
  if (explicit) return explicit;
  const tags = runGit(['tag', '--list', 'v*', '--sort=-v:refname'], cwd, true)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (tags.length === 0) return undefined;
  const currentIndex = tags.indexOf(currentTag);
  if (currentIndex >= 0) return tags.slice(currentIndex + 1).find(Boolean);
  return tags.find((tag) => tag !== currentTag);
}

function verifyGitCommitRef(cwd: string, ref: string, label: string): void {
  if (!runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd, true)) {
    throw new Error(`unable to verify ${label} ref for release compare: ${ref}`);
  }
}

export function verifyCompareRange(cwd: string, currentTag: string, previousTag?: string): void {
  if (!previousTag) return;
  verifyGitCommitRef(cwd, previousTag, 'previous tag');
  verifyGitCommitRef(cwd, currentTag, 'current tag');
  const mergeBase = spawnSync('git', ['merge-base', '--is-ancestor', previousTag, currentTag], {
    cwd,
    encoding: 'utf-8',
    stdio: 'pipe',
  });
  if (mergeBase.status !== 0) {
    throw new Error(`invalid release compare range: ${previousTag} is not an ancestor of ${currentTag}`);
  }
}

function normalizeContributors(contributors: Contributor[]): Contributor[] {
  const deduped = new Map<string, Contributor>();
  for (const contributor of contributors) {
    const login = contributor.login?.trim();
    const displayName = contributor.displayName.trim();
    if (!displayName && !login) continue;
    const key = (login || displayName).toLowerCase();
    if (!deduped.has(key)) {
      deduped.set(key, {
        displayName: displayName || `@${login}`,
        ...(login ? { login } : {}),
        ...(contributor.url ? { url: contributor.url } : {}),
      });
    }
  }
  return [...deduped.values()].sort((left, right) => {
    const leftKey = (left.login || left.displayName).toLowerCase();
    const rightKey = (right.login || right.displayName).toLowerCase();
    return leftKey.localeCompare(rightKey);
  });
}

export function formatContributor(contributor: Contributor): string {
  if (contributor.login && contributor.url) {
    return `[@${contributor.login}](${contributor.url})`;
  }
  if (contributor.login) {
    return `@${contributor.login}`;
  }
  if (contributor.url) {
    return `[${contributor.displayName}](${contributor.url})`;
  }
  return contributor.displayName;
}

function joinHumanList(values: string[]): string {
  if (values.length === 0) return 'the contributors';
  if (values.length === 1) return values[0]!;
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, and ${values.at(-1)}`;
}

export function renderContributorsSection(contributors: Contributor[]): string {
  const normalized = normalizeContributors(contributors);
  if (normalized.length === 0) {
    return 'Thanks to the contributors who made this release possible.';
  }
  return `Thanks to ${joinHumanList(normalized.map((contributor) => formatContributor(contributor)))} for contributing to this release.`;
}

export function buildFullChangelogLine(repo: string, currentTag: string, previousTag?: string): string {
  if (!repo) {
    throw new Error('unable to determine GitHub repository; pass --repo or set GITHUB_REPOSITORY');
  }
  if (previousTag) {
    return `**Full Changelog**: [\`${previousTag}...${currentTag}\`](https://github.com/${repo}/compare/${previousTag}...${currentTag})`;
  }
  return `**Full Changelog**: [\`${currentTag}\`](https://github.com/${repo}/releases/tag/${currentTag})`;
}

function replaceTitle(markdown: string, currentTag: string): string {
  if (!/^#\s+/m.test(markdown)) {
    throw new Error('release body template is missing a top-level title');
  }
  return markdown.replace(/^#\s+.*$/m, `# oh-my-codex ${currentTag}`);
}

function findSectionEnd(lines: string[], startIndex: number): number {
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index] ?? '')) return index;
    if (/^\*\*Full Changelog\*\*:/.test(lines[index] ?? '')) return index;
  }
  return lines.length;
}

export function replaceSectionBody(markdown: string, heading: string, body: string): string {
  const lines = markdown.split(/\r?\n/);
  const headingLine = `## ${heading}`;
  const startIndex = lines.findIndex((line) => line.trim() === headingLine);
  if (startIndex === -1) {
    throw new Error(`release body template is missing section: ${headingLine}`);
  }
  const endIndex = findSectionEnd(lines, startIndex);
  lines.splice(startIndex + 1, endIndex - startIndex - 1, '', ...body.split('\n'), '');
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

export function replaceFullChangelogLine(markdown: string, fullChangelogLine: string): string {
  const lines = markdown.split(/\r?\n/);
  const lineIndex = lines.findIndex((line) => /^\*\*Full Changelog\*\*:/.test(line));
  if (lineIndex === -1) {
    throw new Error('release body template is missing the Full Changelog line');
  }
  lines[lineIndex] = fullChangelogLine;
  return `${lines.join('\n').trimEnd()}\n`;
}

function parseShortlogLine(line: string): Contributor | undefined {
  const match = line.match(/^\s*\d+\s+(.+?)(?:\s+<[^>]+>)?$/);
  if (!match) return undefined;
  const displayName = match[1]?.trim();
  if (!displayName) return undefined;
  return { displayName };
}

export function getGitContributors(cwd: string, currentTag: string, previousTag?: string): Contributor[] {
  const range = previousTag ? `${previousTag}..${currentTag}` : currentTag;
  const shortlog = runGit(['shortlog', '-sne', range], cwd, true);
  if (!shortlog) return [];
  return normalizeContributors(shortlog.split(/\r?\n/).map((line) => parseShortlogLine(line)).filter((value): value is Contributor => Boolean(value)));
}

export async function getGitHubCompareContributors(
  repo: string,
  currentTag: string,
  previousTag: string,
  githubToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Contributor[]> {
  const response = await fetchImpl(`https://api.github.com/repos/${repo}/compare/${previousTag}...${currentTag}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${githubToken}`,
      'User-Agent': 'oh-my-codex-release-body-generator',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub compare API failed (${response.status})`);
  }
  const payload = await response.json() as CompareResponse;
  const contributors = (payload.commits ?? []).map((commit) => {
    if (commit.author?.login) {
      return {
        displayName: `@${commit.author.login}`,
        login: commit.author.login,
        ...(commit.author.html_url ? { url: commit.author.html_url } : {}),
      } satisfies Contributor;
    }
    const name = commit.commit?.author?.name?.trim();
    return name ? { displayName: name } satisfies Contributor : undefined;
  }).filter((value): value is Contributor => Boolean(value));
  return normalizeContributors(contributors);
}

export async function resolveContributors(options: {
  cwd: string;
  repo?: string;
  currentTag: string;
  previousTag?: string;
  githubToken?: string;
}): Promise<Contributor[]> {
  const { cwd, repo, currentTag, previousTag, githubToken } = options;
  if (repo && previousTag && githubToken) {
    try {
      return await getGitHubCompareContributors(repo, currentTag, previousTag, githubToken);
    } catch (error) {
      console.error(`[generate-release-body] falling back to git shortlog: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return getGitContributors(cwd, currentTag, previousTag);
}

export async function generateReleaseBody(options: GenerateReleaseBodyOptions): Promise<string> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const templatePath = resolve(cwd, options.templatePath);
  const outPath = resolve(cwd, options.outPath);
  const currentTag = resolveCurrentTag(cwd, options.currentTag);
  const previousTag = resolvePreviousTag(cwd, currentTag, options.previousTag);
  verifyCompareRange(cwd, currentTag, previousTag);
  const repo = options.repo || process.env.GITHUB_REPOSITORY || resolveRepositoryFromRemote(cwd);
  const contributors = await resolveContributors({
    cwd,
    repo,
    currentTag,
    previousTag,
    githubToken: options.githubToken || process.env.GITHUB_TOKEN,
  });

  let markdown = readFileSync(templatePath, 'utf-8');
  markdown = replaceTitle(markdown, currentTag);
  markdown = replaceSectionBody(markdown, 'Contributors', renderContributorsSection(contributors));
  markdown = replaceFullChangelogLine(markdown, buildFullChangelogLine(repo || '', currentTag, previousTag));
  writeFileSync(outPath, markdown);
  return markdown;
}

async function main(): Promise<void> {
  const templatePath = arg('--template');
  const outPath = arg('--out');
  if (!templatePath || !outPath) usage();
  await generateReleaseBody({
    templatePath,
    outPath,
    currentTag: arg('--current-tag'),
    previousTag: arg('--previous-tag'),
    repo: arg('--repo'),
  });
  console.log(resolve(process.cwd(), outPath));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
