# Release readiness — 0.20.1

## Pre-tag declaration

This is a static, declarative readiness contract for the tagged release tree. It records no executed command, test result, review, CI run, staged-tree value, tag object, GitHub release, npm publication, or public-install observation. Those facts are pending until observed and must be written only to the external receipt locations below.

## Release identity

- Release: `0.20.1` (patch).
- Date: 2026-07-12.
- Previous tag: `v0.20.0`.
- Frozen dev base: `9eadab9f191103177fb3eac1b237188ada1f503c`.
- Exact compare range: `v0.20.0..9eadab9f191103177fb3eac1b237188ada1f503c`.
- Expected range inventory: nine commits — seven fix PRs and two prior-release collateral corrections.
- Compatibility: no intentional breaking CLI or package-layout changes.

## Frozen commit inventory

| Commit | PR / issue classification | Title and surface | Release disposition |
|---|---|---|---|
| `f644d2cd3ae98587942aa94f0030f083ea0bb10f` | Direct commit; no PR | `docs(release): correct 0.20.0 collateral to cover the full v0.19.1..v0.20.0 range`; prior-release release documentation | Prior-release collateral correction; inventory only, not a 0.20.1 product headline. |
| `5d43a5bf6f008de17f9425bee4495c457c60b96a` | Direct commit; no PR | `docs(release): describe capabilities preflight as a manual command`; prior-release release documentation | Prior-release collateral correction; inventory only, not a 0.20.1 product headline. |
| `9ea0181820186e7ac14f2ba60c130af3dfb5ce26` | PR #3107 | `Fix CRLF generated AGENTS marker insertion (#3107)`; AGENTS marker utility and regression test | Patch fix; public CRLF-marker coverage. |
| `0f38ebecda8e39c6d0346574364185ff45c29f8d` | PR #3110 | `Fix Ralplan Markdown draft artifact writes (#3110)`; native-hook planning-write boundary and tests | Patch fix; public Ralplan-draft coverage. |
| `05262a1cb27429c72764dc4ba0b3c96a2e987fa3` | PR #3111 | `fix: stop seeding legacy multi-agent config (#3111)`; generator, setup, uninstall, doctor, and tests | Patch fix; public legacy multi-agent default-seeding coverage. |
| `754716f179ee69f58a3df1803ff6bdd5688fba9f` | PR #3114 | `fix(hooks): keep Stop responses schema-safe (#3114)`; Stop response and plugin-wrapper tests | Patch fix; public schema-safe Stop response coverage. |
| `5fa4f43585ac539bb2df31a8488c4373594d079a` | PR #3115 | `fix(config): stop seeding legacy context defaults (#3115)`; generator, setup, doctor, docs, and tests | Patch fix; public legacy context-default coverage. |
| `d4c605fc44b2ce2e87e650630768449f05bd1492` | PR #3117; issue #3116 | `fix(hooks): trust delegated collaboration child provenance under Conductor guard (#3116) (#3117)`; hook provenance, docs, and tests | Patch fix; public delegated-child provenance coverage. |
| `9eadab9f191103177fb3eac1b237188ada1f503c` | PR #3120; issue #3119 | `fix(leader): detect native delegation presence and stop misparsing quoted Bash write targets (#3119) (#3120)`; leader/parser tests | Patch fix; public native-delegation and quoted-Bash-target coverage. |

Exactly seven PRs are in scope: #3107, #3110, #3111, #3114, #3115, #3117, and #3120. #3116 and #3119 are issues, not additional PRs. Reproduce the inventory with `git log --reverse --format='%H%x09%s' v0.20.0..9eadab9f191103177fb3eac1b237188ada1f503c`; any mismatch blocks release preparation.

## Stable release-prep scope

The expected staged path set contains exactly these nine paths:

1. `package.json`
2. `package-lock.json`
3. `Cargo.toml`
4. `Cargo.lock`
5. `plugins/oh-my-codex/.codex-plugin/plugin.json`
6. `CHANGELOG.md`
7. `RELEASE_BODY.md`
8. `docs/release-notes-0.20.1.md`
9. `docs/qa/release-readiness-0.20.1.md`

The five metadata paths may contain only synchronized `0.20.1` version updates with no dependency or integrity churn. Product source, workflows, individual crate manifests, `.gjc`, and `artifacts` are outside this staged scope. The deterministic staged-tree verifier below supplies the required path, whitespace, metadata-preservation, mode/object-type, and staged-tree evidence; its results remain pending until external receipts record them.

## Deterministic staged-scope and metadata-preservation verification

