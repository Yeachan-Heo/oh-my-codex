---
name: web-clone
description: URL-driven website cloning with visual + functional verification
---

<Purpose>
Clone a target website from its URL, replicating both visual appearance and core interactive functionality. Uses Playwright MCP for live page extraction, LLM-driven code generation, and iterative verification with `$visual-verdict` for visual scoring.
</Purpose>

<Use_When>
- User provides a target URL and wants the site replicated as working code
- User says "clone site", "clone website", "copy webpage", or "web-clone"
- Task requires both visual fidelity AND functional parity with the original
- Reference is a live URL (not a static screenshot — use `$visual-verdict` for screenshot-only tasks)
</Use_When>

<Do_Not_Use_When>
- User only has screenshot references without a live URL — use `$visual-verdict` directly
- User wants to modify, redesign, or "improve" the site — use standard implementation flow
- Target requires authentication, payment flows, or backend API parity — out of scope for v1
- Multi-page / multi-route deep cloning — v1 handles single-page scope only
</Do_Not_Use_When>

<Scope_Limits>
**v1 scope**: Single page clone of the provided URL.

Included:
- Layout structure (header, nav, content areas, sidebar, footer)
- Typography (font families, sizes, weights, line heights)
- Colors, spacing, borders, border-radius
- Core interactions: navigation links, buttons, form elements, dropdowns, modals, toggles
- Responsive hints from the extracted layout (flexbox/grid patterns)

Excluded:
- Backend API integration or data fetching
- Authentication flows or protected content
- Dynamic/personalized content (user-specific data)
- Multi-page crawling or route graph cloning
- Third-party widget functionality (maps, embeds, chat widgets)
- Image/asset replication (use placeholders for external images)

**Legal notice**: Only clone sites you own or have explicit permission to replicate. Respect copyright and trademarks.
</Scope_Limits>

<Prerequisites>
Playwright MCP server must be available for browser automation.

1. Before first tool use, call `ToolSearch("browser")` or `ToolSearch("playwright")` to discover available browser tools.
2. If no browser tools are found, instruct the user:
   ```
   Playwright MCP is required. Configure it:
   codex mcp add playwright npx "@playwright/mcp@latest"
   ```
3. Required tools: `browser_navigate`, `browser_snapshot`, `browser_take_screenshot`, `browser_evaluate`, `browser_wait_for`. Optional: `browser_click`, `browser_network_requests`.
</Prerequisites>

<Inputs>
- `target_url` (required): The URL to clone
- `output_dir` (optional, default: current working directory): Where to generate the clone project
- `tech_stack` (optional, inferred from project context): HTML/CSS/JS, React, Vue, Svelte, etc.
</Inputs>

<Tool_Usage>
- Before first MCP tool use, call `ToolSearch("browser")` or `ToolSearch("playwright")` to discover deferred Playwright MCP tools.
- If no browser tools are found, stop immediately and instruct the user to configure Playwright MCP.
- Use `browser_snapshot` (accessibility tree) for structural understanding — it is far more token-efficient than screenshots.
- Use `browser_take_screenshot` only when visual verification is needed (Pass 1 baseline, Pass 4 comparison).
- Use `browser_evaluate` for DOM/style extraction — pass the scripts from this skill EXACTLY as written (do not modify them).
- If running within ralph, use `state_write` / `state_read` for web-clone state persistence between iterations.
- Skip Codex consultation for straightforward extraction; use it only if verification repeatedly fails on the same issue.
</Tool_Usage>

<State_Management>
Persist extraction and progress data so the pipeline can resume if interrupted.

- **After Pass 1 completes**: Write extraction summary to `.omx/state/{scope}/web-clone-extraction.json` containing:
  - `target_url`, `extracted_at` timestamp
  - `screenshot_path` (path to `target-full.png`)
  - `landmark_count` (number of nav, main, footer, form elements)
  - `interactive_count` (number of detected interactive elements)
  - `extraction_size_kb` (approximate size of DOM extraction data)
