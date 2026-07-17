---
name: help
description: Guide on using oh-my-codex plugin
---

# How OMX Works

**You don't need to learn any commands!** OMX enhances Codex CLI with intelligent behaviors that activate automatically.

## What Happens Automatically

| When You... | I Automatically... |
|-------------|-------------------|
| Give me a complex task | Start with one capable owner and adapt to the task shape |
| Ask me to plan something | Start a planning interview |
| Need something done completely | Persist until verified complete |
| Work on UI/frontend | Activate design sensibility |
| Say "stop" or "cancel" | Intelligently stop current operation |

## Magic Keywords (Optional Shortcuts)

You can include these words naturally in your request for explicit control:

| Keyword | Effect | Example |
|---------|--------|---------|
| **ralph** | Persistence mode | "ralph: fix all the bugs" |
| **ralplan** | Iterative planning | "ralplan this feature" |
| **ulw** | Max parallelism | "ulw refactor the API" |
| **team** | Coordinated independent lanes | "team: implement the approved plan" |
| **eco** | Reduce context, stages, fan-out, and model cost | "eco: fix the routine lint errors" |
| **plan** | Planning interview | "plan the new endpoints" |

Ralph starts with one owner for persistence. Use Ultrawork or Team explicitly when the work has independent lanes that benefit from coordination.

## Stopping Things

Just say:
- "stop"
- "cancel"
- "abort"

I'll figure out what to stop based on context.

## First Time Setup

If you haven't configured OMX yet:

```
/omx-setup
```

This is the **only command** you need to know. It downloads the configuration and you're done.

If you only need lightweight directory guidance scaffolding for `AGENTS.md` files, use:

```bash
omx agents-init .
```

That command is intentionally narrower than full setup: it only bootstraps `AGENTS.md` files for the target directory and its immediate child directories.

## For 2.x Users

Your old commands still work! `/ralph`, `/ultrawork`, `/plan`, etc. all function exactly as before.

But now you don't NEED them - everything is automatic.

---

## Usage Analysis

Analyze your oh-my-codex usage and get tailored recommendations to improve your workflow.

> Note: This replaces the former `/learn-about-omc` skill.

### What It Does

1. Reads token tracking from `~/.omx/state/token-tracking.jsonl`
2. Reads session history from `.omx/state/session-history.json`
3. Analyzes agent usage patterns
4. Correlates observed task shape with execution mode, reviewer yield, retries, and outcomes
5. Recommends changes only when task-shape and outcome evidence supports them

### Step 1: Gather Data

```bash
# Check for token tracking data
TOKEN_FILE="$HOME/.omx/state/token-tracking.jsonl"
SESSION_FILE=".omx/state/session-history.json"
CONFIG_FILE="$HOME/.codex/.omx-config.json"

echo "Analyzing OMX Usage..."
echo ""

# Check what data is available
HAS_TOKENS=false
HAS_SESSIONS=false
HAS_CONFIG=false

if [[ -f "$TOKEN_FILE" ]]; then
  HAS_TOKENS=true
  TOKEN_COUNT=$(wc -l < "$TOKEN_FILE")
  echo "Token records found: $TOKEN_COUNT"
fi

if [[ -f "$SESSION_FILE" ]]; then
  HAS_SESSIONS=true
  SESSION_COUNT=$(cat "$SESSION_FILE" | jq '.sessions | length' 2>/dev/null || echo "0")
  echo "Sessions found: $SESSION_COUNT"
fi

if [[ -f "$CONFIG_FILE" ]]; then
  HAS_CONFIG=true
  DEFAULT_MODE=$(cat "$CONFIG_FILE" | jq -r '.defaultExecutionMode // "not set"')
  echo "Default execution mode: $DEFAULT_MODE"
fi
```

### Step 2: Analyze Agent Usage (if token data exists)