After staging the release changes, first satisfy the local-exclusion precondition for `artifacts/release-0.20.1/external-receipts/` specified below, create that excluded directory locally, and run this deterministic verifier exactly as shown. It captures an immutable `stagedTreeOid` with `git write-tree` before any staged validation, exact-matches the nine changed paths and checks whitespace against that tree, proves that every tree entry is a regular blob with the required mode and object type, and byte-compares both the staged-tree and working-tree forms of the five metadata files against the frozen base with the only permitted transformation. The seven frozen-base paths must retain their frozen regular-blob mode/type; each of the two new documentation paths must be a `100644` blob. It rejects dependency, integrity, resolved, and all other metadata churn. Immediately before its final operation establishes the sole authoritative `staged-tree.oid` receipt, it requires the live index tree still equals the initially captured OID; no downstream flow may supply, replace, or rebind that OID.

```sh
receiptRoot="$(git rev-parse --show-toplevel)/artifacts/release-0.20.1/external-receipts"
mkdir -p "$receiptRoot"
STAGED_TREE_OID_RECEIPT="$receiptRoot/staged-tree.oid" node - <<'NODE'
const { execFileSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");

const frozenBase = "9eadab9f191103177fb3eac1b237188ada1f503c";
const frozenBasePaths = [
  "package.json",
  "package-lock.json",
  "Cargo.toml",
  "Cargo.lock",
  "plugins/oh-my-codex/.codex-plugin/plugin.json",
  "CHANGELOG.md",
  "RELEASE_BODY.md",
];
const newDocumentationPaths = [
  "docs/release-notes-0.20.1.md",
  "docs/qa/release-readiness-0.20.1.md",
];
const expectedPaths = [...frozenBasePaths, ...newDocumentationPaths].sort();
const stagedTreeReceipt = process.env.STAGED_TREE_OID_RECEIPT;
if (!stagedTreeReceipt) {
  throw new Error("STAGED_TREE_OID_RECEIPT is required");
}

function git(args, options = {}) {
  return execFileSync("git", args, { encoding: "utf8", ...options });
}

const stagedTreeOid = git(["write-tree"]).trim();
if (!/^[0-9a-f]{40}$/.test(stagedTreeOid)) {
  throw new Error(`invalid staged-tree OID: ${stagedTreeOid}`);
}

function fileAt(treeOid, path) {
  return git(["show", `${treeOid}:${path}`]);
}

function replaceExactlyOnce(text, pattern, replacement, label) {
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`${label}: expected exactly one permitted version field, found ${matches.length}`);
  }
  return text.replace(pattern, replacement);
}

const stagedPaths = git(["diff", "--name-only", frozenBase, stagedTreeOid])
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .sort();
if (JSON.stringify(stagedPaths) !== JSON.stringify(expectedPaths)) {
  throw new Error(`unexpected staged paths: ${JSON.stringify(stagedPaths)}`);
}
git(["diff", "--check", frozenBase, stagedTreeOid], { stdio: "inherit" });

function frozenTreeEntry(path) {
  const output = git(["ls-tree", frozenBase, "--", path]).trim();
  const match = /^([0-7]{6}) ([a-z]+) ([0-9a-f]{40})\t(.+)$/.exec(output);
  if (!match || match[4] !== path) {
    throw new Error(`${path}: expected exactly one frozen-base tree entry`);
  }
  return { mode: match[1], type: match[2] };
}

function stagedTreeEntry(path) {
  const output = git(["ls-tree", stagedTreeOid, "--", path]).trim();
  const match = /^([0-7]{6}) ([a-z]+) ([0-9a-f]{40})\t(.+)$/.exec(output);
  if (!match || match[4] !== path) {
    throw new Error(`${path}: expected exactly one staged-tree entry`);
  }
  return {
    mode: match[1],
    type: match[2],
  };
}

function isRegularBlob(entry) {
  return (entry.mode === "100644" || entry.mode === "100755") && entry.type === "blob";
}

for (const path of frozenBasePaths) {
  const base = frozenTreeEntry(path);
  const staged = stagedTreeEntry(path);
  if (!isRegularBlob(base)) {
    throw new Error(`${path}: frozen-base entry is not a regular blob (${base.mode} ${base.type})`);
  }
  if (!isRegularBlob(staged) || staged.mode !== base.mode || staged.type !== base.type) {
    throw new Error(
      `${path}: staged mode/type must preserve frozen regular blob ${base.mode} ${base.type}, found ${staged.mode} ${staged.type}`,
    );
  }
}

for (const path of newDocumentationPaths) {
  const staged = stagedTreeEntry(path);
  if (staged.mode !== "100644" || staged.type !== "blob") {
    throw new Error(`${path}: staged entry must be a 100644 blob, found ${staged.mode} ${staged.type}`);
  }
}

const expectedMetadata = {
  "package.json": (base) => replaceExactlyOnce(
    base,
    /^  "version": "0\.20\.0",$/gm,
    '  "version": "0.20.1",',
    "package.json root version",
  ),
  "package-lock.json": (base) => replaceExactlyOnce(
    replaceExactlyOnce(
      base,
      /^  "version": "0\.20\.0",$/gm,
      '  "version": "0.20.1",',
      "package-lock.json root version",
    ),
    /^      "version": "0\.20\.0",$/gm,
    '      "version": "0.20.1",',
    "package-lock.json packages[\"\"].version",
  ),
  "Cargo.toml": (base) => replaceExactlyOnce(
    base,
    /(\[workspace\.package\]\n\nversion = )"0\.20\.0"/g,
    '$1"0.20.1"',
    "Cargo.toml workspace.package version",
  ),
  "Cargo.lock": (base) => [
    "omx-api",
    "omx-explore-harness",
    "omx-mux",
    "omx-runtime",
    "omx-runtime-core",
    "omx-sparkshell",
  ].reduce(
    (text, name) => replaceExactlyOnce(
      text,
      new RegExp(
        `(\\[\\[package\\]\\]\\nname = "${name}"\\nversion = )"0\\.20\\.0"`,
        "g",
      ),
      '$1"0.20.1"',
      `Cargo.lock ${name} version`,
    ),
    base,
  ),
  "plugins/oh-my-codex/.codex-plugin/plugin.json": (base) => replaceExactlyOnce(
    base,
    /^  "version": "0\.20\.0",$/gm,
    '  "version": "0.20.1",',
    "plugin manifest version",
  ),
};

for (const [path, transform] of Object.entries(expectedMetadata)) {
  const expected = Buffer.from(transform(fileAt(frozenBase, path)));
  const staged = Buffer.from(fileAt(stagedTreeOid, path));
  const workingTree = readFileSync(path);
  if (!expected.equals(staged) || !expected.equals(workingTree)) {
    throw new Error(`${path}: differs from its sole permitted version update`);
  }
}

const stagedTreeLine = `${stagedTreeOid}\n`;
const liveStagedTreeOid = git(["write-tree"]).trim();
if (liveStagedTreeOid !== stagedTreeOid) {
  throw new Error(`index changed during verification: expected ${stagedTreeOid}, found ${liveStagedTreeOid}`);
}
try {
  writeFileSync(stagedTreeReceipt, stagedTreeLine, { encoding: "utf8", flag: "wx" });
} catch (error) {
  if (error?.code !== "EEXIST") {
    throw error;
  }
}
const recordedTreeLine = readFileSync(stagedTreeReceipt, "utf8");
if (recordedTreeLine.length !== 41 || !/^[0-9a-f]{40}\n$/.test(recordedTreeLine)) {
  throw new Error("staged-tree.oid must contain exactly one lowercase 40-hex OID line");
}
if (recordedTreeLine !== stagedTreeLine) {
  throw new Error(`staged-tree.oid is already bound to ${recordedTreeLine.trim()}, not ${stagedTreeOid}`);
}
console.log(stagedTreeOid);
NODE
```