- **After each Pass 4 verification**: Append the composite verdict to `.omx/state/{scope}/web-clone-verdicts.json`.
- **When running within ralph**: Also persist the `visual` portion of the composite verdict to `.omx/state/{scope}/ralph-progress.json` for ralph compatibility, mapping `visual.score` → top-level `score` and `visual.verdict` → top-level `verdict`.
- **On completion or failure**: Write final status with `completed_at` or `failed_at` timestamp.
</State_Management>

<Context_Budget>
Pass 1 extraction can produce very large data. Apply these limits proactively:

- **DOM tree**: If the serialized JSON exceeds ~30KB, reduce `depth` parameter from 8 to 4 and re-extract. Focus on top-level structure.
- **Accessibility snapshot**: If it exceeds ~20KB, this is normal for complex pages. Summarize key landmarks rather than keeping the full tree.
- **Interactive elements**: Cap at 50 elements. If more exist, keep only visible ones (`isVisible: true`).
- **Total extraction context**: Aim for under 60KB combined. If exceeded, prioritize: screenshot > accessibility snapshot > interactive elements > DOM styles.
- **Image tokens**: Full-page screenshots are expensive. Take one baseline in Pass 1 and one comparison in Pass 4. Do not take screenshots between iterations unless debugging a specific region.
</Context_Budget>

<Steps>

## Pass 1 — Extract

Capture the target page's structure, styles, interactions, and visual baseline.

1. **Navigate**: `browser_navigate` to `target_url`.
2. **Wait for render**: `browser_wait_for` with appropriate condition (network idle or timeout of 5s) to ensure full render including lazy-loaded content.
3. **Accessibility snapshot**: `browser_snapshot` — captures the semantic tree (roles, names, values, interactive states). This is your primary structural reference.
4. **Full-page screenshot**: `browser_take_screenshot` with `fullPage: true` — save as reference baseline `target-full.png`.
5. **DOM + computed styles**: `browser_evaluate` with the following script. **COPY THIS SCRIPT EXACTLY — do not modify it**:
   ```javascript
   (() => {
     const walk = (el, depth = 0) => {
       if (depth > 8 || !el.tagName) return null;
       const cs = window.getComputedStyle(el);
       return {
         tag: el.tagName.toLowerCase(),
         id: el.id || undefined,
         classes: [...el.classList].slice(0, 5),
         styles: {
           display: cs.display, position: cs.position,
           width: cs.width, height: cs.height,
           padding: cs.padding, margin: cs.margin,
           fontSize: cs.fontSize, fontFamily: cs.fontFamily,
           fontWeight: cs.fontWeight, lineHeight: cs.lineHeight,
           color: cs.color, backgroundColor: cs.backgroundColor,
           border: cs.border, borderRadius: cs.borderRadius,
           flexDirection: cs.flexDirection, justifyContent: cs.justifyContent,
           alignItems: cs.alignItems, gap: cs.gap,
           gridTemplateColumns: cs.gridTemplateColumns,
         },
         text: el.childNodes.length === 1 && el.childNodes[0].nodeType === 3
           ? el.textContent?.trim().slice(0, 100) : undefined,
         children: [...el.children].map(c => walk(c, depth + 1)).filter(Boolean),
       };
     };
     return walk(document.body);
   })()
   ```
6. **Interactive elements**: `browser_evaluate` to catalog all interactable elements. **COPY THIS SCRIPT EXACTLY — do not modify it**:
   ```javascript
   (() => {
     const results = [];
     document.querySelectorAll(
       'button, a[href], input, select, textarea, [role="button"], ' +
       '[onclick], [aria-haspopup], [aria-expanded], details, dialog'
     ).forEach(el => {
       results.push({
         tag: el.tagName.toLowerCase(),
         type: el.type || el.getAttribute('role') || 'interactive',
         text: (el.textContent || '').trim().slice(0, 80),
         href: el.href || undefined,
         ariaLabel: el.getAttribute('aria-label') || undefined,
         isVisible: el.offsetParent !== null,
       });
     });
     return results;
   })()
   ```
7. **Network patterns** (optional): `browser_network_requests` — note XHR/fetch calls for reference. Do not attempt to replicate backends.

Keep all extraction results in working memory for Pass 2.

## Pass 2 — Build Plan

Analyze extraction results and decompose into a component plan.

