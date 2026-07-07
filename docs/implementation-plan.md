# Implementation Plan

목표: OpenCode에 Kiro provider를 plugin 형태로 추가한다.

기본 방향:

- 1차 제품 형태는 OpenCode server plugin입니다.
- OpenCode에는 `@ai-sdk/openai-compatible` provider처럼 보이게 합니다.
- 실제 요청은 plugin의 custom `fetch` adapter에서 Kiro/CodeWhisperer 요청으로 변환합니다.
- 모델 목록은 정적 whitelist가 아니라 dynamic resolver로 처리합니다.
- `kiro-cli acp`는 공식 경로 fallback이자 장기 안정성 검증 트랙으로 유지합니다.

## Non-Goals

- Kiro private token file을 기본 동작에서 직접 수정하지 않습니다.
- 모델 ID를 상수 whitelist로 막지 않습니다.

## Milestone 0: Project Scaffold

목표: npm package로 빌드/테스트 가능한 OpenCode plugin 골격을 만든다.

작업:

- `package.json` 생성
  - ESM package
  - `@opencode-ai/plugin` dependency
  - TypeScript, test runner 설정
- `tsconfig.json`, formatter 설정
- `src/index.ts`에서 default plugin module export
- `src/plugin.ts`에서 `config`, `auth`, `provider` hook skeleton 작성
- `test/`와 fixture 구조 생성

완료 기준:

- `npm test` 또는 선택한 test command가 실행됩니다.
- plugin package entrypoint가 import 가능합니다.
- OpenCode plugin module shape가 unit test로 검증됩니다.

## Milestone 1: Config Injection

목표: plugin 설치만으로 `provider.kiro` 기본 설정이 OpenCode config에 주입된다.

작업:

- `config` hook에서 `provider.kiro` 생성
- `npm: "@ai-sdk/openai-compatible"` 설정
- provider-level `api` 또는 `options.baseURL` 설정
- fallback model metadata 주입
- 사용자가 이미 정의한 provider/model 설정은 덮어쓰지 않고 merge
- `enabled_providers`/`disabled_providers`와 충돌하지 않게 처리

완료 기준:

- 빈 config에 Kiro provider가 생깁니다.
- 사용자 override가 유지됩니다.
- model limit, modality, variant metadata가 기본값으로 들어갑니다.

## Milestone 2: Model Resolver

목표: Kiro 모델 변경에 빠르게 대응할 수 있는 resolver를 만든다.

작업:

- `src/model-resolver.ts`
  - alias resolution
  - model name normalization
  - hidden/manual model lookup
  - optimistic pass-through
  - suggestion generation
- `src/model-cache.ts`
  - TTL cache
  - stale detection
  - refresh coordination
  - fallback preset loading
- `src/models.ts`
  - fallback preset only
  - runtime validation에는 사용하지 않음
- config knobs
  - `modelCacheTtlSeconds`
  - `modelAliases`
  - `hiddenModels`
  - `disabledModels`
  - `disableModelPassThrough`

완료 기준:

- `claude-sonnet-4-6`이 `claude-sonnet-4.6`으로 정규화됩니다.
- date suffix가 제거됩니다.
- alias가 먼저 적용됩니다.
- cache에 없는 모델도 pass-through됩니다.
- pass-through disable 시 명확한 에러와 suggestion을 반환합니다.

## Milestone 3: Auth and Environment Diagnostics

목표: 사용자가 Kiro 인증 상태를 명확히 알 수 있게 한다.

작업:

- `src/auth.ts`
  - `KIRO_API_KEY` 감지
  - `kiro-cli whoami` fallback
  - region 설정 파싱
  - auth method 상태 반환
- OpenCode `auth` hook
  - API key 입력 방식
  - login 안내 메시지
  - custom fetch adapter에 credential 전달
- `kiro_status` custom tool 또는 diagnostic command
  - plugin version
  - region
  - auth method
  - model cache status
  - selected backend

완료 기준:

- 인증이 없으면 실행 가능한 다음 단계가 표시됩니다.
- `KIRO_API_KEY`가 있으면 headless mode로 판단합니다.
- login session이 있으면 CLI 상태를 감지합니다.
- token 파일 내용을 로그에 출력하지 않습니다.

## Milestone 4: Custom Fetch Adapter Prototype

목표: OpenCode의 OpenAI-compatible request를 Kiro request로 변환해 응답을 반환한다.

작업:

- `src/fetch-adapter.ts`
  - request body parse
  - model resolver 적용
  - OpenAI-compatible messages 변환
  - system prompt 병합
  - image input 변환
  - tool definition 변환
  - tool result 변환
- `src/kiro-client.ts`
  - AWS/Kiro client wrapper
  - region endpoint 구성
  - retry boundary
  - timeout 처리
- `src/response-adapter.ts`
  - text response 변환
  - streaming chunk 변환
  - tool call 변환
  - usage metadata best effort

완료 기준:

