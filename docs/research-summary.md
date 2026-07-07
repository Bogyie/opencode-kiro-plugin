# Research Summary

조사일: 2026-07-07  
조사 방식: OpenCode/Kiro 공식 문서 확인, OpenCode upstream source 확인, subagent 병렬 조사 결과 통합

## 결론

OpenCode에 Kiro를 "provider"로 추가하려면 먼저 provider라는 단어를 두 의미로 나눠야 합니다.

1. OpenCode LLM provider: OpenCode의 모델 호출 계층입니다. `@ai-sdk/openai-compatible`, `@ai-sdk/openai`, `@ai-sdk/anthropic` 같은 AI SDK provider와 `provider` config를 통해 동작합니다.
2. Kiro agent provider: Kiro CLI/ACP agent를 OpenCode에서 호출 가능한 backend처럼 사용하는 방식입니다. Kiro가 공개한 공식 통합 표면은 이쪽에 가깝습니다.

Kiro가 공식적으로 OpenAI-compatible `/v1/chat/completions`, OpenAI Responses API, Anthropic Messages API 같은 직접 LLM endpoint를 공개하지 않았기 때문에, 현재 시점의 안전한 구현 방향은 Kiro CLI/ACP adapter입니다.

## 핵심 발견

OpenCode 쪽:

- plugin은 JavaScript/TypeScript module이며 `@opencode-ai/plugin` 타입을 사용할 수 있습니다.
- local plugin은 `.opencode/plugins/` 또는 `~/.config/opencode/plugins/`에서 자동 로드됩니다.
- npm plugin은 `opencode.json`의 `plugin` 배열에 package name을 넣어 설치합니다.
- custom provider는 `provider.<id>.npm`, `provider.<id>.options.baseURL`, `provider.<id>.models`로 설정합니다.
- source상 plugin hook에는 `config`, `auth`, `provider`, `chat.params`, `chat.headers`, `shell.env` 등이 있습니다.
- `provider` hook만으로 완전히 새로운 provider를 만드는 것은 제한적입니다. 새 provider는 config에 등록하는 경로가 더 안정적입니다.

Kiro 쪽:

- Kiro는 AWS가 운영하는 IDE/CLI/Web agentic engineering 제품입니다.
- 인증은 GitHub, Google, AWS Builder ID, AWS IAM Identity Center, external IdP를 지원합니다.
- headless/CI는 `KIRO_API_KEY` 환경 변수를 사용하지만 Pro 계열 구독 및 관리자 설정이 필요합니다.
- 공개 문서에서 직접 LLM API endpoint와 request/response schema는 확인되지 않았습니다.
- 공식 통합 표면은 `kiro-cli chat`, `kiro-cli chat --no-interactive`, `kiro-cli acp`입니다.
- ACP 모드는 JSON-RPC 2.0 over stdio로 동작하며 streaming chunk, tool call update, turn end 이벤트를 제공합니다.

Community 구현:

- `tickernelz/opencode-kiro-auth`는 실제 OpenCode server plugin 형태로 Kiro provider를 등록합니다. `config` hook에서 `provider.kiro`에 `@ai-sdk/openai-compatible`와 base URL을 주입하고, `auth.loader`에서 custom `fetch`를 제공해 OpenCode의 OpenAI-compatible 요청을 Kiro/CodeWhisperer request로 변환합니다.

## 구현 가설

현재 가능한 구현 경로는 다섯 가지입니다.

1. Config-only OpenAI-compatible provider
   - Kiro가 OpenAI-compatible endpoint를 제공한다는 전제가 필요합니다.
   - 현재 공식 문서상 근거가 부족합니다.

2. `kiro-cli chat --no-interactive` subprocess adapter
   - 가장 빠른 MVP 후보입니다.
   - 단점은 OpenCode의 native streaming/tool-call provider와 완전히 같은 UX를 만들기 어렵다는 점입니다.

3. `kiro-cli acp` JSON-RPC adapter
   - 공식 표면을 쓰면서 streaming과 session control을 받을 수 있습니다.
   - OpenCode provider interface에 ACP session events를 매핑하는 설계가 필요합니다.

4. 비공식 HTTP adapter
   - 직접 endpoint를 찾고 request schema를 맞추는 방식입니다.
   - 약관, 안정성, 계정 리스크가 커서 기본 구현에서 제외해야 합니다.

5. OpenCode plugin + custom fetch adapter
   - `opencode-kiro-auth`가 이미 검증한 패턴입니다.
   - OpenCode에는 `@ai-sdk/openai-compatible` provider로 보이게 하고, 실제 fetch에서 Kiro/CodeWhisperer SDK request로 변환합니다.
   - provider UX는 가장 좋지만 비공식 API 및 request 변환 유지보수 부담이 있습니다.

## 다음 액션

- `kiro-cli acp`의 JSON-RPC initialize/session flow를 실제로 기록합니다.
- OpenCode plugin으로 custom tool 또는 command를 추가해 Kiro CLI 호출 MVP를 먼저 만듭니다.
- 그 다음 OpenCode provider 계층에 붙일 수 있는지 검증합니다.
- Kiro model metadata는 정적 preset을 fallback으로만 두고, 실제 모델 목록은 discovery/cache/resolver로 보정합니다.
