---
name: deepsearch
description: "Perform a thorough, multi-pass codebase search for a query, pattern, or concept — covering exact matches, related terms, import/export chains, and usage patterns across the codebase. Use when a user needs to find all locations of a symbol, understand how a concept is used, or trace a dependency chain. Returns primary locations, related files, usage patterns, and key insights with file:line citations."
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
