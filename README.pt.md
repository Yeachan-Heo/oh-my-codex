# oh-my-codex (OMX)

<p align="center">
  <img src="https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png" alt="oh-my-codex character" width="280">
  <br>
  <em>Seu codex não está sozinho.</em>
</p>

[![npm version](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

> **[Website](https://yeachan-heo.github.io/oh-my-codex-website/)** | **[Documentation](https://yeachan-heo.github.io/oh-my-codex-website/docs.html)** | **[CLI Reference](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#cli-reference)** | **[Workflows](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#workflows)** | **[GitHub](https://github.com/Yeachan-Heo/oh-my-codex)** | **[npm](https://www.npmjs.com/package/oh-my-codex)**

Camada de orquestração multiagente para [OpenAI Codex CLI](https://github.com/openai/codex).

## Idiomas

- [English](./README.md)
- [한국어 (Korean)](./README.ko.md)
- [日本語 (Japanese)](./README.ja.md)
- [简体中文 (Chinese Simplified)](./README.zh.md)
- [繁體中文 (Chinese Traditional)](./README.zh-TW.md)
- [Tiếng Việt (Vietnamese)](./README.vi.md)
- [Español (Spanish)](./README.es.md)
- [Português (Portuguese)](./README.pt.md)
- [Русский (Russian)](./README.ru.md)
- [Türkçe (Turkish)](./README.tr.md)
- [Deutsch (German)](./README.de.md)
- [Français (French)](./README.fr.md)
- [Italiano (Italian)](./README.it.md)


OMX transforma o Codex de um agente de sessão única em um sistema coordenado com:
- Role prompts (`/prompts:name`) para agentes especializados
- Workflow skills (`$name`) para modos de execução repetíveis
- Orquestração de equipes no tmux (`omx team`, `$team`)
- Estado persistente e memória via servidores MCP

## Por que OMX

Codex CLI é forte para tarefas diretas. OMX adiciona estrutura para trabalhos maiores:
- Decomposição e execução em etapas (`team-plan -> team-prd -> team-exec -> team-verify -> team-fix`)
- Estado persistente do ciclo de vida dos modos (`.omx/state/`)
- Superfícies de memória e bloco de notas para sessões longas
- Controles operacionais para início, verificação e cancelamento

OMX é um complemento, não um fork. Utiliza os pontos de extensão nativos do Codex.

## Requisitos

- macOS ou Linux (Windows via WSL2)
- Node.js >= 20
- Codex CLI instalado (`npm install -g @openai/codex`)
- Autenticação do Codex configurada

## Início rápido (3 minutos)

```bash
npm install -g oh-my-codex
omx setup
omx doctor
```

Perfil de inicialização recomendado para ambientes confiáveis:

```bash
omx --xhigh --madmax
```

## Novidades na v0.5.0

- **Configuração com escopo** via `omx setup --scope user|project` para modos de instalação flexíveis.
- **Roteamento de Spark worker** via `--spark` / `--madmax-spark` — workers da equipe podem usar `gpt-5.3-codex-spark` sem forçar o modelo líder.
- **Consolidação do catálogo** — removidos prompts obsoletos (`deep-executor`, `scientist`) e 9 skills obsoletas para uma superfície mais enxuta.
- **Níveis de detalhamento de notificações** para controle granular da saída do CCNotifier.

## Primeira sessão

Dentro do Codex:

```text
/prompts:architect "analyze current auth boundaries"
/prompts:executor "implement input validation in login"
$plan "ship OAuth callback safely"
$team 3:executor "fix all TypeScript errors"
```

Do terminal:

```bash
omx team 4:executor "parallelize a multi-module refactor"
omx team status <team-name>
omx team shutdown <team-name>
```

## Modelo central

OMX instala e conecta estas camadas:

```text
User
  -> Codex CLI
    -> AGENTS.md (cérebro de orquestração)
    -> ~/.codex/prompts/*.md (catálogo de prompts de agentes)
    -> ~/.agents/skills/*/SKILL.md (catálogo de skills)
    -> ~/.codex/config.toml (funcionalidades, notificações, MCP)
    -> .omx/ (estado de execução, memória, planos, logs)
```

## Comandos principais

```bash
omx                # Iniciar Codex (+ HUD no tmux quando disponível)
omx setup          # Instalar prompts/skills/config por escopo + projeto AGENTS.md/.omx
omx doctor         # Diagnósticos de instalação/execução
omx doctor --team  # Diagnósticos de Team/swarm
omx team ...       # Iniciar/status/retomar/encerrar workers tmux da equipe
omx status         # Mostrar modos ativos
omx cancel         # Cancelar modos de execução ativos
omx reasoning <mode> # low|medium|high|xhigh
omx tmux-hook ...  # init|status|validate|test
omx hooks ...      # init|status|validate|test (fluxo de trabalho de extensão de plugins)
omx hud ...        # --watch|--json|--preset
omx help
```

## Extensão de Hooks (Superfície adicional)

OMX agora inclui `omx hooks` para scaffolding e validação de plugins.

- `omx tmux-hook` continua sendo suportado e não foi alterado.
- `omx hooks` é aditivo e não substitui os fluxos de trabalho do tmux-hook.
- Arquivos de plugins ficam em `.omx/hooks/*.mjs`.
- Plugins estão desativados por padrão; ative com `OMX_HOOK_PLUGINS=1`.

Consulte `docs/hooks-extension.md` para o fluxo de trabalho completo de extensões e modelo de eventos.

## Flags de inicialização

```bash
--yolo
--high
--xhigh
--madmax
--force
--dry-run
--verbose
--scope <user|project>  # apenas para setup
```

`--madmax` mapeia para Codex `--dangerously-bypass-approvals-and-sandbox`.
Use apenas em ambientes sandbox confiáveis ou externos.

### Política de workingDirectory MCP (endurecimento opcional)

Por padrão, as ferramentas MCP de state/memory/trace aceitam o `workingDirectory` fornecido pelo chamador.
Para restringir isso, defina uma lista de raízes permitidas:

```bash
export OMX_MCP_WORKDIR_ROOTS="/path/to/project:/path/to/another-root"
```

Quando definido, valores de `workingDirectory` fora dessas raízes são rejeitados.

## Controle de prompts Codex-First

Por padrão, OMX injeta:

```text
-c model_instructions_file="<cwd>/AGENTS.md"
```

Isso adiciona as instruções do projeto `AGENTS.md` aos comandos de inicialização do Codex.
Estende o comportamento do Codex, mas não substitui nem contorna as políticas centrais do sistema Codex.

Controles:

```bash
OMX_BYPASS_DEFAULT_SYSTEM_PROMPT=0 omx     # desativar injeção de AGENTS.md
OMX_MODEL_INSTRUCTIONS_FILE=/path/to/instructions.md omx
```

## Modo equipe

Use o modo equipe para trabalhos amplos que se beneficiam de workers paralelos.

Ciclo de vida:

```text
start -> assign scoped lanes -> monitor -> verify terminal tasks -> shutdown
```

Comandos operacionais:

```bash
omx team <args>
omx team status <team-name>
omx team resume <team-name>
omx team shutdown <team-name>
```

Regra importante: não encerre enquanto tarefas estiverem em estado `in_progress`, a menos que esteja abortando.

### Política de limpeza Ralph

Quando uma equipe roda em modo ralph (`omx team ralph ...`), a limpeza no encerramento
aplica uma política dedicada diferente do caminho normal:

| Comportamento | Equipe normal | Equipe Ralph |
|---|---|---|
| Encerramento forçado em caso de falha | Lança `shutdown_gate_blocked` | Ignora a porta, registra evento `ralph_cleanup_policy` |
| Exclusão automática de branches | Exclui branches do worktree no rollback | Preserva branches (`skipBranchDeletion`) |
| Log de conclusão | Evento padrão `shutdown_gate` | Evento adicional `ralph_cleanup_summary` com detalhamento de tarefas |

A política Ralph é detectada automaticamente do estado do modo equipe (`linked_ralph`) ou
pode ser passada explicitamente via `omx team shutdown <name> --ralph`.

Seleção de Worker CLI para workers da equipe:

```bash
OMX_TEAM_WORKER_CLI=auto    # padrão; usa claude quando worker --model contém "claude"
OMX_TEAM_WORKER_CLI=codex   # forçar workers Codex CLI
OMX_TEAM_WORKER_CLI=claude  # forçar workers Claude CLI
OMX_TEAM_WORKER_CLI_MAP=codex,codex,claude,claude  # mix de CLI por worker (comprimento=1 ou quantidade de workers)
OMX_TEAM_AUTO_INTERRUPT_RETRY=0  # opcional: desativar fallback adaptativo queue->resend
```

Notas:
- Argumentos de inicialização de workers são compartilhados via `OMX_TEAM_WORKER_LAUNCH_ARGS`.
- `OMX_TEAM_WORKER_CLI_MAP` sobrescreve `OMX_TEAM_WORKER_CLI` para seleção por worker.
- O envio de triggers usa retentativas adaptativas por padrão (queue/submit, depois fallback seguro clear-line+resend quando necessário).
- No modo Claude worker, OMX inicia workers como `claude` simples (sem argumentos extras de inicialização) e ignora substituições explícitas de `--model` / `--config` / `--effort` para que o Claude use o `settings.json` padrão.

## O que `omx setup` grava

- `.omx/setup-scope.json` (escopo de instalação persistido)
- Instalações dependentes do escopo:
  - `user`: `~/.codex/prompts/`, `~/.agents/skills/`, `~/.codex/config.toml`, `~/.omx/agents/`
  - `project`: `./.codex/prompts/`, `./.agents/skills/`, `./.codex/config.toml`, `./.omx/agents/`
- Comportamento de inicialização: se o escopo persistido for `project`, o lançamento do `omx` usa automaticamente `CODEX_HOME=./.codex` (a menos que `CODEX_HOME` já esteja definido).
- O `AGENTS.md` existente é preservado por padrão. Em execuções TTY interativas, o setup pergunta antes de sobrescrever; `--force` sobrescreve sem perguntar (verificações de segurança de sessões ativas continuam aplicáveis).
- Atualizações do `config.toml` (para ambos os escopos):
  - `notify = ["node", "..."]`
  - `model_reasoning_effort = "high"`
  - `developer_instructions = "..."`
  - `[features] multi_agent = true, child_agents_md = true`
  - Entradas de servidores MCP (`omx_state`, `omx_memory`, `omx_code_intel`, `omx_trace`)
  - `[tui] status_line`
- `AGENTS.md` do projeto
- Diretórios `.omx/` de execução e configuração do HUD

## Agentes e skills

- Prompts: `prompts/*.md` (instalados em `~/.codex/prompts/` para `user`, `./.codex/prompts/` para `project`)
- Skills: `skills/*/SKILL.md` (instalados em `~/.agents/skills/` para `user`, `./.agents/skills/` para `project`)

Exemplos:
- Agentes: `architect`, `planner`, `executor`, `debugger`, `verifier`, `security-reviewer`
- Skills: `autopilot`, `plan`, `team`, `ralph`, `ultrawork`, `cancel`

## Estrutura do projeto

```text
oh-my-codex/
  bin/omx.js
  src/
    cli/
    team/
    mcp/
    hooks/
    hud/
    config/
    modes/
    notifications/
    verification/
  prompts/
  skills/
  templates/
  scripts/
```

## Desenvolvimento

```bash
git clone https://github.com/Yeachan-Heo/oh-my-codex.git
cd oh-my-codex
npm install
npm run build
npm test
```

## Documentação

- **[Documentação completa](https://yeachan-heo.github.io/oh-my-codex-website/docs.html)** — Guia completo
- **[Referência CLI](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#cli-reference)** — Todos os comandos `omx`, flags e ferramentas
- **[Guia de notificações](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#notifications)** — Configuração de Discord, Telegram, Slack e webhooks
- **[Fluxos de trabalho recomendados](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#workflows)** — Cadeias de skills testadas em batalha para tarefas comuns
- **[Notas de versão](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#release-notes)** — Novidades em cada versão

## Notas

- Log de alterações completo: `CHANGELOG.md`
- Guia de migração (pós-v0.4.4 mainline): `docs/migration-mainline-post-v0.4.4.md`
- Notas de cobertura e paridade: `COVERAGE.md`
- Fluxo de trabalho de extensão de hooks: `docs/hooks-extension.md`
- Detalhes de instalação e contribuição: `CONTRIBUTING.md`

## Agradecimentos

Inspirado em [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode), adaptado para Codex CLI.

## Licença

MIT