The sole accepted mutations are one `package.json` version line, the two `package-lock.json` root fields, the `Cargo.toml` workspace-package version field, the six named `Cargo.lock` package versions, and one plugin-manifest version field. The verifier captures `stagedTreeOid` before validation; it validates that immutable tree, then immediately before exclusive creation of `staged-tree.oid` requires a fresh `git write-tree` to equal the captured OID. It then reads the receipt back and requires exactly one 40-lowercase-hex line plus its terminating newline and equality with that verified OID. Thus its stdout only confirms the receipt: `staged-tree.oid` is the sole authoritative handoff. Rerun the entire verifier after every lifecycle command that mutates the worktree or index; a rerun may proceed only when the existing receipt passes that exact validation and equals the current tree, never by overwriting it. `path-scope.json`, every gate receipt, and both review receipts must bind to that exact receipt value.

## Isolated exact-tree local verification

All local build, test, package, and smoke gates must run only in a disposable detached verification worktree, never in the release-preparation worktree. The deterministic verifier must already have established `staged-tree.oid`; this flow reads that exact receipt, validates its one-line form, and asserts that the release-preparation index's current `git write-tree` still equals it before creating the synthetic verification commit. First satisfy the local-exclusion precondition for `artifacts/release-0.20.1/external-receipts/` specified below. `receiptRoot` is deliberately outside the disposable worktree.