```bash
if [[ "$HAS_TOKENS" == "true" ]]; then
  echo ""
  echo "TOKEN USAGE BY BILLING CATEGORY:"
  jq -rs '
    def stream_key:
      if .session_id != null then ["session", .session_id] | @json
      elif .thread_id != null then ["thread", .thread_id] | @json
      else ["legacy", (.project // "unknown")] | @json
      end;
    def total($field):
      reduce .[] as $record ({};
        ($record | stream_key) as $stream
        | if $record[$field] == null then .
          elif ($record[$field + "_cumulative"] // false) then
            .[$stream] = $record[$field]
          else
            .[$stream] = ((.[$stream] // 0) + $record[$field])
          end
      )
      | ([.[]] | add // 0);
    {
      input_tokens: total("input_tokens"),
      cached_input_tokens: total("cached_input_tokens"),
      uncached_input_tokens: total("uncached_input_tokens"),
      output_tokens: total("output_tokens"),
      reasoning_output_tokens: total("reasoning_output_tokens")
    }
    | to_entries[]
    | "\(.key): \(.value)"
  ' "$TOKEN_FILE"

  echo ""
  echo "TOP AGENTS BY USAGE:"
  jq -r '.agent // "main"' "$TOKEN_FILE" | sort | uniq -c | sort -rn | head -10

  echo ""
  echo "MODEL DISTRIBUTION:"
  jq -r '.model // "unknown"' "$TOKEN_FILE" | sort | uniq -c | sort -rn
fi
```

Each new ledger record carries a cumulative/delta flag for every token field.
Step 2 replaces cumulative snapshots within each session and adds delta values;
use the exact fallback order: `session_id` → `thread_id` → project. Records
written before these flags existed cannot be disambiguated after the fact, so
missing flags retain the legacy additive interpretation. Old cumulative
snapshots may therefore remain overcounted; use a post-upgrade ledger segment
when exact historical totals are required.

Keep these five ledger fields separate in the report. `input_tokens` is the
overall input count; `cached_input_tokens` and `uncached_input_tokens` explain
its cache split and must not be added to it as extra input. Keep
`reasoning_output_tokens` distinct from ordinary `output_tokens` so billing
weights can be applied without hiding the source categories.

### Step 3: Generate Recommendations

Base recommendations on observed task shape and outcome evidence, not zero-usage counts alone:

- Recommend Team only when repeated tasks show two or more independent owned lanes.
- Recommend a reviewer when risk-matched findings changed outcomes, not merely when reviewer usage is zero.
- Prefer the model with the best accepted outcome per billable-equivalent token; cheap per-call price is not sufficient.

**If routine, bounded tasks repeatedly use high-cost models without better outcomes:**
- "Consider ecomode for this recurring task shape; its successful runs have not needed broad context or high-tier review"

**If independent lanes repeatedly serialize and increase elapsed time:**
- "Consider Team for this task shape because the history shows independent lanes with clear ownership"

**If security-sensitive changes show review findings or weak verification:**
- "Add a security reviewer for this risk surface because prior outcome evidence shows reviewer yield"

**If defaultExecutionMode not set:**
- "Set defaultExecutionMode in /omx-setup for consistent behavior"

Do not recommend Team or any reviewer merely because its usage count is zero. Absence of usage is not evidence that another stage will improve outcomes.

### Step 4: Output Report

Format a summary with:
- Token summary with separate input, cached input, uncached input, output, and reasoning output totals
- Top agents used
- Task shapes and observed outcomes
- Evidence-backed recommendations

### Example Output

```
📊 Your OMX Usage Analysis

TOKEN SUMMARY:
- Total records: 1,234
- input_tokens: 8,420,000
- cached_input_tokens: 6,310,000
- uncached_input_tokens: 2,110,000
- output_tokens: 740,000
- reasoning_output_tokens: 185,000
- By Reasoning Effort: high 45%, medium 40%, low 15%

TOP AGENTS:
1. executor (234 uses)
2. architect (89 uses)
3. explore (67 uses)

TASK-SHAPE EVIDENCE:
- 18 bounded maintenance runs completed with one owner
- 4 multi-module runs had independent lanes but executed sequentially
- Security review found actionable issues on 3 of 5 auth-boundary changes

RECOMMENDATIONS:
1. Use ecomode for bounded maintenance runs to reduce context and stage count
2. Use Team for the recurring independent multi-module lanes
3. Keep security review scoped to auth-boundary changes, where it has demonstrated yield
```

### Graceful Degradation

If no data found:

```
📊 Limited Usage Data Available

No token tracking found. To enable tracking:
1. Ensure ~/.omx/state/ directory exists
2. Run any OMX command to start tracking

Tip: Run /omx-setup to configure OMX properly.
```

## Need More Help?

- **README**: https://github.com/Yeachan-Heo/oh-my-codex
- **Issues**: https://github.com/Yeachan-Heo/oh-my-codex/issues

---

*Version: 4.2.3*
