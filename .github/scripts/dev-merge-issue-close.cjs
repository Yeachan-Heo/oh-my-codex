const CLOSE_KEYWORD_PATTERN = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b/gi;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collectMatches(pattern, text) {
  const matches = [];
  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    matches.push(match);
  }
  return matches;
}

function collectIssueNumbersFromSegment(segment, owner, repo) {
  const escapedOwner = escapeRegex(owner);
  const escapedRepo = escapeRegex(repo);
  const issueRefPattern = new RegExp(
    `(?:^|[\\s([{:;,])(?:${escapedOwner}\\/${escapedRepo})?#(\\d+)\\b|https:\\/\\/github\\.com\\/${escapedOwner}\\/${escapedRepo}\\/issues\\/(\\d+)\\b`,
    'gi',
  );

  const issueNumbers = [];
  for (const match of collectMatches(issueRefPattern, segment)) {
    const issueNumber = Number(match[1] || match[2]);
    if (Number.isInteger(issueNumber) && issueNumber > 0) {
      issueNumbers.push(issueNumber);
    }
  }
  return issueNumbers;
}

function collectLinkedLocalIssueNumbers({ title = '', body = '', owner, repo }) {
  const issueNumbers = new Set();
  const text = [title, body].filter(Boolean).join('\n');
  const escapedOwner = escapeRegex(owner);
  const escapedRepo = escapeRegex(repo);
  const refRegex = new RegExp(
    `(?:${escapedOwner}\\/${escapedRepo})?#\\d+|https:\\/\\/github\\.com\\/${escapedOwner}\\/${escapedRepo}\\/issues\\/\\d+`,
    'gi',
  );
  const separatorsPattern = /^(?:\s|,|and\b|issues?\b|:|;|\(|\)|\[|\]|\{|\})*$/i;

  for (const line of text.split(/\r?\n/)) {
    const keywordMatches = collectMatches(CLOSE_KEYWORD_PATTERN, line);
    if (keywordMatches.length === 0) continue;

    for (const [index, match] of keywordMatches.entries()) {
      const segmentEnd = keywordMatches[index + 1]?.index ?? line.length;
      const segment = line.slice(match.index + match[0].length, segmentEnd);
      const trimmedSegment = segment.trimStart();
      const normalizedSegment = trimmedSegment.replace(/^:\s*/, '');
      const issueRefs = collectIssueNumbersFromSegment(normalizedSegment, owner, repo);
      if (issueRefs.length === 0) continue;

      const issueRefCount = issueRefs.length;
      const consumed = [];
      refRegex.lastIndex = 0;
      let refMatch;
      while ((refMatch = refRegex.exec(normalizedSegment)) !== null && consumed.length < issueRefCount) {
        consumed.push({ start: refMatch.index, end: refMatch.index + refMatch[0].length });
      }
      if (consumed.length !== issueRefCount) continue;

      let cursor = 0;
      let explicitReferenceList = true;
      for (const part of consumed) {
        if (!separatorsPattern.test(normalizedSegment.slice(cursor, part.start))) {
          explicitReferenceList = false;
          break;
        }
        cursor = part.end;
      }
      if (!explicitReferenceList) continue;

      if (!separatorsPattern.test(normalizedSegment.slice(cursor))) {
        continue;
      }

      for (const issueNumber of issueRefs) {
        issueNumbers.add(issueNumber);
      }
    }
  }

  return [...issueNumbers].sort((a, b) => a - b);
}

function buildMaintainerCloseComment({ prNumber }) {
  return [
    `Closing automatically because PR #${prNumber} was merged into \`dev\` and explicitly referenced this issue in the PR title or body.`,
    '',
    'A hot-fix build is available now. Try it with `omx update --dev` and let us know whether it resolves the issue.',
    '',
    '—',
    "*[repo owner's gaebal-gajae (clawdbot) 🦞]*",
  ].join('\n');
}

function formatIssueList(issueNumbers) {
  return issueNumbers.map((issueNumber) => `#${issueNumber}`).join(', ');
}

function buildMaintainerPrComment({ issueNumbers }) {
  return [
    `Closed explicitly linked issue${issueNumbers.length === 1 ? '' : 's'} after this PR was merged into \`dev\`: ${formatIssueList(issueNumbers)}.`,
    '',
    'A hot-fix build is available now. Issue creators can try it with `omx update --dev` and let us know whether it resolves the issue.',
    '',
    '—',
    "*[repo owner's gaebal-gajae (clawdbot) 🦞]*",
  ].join('\n');
}

function isResourceNotAccessibleError(error) {
  if (!error) return false;
  if (error.status === 403 || error.status === '403') return true;
  return /resource not accessible by integration/i.test(error.message || '');
}

async function postMergedPrFollowUpComment({ github, core, owner, repo, prNumber, issueNumbers }) {
  const body = buildMaintainerPrComment({ issueNumbers });

  try {
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body,
    });
    return { posted: true };
  } catch (error) {
    const detail = error && error.message ? error.message : String(error);
    if (isResourceNotAccessibleError(error)) {
      core.warning(
        `Skipped best-effort PR follow-up comment on #${prNumber}: GitHub returned 403 Resource not accessible by integration. Linked issue closure already succeeded, so the workflow is not failing.`,
      );
    } else {
      core.warning(
        `Skipped best-effort PR follow-up comment on #${prNumber}: ${detail}. Linked issue closure already succeeded, so the workflow is not failing.`,
      );
    }
    return { posted: false, error };
  }
}

module.exports = {
  buildMaintainerCloseComment,
  buildMaintainerPrComment,
  collectLinkedLocalIssueNumbers,
  isResourceNotAccessibleError,
  postMergedPrFollowUpComment,
};