```sh
#!/usr/bin/env bash
set -euo pipefail

frozenBase=9eadab9f191103177fb3eac1b237188ada1f503c
mainWorktree="$(git rev-parse --show-toplevel)"
receiptRoot="$mainWorktree/artifacts/release-0.20.1/external-receipts"
stagedTreeReceipt="$receiptRoot/staged-tree.oid"
verificationRef=refs/gjc/release-0.20.1/verification
zeroOid=0000000000000000000000000000000000000000

read_exact_oid() {
  node - "$1" <<'NODE'
const { readFileSync } = require("node:fs");
const value = readFileSync(process.argv[2], "utf8");
if (value.length !== 41 || !/^[0-9a-f]{40}\n$/.test(value)) {
  throw new Error(`${process.argv[2]} must contain exactly one lowercase 40-hex OID line`);
}
process.stdout.write(value);
NODE
}

stagedTreeOid="$(read_exact_oid "$stagedTreeReceipt")"
test "$(git write-tree)" = "$stagedTreeOid"
verificationCommit="$(git commit-tree "$stagedTreeOid" -p "$frozenBase" -m 'local-only 0.20.1 verification tree')"
git check-ref-format "$verificationRef"
case "$verificationRef" in
  refs/heads/*|refs/tags/*|refs/remotes/*)
    echo 'verification ref must be outside heads, tags, and remotes' >&2
    exit 1
    ;;
esac
git update-ref "$verificationRef" "$verificationCommit" "$zeroOid"
verificationWorktree="$(mktemp -d "${TMPDIR:-/tmp}/oh-my-codex-0.20.1-verify.XXXXXX")"
rmdir "$verificationWorktree"

assert_verification_ref_is_live() {
  test "$(git rev-parse --verify "$verificationRef")" = "$verificationCommit"
  test "$(git rev-parse "${verificationRef}^")" = "$frozenBase"
  if git rev-parse --verify "${verificationRef}^2" >/dev/null; then
    echo 'verification commit must have exactly one parent' >&2
    return 1
  fi
  test "$(git rev-parse "${verificationRef}^{tree}")" = "$stagedTreeOid"
}

assert_verification_commit_is_local_only() {
  assert_verification_ref_is_live
  test -z "$(git for-each-ref --format='%(refname)' --points-at "$verificationCommit" refs/heads refs/remotes)"
  test -z "$(git tag --points-at "$verificationCommit")"
  while IFS= read -r remote; do
    advertised="$(git ls-remote "$remote")"
    case $'\n'"$advertised"$'\n' in
      *$'\n'"$verificationCommit"$'\t'*)
        echo "verification commit is advertised by remote $remote" >&2
        return 1
        ;;
    esac
  done < <(git remote)
}

assert_verification_commit_is_local_only
mkdir -p "$receiptRoot/logs"
git cat-file commit "$verificationRef" >"$receiptRoot/verification-commit.object"
node - "$receiptRoot" "$verificationRef" "$verificationCommit" "$frozenBase" "$stagedTreeOid" <<'NODE'
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync } = require("node:fs");
const [receiptRoot, verificationRef, verificationCommit, frozenBase, stagedTreeOid] = process.argv.slice(2);
const objectPath = `${receiptRoot}/verification-commit.object`;
const object = readFileSync(objectPath);
const objectSha256 = createHash("sha256").update(object).digest("hex");
const recomputedCommitOid = execFileSync(
  "git",
  ["hash-object", "-t", "commit", "--stdin"],
  { encoding: "utf8", input: object },
).trim();
if (recomputedCommitOid !== verificationCommit) {
  throw new Error(`canonical commit object recomputes to ${recomputedCommitOid}, not ${verificationCommit}`);
}
const parent = execFileSync("git", ["rev-parse", `${verificationRef}^`], { encoding: "utf8" }).trim();
const tree = execFileSync("git", ["rev-parse", `${verificationRef}^{tree}`], { encoding: "utf8" }).trim();
if (parent !== frozenBase || tree !== stagedTreeOid) {
  throw new Error("verification ref parent/tree differs from the frozen base or staged-tree receipt");
}
const oidLine = `${verificationCommit}\n`;
if (oidLine.length !== 41 || !/^[0-9a-f]{40}\n$/.test(oidLine)) {
  throw new Error("verification commit must be a lowercase 40-hex OID");
}
writeFileSync(`${receiptRoot}/verification-commit.oid`, oidLine, { encoding: "utf8", flag: "wx" });
const receipt = {
  schema: "oh-my-codex.release-evidence/v1",
  kind: "verification-commit",
  release: "0.20.1",
  recordedAt: new Date().toISOString(),
  status: "pass",
  subject: verificationRef,
  inputs: { stagedTreeOid, frozenBase, verificationRef, verificationCommit },
  observations: {
    parent,
    tree,
    refReachable: true,
    canonicalObject: "verification-commit.object",
    canonicalObjectSha256: objectSha256,
    recomputedCommitOid,
  },
  sha256: objectSha256,
  producer: "git cat-file commit plus git hash-object -t commit --stdin",
};
writeFileSync(`${receiptRoot}/verification-commit.json`, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
NODE
git worktree add --detach "$verificationWorktree" "$verificationRef"

cleanup_verification_worktree() {
  git worktree remove --force "$verificationWorktree"
}
trap cleanup_verification_worktree EXIT HUP INT TERM

assert_isolated_tree_is_clean() {
  assert_verification_ref_is_live
  test "$(git -C "$verificationWorktree" rev-parse HEAD)" = "$verificationCommit"
  test "$(git -C "$verificationWorktree" rev-parse 'HEAD^{tree}')" = "$stagedTreeOid"
  if git -C "$verificationWorktree" symbolic-ref -q HEAD; then
    echo 'verification worktree HEAD must remain detached' >&2
    return 1
  fi
  git -C "$verificationWorktree" diff --quiet
  git -C "$verificationWorktree" diff --cached --quiet
  test -z "$(git -C "$verificationWorktree" status --porcelain=v1 --untracked-files=all)"
}

run_isolated_gate() {
  label=$1
  shift
  assert_isolated_tree_is_clean
  status=0
  (
    cd "$verificationWorktree"
    "$@"
  ) >"$receiptRoot/logs/${label}.log" 2>&1 || status=$?
  assert_isolated_tree_is_clean
  printf '%s\n' "$status" >"$receiptRoot/logs/${label}.status"
  return "$status"
}

reconcile_candidate_and_delete_verification_ref() {
  local candidateCommit
  candidateCommit="$(git rev-parse --verify "${1:?real candidate commit is required}^{commit}")"
  assert_verification_commit_is_local_only
  test "$candidateCommit" != "$verificationCommit"
  test "$(git rev-parse "${candidateCommit}^")" = "$frozenBase"
  if git rev-parse --verify "${candidateCommit}^2" >/dev/null; then
    echo 'candidate commit must have exactly one parent' >&2
    return 1
  fi
  test "$(git rev-parse "${candidateCommit}^{tree}")" = "$stagedTreeOid"
  test "$(git rev-parse "${verificationRef}^")" = "$frozenBase"
  test "$(git rev-parse "${verificationRef}^{tree}")" = "$stagedTreeOid"
  git update-ref -d "$verificationRef" "$verificationCommit"
  if git rev-parse --verify --quiet "$verificationRef" >/dev/null; then
    echo 'verification ref deletion did not take effect' >&2
    return 1
  fi
  if git show-ref --verify --quiet "$verificationRef"; then
    echo 'verification ref remains in the local ref database' >&2
    return 1
  fi
}
```

