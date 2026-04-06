# MCP 설정 가이드

이 문서는 Portable Codex Starter에 외부 문서/시스템 연결을 붙일 때 보는 운영 문서다.

실사용 핵심만 말하면:

1. 기본 설치 후 `.codex/config.toml`을 유지한다.
2. `.codex/mcp-servers.example.toml`에서 필요한 서버만 골라 복사한다.
3. 실제 명령과 인자는 각 MCP 서버의 공식 문서를 보고 채운다.

## 기본 원칙

- MCP는 많이 붙일수록 좋은 게 아니다.
- 항상 "실제로 자주 쓰는 것"만 켠다.
- 기본 추천은 문서형 1개 + 저장소형 1개 + 브라우저형 1개 정도다.
- 운영 부담이 큰 MCP는 주석 상태로 두고 필요할 때만 켠다.

## 추천 우선순위

### 1. OpenAI 개발자 문서

가장 안전한 기본값이다.

이미 템플릿에 들어 있다:

```toml
[mcp_servers.openaiDeveloperDocs]
url = "https://developers.openai.com/mcp"
```

용도:

- OpenAI API 사용법 확인
- 모델 선택
- 최신 파라미터/기능 확인

### 2. GitHub MCP

용도:

- 저장소, PR, 이슈, 코드 탐색
- 로컬 checkout 밖의 GitHub 컨텍스트 확인

주의:

- 사용하는 GitHub MCP 서버 구현마다 실행 명령이 다를 수 있다.
- 템플릿에는 자리만 만들어 두고 실제 명령은 하드코딩하지 않았다.

### 3. Context7

용도:

- 최신 라이브러리 문서 검색
- 프레임워크 사용법 확인

주의:

- 서버 구현과 실행 방식이 배포처마다 달라질 수 있다.

### 4. Chrome DevTools MCP

용도:

- 브라우저 재현
- 콘솔/네트워크 확인
- UI 디버깅

이건 서버가 떠 있어야만 유용하다.

### 5. Markitdown

용도:

- 문서/파일 변환
- 긴 자료를 LLM 친화적 텍스트로 바꾸기

## 운영 추천 조합

### 문서 중심 개발

- `openaiDeveloperDocs`
- `context7`

### GitHub 중심 유지보수

- `github`
- `openaiDeveloperDocs`

### 프론트엔드 디버깅

- `chrome_devtools`
- `context7`

### 문서/분석 작업

- `markitdown`
- `github`

## 설정 방식

가장 안전한 방식은 `.codex/config.toml`에 필요한 섹션만 수동으로 붙이는 것이다.

예시:

```toml
model_reasoning_effort = "high"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[agents]
max_threads = 4
max_depth = 1

[mcp_servers.openaiDeveloperDocs]
url = "https://developers.openai.com/mcp"
```

## 주의할 점

- MCP를 너무 많이 켜면 오히려 판단 비용이 늘어난다.
- 내부 문서, 브라우저, GitHub를 동시에 다 켜는 건 필요한 작업에서만 한다.
- 인증이 필요한 MCP는 토큰/시크릿 설계가 먼저다.
- MCP가 있다고 항상 검색부터 하는 게 아니라, 로컬 코드와 repo 규칙을 먼저 본다.

## 같이 보면 좋은 문서

- [운영 자동화 가이드](automation-playbook.md)
- [품질 게이트 가이드](quality-gates.md)
