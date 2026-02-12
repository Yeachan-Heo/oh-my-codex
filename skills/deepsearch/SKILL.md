---
name: deepsearch
description: Thorough codebase search
---

# Deep Search Mode

[DEEPSEARCH MODE ACTIVATED]

## Objective

Perform thorough search of the codebase for the specified query, pattern, or concept.

## Search Strategy

1. **Broad Search**
   - Search for exact matches
   - Search for related terms and variations
   - Check common locations (components, utils, services, hooks)

2. **Deep Dive**
   - Read files with matches
   - Check imports/exports to find connections
   - Follow the trail (what imports this? what does this import?)

3. **Synthesize**
   - Map out where the concept is used
   - Identify the main implementation
   - Note related functionality

## Output Format

- **Primary Locations** (main implementations)
- **Related Files** (dependencies, consumers)
- **Usage Patterns** (how it's used across the codebase)
- **Key Insights** (patterns, conventions, gotchas)

Focus on being comprehensive but concise. Cite file paths and line numbers.
