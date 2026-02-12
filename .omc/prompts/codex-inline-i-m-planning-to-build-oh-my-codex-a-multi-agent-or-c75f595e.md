I'm planning to build "oh-my-codex" - a multi-agent orchestration layer for OpenAI's Codex CLI (https://github.com/openai/codex), inspired by "oh-my-claudecode" which does the same for Claude Code.

oh-my-claudecode works by:
1. **Hooks**: Intercepting Claude Code lifecycle events (session start, tool use pre/post, user prompt submit) to inject context and trigger skills
2. **Skills**: User-invocable commands (/skill-name) that expand to full prompts with specialized workflows
3. **MCP servers**: Providing additional tools via Model Context Protocol (LSP, AST grep, Python REPL, state management, external AI providers)
4. **Agent definitions**: Specialized system prompts for different roles (architect, executor, reviewer, etc.)
5. **State management**: Persistent state files for multi-turn workflows

Key architectural questions:
1. Does Codex CLI (as of early 2026) support hooks/lifecycle events? If not, what's the best way to implement equivalent functionality?
2. Can we build this as a pure add-on (like oh-my-claudecode is for Claude Code), or do we need to fork Codex CLI?
3. If a fork is needed, what's the best strategy for keeping it in sync with upstream?
4. What Codex CLI features can we leverage for extensibility?
5. What are the key differences between Claude Code and Codex CLI architectures that would affect porting?

Please analyze this from an architecture perspective and recommend the best approach.