1. **Identify page regions**: From DOM tree + accessibility snapshot, identify major sections:
   - Navigation bar / header
   - Hero / banner section
   - Main content area(s)
   - Sidebar (if present)
   - Footer
   - Overlay elements (modals, drawers)

2. **Map components**: For each region, define:
   - Component name and responsibility
   - Key style properties (from computed styles)
   - Content summary (headings, text, images)
   - Child components if nested

3. **Create interaction map**: From interactive elements list:
   - Navigation links → anchor tags with `href`
   - Form elements → proper `<form>` with inputs, labels, validation
   - Buttons → click handlers (toggle, submit, navigate)
   - Dropdowns/modals → show/hide toggle with transitions
   - Accordions/tabs → state-based visibility

4. **Extract design tokens**: Identify recurring values:
   - Color palette (primary, secondary, background, text colors)
   - Font stack (families, size scale, weight scale)
   - Spacing scale (padding/margin patterns)
   - Border radius values

5. **Define file structure**:
   ```
   {output_dir}/
   ├── index.html          (or App.tsx / App.vue)
   ├── styles/
   │   ├── globals.css      (reset + tokens)
   │   └── components.css   (or scoped styles)
   ├── scripts/
   │   └── interactions.js  (toggle, modal, dropdown logic)
   └── assets/              (placeholder images)
   ```
   Adapt to `tech_stack` if specified (React components, Vue SFCs, etc.).

## Pass 3 — Generate Clone

Implement the clone from the plan. Work component-by-component.

1. **Scaffold**: Create the directory structure and base files.
2. **Design tokens first**: Implement CSS custom properties or Tailwind config from extracted tokens.
3. **Layout shell**: Build the page-level layout matching the original's flexbox/grid structure.
4. **Components**: Implement each region top-down:
   - Match DOM structure from extraction (semantic tags, landmark roles)
   - Apply computed styles — prioritize layout properties, then typography, then decorative
   - Use actual extracted text content; use placeholder `<img>` for external images
5. **Interactions**: Wire up detected behaviors:
   - Navigation: working `<a>` tags (to `#` anchors or stubs for v1)
   - Forms: proper structure with `<label>`, input types, placeholder text
   - Toggles: JavaScript for dropdowns, modals, accordions
   - Hover/focus states: CSS transitions matching original behavior
6. **Responsive**: If the original uses responsive breakpoints (detectable from media queries in computed styles or from viewport behavior), add basic responsive rules.

## Pass 4 — Verify

Compare the clone against the original across three dimensions.

1. **Serve the clone**: Start a local server for the generated project:
   ```bash
   npx serve {output_dir} -l 3456 --no-clipboard
   ```
   If `npx serve` is unavailable, fall back to: `python3 -m http.server 3456 -d {output_dir}`.
   The clone will be accessible at `http://localhost:3456`.
2. **Visual verification**:
   - Navigate to the clone with Playwright: `browser_navigate` to clone URL.
   - Take full-page screenshot of clone.
   - Run `$visual-verdict` with: `reference_images=["target-full.png"]`, `generated_screenshot="clone-full.png"`, `category_hint="web-clone"`.
   - The visual portion of the verdict feeds directly into the composite verdict below.
   - Visual pass threshold: **score >= 85**.

3. **Structural verification**: Compare landmark counts:
   - Count `<nav>`, `<main>`, `<footer>`, `<form>`, `<button>`, `<a>` in both original and clone.
   - Structure passes when all major landmarks exist (missing landmarks = fail).

4. **Functional spot-check**: Test 2–3 detected interactions via Playwright:
   - Click a navigation link → verify URL change or scroll behavior
   - Toggle a dropdown/modal → verify visibility change
   - Interact with a form field → verify it accepts input
   - Use `browser_click` and `browser_snapshot` to verify state changes.

5. **Emit composite verdict**:

```json
{
  "visual": {
    "score": 82,
    "verdict": "revise",
    "category_match": true,
    "differences": ["Header spacing tighter than original"],
    "suggestions": ["Increase nav gap to 24px"]
  },
  "functional": {
    "tested": 3,
    "passed": 2,
    "failures": ["Dropdown does not open on click"]
  },
  "structure": {
    "landmark_match": true,
    "missing": [],
    "extra": []
  },
  "overall_verdict": "revise",
  "priority_fixes": [
    "Fix dropdown toggle interaction",
    "Increase header nav spacing"
  ]
}
```