Invoke every local command in the matrix through `run_isolated_gate`, preserving its command and arguments exactly; a nonzero command result blocks progression only after the required post-command assertion and external log/status capture. This includes `npm ci`; every `npm run` build, test, lint, check, package-smoke, and regression command; `npm pack --json --dry-run`; every `node` command and focused config/setup/doctor/uninstall matrix in the local gate matrix; and all listed `cargo` commands. Thus package, packed-install smoke, and Rust gates cannot read unstaged or untracked content from the release-preparation worktree. The temporary commit is anchored by the compare-and-swap, create-once `verificationRef`; it must remain reachable through every local gate and both reviews. It is local-only under an explicit push-refspec allowlist: while it exists, bare or implicit `git push`, `--all`, and `--mirror` are prohibited, and any permitted push must name only an approved release head ref, never `refs/gjc/release-0.20.1/verification` or its commit. Tag creation or movement, promotion, and candidate operations may not name the verification ref or commit. The initial and terminal local/remote/tag probes above are required proof that it was neither published nor tagged. Capture all gate logs and JSON receipts under `receiptRoot`, never under `verificationWorktree`; the trap removes only the disposable worktree and must not remove `verificationRef`.

Before and after every individual command, `assert_isolated_tree_is_clean` must succeed. Its live-verification-ref, detached-HEAD, exact-`HEAD^{tree}`, clean-index, clean-working-tree, and no-untracked-files assertions are mandatory even when a gate command fails. Architect and Critic must review tree-addressed inputs from `stagedTreeOid` (for example, `git diff "$frozenBase" "$stagedTreeOid"` and `git show "$stagedTreeOid:<path>"`), not files from any worktree; this preserves the existing same-tree review requirement while excluding unstaged or untracked inputs. Before and after each review, resolve `verificationRef`, `verificationRef^`, and `verificationRef^{tree}` and require the recorded commit, frozen base, and `stagedTreeOid` respectively; both review receipts must identify that live ref and commit.

Do not invoke `reconcile_candidate_and_delete_verification_ref` until every required local gate has captured its receipt and Architect then Critic have approved the live verification ref. Pass the actual newly created candidate commit as its sole argument. The function performs the terminal local/tag/remote probe while the ref is still live, resolves both the candidate's and the verification ref's parent and tree, requires each to be a one-parent child of the frozen base with the receipt tree, then performs compare-and-swap deletion and proves the ref is absent through both `rev-parse --verify` and `show-ref --verify`. Only after that successful return may `path-scope.json` record candidate reconciliation: its `inputs` must include `stagedTreeOid`, `verificationRef`, and `verificationCommit`; its observations must include the candidate OID, both resolved parent/tree pairs, the terminal unpublished/untagged probe results, the expected-old OID used for deletion, and both successful deletion probes. A failed candidate check, probe, deletion, or receipt blocks; neither worktree cleanup nor any earlier lifecycle step may delete the ref.

## Required command and gate matrix

All rows are required and pending. Commands that can change the tracked tree must be followed by a staged-path and staged-tree assertion; an error status must not suppress that assertion.

