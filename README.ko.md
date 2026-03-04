# oh-my-codex (OMX)

<p align="center">
  <img src="https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png" alt="oh-my-codex character" width="280">
  <br>
  <em>당신의 codex는 혼자가 아닙니다.</em>
</p>

[![npm version](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

> **[Website](https://yeachan-heo.github.io/oh-my-codex-website/)** | **[Documentation](https://yeachan-heo.github.io/oh-my-codex-website/docs.html)** | **[CLI Reference](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#cli-reference)** | **[Workflows](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#workflows)** | **[GitHub](https://github.com/Yeachan-Heo/oh-my-codex)** | **[npm](https://www.npmjs.com/package/oh-my-codex)**

[OpenAI Codex CLI](https://github.com/openai/codex)를 위한 멀티 에이전트 오케스트레이션 레이어.

## 언어

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


OMX는 Codex를 단일 세션 에이전트에서 조율된 시스템으로 전환합니다:
- 전문 에이전트를 위한 role prompts (`/prompts:name`)
- 반복 가능한 실행 모드를 위한 workflow skills (`$name`)
- tmux에서의 팀 오케스트레이션 (`omx team`, `$team`)
- MCP 서버를 통한 영구 상태 및 메모리

## OMX를 사용하는 이유

Codex CLI는 직접적인 작업에 강합니다. OMX는 더 큰 작업을 위한 구조를 추가합니다:
- 분해 및 단계적 실행 (`team-plan -> team-prd -> team-exec -> team-verify -> team-fix`)
- 영구 모드 라이프사이클 상태 (`.omx/state/`)
- 장기 세션을 위한 메모리 및 메모장 표면
- 시작, 검증 및 취소를 위한 운영 제어

OMX는 애드온이며, 포크가 아닙니다. Codex의 네이티브 확장 포인트를 사용합니다.

## 요구사항

- macOS 또는 Linux (Windows는 WSL2를 통해)
- Node.js >= 20
- Codex CLI 설치됨 (`npm install -g @openai/codex`)
- Codex 인증 구성됨

## 빠른 시작 (3분)

```bash
npm install -g oh-my-codex
omx setup
omx doctor
```

신뢰할 수 있는 환경을 위한 권장 시작 프로필:

```bash
omx --xhigh --madmax
```

## v0.5.0의 새로운 기능

- `omx setup --scope user|project`를 통한 **범위 인식 설정** — 유연한 설치 모드.
- `--spark` / `--madmax-spark`를 통한 **Spark worker 라우팅** — 팀 워커가 리더 모델을 강제하지 않고 `gpt-5.3-codex-spark`를 사용 가능.
- **카탈로그 통합** — 더 간결한 표면을 위해 deprecated 프롬프트(`deep-executor`, `scientist`)와 9개의 deprecated 스킬 제거.
- **알림 상세 레벨** — CCNotifier 출력에 대한 세밀한 제어.

## 첫 번째 세션

Codex 내부에서:

```text
/prompts:architect "analyze current auth boundaries"
/prompts:executor "implement input validation in login"
$plan "ship OAuth callback safely"
$team 3:executor "fix all TypeScript errors"
```

터미널에서:

```bash
omx team 4:executor "parallelize a multi-module refactor"
omx team status <team-name>
omx team shutdown <team-name>
```

## 핵심 모델

OMX는 다음 레이어를 설치하고 연결합니다:

```text
User
  -> Codex CLI
    -> AGENTS.md (오케스트레이션 브레인)
    -> ~/.codex/prompts/*.md (에이전트 프롬프트 카탈로그)
    -> ~/.agents/skills/*/SKILL.md (스킬 카탈로그)
    -> ~/.codex/config.toml (기능, 알림, MCP)
    -> .omx/ (런타임 상태, 메모리, 계획, 로그)
```

## 주요 명령어

```bash
omx                # Codex 실행 (tmux에서 HUD와 함께)
omx setup          # 범위별 프롬프트/스킬/설정 설치 + 프로젝트 AGENTS.md/.omx
omx doctor         # 설치/런타임 진단
omx doctor --team  # Team/swarm 진단
omx team ...       # tmux 팀 워커 시작/상태/재개/종료
omx status         # 활성 모드 표시
omx cancel         # 활성 실행 모드 취소
omx reasoning <mode> # low|medium|high|xhigh
omx tmux-hook ...  # init|status|validate|test
omx hooks ...      # init|status|validate|test (플러그인 확장 워크플로우)
omx hud ...        # --watch|--json|--preset
omx help
```

## Hooks 확장 (추가 표면)

OMX는 이제 플러그인 스캐폴딩 및 검증을 위한 `omx hooks`를 포함합니다.

- `omx tmux-hook`은 계속 지원되며 변경되지 않았습니다.
- `omx hooks`는 추가적이며 tmux-hook 워크플로우를 대체하지 않습니다.
- 플러그인 파일은 `.omx/hooks/*.mjs`에 위치합니다.
- 플러그인은 기본적으로 비활성화되어 있으며; `OMX_HOOK_PLUGINS=1`로 활성화합니다.

전체 확장 워크플로우 및 이벤트 모델은 `docs/hooks-extension.md`를 참조하세요.

## 시작 플래그

```bash
--yolo
--high
--xhigh
--madmax
--force
--dry-run
--verbose
--scope <user|project>  # setup 전용
```

`--madmax`는 Codex `--dangerously-bypass-approvals-and-sandbox`에 매핑됩니다.
신뢰할 수 있는/외부 sandbox 환경에서만 사용하세요.

### MCP workingDirectory 정책 (선택적 강화)

기본적으로 MCP state/memory/trace 도구는 호출자가 제공한 `workingDirectory`를 수락합니다.
이를 제한하려면 허용된 루트 목록을 설정하세요:

```bash
export OMX_MCP_WORKDIR_ROOTS="/path/to/project:/path/to/another-root"
```

설정 시 이 루트 외부의 `workingDirectory` 값은 거부됩니다.

## Codex-First 프롬프트 제어

기본적으로 OMX는 다음을 주입합니다:

```text
-c model_instructions_file="<cwd>/AGENTS.md"
```

이것은 프로젝트 `AGENTS.md` 지침을 Codex 시작 명령에 추가합니다.
Codex 동작을 확장하지만, Codex 핵심 시스템 정책을 대체/우회하지 않습니다.

제어:

```bash
OMX_BYPASS_DEFAULT_SYSTEM_PROMPT=0 omx     # AGENTS.md 주입 비활성화
OMX_MODEL_INSTRUCTIONS_FILE=/path/to/instructions.md omx
```

## 팀 모드

병렬 워커가 유리한 대규모 작업에 팀 모드를 사용합니다.

라이프사이클:

```text
start -> assign scoped lanes -> monitor -> verify terminal tasks -> shutdown
```

운영 명령어:

```bash
omx team <args>
omx team status <team-name>
omx team resume <team-name>
omx team shutdown <team-name>
```

중요 규칙: 중단하는 경우가 아니라면 작업이 `in_progress` 상태인 동안 종료하지 마세요.

### Ralph 정리 정책

팀이 ralph 모드(`omx team ralph ...`)로 실행될 때, 종료 정리는
일반 경로와 다른 전용 정책을 적용합니다:

| 동작 | 일반 팀 | Ralph 팀 |
|---|---|---|
| 실패 시 강제 종료 | `shutdown_gate_blocked` 발생 | 게이트를 우회하고 `ralph_cleanup_policy` 이벤트 기록 |
| 자동 브랜치 삭제 | 롤백 시 worktree 브랜치 삭제 | 브랜치 보존 (`skipBranchDeletion`) |
| 완료 로깅 | 표준 `shutdown_gate` 이벤트 | 작업 분석이 포함된 추가 `ralph_cleanup_summary` 이벤트 |

Ralph 정책은 팀 모드 상태(`linked_ralph`)에서 자동 감지되거나
`omx team shutdown <name> --ralph`로 명시적으로 전달할 수 있습니다.

팀 워커를 위한 Worker CLI 선택:

```bash
OMX_TEAM_WORKER_CLI=auto    # 기본값; worker --model에 "claude"가 포함되면 claude 사용
OMX_TEAM_WORKER_CLI=codex   # Codex CLI 워커 강제
OMX_TEAM_WORKER_CLI=claude  # Claude CLI 워커 강제
OMX_TEAM_WORKER_CLI_MAP=codex,codex,claude,claude  # 워커별 CLI 혼합 (길이=1 또는 워커 수)
OMX_TEAM_AUTO_INTERRUPT_RETRY=0  # 선택: 적응형 queue->resend 폴백 비활성화
```

참고:
- 워커 시작 인수는 여전히 `OMX_TEAM_WORKER_LAUNCH_ARGS`를 통해 공유됩니다.
- `OMX_TEAM_WORKER_CLI_MAP`은 워커별 선택을 위해 `OMX_TEAM_WORKER_CLI`를 재정의합니다.
- 트리거 제출은 기본적으로 적응형 재시도를 사용합니다 (queue/submit, 필요시 안전한 clear-line+resend 폴백).
- Claude worker 모드에서 OMX는 워커를 일반 `claude`로 시작하고 (추가 시작 인수 없음) 명시적인 `--model` / `--config` / `--effort` 재정의를 무시하여 Claude가 기본 `settings.json`을 사용합니다.

## `omx setup`이 작성하는 것

- `.omx/setup-scope.json` (저장된 설정 범위)
- 범위에 따른 설치:
  - `user`: `~/.codex/prompts/`, `~/.agents/skills/`, `~/.codex/config.toml`, `~/.omx/agents/`
  - `project`: `./.codex/prompts/`, `./.agents/skills/`, `./.codex/config.toml`, `./.omx/agents/`
- 시작 동작: 저장된 범위가 `project`이면, `omx` 시작 시 자동으로 `CODEX_HOME=./.codex`를 사용합니다 (`CODEX_HOME`이 이미 설정되지 않은 경우).
- 기존 `AGENTS.md`는 기본적으로 보존됩니다. 대화형 TTY 실행에서 setup은 덮어쓰기 전에 확인합니다; `--force`는 확인 없이 덮어씁니다 (활성 세션 안전 검사는 여전히 적용됩니다).
- `config.toml` 업데이트 (두 범위 모두):
  - `notify = ["node", "..."]`
  - `model_reasoning_effort = "high"`
  - `developer_instructions = "..."`
  - `[features] multi_agent = true, child_agents_md = true`
  - MCP 서버 항목 (`omx_state`, `omx_memory`, `omx_code_intel`, `omx_trace`)
  - `[tui] status_line`
- 프로젝트 `AGENTS.md`
- `.omx/` 런타임 디렉토리 및 HUD 설정

## 에이전트와 스킬

- 프롬프트: `prompts/*.md` (`user`는 `~/.codex/prompts/`에, `project`는 `./.codex/prompts/`에 설치)
- 스킬: `skills/*/SKILL.md` (`user`는 `~/.agents/skills/`에, `project`는 `./.agents/skills/`에 설치)

예시:
- 에이전트: `architect`, `planner`, `executor`, `debugger`, `verifier`, `security-reviewer`
- 스킬: `autopilot`, `plan`, `team`, `ralph`, `ultrawork`, `cancel`

## 프로젝트 구조

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

## 개발

```bash
git clone https://github.com/Yeachan-Heo/oh-my-codex.git
cd oh-my-codex
npm install
npm run build
npm test
```

## 문서

- **[전체 문서](https://yeachan-heo.github.io/oh-my-codex-website/docs.html)** — 완전한 가이드
- **[CLI 레퍼런스](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#cli-reference)** — 모든 `omx` 명령어, 플래그 및 도구
- **[알림 가이드](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#notifications)** — Discord, Telegram, Slack 및 webhook 설정
- **[권장 워크플로우](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#workflows)** — 일반적인 작업을 위한 실전 검증된 스킬 체인
- **[릴리스 노트](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#release-notes)** — 각 버전의 새로운 기능

## 참고

- 전체 변경 로그: `CHANGELOG.md`
- 마이그레이션 가이드 (v0.4.4 이후 mainline): `docs/migration-mainline-post-v0.4.4.md`
- 커버리지 및 패리티 노트: `COVERAGE.md`
- Hook 확장 워크플로우: `docs/hooks-extension.md`
- 설정 및 기여 세부사항: `CONTRIBUTING.md`

## 감사의 말

[oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode)에서 영감을 받아 Codex CLI용으로 적응하였습니다.

## 라이선스

MIT