## Pass 5 — Iterate

Fix highest-impact issues and re-verify.

1. **Prioritize fixes** by impact: layout > interactions > spacing > typography > colors.
2. **Apply targeted edits**: Fix only the issues listed in `priority_fixes`. Do not refactor working code.
3. **Re-verify**: Repeat Pass 4.
4. **Loop**: Continue until `overall_verdict` is `pass` OR max **5 iterations** reached.
5. **Final report**: Summarize what was successfully cloned, any remaining differences, and elements that could not be replicated.

</Steps>

<Output_Contract>
After each verification pass, emit a **composite web-clone verdict** JSON:

```json
{
  "visual": {
    "score": 0,
    "verdict": "revise",
    "category_match": false,
    "differences": ["..."],
    "suggestions": ["..."],
    "reasoning": "short explanation"
  },
  "functional": {
    "tested": 0,
    "passed": 0,
    "failures": ["..."]
  },
  "structure": {
    "landmark_match": false,
    "missing": ["..."],
    "extra": ["..."]
  },
  "overall_verdict": "revise",
  "priority_fixes": ["..."]
}
```

Rules:
- `visual` follows the `VisualVerdict` shape from `$visual-verdict`
- `functional.tested/passed` are counts; `failures` list specific interaction failures
- `structure.landmark_match` is `true` when all major HTML landmarks (nav, main, footer, forms) are present
- `overall_verdict`: `pass` when visual.score >= 85 AND functional.failures is empty AND structure.landmark_match is true
- `priority_fixes`: ordered by impact, drives the next iteration
</Output_Contract>

<Iteration_Thresholds>
- **Visual pass**: score >= 85
- **Functional pass**: zero failures on tested interactions
- **Structure pass**: all major landmarks present
- **Overall pass**: all three dimensions pass
- **Max iterations**: 5 (report best achieved result if threshold not met)
</Iteration_Thresholds>

<Error_Handling>
- **Playwright MCP unavailable**: Stop. Instruct user to configure it. Do not attempt to clone without browser tools.
- **Page fails to load**: Report the URL and HTTP status. Suggest the user verify the URL is accessible.
- **browser_evaluate returns empty**: The page may use heavy client-side rendering. Wait longer (`browser_wait_for` with extended timeout) and retry once.
- **Visual score stuck below threshold after 3 iterations**: Report the current state as best-effort. List the unresolved differences for the user.
- **Extraction data too large for context**: Truncate deep DOM branches (depth > 6). Focus on top-level structure and defer nested details to iteration fixes.
</Error_Handling>

<Example>
**User**: "Clone https://news.ycombinator.com"

**Pass 1**: Navigate to HN. Extract: table-based layout, orange (#ff6600) nav bar, story list with links + points + comments, footer. Screenshot saved.

**Pass 2**: Regions: nav bar (logo + links), story table (30 rows × title + meta), footer. Tokens: orange #ff6600, gray #828282, Verdana font, 10pt base. Interaction map: story links (external), comment links, "more" pagination.

**Pass 3**: Generate index.html with HN-style table layout, CSS matching extracted colors/fonts, working `<a>` tags for stories.

**Pass 4**: Visual score=78 (font size off, spacing between stories too tight). Functional 2/2 (links work). Structure match=true.

**Pass 5 iteration 1**: Fix font to Verdana 10pt, increase row padding → score=88. Functional 2/2. Structure match. → `overall_verdict: pass`. Done.
</Example>

<Final_Checklist>
- [ ] Pass 1 extraction completed and summarized (screenshot + accessibility tree + DOM styles + interactions)
- [ ] Pass 2 component plan created with file structure
- [ ] Pass 3 clone generated and files written to `output_dir`
- [ ] Clone serves locally without errors
- [ ] Pass 4 composite verdict emitted with all three dimensions
- [ ] `overall_verdict` is `pass`, or max 5 iterations reached with best-effort report
- [ ] When in ralph: visual verdict persisted to `ralph-progress.json`
- [ ] Extraction summary persisted to `web-clone-extraction.json`
</Final_Checklist>