| Gate | Required command or check | Required acceptance evidence | Status |
|---|---|---|---|
| Freeze and inventory | Verify `HEAD` and `dev` equal frozen base; verify `v0.20.0` ancestry; require nine commits; run the frozen `git log` inventory command and inspect the seven listed PRs | Exact base, ancestry, count, commit inventory, and PR/issue classification | Pending |
| Metadata and plugin sync | `npm ci`; `npm run build`; `node dist/scripts/check-version-sync.js --tag v0.20.1`; `npm run sync:plugin:check` | Synchronized package/Cargo/plugin versions and no tracked-tree mutation outside the nine paths | Pending |
| Focused regression gates | `node --test dist/utils/__tests__/agents-md.test.js`; `node --test dist/scripts/__tests__/codex-native-hook.test.js`; focused config/setup/doctor/uninstall matrices; `node dist/scripts/run-test-files.js dist/scripts/__tests__/codex-native-hook.test.js dist/leader/__tests__/contract.test.js` | Coverage of #3107 CRLF markers, #3110 drafts, #3111/#3115 default seeding, #3114 Stop schema, and #3117/#3120 provenance/delegation/parser behavior | Pending |
| Release regression suites | `npm run test:recent-bug-regressions:compiled`; `npm run test:plugin-boundaries:compiled`; `npm run test:ralph-persistence:compiled`; `npm run test:explicit-terminal-contract:compiled` | Compiled regression, plugin, persistence, and terminal-contract results | Pending |
| Package | `npm pack --json --dry-run` | Pack identity and contents | Pending |
| Full local gates | `npm run lint`; `npm run check:no-unused`; `npm test`; `npm run build:full`; `npm run smoke:packed-install`; `cargo fmt --all --check`; `cargo clippy --workspace --all-targets -- -D warnings`; `cargo test --workspace` | Passing full Node, package, and Rust quality gates, subject only to the named exception below | Pending |
| Review and promotion | Independent Architect then Critic approval for the same external staged-tree observation; candidate has one parent at the frozen base; promotion is a two-parent merge with the same tree | Review receipts, topology evidence, exact candidate dev CI, and exact promoted main CI | Pending |
| Tag and publication | Follow the mandatory final tag and release-body sequence below; then run the tag workflow and public GitHub/npm/install/native checks | Exact annotated tag object, validated generated body, release assets, npm provenance, and public-install receipts | Pending |

## Mandatory final tag and release-body sequence

The final tag and release-body gate is ordered and fail-closed; the final annotated tag's exact tree is the release-body source of truth:

1. Run authoritative absence probes for `v0.20.1` before any irreversible release action.
2. Establish the green promoted commit.
3. In a clean detached worktree at that promoted commit, require `git status --porcelain --untracked-files=all` to produce zero output, `git symbolic-ref -q HEAD` to fail, `HEAD` to resolve to the promoted commit, and `git rev-parse HEAD^{tree}` to exactly equal the sole OID recorded in `staged-tree.oid`. Any worktree, commit, or tree mismatch blocks tag creation.
4. Create the final local annotated `v0.20.1` tag at that promoted commit.
5. After the tag exists, require the tagged template blob to match the release tree with `test "$(git rev-parse v0.20.1:RELEASE_BODY.md)" = "$(git rev-parse "${stagedTreeOid}:RELEASE_BODY.md")"`, where `stagedTreeOid` is the sole recorded value from `staged-tree.oid`, then materialize that tagged blob only with `git show v0.20.1:RELEASE_BODY.md > /tmp/RELEASE_BODY.tagged-0.20.1.md`.
6. Generate the release body with `node dist/scripts/generate-release-body.js --template /tmp/RELEASE_BODY.tagged-0.20.1.md --out /tmp/RELEASE_BODY.generated-0.20.1.md --current-tag v0.20.1 --previous-tag v0.20.0 --repo Yeachan-Heo/oh-my-codex`.
7. Validate that generated file for `0.20.1`, `## Contributors`, the exact `v0.20.0...v0.20.1` compare range, and all seven in-scope PRs.
8. Assert local annotated-tag commit/tree identity: `git cat-file -t v0.20.1` must be `tag`, `git rev-parse v0.20.1^{commit}` must equal the promoted commit, and `git rev-parse v0.20.1^{tree}` must exactly equal `stagedTreeOid`.
9. Only then push the exact local annotated tag object; the remote tag object must equal the local `v0.20.1` tag object.

All nine review inputs—the exact nine staged paths, including `RELEASE_BODY.md`—are pinned to the same staged/tagged tree: review evidence must identify `stagedTreeOid`, and the final tag tree and tagged template blob must equal that tree. An unstaged or post-review collateral edit is not a review or release-body input and cannot affect the generated release body or review evidence.

No release-body command may write a root `RELEASE_BODY.generated.md` output.

## macOS GNU `stat -c` exception contract

