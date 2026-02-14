export function suggestClosest(input: string, candidates: string[]): string | null {
  const needle = input.trim().toLowerCase();
  if (!needle) return null;

  const exact = candidates.find(candidate => candidate.toLowerCase() === needle);
  if (exact) return exact;

  const prefix = candidates.find(candidate => candidate.toLowerCase().startsWith(needle));
  if (prefix) return prefix;

  let best: { value: string; distance: number } | null = null;
  for (const candidate of candidates) {
    const distance = levenshtein(needle, candidate.toLowerCase());
    if (!best || distance < best.distance) {
      best = { value: candidate, distance };
    }
  }

  if (!best) return null;
  const threshold = Math.max(2, Math.floor(needle.length / 2));
  return best.distance <= threshold ? best.value : null;
}

function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0));

  for (let i = 0; i < rows; i++) dp[i][0] = i;
  for (let j = 0; j < cols; j++) dp[0][j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  return dp[rows - 1][cols - 1];
}
