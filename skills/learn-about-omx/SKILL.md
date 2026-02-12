---
name: learn-about-omx
description: Learn about your OMX usage patterns and get personalized recommendations
---

# Learn About OMX

Analyze your OMX usage patterns and provide personalized recommendations for getting more out of oh-my-codex.

## Usage

```
/learn-about-omx
```

## Behavior

1. **Scan usage data** from:
   - `.omc/sessions/` for session history
   - `.omc/state/` for mode usage patterns
   - `.omc/notepad.md` for working memory
   - `.omc/project-memory.json` for project context
   - Agent flow traces for tool and agent usage
2. **Analyze patterns**:
   - Most-used modes and skills
   - Agent types spawned most frequently
   - Common workflows and task types
   - Session durations and completion rates
3. **Generate recommendations**:
   - Underused features that match your workflow
   - More efficient skill combinations
   - Configuration optimizations
   - Tips based on your usage profile

## Output

A personalized report with usage statistics and actionable recommendations for improving your OMX workflow.
