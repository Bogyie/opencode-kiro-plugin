# Implementation Strategy

## Goal

OpenCode에 Kiro provider를 plugin 형태로 추가합니다. 단, Kiro의 공식 직접 LLM API가 확인되지 않았으므로 초기 목표는 Kiro CLI/ACP를 안정적으로 감싸는 adapter입니다.

## Architecture Options

### Option A: Config-only OpenAI-compatible Provider

조건:

- Kiro가 OpenAI-compatible `/v1/chat/completions` endpoint를 제공해야 합니다.

장점:

- 구현이 가장 작습니다.
- OpenCode의 기존 provider config만으로 동작합니다.
- `@ai-sdk/openai-compatible`를 그대로 사용할 수 있습니다.

단점:

- 현재 공식 근거가 없습니다.
- auth, stream, tool call, usage metadata가 Kiro와 맞지 않을 수 있습니다.

판정: future path로 보관합니다.

### Option B: `kiro-cli chat --no-interactive` Adapter

조건:

- 사용자의 machine에 `kiro-cli`가 설치되어 있어야 합니다.
- `KIRO_API_KEY` 또는 login session이 있어야 합니다.

장점:

- 공식 CLI 표면을 사용합니다.
- MVP 구현이 빠릅니다.
- CI/headless 시나리오와 잘 맞습니다.

단점:

- streaming UX가 제한될 수 있습니다.
- OpenCode의 LLM tool-call protocol과 1:1 매핑이 어렵습니다.
- prompt 단위 호출에 가까워 session 재사용이 제한될 수 있습니다.

판정: MVP 후보입니다.

### Option C: `kiro-cli acp` Adapter

조건:

- OpenCode plugin 또는 별도 adapter process가 ACP JSON-RPC를 처리해야 합니다.

장점:

- Kiro가 공식 문서화한 agent integration path입니다.
- streaming chunk, tool call, session control을 받을 수 있습니다.
- 장기적으로 provider-like UX에 가장 가깝습니다.

단점:

- ACP event를 OpenCode provider stream으로 변환해야 합니다.
- OpenCode plugin hook만으로 충분한지 검증이 필요합니다.
- adapter state/session lifecycle 설계가 필요합니다.

판정: 권장 구현 방향입니다.

### Option D: Unofficial HTTP Adapter

조건:

- Kiro 내부 endpoint, auth, request/response schema를 reverse engineer해야 합니다.

장점:

- 성공하면 가장 provider답게 동작할 수 있습니다.

단점:

- 공식 지원이 없습니다.
- 약관 및 계정 리스크가 큽니다.
- Kiro 변경에 쉽게 깨집니다.

판정: 기본 구현에서 제외합니다.

### Option E: OpenCode Plugin with Custom Fetch

조건:

- OpenCode provider는 `@ai-sdk/openai-compatible`로 등록합니다.
- plugin `auth.loader`가 `baseURL`과 custom `fetch`를 반환합니다.
- custom `fetch`에서 OpenAI-compatible request를 Kiro/CodeWhisperer request로 변환합니다.

참고 구현:

- `tickernelz/opencode-kiro-auth`

장점:

- 사용자는 OpenCode에서 일반 provider처럼 사용할 수 있습니다.
- OpenCode의 model selection, variants, auth flow와 잘 맞습니다.
- 별도 server 없이 plugin 하나로 배포할 수 있습니다.

단점:

- Kiro/CodeWhisperer request 변환을 직접 유지보수해야 합니다.
- Kiro 내부 API 또는 AWS SDK 동작 변경에 민감합니다.
- 모델 목록이 정적으로 굳으면 빠르게 깨질 수 있습니다.

판정: OpenCode plugin UX를 목표로 할 때 가장 직접적인 구현 후보입니다.

## Model List Strategy

모델 목록은 Kiro 쪽 변경이 잦을 수 있으므로 하드코딩 whitelist에 의존하지 않습니다.

권장 resolver pipeline:

1. Alias
   - 사용자가 원하는 별칭을 실제 모델 ID로 매핑합니다.
   - 예: `kiro-auto` -> `auto`, `sonnet` -> `claude-sonnet-4.6`

2. Normalize
   - client마다 다른 이름 형식을 Kiro 형식으로 정규화합니다.
   - 예: `claude-sonnet-4-6` -> `claude-sonnet-4.6`
   - 예: `claude-sonnet-4-6-20260101` -> `claude-sonnet-4.6`
   - 예: `claude-4.6-sonnet-high` -> `claude-sonnet-4.6`

