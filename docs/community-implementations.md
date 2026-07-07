# Community Implementations

조사일: 2026-07-07

## tickernelz/opencode-kiro-auth

Repository: https://github.com/tickernelz/opencode-kiro-auth  
Package: `@zhafron/opencode-kiro-auth`  
License: MIT

### What It Shows

이 레포는 OpenCode plugin 형태로 Kiro provider를 붙이는 가장 직접적인 참고 구현입니다.

핵심 구조:

- `package.json`
  - ESM package
  - `@opencode-ai/plugin` dependency
  - `@aws/codewhisperer-streaming-client` dependency
- `src/plugin.ts`
  - `config` hook에서 `provider.kiro`를 자동 주입
  - `provider.kiro.npm = "@ai-sdk/openai-compatible"`
  - provider-level `api`를 Kiro/Q endpoint base URL로 설정
  - model metadata를 기본 config로 채움
  - `auth.loader`에서 `baseURL`과 custom `fetch`를 반환
  - `provider.models` hook에서 model api url/npm을 보정
- `src/plugin/sdk-client.ts`
  - `CodeWhispererStreamingClient`를 생성
  - `https://q.{region}.amazonaws.com` endpoint 사용
  - `x-amzn-kiro-agent-mode: vibe` header 추가
  - thinking effort를 `additionalModelRequestFields.output_config.effort`로 주입
- `src/plugin/request.ts`
  - OpenAI-compatible request를 Kiro/CodeWhisperer request shape로 변환
  - system prompt, tool calls, tool results, image input, thinking mode를 처리
- `src/constants.ts`
  - Kiro auth endpoints, Q endpoint, model mapping, region helpers를 보유

### Useful Patterns

- OpenCode에는 OpenAI-compatible provider처럼 보이게 하고 custom `fetch`에서 실제 Kiro request로 변환합니다.
- `auth.loader`가 runtime credential과 fetch adapter를 함께 공급합니다.
- provider config 자동 주입으로 사용자의 `opencode.json` burden을 줄입니다.
- thinking 모델은 별도 virtual model 또는 variant로 표현할 수 있습니다.

### Cautions

- model mapping이 상수 중심이면 Kiro 모델 변경에 느리게 대응합니다.
- AWS/Kiro 내부 API 의존도가 있으므로 regression tests가 중요합니다.
- local Kiro CLI DB sync나 token handling은 사용자의 credential 저장소를 건드릴 수 있으므로 보수적으로 설계해야 합니다.

## Impact on This Project

기존 결론은 "Kiro 공식 LLM API가 문서화되지 않았으므로 CLI/ACP가 안전한 시작점"이었습니다. community 구현을 반영하면 구현 후보는 더 구체화됩니다.

권장 우선순위:

1. `opencode-kiro-auth` 패턴을 참고해 OpenCode plugin + custom fetch adapter를 prototype합니다.
2. 공식성/안정성이 더 필요한 사용자를 위해 CLI/ACP adapter를 별도 backend로 유지합니다.
