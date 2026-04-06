# Portable Codex Starter

이 폴더는 GitHub Codespaces + VS Code + Codex를 개인용으로 강하게 쓰기 위한 starter pack이다.

핵심만 말하면:

- `AGENTS.md`로 Codex 행동을 고정
- `.codex/agents/`로 역할 분리
- `.agents/skills/`와 `.github/skills/`로 반복 절차 고정
- `.devcontainer/`로 Codespaces 기본 환경 준비
- `.github/`로 Copilot instruction / hooks / workflows / custom agents 추가

긴 설명은 아래 문서로 분리해뒀다.

- 운영 자동화: [docs/automation-playbook.md](docs/automation-playbook.md)
- MCP 설정: [docs/mcp-setup.md](docs/mcp-setup.md)
- 품질 게이트: [docs/quality-gates.md](docs/quality-gates.md)
- 소스 맵: [docs/source-map.md](docs/source-map.md)

## 가장 빠른 시작

이 폴더 안에서:

```bash
node scripts/install.mjs --target /path/to/your-project --with-config
node scripts/doctor.mjs --target /path/to/your-project
```

Codex core만 넣고 싶으면:

```bash
node scripts/install.mjs --target /path/to/your-project --with-config --core-only
node scripts/doctor.mjs --target /path/to/your-project --core-only
```

skills를 `.codex/skills/`에 넣고 싶으면:

```bash
node scripts/install.mjs --target /path/to/your-project --with-config --skills-root=.codex
node scripts/doctor.mjs --target /path/to/your-project --skills-root=.codex
```

## 설치되면 들어가는 것

풀세트 기준:

- `AGENTS.md`
- `.codex/agents/`
- `.agents/skills/`
- `.codex/config.toml`
- `.codex/config.toml.example`
- `.codex/mcp-servers.example.toml`
- `.codex/starter-docs/`
- `.devcontainer/`
- `.github/copilot-instructions.md`
- `.github/instructions/`
- `.github/agents/`
- `.github/skills/`
- `.github/hooks/`
- `.github/workflows/`

## 지금 들어 있는 Codex 역할

총 33개다.

자주 쓸 것만 기억하면 충분하다.

- 계획: `planner`
- 구조 분석: `architect`
- 구현: `executor`
- 가벼운 탐색: `explore-harness`
- 일반 탐색: `explore`
- 코드 리뷰: `code-reviewer`
- 보안 리뷰: `security-reviewer`
- 테스트/검증: `test-engineer`, `qa-tester`, `verifier`
- 분업 리드: `team-orchestrator`
- 분업 실행: `team-executor`

## Codex에게 이렇게 말하면 된다

- `planner로 이 기능 계획만 세워줘. 아직 구현하지 마.`
- `architect 관점으로 현재 구조의 리스크를 분석해줘.`
- `executor처럼 바로 구현하고 테스트까지 해줘.`
- `code-reviewer처럼 현재 변경점 리뷰해줘.`
- `security-reviewer로 인증 흐름 취약점만 봐줘.`
- `team-orchestrator처럼 planner, architect, executor로 역할 분담해서 결론 내줘.`

## 운영 자동화에서 이미 들어간 것

- Codespaces 최소 머신 사양 제안
- recommended secrets
- Copilot instructions / path instructions / custom agents
- hook 기반 위험 명령 제어
- Copilot setup workflow
- portable quality gate workflow
- GitHub Copilot용 repo skills
- MCP 설정 템플릿

## 아직 수동으로 켜야 하는 것

- Codespaces prebuilds
- Copilot code review 자동화
- GitHub Code Quality
- Slack / Linear / Azure Boards 연동
- 실제 MCP 서버 명령/토큰 설정

## 검증 명령

starter 자체를 다시 확인하고 싶으면:

```bash
npm run verify:kit
```

현재 기준 검증 포인트:

- `.codex/agents` 33개
- `.agents/skills` 13개
- `.github/skills` 4개
- `.github/agents` 5개
- `.github/instructions` 5개
- workflow 2개

## 추천 사용 흐름

1. 새 repo를 Codespaces로 연다.
2. 이 starter를 설치한다.
3. `doctor`로 확인한다.
4. 필요하면 MCP 설정을 붙인다.
5. Codex에게 역할 이름을 붙여서 시킨다.
6. GitHub 쪽 자동화는 운영 문서를 보고 켠다.