- 단순 text prompt가 OpenCode에서 Kiro로 전달됩니다.
- streaming off path가 동작합니다.
- Kiro 에러가 OpenCode 사용자에게 읽을 수 있는 메시지로 변환됩니다.
- fixture 기반 request/response 변환 테스트가 있습니다.

## Milestone 5: Streaming and Tool Calls

목표: OpenCode provider UX에 필요한 streaming/tool-call 품질을 확보한다.

작업:

- Kiro streaming event fixture 수집
- SSE stream 변환
- tool call start/delta/done event 매핑
- tool result continuation handling
- duplicate/orphan tool result 방어
- thinking/reasoning field 처리

완료 기준:

- streaming text가 OpenCode에서 점진적으로 표시됩니다.
- tool call이 OpenCode tool execution과 충돌하지 않습니다.
- tool result 이후 후속 응답이 이어집니다.
- reasoning/thinking model variant가 최소한 degraded mode로 동작합니다.

## Milestone 6: CLI/ACP Fallback Track

목표: custom fetch path가 깨졌을 때 사용할 공식 표면 fallback을 준비한다.

작업:

- `src/kiro-cli.ts`
  - `kiro-cli` discovery
  - version check
  - `whoami`
  - optional model list command probing
- `src/acp-client.ts`
  - JSON-RPC stdio client
  - initialize/session flow
  - prompt/send/cancel
- backend selection
  - `backend: "fetch" | "cli-chat" | "acp" | "auto"`

완료 기준:

- `backend=cli-chat`에서 non-interactive prompt가 동작합니다.
- `backend=acp` handshake fixture test가 있습니다.
- `backend=auto`는 fetch 실패 시 무조건 fallback하지 않고 명확한 policy로 동작합니다.
- `cli-chat`은 공식 `kiro-cli chat --no-interactive` 표면만 사용하므로, CLI가 별도 model flag를 공식화하기 전까지 model selection은 보장하지 않습니다.

## Milestone 7: Packaging and Documentation

목표: 사용자가 설치하고 문제를 진단할 수 있게 한다.

작업:

- README 사용법
- `opencode.json` 예시
- auth setup guide
- model resolver config guide
- troubleshooting guide
- license notice
- changelog

완료 기준:

- npm package로 설치 가능합니다.
- local path plugin으로 개발 테스트 가능합니다.
- README만 보고 최소 설정을 완료할 수 있습니다.

## Recommended Build Order

1. Milestone 0: scaffold
2. Milestone 2: model resolver
3. Milestone 1: config injection
4. Milestone 3: auth diagnostics
5. Milestone 4: custom fetch text-only prototype
6. Milestone 5: streaming/tool calls
7. Milestone 6: CLI/ACP fallback
8. Milestone 7: packaging/docs

이 순서로 가는 이유는 모델 resolver가 plugin config와 adapter 양쪽에서 공통으로 필요하고, Kiro 모델 변경 대응 요구사항을 가장 먼저 구조에 반영해야 하기 때문입니다.

## Initial File Layout

```txt
src/
  index.ts
  plugin.ts
  config.ts
  auth.ts
  fetch-adapter.ts
  response-adapter.ts
  kiro-client.ts
  kiro-cli.ts
  acp-client.ts
  model-cache.ts
  model-resolver.ts
  models.ts
  errors.ts
  logger.ts
test/
  plugin.test.ts
  config.test.ts
  auth.test.ts
  model-cache.test.ts
  model-resolver.test.ts
  fetch-adapter.test.ts
  response-adapter.test.ts
  fixtures/
    openai-chat-request.json
    kiro-generate-request.json
    kiro-stream.txt
    model-list.json
```

## Risk Controls

- License
  - MIT 참고 코드도 그대로 복사하지 않고 독립 구현합니다.

- API stability
  - Kiro endpoint/client wrapper를 한 모듈에 격리합니다.
  - fixture tests로 request/response contract를 고정합니다.

- Model churn
  - pass-through를 기본값으로 둡니다.
  - fallback preset은 cache bootstrap과 UI 표시용으로만 씁니다.

- Credential safety
  - token 값을 로그에 남기지 않습니다.
  - token DB/file write는 기본 비활성화합니다.
  - read-only credential discovery와 explicit API key를 우선합니다.

- User experience
  - provider가 실패하면 "로그인 필요", "모델 미지원", "quota/rate limit", "network"를 구분합니다.
  - unsupported model 에러에는 same-family suggestion을 제공합니다.

## First PR Scope

첫 PR은 transport 구현까지 욕심내지 않습니다.

포함:

- package scaffold
- plugin module skeleton
- config schema
- model resolver/cache
- config injection unit tests
- resolver unit tests
- README installation draft

제외:

- 실제 Kiro network call
- streaming
- tool call 변환
- ACP transport

첫 PR 완료 후 두 번째 PR에서 auth diagnostics와 text-only custom fetch prototype을 붙입니다.
