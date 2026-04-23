export interface DocumentRefreshRule {
  id: string;
  description: string;
  sourceGlobs: string[];
  refreshTargets: string[];
  ignoredGlobs?: string[];
}

export const DEFAULT_DOCUMENT_REFRESH_RULES: DocumentRefreshRule[] = [
  {
    id: "native-hook-behavior",
    description: "Codex native hook behavior and managed hook configuration",
    sourceGlobs: [
      "src/scripts/codex-native-hook.ts",
      "src/scripts/codex-native-pre-post.ts",
      "src/scripts/__tests__/codex-native-hook.test.ts",
      "src/config/codex-hooks.ts",
      "src/config/__tests__/codex-hooks.test.ts",
    ],
    refreshTargets: [
      "docs/codex-native-hooks.md",
      ".omx/plans/*codex-native*",
      ".omx/specs/*codex-native*",
      ".omx/plans/*native-hook*",
      ".omx/specs/*native-hook*",
    ],
  },
  {
    id: "document-refresh-enforcer",
    description: "Document-refresh warning classifier and rule behavior",
    sourceGlobs: [
      "src/document-refresh/**",
    ],
    refreshTargets: [
      "docs/codex-native-hooks.md",
      ".omx/plans/*document-refresh*",
      ".omx/specs/*document-refresh*",
    ],
  },
  {
    id: "cli-operator-behavior",
    description: "CLI and operator-facing behavior",
    sourceGlobs: [
      "src/cli/**",
    ],
    refreshTargets: [
      "README.md",
      "docs/getting-started.html",
      ".omx/plans/*cli*",
      ".omx/specs/*cli*",
      ".omx/plans/*operator*",
      ".omx/specs/*operator*",
    ],
    ignoredGlobs: [
      "src/cli/**/__tests__/**",
      "src/cli/**/*.test.ts",
    ],
  },
  {
    id: "prompt-guidance-behavior",
    description: "Prompt guidance and hook routing behavior",
    sourceGlobs: [
      "src/hooks/keyword-detector.ts",
      "src/hooks/triage-config.ts",
      "src/hooks/triage-heuristic.ts",
      "src/hooks/__tests__/prompt-guidance-*.test.ts",
      "src/hooks/__tests__/analyze-*-contract.test.ts",
    ],
    refreshTargets: [
      "docs/prompt-guidance-contract.md",
      ".omx/plans/*prompt*",
      ".omx/specs/*prompt*",
      ".omx/plans/*guidance*",
      ".omx/specs/*guidance*",
    ],
  },
];
