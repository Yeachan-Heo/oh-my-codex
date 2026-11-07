# oh-my-codex (OMX)

<p align="center">
  <img src="https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png" alt="oh-my-codex character" width="280">
  <br>
  <em>Codex를 더 강력하게 시작하고, 일이 복잡해지면 OMX가 더 나은 프롬프트·워크플로·런타임 지원을 더합니다.</em>
</p>

[![npm version](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Discord](https://img.shields.io/discord/1452487457085063218?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/wSyUQYfhAw)

**웹사이트:** https://yeachan-heo.github.io/oh-my-codex-website/  
**문서:** [시작하기](../../docs/getting-started.html) · [에이전트](../../docs/agents.html) · [스킬](../../docs/skills.html) · [통합](../../docs/integrations.html) · [데모](../../DEMO.md) · [OpenClaw 가이드](../openclaw-integration.md)  
**커뮤니티:** [Discord](https://discord.gg/wSyUQYfhAw) — oh-my-codex, [gajae-code](https://github.com/Yeachan-Heo/gajae-code) 및 관련 도구의 공용 Gajae 커뮤니티.

## 공식 프로젝트 및 패키지

공식 OMX 프로젝트는 이 저장소 [Yeachan-Heo/oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex)이며 공식 npm 패키지는 [oh-my-codex](https://www.npmjs.com/package/oh-my-codex)입니다. `npm install -g oh-my-codex`로 설치하세요. “OMX v2” 같은 이름을 쓰는 제3자 프로젝트나 포크는 이 README 또는 문서에서 명시하지 않는 한 공식 후속작이나 대체 릴리스가 아닙니다. 확실하지 않을 때는 이 저장소와 npm 패키지를 공식 설치 대상으로 삼으세요.

OMX는 [OpenAI Codex CLI](https://github.com/openai/codex)를 위한 워크플로 계층입니다. Codex를 실행 엔진으로 유지하면서 더 강한 기본 세션, 일관된 작업 흐름, `$plan`, `$ultragoal`, `$team`, `$code-review`, `$ultraqa` 같은 개별 워크플로, 프로젝트 지침 및 `.omx/`의 지속 상태를 제공합니다.

> ⚠️ **권장 기본 환경은 macOS 또는 Linux와 Codex CLI입니다.** OMX는 이 경로를 중심으로 설계·개선됩니다. 네이티브 Windows와 Codex App은 기본 경험이 아니며 지원이 제한적이거나 동작이 달라질 수 있습니다.

## 핵심 유지관리자

| 역할 | 이름 | GitHub |
| --- | --- | --- |
| 제작자 및 리드 | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| 유지관리자 | Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| 유지관리자 | Valeriy Pavlovich | [@iqdoctor](https://github.com/iqdoctor) |

## 앰배서더 및 주요 기여자

- 앰배서더: Sigrid Jin ([ @sigridjineth ](https://github.com/sigridjineth))
- 주요 기여자: Doyun Ha, Junho Yeo, JiHongKim98, Lor, HyunjunJeon. [GitHub](https://github.com/Yeachan-Heo/oh-my-codex/graphs/contributors)에서 전체 목록을 확인할 수 있습니다.

## 권장 기본 흐름

Codex CLI가 이미 설치되어 있다면:

```bash
codex --version
npm install -g oh-my-codex
# Codex가 편집할 Git 프로젝트에서 실행하고 작업별 이름을 지정합니다.
omx --worktree=feat/task --madmax --xhigh
```

Codex CLI를 아직 설치하지 않았고 npm으로 관리하려면:

```bash
npm install -g @openai/codex
npm install -g oh-my-codex
```

기존 Homebrew `codex`가 소유한 바이너리(예: `/opt/homebrew/bin/codex`)에 npm으로 Codex를 덮어 설치하지 마세요. `EEXIST`가 발생할 수 있습니다. OMX에는 인증된 `codex` 명령이 PATH에 있으면 충분합니다. 실제 OMX 버전 업그레이드 후에는 setup이 자동 실행되지 않으므로 `omx setup --scope project --merge-agents` 또는 `omx update`를 실행하세요. 시작 시 npm 업데이트 확인은 기본적으로 빈도 제한 및 확인을 거칩니다. `OMX_AUTO_UPDATE=0`으로 끄고, `OMX_AUTO_UPDATE=defer`로 확인 없이 세션 종료 후 업데이트를 예약할 수 있습니다.

설치 범위를 선택하세요: 대상 Git 프로젝트에 프로젝트 지침을 두려면 `omx setup --scope project --merge-agents`, 사용자 수준 Codex 설정에는 `omx setup --scope user`를 사용합니다. 홈 디렉터리에서 프로젝트 setup을 실행하면 전역 지침과 섞일 수 있으니, 실제로 그 디렉터리가 프로젝트일 때만 실행하세요. merge 옵션은 저장소별 정책이며 강제/기본 정책이 아닙니다. 기존 `AGENTS.md`의 OMX 섹션은 `<!-- OMX:AGENTS:START -->` / `<!-- OMX:AGENTS:END -->` 사이에서 관리됩니다.

Codex 플러그인 설치는 `plugins/oh-my-codex`의 공식 플러그인 레이아웃도 제공합니다. 플러그인 모드에서도 런타임은 설치된 OMX CLI를 사용하며, 지속 지침용 `AGENTS.md`가 필요합니다. `omx setup --disable-hooks`는 OMX 훅을 비활성화하고 일반 자산 설치보다 먼저 종료합니다.

설치 후 다음을 확인하세요:

```bash
omx doctor
codex login status
omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"
```

`omx doctor`는 OMX 파일, 훅 및 런타임 사전조건을 확인합니다. 실제 실행 테스트는 현재 셸의 Codex 인증·프로필·엔드포인트까지 확인합니다.

## 첫 세션 및 안전한 실행

macOS/Linux에서 tmux를 사용할 수 있으면 OMX는 기본적으로 리더를 분리된 OMX 관리 tmux에서 실행하여 HUD와 런타임 pane을 복구할 수 있게 합니다. `--worktree`는 별도 Git checkout에서 실행하며 `--madmax`와 함께 쓸 때 권장됩니다. 작업별 worktree 이름을 지정하세요.

`--madmax`는 Codex의 `--dangerously-bypass-approvals-and-sandbox`를 줄인 표기입니다. 승인 및 샌드박스 보호를 끄므로 신뢰할 수 있는 저장소와 환경에서만 사용하세요. `--high` 및 `--xhigh`는 reasoning effort 설정의 축약형입니다. 반복/동시 실행에는 `--worktree=feature/auth`처럼 이름 있는 worktree를 쓰세요. 이름 없는 `--worktree`는 일회성 detached worktree이며 원본 HEAD가 바뀌면 `worktree_target_mismatch`가 날 수 있습니다. 대상 worktree가 dirty하면 OMX는 경고 후 그대로 실행합니다. Team 작업자는 기본적으로 자체 worktree를 사용합니다.

일반 실행은 선택한 `OMX_ROOT`에 하나의 쓰기 가능한 세션 포인터를 소유합니다. 같은 checkout에서 두 번째 일반 실행은 공유를 막기 위해 실패합니다. 별도 대화에는 고유한 루트를 지정하세요:

```bash
omx
OMX_ROOT="$HOME/.omx/instances/second-conversation" omx
OMX_ROOT="$HOME/.omx/instances/third-conversation" omx
```

PowerShell: `$env:OMX_ROOT = "$HOME/.omx/instances/second-conversation"`  
Command Prompt: `set "OMX_ROOT=%USERPROFILE%\.omx\instances\second-conversation"`

같은 명시적 루트를 두 번 쓰면 소유권 충돌로 실패합니다. 각 checkout은 기본 루트가 다릅니다. repo-aware 도구에는 저장소/worktree 루트, Git common dir 및 CodeGraph 모드 관련 `OMX_*` 컨텍스트가 전달됩니다. 자동 모드는 worktree 로컬 인덱스, 저장소 인덱스를 차례로 찾고 없으면 꺼집니다. OMX는 CodeGraph를 설치하거나 인덱싱/복사/심볼릭 링크하지 않습니다. 공유 인덱스는 편리하지만 worktree 변경을 반영하지 않을 수 있습니다.

한 번만 tmux/HUD 관리 없이 실행하려면 `omx --direct --yolo`, 셸 기본값으로는 `OMX_LAUNCH_POLICY=direct omx --yolo`를 사용하세요. 정책은 `direct|tmux|detached-tmux|auto`이며 CLI 플래그가 환경 변수보다 우선합니다. 기존 tmux pane 안에서 `--direct`를 사용해도 새 HUD 분할은 만들지 않지만 프로세스는 그 pane에서 실행됩니다.

## OMX의 역할

OMX는 Codex를 대체하지 않습니다. Codex가 실제 작업을 하고, OMX 역할 키워드는 역할을 재사용 가능하게 하며, 스킬은 반복 워크플로를 지원하고 `.omx/`는 계획·로그·메모리·상태를 저장합니다. 핵심은 수동 명령 표면보다 더 나은 라우팅, 워크플로 및 런타임입니다.

Codex가 이미 충분하고 추가 워크플로 계층이 필요 없다면 OMX를 사용하지 않아도 됩니다.

## 초보자 안내

1. `codex --version`으로 Codex CLI를 확인하고 `npm install -g oh-my-codex`로 OMX를 설치/업데이트합니다. npm으로 Codex를 관리하려면 먼저 `@openai/codex`를 별도 설치합니다.
2. 버전 업그레이드 후 대상 프로젝트에서 `omx setup --scope project --merge-agents` 또는 사용자 설정용 `omx setup --scope user`를 실행합니다. npm 업데이트도 하려면 `omx update`를 사용합니다.
3. `omx doctor`를 실행합니다.
4. `codex login status` 및 위의 `omx exec` 스모크 테스트를 실행합니다.
5. Git 프로젝트에서 이름 있는 worktree로 시작합니다. 동시 `--madmax` 세션에는 각기 다른 worktree를 사용합니다.
6. 요구사항이나 경계가 불분명하면 `$deep-interview`를 실행합니다.
7. 계획과 trade-off 검토에는 `$ralplan`을 실행합니다.
8. 지속 목표가 필요하면 `/goal`, 실행에 내구성 있는 다중 목표 기록이 필요하면 `$ultragoal`, 조정된 병렬 실행이 필요하면 `$team`을 사용합니다.

## 권장 워크플로

`$autopilot`은 `$deep-interview -> $ralplan -> $ultragoal`의 표준 오케스트레이터입니다. 각 단계는 입력 요건이 이미 충족되면 따로 실행할 수 있습니다.

1. `$deep-interview`: 반복 질문으로 모호성을 해소하고 실행 가능한 요구사항을 만듭니다.
2. `$ralplan`: 요구사항을 바탕으로 아키텍처·실현 가능성·합의를 검토합니다.
3. `$ultragoal`: `.omx/ultragoal` 체크포인트를 사용해 여러 목표를 지속 실행합니다.
4. `$team`: 작업이 여러 lane의 조정을 필요로 할 때 실행합니다.

`$deep-interview`는 독립 요구사항 단계이며 `$plan --interview`의 별칭이 아니고 구현도 하지 않습니다. 계획 스킬은 계획 산출물에서 끝납니다. 코드 변경은 명시적 실행 단계가 필요합니다. Ultragoal 스토리 안에서는 병렬 조정이 이득일 때만 Team을 사용하세요.

### 세션에서 자주 쓰는 표면

| 명령/표면 | 용도 |
| --- | --- |
| `$plan "..."` | 선택적 계획 및 명확화 |
| `$ultragoal "..."` | 승인된 계획 후 지속 실행 |
| `$team "..."` | 충분히 큰 작업의 병렬 조정 |
| `/skills` | 설치된 스킬과 보조 기능 탐색 |
| `/goal ...` | 턴을 넘어 재조정할 지속 목표/체크포인트 |
| `omx mission <file>` | 프롬프트/체크리스트 순차 배치 실행 |

## 고급/운영자 표면

### Mission 큐

`omx mission plan ./mission.md` 또는 `omx mission ./mission.md --dry-run`으로 입력을 검증하고 `omx mission run ./mission.md -- --model gpt-5`로 실행합니다. 중단 시 `status`, `resume`, `mark --status blocked`, `rerun --task`를 사용합니다. 지속 요약 및 ledger는 `.omx/missions/<slug>/`에 저장됩니다. [Mission 문서](../../docs/mission.md)를 참조하세요.

### 이전 대화 내보내기

`omx session search "기억나는 문구"`로 ID를 찾은 다음 `omx session export <session-id> --output conversation.md`를 실행합니다. 정확한 ID 또는 유일한 접두사를 지원하며 활성/보관 대화를 포함합니다. `--format json`, `--include-tools`, `--codex-home <path>`를 지정할 수 있고 `--output` 생략 시 stdout에 씁니다. 기존 파일은 덮어쓰지 않습니다. 기본 내보내기는 user/assistant 메시지만 포함하며 system/developer 지침과 reasoning 기록은 제외하지만 메시지 텍스트를 가리지는 않습니다. [세션 내보내기 문서](../../docs/session-export.md).

### 토큰 사용량과 실행 타임라인

`omx session usage --since 7d --sort tokens`는 로컬 활성/보관 세션의 기록된 누적 토큰을 보여줍니다. `--project current`, `--session`, `--json`, `--codex-home`, `--limit`를 지원합니다. 세션은 마지막 활동으로 선택되므로 사용량이 해당 기간의 청구/소비량과 같지는 않습니다. 복제 세션은 한 번만 집계되고 측정이 없으면 unknown으로 표시됩니다. [사용량 문서](../../docs/session-usage.md).

`omx session timeline <session-id>`는 대화 텍스트를 내보내지 않고 도구 호출, 턴 경계, 압축, 오류 및 실행 시간을 보여줍니다. `--kind tools --sort duration --limit 10`, `--status failed`, `--tool <name>`, `--json --output timeline.json` 등을 쓸 수 있습니다. 필터는 이벤트 목록만 바꾸며 요약은 전체 세션을 기준으로 합니다. 알 수 없는 시간은 unknown이며 명시적 오류가 없다는 사실만으로 성공이 증명되지는 않습니다. [타임라인 문서](../../docs/session-timeline.md).

### Team 런타임

Team은 기본 시작 방식이 아니라 지속 tmux/worktree 조정이 필요할 때 사용합니다. Codex App 또는 tmux 밖의 세션에서는 `omx team`을 인앱 워크플로가 아닌 셸 런타임으로 취급하세요. Ultragoal과 연결된 Team에서 목표 상태는 리더 소유이며 작업자는 증거를 보고합니다. 시작 시 재개에 필요한 사전 실행 컨텍스트가 저장됩니다. 작은 원자 작업은 worker 수를 하나로 제한하고 과도한 조정 경고를 낼 수 있습니다.

```bash
omx team 3:executor "fix the failing tests with verification"
omx team status <team-name>
omx team resume <team-name>
omx team shutdown <team-name>
```

`omx team status`와 `omx tmux-hook status`는 관찰 전용입니다. 만료 claim 회수, 메시지 전달, worker 커밋 통합 또는 상태 변경은 하지 않습니다. 훅 설정이 없으면 이를 보고할 뿐 파일을 만들지 않습니다. 초기화에는 `omx tmux-hook init`을 사용합니다.

### Setup, doctor 및 HUD

플러그인 마켓플레이스는 `${CODEX_HOME:-~/.codex}/plugins/cache/$MARKETPLACE_NAME/oh-my-codex/$VERSION/`에 번들을 캐시할 수 있습니다. 번들에는 Codex lifecycle 훅, 선택적 MCP 호환 서버 및 앱용 메타데이터가 포함되지만 기본 비활성입니다. setup은 범위에 따라 프롬프트, 스킬, AGENTS, config, 구버전용 native hooks를 설치/갱신합니다. 비-OMX 훅은 보존하고 OMX 래퍼만 다시 씁니다. uninstall은 OMX 래퍼만 제거하고 사용자 훅이 남아 있으면 파일을 보존합니다.

`omx update`는 npm을 확인하고 최신 전역 빌드를 설치한 뒤 동일한 setup 갱신을 실행합니다. 새 setup의 기본 모델은 `gpt-6-astra`이며 사용자 설정과 명시적 override는 보존됩니다. 라우팅 설정은 [모델/env 참조](../../docs/reference/omx-config-schema-routing.md)를 확인하고 설치 버전에서 지원되는 키만 쓰세요. `omx doctor`는 설치 상태를 확인할 뿐 인증된 실제 모델 호출을 보장하지 않습니다. HUD는 모니터링 표면입니다.

HUD는 현재 Team 이름과 worker 수, 상태/작업/역할/pane/갱신 시각을 보여줍니다. 표시 불가 상태는 unknown이며 working 표시가 프로세스 생존을 증명하지는 않습니다. 팀 파일은 읽기 전용으로 검사됩니다. GitGuardex 단계 표시는 프로젝트 `.omx/hud-config.json`에 `"guardex": { "enabled": true }`를 설정한 경우에만 활성화됩니다. worker가 화면에 맞지 않으면 `+N workers`로 축약되며 크기는 tmux geometry에 따라 조정됩니다.

일반 비-Team 세션에서는 native Codex hooks가 표준입니다: 플러그인 등록은 `plugins/oh-my-codex/hooks/hooks.json`, 레거시/구버전 fallback은 `.codex/hooks.json`, OMX 플러그인 훅은 `.omx/hooks/*.mjs`, tmux 알림 및 watcher는 fallback 경로입니다. [Codex native hook mapping](../../docs/codex-native-hooks.md).

### 준비 완료로 오해되는 상태 진단

`omx doctor`가 녹색이어도 실제 실행이 실패하면 OMX를 실행하는 동일한 셸/프로필에서 로그인 상태와 `omx exec` 테스트를 확인하세요. 사용자 지정 HOME, 프로필, 컨테이너/서비스 셸의 `CODEX_HOME`이 예상한 인증/설정인지 확인합니다. 로컬 OpenAI 호환 프록시를 쓰면 active `config.toml`의 `openai_base_url`도 확인하세요. Team 재개에서 죽은 tmux 세션이 나타나면 실제로 중단된 팀임을 확인한 후에만 강제 종료하고 `omx cancel`, `omx doctor --team`을 실행합니다.

tmux 세션의 Shift+Enter가 줄바꿈 대신 제출하면 [실행 readiness 문제 해결](../../docs/troubleshooting.md#shiftenter-submits-instead-of-inserting-a-newline-in-tmux-backed-omx-sessions)을 확인하세요. 지속 문제는 보통 tmux terminal capability/discovery 문제입니다.

### Sparkshell과 Wiki

- `omx sparkshell <command>`는 셸 기반 점검 및 제한된 검증용입니다. 저장소 읽기 전용 탐색에는 Codex의 기본 저장소 도구/서브에이전트를 쓰세요. 오래된 `omx explore`는 제거되었습니다.
- 기본 Sparkshell 요약 모델은 `gpt-6-astra`입니다. `OMX_SPARKSHELL_FALLBACK_MODEL`로 별도 fallback을 지정할 수 있습니다. 실행 파일, 모델, 지시 파일, 요약 시간 제한도 해당 `OMX_SPARKSHELL_*` 환경 변수로 조정합니다.
- `omx wiki`는 CLI 우선 JSON 인터페이스이며 `omx_wiki` MCP는 호환성 용도입니다. 지식은 저장소의 `omx_wiki/`에 Markdown으로 보관되며 벡터 중심이 아니라 검색 중심입니다.

```bash
omx sparkshell git status
omx wiki list --json
omx wiki query --input '{"query":"session-start lifecycle"}' --json
omx wiki lint --json
omx wiki refresh --json
```

### Team 모드의 플랫폼 참고

Team은 macOS/Linux와 tmux에서 가장 잘 작동합니다. Windows native는 보조 경로이며 보통 WSL2가 낫습니다. Windows에서는 기존 tmux 기반 경로에 호환 바이너리 `psmux`를 사용할 수 있습니다.

| 플랫폼 | 설치 |
| --- | --- |
| macOS | `brew install tmux` |
| Ubuntu/Debian | `sudo apt install tmux` |
| Fedora | `sudo dnf install tmux` |
| Arch | `sudo pacman -S tmux` |
| Windows | `winget install psmux` |
| Windows (WSL2) | `sudo apt install tmux` |

## 알려진 문제

일부 Intel Mac에서는 시작 시 macOS Gatekeeper가 여러 프로세스를 검증하면서 `syspolicyd` / `trustd` CPU 사용량이 높아질 수 있습니다. 다음을 시도하세요:

- `xattr -dr com.apple.quarantine $(which omx)`
- macOS 보안 설정의 Developer Tools 허용 목록에 터미널 앱 추가
- 동시 실행 수를 줄이고 `--madmax --high` 사용을 피하기

## 문서

- [시작하기](../../docs/getting-started.html) · [데모](../../DEMO.md) · [Wiki](../../docs/wiki-feature.md) · [에이전트](../../docs/agents.html) · [스킬](../../docs/skills.html)
- [Codex native hook mapping](../../docs/codex-native-hooks.md) · [GitHub/PR/package identity pipeline](../../docs/pipeline/github-pr-package-identity.md) · [통합](../../docs/integrations.html)
- [문제 해결](../../docs/troubleshooting.md) · [OpenClaw/notification gateway](../openclaw-integration.md) · [기여](../../CONTRIBUTING.md) · [변경 기록](../../CHANGELOG.md)

## 언어

- [English](../../README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [简体中文](README.zh.md) · [繁體中文](README.zh-TW.md) · [Tiếng Việt](README.vi.md) · [Español](README.es.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [Türkçe](README.tr.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Italiano](README.it.md) · [Ελληνικά](README.el.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Bahasa Indonesia](README.id.md)

## 추가 실행 예제

### 목표와 워크플로

```text
# 장기 작업을 위한 지속 목표와 체크포인트:
/goal 안전한 인증 리팩터링 계획을 세우고 구현한 뒤 로그인, 로그아웃, refresh token 동작을 검증합니다.

$deep-interview "인증 변경 사항을 명확히 하기"
$ralplan "인증 계획을 승인하고 trade-off 검토하기"
$ultragoal "승인된 계획을 지속 가능한 Codex 목표로 실행하기"
```

```bash
omx --worktree=feat/task --madmax --xhigh
```

### 여러 대화 및 worktree 예제

```powershell
$env:OMX_ROOT = "$HOME/.omx/instances/second-conversation"
omx
```

```bat
set "OMX_ROOT=%USERPROFILE%\.omx\instances\second-conversation"
omx
```

```bash
omx --worktree=feature/auth --madmax --xhigh
```

```bash
omx --worktree=feature/auth --madmax --xhigh
omx --worktree=fix/flaky-tests --madmax --xhigh
```

### 직접 실행 및 launch policy

```bash
omx --direct --yolo
```

```bash
OMX_LAUNCH_POLICY=direct omx --yolo
```

```bash
unset OMX_LAUNCH_POLICY
```

CLI 정책 플래그는 환경 변수보다 우선하며, `--` 앞에 둔 마지막 정책 플래그가 적용됩니다.

```bash
OMX_LAUNCH_POLICY=direct omx --tmux --yolo
```

### 체크아웃 작업용 지속 목표

```text
# 복사해 사용할 수 있는 지속 목표 예제:
/goal 재현, 구현, 회귀 테스트 및 최종 검증 체크포인트를 포함해 checkout 버그 수정 작업을 완료합니다.

$plan "checkout 버그 수정 계획을 승인하고 trade-off 검토하기"
$ultragoal "체크포인트 증거와 함께 승인된 checkout 수정 실행하기"
```

피해야 할 패턴:

```text
omx --madmax --xhigh
# 요청을 설명하기도 전에 "혹시 모르니" 스킬 20개를 한꺼번에 로드합니다.
# 이렇게 하면 컨텍스트가 불필요하게 커져 관련 없는 워크플로에 주의를 빼앗깁니다.
```

### 중단된 Team 정리

실제로 종료되었거나 의도적으로 버린 Team임을 확인한 경우에만 강제 종료를 사용합니다.

```bash
omx team shutdown <team-name> --force --confirm-issues
omx cancel
omx doctor --team
```

### 추가 Sparkshell pane 점검

```bash
omx sparkshell --tmux-pane %12 --tail-lines 400
```

## 기여자

| 역할 | 이름 | GitHub |
| --- | --- | --- |
| 제작자 및 리드 | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| 유지관리자 | Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| 유지관리자 | Valeriy Pavlovich | [@iqdoctor](https://github.com/iqdoctor) |

## Star 기록

[![Star History Chart](https://api.star-history.com/svg?repos=Yeachan-Heo/oh-my-codex&type=date&legend=top-left)](https://www.star-history.com/#Yeachan-Heo/oh-my-codex&type=date&legend=top-left)

## 라이선스

MIT

## GEO 가시성 벤치마크

OMX에는 LLM 적중률, MRR, 점유율 및 인용을 측정하기 위한 [`geobench`](https://github.com/NomaDamas/geobench) 제품 명세가 포함됩니다.

- 명세: [`geobench/oh-my-codex.yaml`](../../geobench/oh-my-codex.yaml)
- 실행 안내: [`docs/geobench.md`](../../docs/geobench.md)
