# 운영 자동화 가이드

이 문서는 Portable Codex Starter를 "그냥 agent 묶음"이 아니라, 실제로 오래 쓰는 개인용/소규모 팀 운영 세트로 쓰기 위한 문서다.

실사용 quickstart는 [README.md](../README.md)만 보면 된다.
이 문서는 그보다 긴 운영 문서다.

## 1. Codespaces 계층

현재 포함:

- `.devcontainer/devcontainer.json`
- `.devcontainer/scripts/post-create.sh`

현재 하는 일:

- Node 20, Rust, GitHub CLI 설치
- 기본 VS Code extension 추천
- `openFiles`로 시작 파일 열기
- recommended secrets 제안
- `postCreateCommand` 실행
- 최소 머신 사양 제안
  - 4 CPU
  - 8GB memory
  - 32GB storage

### 아직 수동으로 해야 하는 것

- Codespaces prebuilds 활성화
- 실제 조직/개인 secret 값 입력
- 저장소/브랜치별 Codespaces 정책 선택

## 2. 저장소 규칙 자동 주입

현재 포함:

- `AGENTS.md`
- `.github/copilot-instructions.md`
- `.github/instructions/`
- `.github/agents/`

용도:

- Codex는 `AGENTS.md` 기준으로 작동
- GitHub Copilot은 `.github/copilot-instructions.md`와 `.github/instructions/*`를 사용
- GitHub custom agent는 `.github/agents/*`를 사용

## 3. 반복 절차를 skill로 고정

현재 포함:

- Codex용 portable skills: `.agents/skills/`
- GitHub Copilot용 repo skills: `.github/skills/`

GitHub skills는 다음 절차를 빠르게 재사용하기 위한 것이다.

- runtime smoke testing
- deploy readiness
- incident triage
- security review gate

## 4. 행동 통제

현재 포함:

- `.github/hooks/copilot-policy.json`
- hook scripts

용도:

- 세션 시작/종료 로그
- user prompt 로그
- tool use 전 정책 검사
- 위험 명령 차단

## 5. cloud agent 환경 맞춤화

현재 포함:

- `.github/workflows/copilot-setup-steps.yml`

현재 방향:

- Node 설치
- Rust 설치
- npm / cargo 의존성 준비
- build script가 있을 때만 build

즉 "특정 repo에서만 도는 스크립트"가 아니라, 여러 repo에서 버티는 범용 bootstrap에 가깝게 해뒀다.

## 6. 자동 품질 게이트

현재 포함:

- `.github/workflows/portable-quality-gate.yml`

하는 일:

- Node/Rust 품질 스크립트가 있으면 실행
- starter 핵심 scaffolding 존재 여부 확인
- hook JSON 기본 검증

추가로 수동 활성화가 필요한 것은 [품질 게이트 가이드](quality-gates.md)에 정리했다.

## 7. 외부 정보 연결

현재 포함:

- `.codex/mcp-servers.example.toml`

즉 "틀"은 넣어뒀다.
실제 MCP 서버 활성화는 토큰, 명령, 로컬 서버 유무가 달라서 수동 설정이 필요하다.

추천 조합과 예시는 [MCP 설정 가이드](mcp-setup.md)를 보면 된다.

## 8. 일감 유입 채널

이건 starter가 repo 파일만으로 대신 켜줄 수는 없다.

예:

- Slack
- Linear
- Azure Boards
- GitHub issue assignment

이런 건 GitHub 서비스 설정/앱 설치/조직 권한이 필요하다.

그래도 이 starter는 그 이후의 repo 계층은 준비해 둔다.

## 9. 권장 작업 분담

개인용 실전 권장:

- 즉시 수정/실험: Codespaces 안의 Codex
- 브랜치 리뷰/PR 검토: GitHub Copilot + Code Review
- 긴 탐색/병렬 검토: Codex subagent 역할 분담

## 10. 권장 설치 후 체크리스트

1. starter 설치
2. `doctor` 확인
3. `.codex/config.toml` 확인
4. 필요하면 `.codex/mcp-servers.example.toml`에서 MCP 섹션 복사
5. Codespaces secret 준비
6. GitHub에서 Copilot code review / Code Quality / branch protection 설정

## 공식 문서

- Codespaces recommended secrets:
  `https://docs.github.com/en/enterprise-cloud%40latest/codespaces/setting-up-your-project-for-codespaces/configuring-dev-containers/specifying-recommended-secrets-for-a-repository`
- Codespaces openFiles:
  `https://docs.github.com/en/codespaces/setting-up-your-project-for-codespaces/configuring-dev-containers/automatically-opening-files-in-the-codespaces-for-a-repository`
- Copilot custom instructions:
  `https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions`
- Copilot hooks:
  `https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-hooks`
- Copilot coding agent environment:
  `https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-environment`
