# 품질 게이트 가이드

이 문서는 "repo 파일로 할 수 있는 것"과 "GitHub에서 따로 켜야 하는 것"을 분리해서 정리한 운영 문서다.

## 이 starter가 이미 넣어주는 것

- `.github/workflows/portable-quality-gate.yml`
- `.github/workflows/copilot-setup-steps.yml`
- `.github/hooks/copilot-policy.json`
- `.github/skills/`

즉 파일 기반의 기본 게이트는 이미 있다.

## GitHub에서 따로 켜야 하는 것

다음 기능은 repo에 파일을 넣는 것만으로는 끝나지 않는다.

### 1. Copilot Code Review 자동화

추천:

- 새 PR 자동 리뷰 켜기
- 새 push마다 재리뷰 켜기
- 필요하면 draft PR도 리뷰 대상에 포함

이건 GitHub UI나 조직/저장소 설정에서 켜야 한다.

### 2. GitHub Code Quality

추천:

- 기본 브랜치 품질 결과 보기
- PR에서 새 문제를 빠르게 식별
- ruleset이나 merge 정책과 같이 운용

이것도 GitHub 쪽 기능 활성화가 필요하다.

### 3. 브랜치 보호 / Rulesets

최소 권장:

- PR 필수
- quality gate workflow 통과 필수
- main 직접 푸시 제한
- 필요하면 리뷰 승인 수 지정

## 실무 권장 운영

### 개인용 최소 세트

- `portable-quality-gate.yml`
- Copilot code review 수동 호출
- 위험한 작업은 hooks로 제어

### 개인용 강한 세트

- `portable-quality-gate.yml`
- Copilot code review 자동화
- GitHub Code Quality 활성화
- main 브랜치 보호

### 팀/조직형 세트

- 위 항목 전부
- rulesets
- 배포 환경별 추가 승인
- PR 템플릿/릴리즈 체크리스트

## 권장 체크 순서

1. 로컬/agent 수정
2. runtime smoke 또는 test 실행
3. `portable-quality-gate.yml` 통과
4. Copilot code review 확인
5. GitHub Code Quality 결과 확인
6. merge 또는 deploy 결정

## 이 starter의 한계

- Copilot code review를 repo 파일만으로 "강제 활성화"할 수는 없다.
- GitHub Code Quality도 starter가 대신 켜주지는 못한다.
- 그래서 이 starter는 "운영 틀"을 제공하고, GitHub 기능 활성화는 사용자가 해야 한다.

## 공식 문서

- Copilot code review:
  `https://docs.github.com/en/copilot/how-tos/agents/copilot-code-review/using-copilot-code-review`
- GitHub Code Quality:
  `https://docs.github.com/code-security/code-quality/concepts/about-code-quality`
- Copilot coding agent environment:
  `https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-environment`