The only potentially eligible platform exception is macOS BSD userland for `dist/cli/__tests__/resume.test.js`, case `preserves transcript mtimes while materializing runtime history for updated sort`, where the fake Codex fixture invokes GNU `stat -c`. An `exception` status is valid only for that named test in the final full-gate receipt and only when all of the following are externally evidenced for the same environment and staged-tree OID:

1. The failure reproduces identically against `v0.20.0`.
2. The candidate passes the affected test on Linux.
3. Architect review then Critic review explicitly accepts the exception for the observed external staged-tree value.

No other failure, platform variation, or unproven baseline reproduction qualifies; an `exception` never substitutes for a missing predicate. This contract does not assert that the exception has occurred.

## External evidence schema and receipt locations

All actual observations belong under `artifacts/release-0.20.1/external-receipts/`. Before any receipt is created, that root must be protected by a verified local `.git/info/exclude` entry: require `git check-ignore -v artifacts/release-0.20.1/external-receipts/staged-tree.oid` to identify that local exclusion and require `git status --short --untracked-files=all -- artifacts/release-0.20.1/` to produce zero output, with no `??`, index state, or other receipt path. Together these checks prove that no receipt path is visible or stageable. This contract neither relies on nor claims a repository `.gitignore` rule for receipts. The tagged readiness file must remain declarative; it must not embed actual tree IDs, command output, reviewer verdicts, CI run IDs, tag details, publication responses, or public-install output.

Each JSON receipt must use schema identifier `oh-my-codex.release-evidence/v1` and contain at least:

- `schema`, `kind`, `release`, and `recordedAt`;
- `status` (`pass`, `fail`, `pending`, or `exception`);
- `subject` identifying the checked command, ref, package, workflow, or external surface;
- `inputs` and `observations` with raw output or a durable output reference;
- `sha256` for captured output, computed with validated trusted Node `crypto`; and
- `producer` identifying the command or reviewer that produced the record.

Expected receipt locations are:

- `staged-tree.oid` for the sole immutable staged-tree handoff; `verification-commit.oid`, `verification-commit.object`, and `verification-commit.json` for the live local verification commit and its canonical object evidence; and `path-scope.json` for candidate/tree reconciliation and verified ref deletion;
- `gates/focused.json`, `gates/full.json`, `package/pack.json`, and `release-body.json` for local command evidence;
- `reviews/architect.json` and `reviews/critic.json` for same-tree review evidence;
- `ci/dev.json`, `ci/main.json`, and `ci/tag-workflow.json` for CI evidence;
- `tag.json`, `github-release.json`, and `npm.json` for tag, assets, registry, integrity, and provenance observations;
- `public-install.json` and `native-smoke.json` for isolated public package and native-binary checks; and
- `preservation/baseline.json` and `preservation/final.json` for unrelated-state preservation evidence.

A receipt index may link these files and their hashes. Actual staged-tree values, command outcomes, review verdicts, CI run IDs, tag object IDs, release URLs, package metadata, and install outputs remain pending until those receipts exist.

`verification-commit.object` must be the unmodified canonical bytes emitted by `git cat-file commit "$verificationRef"` while that ref resolves. `verification-commit.json` must record that durable object path, its trusted-Node-crypto SHA-256, the OID recomputed from those bytes with `git hash-object -t commit --stdin`, the ref, commit, parent, tree, and `refReachable: true`; the recomputed OID, parent, and tree must equal `verification-commit.oid`, the frozen base, and `staged-tree.oid` respectively. It is created once before local gates, reviews, or worktree cleanup and is never rewritten after ref deletion.

`path-scope.json` is the terminal reconciliation receipt. It is valid only after the actual candidate is created and the guarded ref has been deleted by the required compare-and-swap operation; it must capture the pre-deletion live-ref resolution and the post-deletion absence checks described above. A receipt that records deletion before the candidate parent/tree proof, or that lacks either absence proof, blocks.

## Terminal receipt disposition and staged-tree binding

Every required final JSON receipt must have `status: pass`. The sole permitted `exception` is the named macOS GNU `stat -c` test in `gates/full.json`, and it is valid only when every predicate in the exception contract is recorded for the same staged-tree OID. A `pending` or `fail` status always blocks release progression; a missing receipt, an unrecognized exception, or an exception with any missing predicate also blocks.

Each gate receipt (`gates/focused.json` and `gates/full.json`), package receipt (`package/pack.json`), release-body receipt (`release-body.json`), and review receipt (`reviews/architect.json` and `reviews/critic.json`) must record `inputs.stagedTreeOid`. Every such value must exactly equal the sole value recorded in `staged-tree.oid`; any absent, malformed, or different value blocks. Each local gate/package receipt and both review receipts must also record `inputs.verificationRef` and `inputs.verificationCommit`; those values must exactly equal `refs/gjc/release-0.20.1/verification` and the sole value recorded in `verification-commit.oid`. While the ref is live, it must resolve to a one-parent commit whose parent is the frozen base and whose tree exactly equals that receipt's `inputs.stagedTreeOid`; `verification-commit.json` and terminal `path-scope.json` must durably prove that same topology before deletion and the subsequent candidate reconciliation. A receipt index cannot override these terminal status, exact-tree, local-verification-commit, reachability, or deletion requirements.

