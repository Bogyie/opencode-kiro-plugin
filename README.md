# opencode-kiro-plugin

OpenCode에서 Kiro를 provider처럼 사용할 수 있는 플러그인을 만들기 위한 리서치 저장소입니다.

현재 결론은 다음과 같습니다.

- OpenCode의 공식 provider 확장 경로는 `opencode.json`의 `provider` 설정과 `@opencode-ai/plugin` 기반 server plugin입니다.
- Kiro는 2026-07-07 기준 공개 OpenAI-compatible 또는 Anthropic-compatible LLM endpoint를 문서화하지 않습니다.
- Kiro가 공식적으로 공개한 통합 표면은 `kiro-cli chat`, `kiro-cli chat --no-interactive`, `kiro-cli acp`입니다.

## Documents

- [Research Summary](docs/research-summary.md)
- [OpenCode Provider Notes](docs/opencode-provider-notes.md)
- [Kiro Integration Notes](docs/kiro-integration-notes.md)
- [Implementation Strategy](docs/implementation-strategy.md)
- [Implementation Plan](docs/implementation-plan.md)
- [Community Implementations](docs/community-implementations.md)
- [References](docs/references.md)

## Current Recommendation

2. 모델 목록은 정적 whitelist가 아니라 discovery cache, alias, hidden/manual override, pass-through를 갖춘 resolver로 설계합니다.
