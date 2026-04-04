---
name: note
description: Save run-local notes to notepad.md for compaction resilience
---

# Note Skill

Save run-local context to `.omx/notepad.md` so important breadcrumbs survive conversation compaction without becoming a second long-term memory source.

## Usage

| Command | Action |
|---------|--------|
| `/note <content>` | Add to Working Memory with timestamp |
| `/note --priority <content>` | Add to Priority Context (always loaded) |
| `/note --manual <content>` | Add to MANUAL section (never pruned) |
| `/note --show` | Display current notepad contents |
| `/note --prune` | Remove entries older than 7 days |
| `/note --clear` | Clear Working Memory (keep Priority + MANUAL) |

## Sections

### Priority Context (500 char limit)
- **Always** injected on session start
- Use for critical facts: "Project uses pnpm", "API in src/api/client.ts"
- Keep it SHORT - this eats into your context budget
- Treat this as hot context, not the formal long-term memory authority

### Working Memory
- Timestamped session notes
- Auto-pruned after 7 days
- Good for: debugging breadcrumbs, temporary findings

### MANUAL
- Never auto-pruned
- User-controlled sticky run-local notes
- Good for: team contacts, deployment info that should stay handy during this workspace/session flow
- If something should become durable shared knowledge, promote it through the external memory pipeline instead of treating MANUAL as the authority source

## Examples

```
/note Found auth bug in UserContext - missing useEffect dependency
/note --priority Project uses TypeScript strict mode, all files in src/
/note --manual Contact: api-team@company.com for backend questions
/note --show
/note --prune
```

## Behavior

1. Creates `.omx/notepad.md` if it doesn't exist
2. Parses the argument to determine section
3. Appends content with timestamp (for Working Memory)
4. Warns if Priority Context exceeds 500 chars
5. Confirms what was saved

## Integration

Notepad content is automatically loaded on session start:
- Priority Context: ALWAYS loaded
- Working Memory: Loaded if recent entries exist

This helps survive conversation compaction without losing critical context.
Notepad remains run-local scratch/hot context; it is not a replacement for formal long-term memory.