## Pending external evidence and acceptance

Before tag creation, the following remain pending: all local gate outcomes, package/body observations, staged-tree and topology values, Architect and Critic reviews, exact dev and main CI results, release-tag validation, GitHub release assets, npm version/latest/integrity/provenance, isolated public install, native startup, and preservation comparison.

Release is acceptable only when the frozen nine-commit inventory and exact nine-path scope match; the deterministic verifier establishes one immutable staged-tree receipt and all required terminal receipts pass or the sole named exception satisfies every predicate; gate and review receipts bind to that same receipt; the guarded verification commit remains live, unpushed, and untagged until the real candidate proves the same parent/tree and its deletion is verified; candidate, promoted tree, annotated tag, and publication evidence agree; and all external receipts are present. Any base, inventory, scope, whitespace, metadata-preservation, index-mode/object-type, gate, receipt status, staged-tree binding, topology, verification-ref lifetime, absence-probe, review, CI, tag, publication, or preservation mismatch blocks release progression.

## Post-publish reconciliation

Release `v0.20.1` completed through the tag-owned workflow with the reviewed tree preserved end to end:

- candidate `e0fa50be9ed999a6d50bd37c37209dddddf23c8f` and promoted merge commit `d8a8595d7ddb2cefc4d386425ed5863176de1d07` resolve to tree `716122b6176f5819ea5cd4cade3a85614ceb61ca`;
- annotated tag object `59f487083f71bd02eb1751b0cf84d8d669be79bf` peels to the promoted commit;
- dev CI [29189987623](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/29189987623), main CI [29190477909](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/29190477909), and release workflow [29190721318](https://github.com/Yeachan-Heo/oh-my-codex/actions/runs/29190721318) passed;
- the [GitHub release](https://github.com/Yeachan-Heo/oh-my-codex/releases/tag/v0.20.1) contains the manifest and 56 native archive/checksum assets across four products and seven targets; and
- npm exposes `oh-my-codex@0.20.1` as `latest` with integrity, signature, and SLSA provenance metadata; isolated public package and Apple Silicon native startup checks passed.

The excluded receipt digests below anchor those observations without moving or rewriting the release tag:

| Receipt | SHA-256 |
|---|---|
| `staged-tree.oid` | `67fa083bc6fceeebdeaa863242b1dbb82adca838f53d44a80727ee64f4838ac0` |
| `verification-commit.json` | `9b11c61375424e0f253bcfd8466ba38c1b374d1e888c30347d8a183d8c2328b4` |
| `path-scope.json` | `b9709f6354b3738ee26e0287a2bb1d262bf72a6353655b1a3a86b83217b647a3` |
| `gates/focused.json` | `b34fedd8daad5b31c24844b44b3c2bc172de2384893ad03431ddfb9dfe3eb9cc` |
| `gates/full.json` | `f96af982588b36acbcb5fb23bcdb20f9ee5c985b1caf9285e5c165fa3ba4b299` |
| `package/pack.json` | `6b40ce955a4d37dc4dac22bbf9d280c4b781b5f5d10413ebf27f34c1dae28363` |
| `release-body.json` | `d193173c5c448e0532e6556693f4e0e41365d64446b5b22a0cdc61333f29fe70` |
| `reviews/architect.json` | `08ebf7f568c8c408a039eccb450d0384f6acc76da8fc07ef29c0bad1fc1b78f3` |
| `reviews/critic.json` | `e47d1a07f28c940a96f4d9653fc8774098906c79ce4723b6b7fd7afc6a3f1355` |
| `ci/dev.json` | `c80c93f59436eb544598bbb05aa26e422f45eb12d1ab981e28b9f2010671668f` |
| `ci/main.json` | `d5a99bbc4a608d31513dadc1955cce442debe7b853b2d90919428ed6b6b8a66e` |
| `ci/tag-workflow.json` | `55878fe4f5093122077995cba1cd85a4d4b879bfdd5262519951c70e1f5e5a25` |
| `promotion.json` | `70fdaf9a70959eeae16e9f4f9e89caafae78a05fe32a98fb1060468c32f6b234` |
| `publication/github-release.json` | `9002b9555c147a0cd0046cfe15d8abf36978ae8a4725516c38aa7202cd5f119c` |
| `publication/npm.json` | `870da3f27fb7b928c2470d57bde696ad11603ef66ea0da56a530d77e0dc5801d` |
| `public-install/install.json` | `e1e97147cee708adaa5a803c9d9e76c96d31b8a0fadd0aa39a3f98de8e0c46de` |
| `native/startup.json` | `e09e001bc108151b5fc6a46970d1c9760811796d77aa28d800dcc21133b53d87` |
