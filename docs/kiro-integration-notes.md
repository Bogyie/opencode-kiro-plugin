# Kiro Integration Notes

조사일: 2026-07-07

## What Kiro Exposes Publicly

Kiro의 공식 공개 표면은 다음입니다.

- Kiro IDE
- Kiro CLI
- Kiro Web
- Kiro ACP agent mode
- Kiro headless CLI mode

현재 공식 문서에서 확인되는 직접 호출 방식:

```bash
kiro-cli
kiro-cli login
kiro-cli whoami
kiro-cli chat --no-interactive "prompt"
kiro-cli chat --no-interactive --trust-all-tools "prompt"
kiro-cli acp
```

Headless mode는 `KIRO_API_KEY` 환경 변수를 사용합니다.

```bash
export KIRO_API_KEY=ksk_xxxxxxxx
kiro-cli chat --no-interactive "your prompt here"
```

## Community API Surface Findings

공식 문서가 직접 LLM API를 설명하지는 않지만, community 구현들은 Kiro/CodeWhisperer 계열 API를 다음 방식으로 사용합니다.

- `opencode-kiro-auth`
  - AWS `@aws/codewhisperer-streaming-client` 사용
  - endpoint: `https://q.{region}.amazonaws.com`
  - operation 성격: `generateAssistantResponse`
  - Kiro header: `x-amzn-kiro-agent-mode: vibe`
  - auth refresh endpoints:
    - `https://prod.{region}.auth.desktop.kiro.dev/refreshToken`
    - `https://oidc.{region}.amazonaws.com/token`


이 경로들은 실전 구현으로는 유용하지만, 공식 stable API로 문서화된 것은 아니므로 compatibility risk를 별도로 관리해야 합니다.

## Authentication

공식 문서상 지원 인증:

- GitHub
- Google
- AWS Builder ID
- AWS IAM Identity Center
- external identity provider
- API key for headless mode

API key 인증은 Pro, Pro+, Pro Max, Power subscriber 또는 관리자 정책에 따라 사용 가능합니다.

플러그인 구현에서는 Kiro token file을 직접 읽는 방식보다 다음 순서를 권장합니다.

1. `KIRO_API_KEY`가 있으면 headless mode 사용
2. 없으면 `kiro-cli whoami`로 login 상태 확인
3. 미로그인 상태면 사용자에게 `kiro-cli login` 안내
4. 조직/관리자 정책 오류는 그대로 노출

## ACP Mode

Kiro는 `kiro-cli acp`로 ACP-compatible agent process를 실행할 수 있습니다.

특성:

- transport: stdin/stdout
- protocol: JSON-RPC 2.0
- session methods: `initialize`, `session/new`, `session/load`, `session/prompt`, `session/cancel`, `session/set_mode`, `session/set_model`
- update events: `AgentMessageChunk`, `ToolCall`, `ToolCallUpdate`, `TurnEnd`

OpenCode와 연결할 때는 ACP event를 OpenCode model stream 또는 tool event로 변환하는 adapter가 필요합니다.

## Model Notes


- `auto`
- `claude-opus-4.8`
- `claude-opus-4.7`
- `claude-opus-4.6`
- `claude-opus-4.5`
- `claude-sonnet-5`
- `claude-sonnet-4.6`
- `claude-sonnet-4.5`
- `claude-sonnet-4.0`
- `claude-haiku-4.5`
- `deepseek-3.2`
- `minimax-m2.5`
- `minimax-m2.1`
- `glm-5`
- `qwen3-coder-next`
- legacy/internal 후보:
  - `claude-3-7-sonnet`
  - `nova-swe`
  - `gpt-oss-120b`
  - `minimax-m2`
  - `kimi-k2-thinking`

문서화된 context window는 모델별로 다릅니다. 예를 들어 Kiro docs에는 Claude Opus 4.8/4.7/4.6과 Claude Sonnet 5/4.6가 1M context로 표시되고, Claude Sonnet 4.5/4.0 및 Claude Haiku 4.5는 200K context로 표시됩니다.

## Model Flexibility Requirement

Kiro 모델 목록은 tier, region, release timing에 따라 바뀔 수 있으므로 static list를 runtime truth로 쓰면 안 됩니다.

필수 동작:

- startup 시 model discovery를 시도합니다.
- discovery 결과는 TTL cache에 저장합니다.
- cache가 stale이면 background refresh를 시도합니다.
- refresh 실패 시 fallback preset으로 시작합니다.
- 사용자가 `hiddenModels`, `modelAliases`, `disabledModels`를 설정할 수 있게 합니다.
- 알 수 없는 모델은 기본적으로 pass-through합니다.
- Kiro가 거절한 경우 같은 model family의 후보를 제안합니다.

## Risk Notes

- 공식 OpenAI-compatible endpoint가 확인되지 않았습니다.
- Kiro CLI는 폐쇄 소스입니다.
- 비공식 endpoint reverse engineering은 약관, 안정성, 계정 리스크가 큽니다.
- Free/individual subscriber의 service improvement 정책과 Enterprise 데이터 처리 정책 차이를 README에 명확히 적어야 합니다.
- Kiro administrator policy가 model access, MCP, web fetch, API key 사용 가능 여부에 영향을 줄 수 있습니다.