3. Dynamic cache
   - Kiro model list API 또는 CLI discovery 결과를 TTL cache에 저장합니다.
   - cache가 비어 있거나 stale이면 refresh를 시도합니다.
   - refresh 실패 시 fallback preset을 사용하되 경고를 남깁니다.

4. Hidden/manual models
   - 공식 list에는 없지만 동작하는 모델을 user config로 추가할 수 있게 합니다.
   - display ID와 internal ID를 분리합니다.

5. Optimistic pass-through
   - cache에 없는 모델도 즉시 거절하지 않습니다.
   - 정규화한 ID를 Kiro에 보내고 Kiro API/CLI가 최종 판정하게 합니다.
   - 실패 시 같은 family의 사용 가능한 모델을 suggestion으로 제공합니다.

필수 config knobs:

```json
{
  "kiro": {
    "modelCacheTtlSeconds": 21600,
    "modelDiscovery": "auto",
    "modelAliases": {
      "kiro-auto": "auto"
    },
    "hiddenModels": {
      "claude-3.7-sonnet": "CLAUDE_3_7_SONNET_20250219_V1_0"
    },
    "disableModelPassThrough": false
  }
}
```

설계 원칙:

- fallback preset은 마지막 안전망이지 truth source가 아닙니다.
- `SUPPORTED_MODELS` 같은 상수는 UI 표시와 tests용으로만 사용하고 runtime validation에는 쓰지 않습니다.
- 새 모델 출시는 config 업데이트 없이 pass-through로 먼저 사용할 수 있어야 합니다.
- `/models` 또는 OpenCode provider model list는 cache + hidden + alias를 합친 view를 반환합니다.

## Proposed Scaffold

```txt
src/
  index.ts          # OpenCode plugin export
  config.ts         # options, env, validation
  kiro-cli.ts       # kiro-cli discovery, version, whoami
  acp-client.ts     # JSON-RPC over stdio client
  chat-adapter.ts   # no-interactive fallback
  models.ts         # fallback presets and metadata defaults
  model-resolver.ts # alias, normalization, dynamic cache, hidden models, pass-through
  model-cache.ts    # TTL cache and refresh coordination
  errors.ts         # error normalization
test/
  config.test.ts
  kiro-cli.test.ts
  acp-client.test.ts
  chat-adapter.test.ts
  model-resolver.test.ts
  model-cache.test.ts
  fixtures/
    acp-initialize.json
    acp-agent-message-chunk.json
    acp-tool-call.json
    list-models.json
```

## MVP Scope

1. Plugin initialization
   - verify `kiro-cli` exists
   - expose clear diagnostic errors
   - do not read Kiro private token files

2. Auth handling
   - prefer `KIRO_API_KEY`
   - fallback to `kiro-cli whoami`
   - show login guidance if missing

3. Kiro call path
   - implement `chat --no-interactive` adapter first if ACP mapping is too large
   - record ACP handshake and add ACP adapter behind feature flag

4. OpenCode integration
   - provide config injection or documented config snippet
   - add model resolver with fallback presets
   - expose a custom tool or command for diagnostics

5. Tests
   - subprocess command construction
   - env handling
   - model normalization and pass-through
   - model cache stale/refresh behavior
   - ACP JSON-RPC parsing with fixtures

## Open Questions

- Can OpenCode plugin hooks currently replace the actual LLM transport with an ACP-backed adapter without modifying OpenCode core?
- If not, should this plugin start as a custom tool/command plus config helper, then later move toward provider support?
- Does current `kiro-cli acp` support non-interactive API key auth reliably under `KIRO_API_KEY`?
- What is the exact command/flag for listing Kiro models in the installed CLI version?
- How should OpenCode tool-call requests be represented when Kiro itself wants to use tools?

## Recommended First Milestone

Build a diagnostic-only plugin first:

- `opencode.json` loads `opencode-kiro-plugin`
- plugin checks `kiro-cli --version`
- plugin checks auth with `kiro-cli whoami`
- plugin exposes a `kiro_status` custom tool
- plugin documents the Kiro model presets and next adapter path

This validates plugin packaging and user environment before committing to the harder ACP/provider transport layer.
