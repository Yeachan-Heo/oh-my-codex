export const DEFAULT_SAFETY_CRITICAL_PATTERNS: readonly string[] = [
  'auth/',
  'authentication/',
  'crypto/',
  'security/',
  'payments/',
  'billing/',
];

export const DEFAULT_SAFETY_CRITICAL_KEYWORDS: readonly string[] = [
  'password',
  'secret',
  'token',
  'credential',
  'private_key',
];

export interface CategoryInput {
  diffPaths: readonly string[];
  diffContent?: string;
  patterns?: readonly string[];
  keywords?: readonly string[];
}

export interface CategoryVerdict {
  pass: boolean;
  reason: string;
  matchedPaths: readonly string[];
  matchedKeywords: readonly string[];
}

export function checkCategory(input: CategoryInput): CategoryVerdict {
  const patterns = input.patterns ?? DEFAULT_SAFETY_CRITICAL_PATTERNS;
  const keywords = input.keywords ?? DEFAULT_SAFETY_CRITICAL_KEYWORDS;

  const matchedPaths = input.diffPaths.filter((p) => patterns.some((pat) => p.includes(pat)));

  const matchedKeywords = input.diffContent
    ? keywords.filter((kw) => input.diffContent?.toLowerCase().includes(kw))
    : [];

  if (matchedPaths.length === 0 && matchedKeywords.length === 0) {
    return {
      pass: true,
      reason: 'no safety-critical paths or keywords detected',
      matchedPaths: [],
      matchedKeywords: [],
    };
  }

  const bits: string[] = [];
  if (matchedPaths.length > 0) bits.push(`paths: ${matchedPaths.slice(0, 2).join(', ')}`);
  if (matchedKeywords.length > 0) bits.push(`keywords: ${matchedKeywords.slice(0, 2).join(', ')}`);

  return {
    pass: false,
    reason: `safety-critical category detected (${bits.join('; ')})`,
    matchedPaths,
    matchedKeywords,
  };
}
