# OpenCode Provider Notes

조사 기준 upstream: `anomalyco/opencode` commit `9353559088fcb81d02290707e2da2e79d31b9bdc`

## Plugin Loading

OpenCode plugin은 별도 manifest 파일이 필수인 구조가 아니라 JavaScript/TypeScript module export 중심입니다.

로딩 경로:

- project local: `.opencode/plugins/`
- global local: `~/.config/opencode/plugins/`
- npm package: `opencode.json`의 `plugin` 배열

공식 문서상 로드 순서:

1. global config
2. project config
3. global plugin directory
4. project plugin directory

npm plugin은 OpenCode 시작 시 Bun으로 설치되고 `~/.cache/opencode/node_modules/`에 cache됩니다.

## Useful Plugin Hooks

`@opencode-ai/plugin`의 주요 hook:

- `config(input)`: OpenCode config를 수정할 수 있습니다. Kiro provider config 자동 주입 후보입니다.
- `auth`: `/connect` 흐름에 provider credential 입력 또는 OAuth를 붙일 수 있습니다.
- `provider`: 기존 catalog provider의 model 목록을 조정하는 데 사용할 수 있습니다.
- `chat.params`: LLM request parameter를 수정합니다.
- `chat.headers`: LLM request header를 수정합니다.
- `shell.env`: shell 실행 환경 변수를 추가합니다.
- `tool`: custom tool을 추가합니다.

중요한 제약:

- source상 `provider` hook은 catalog/database에 이미 존재하는 provider를 대상으로 model 목록을 바꾸는 성격이 강합니다.
- 완전히 새로운 provider는 `config` hook으로 `provider.kiro`를 추가하거나 사용자가 `opencode.json`에 직접 설정하는 방식이 더 안전합니다.

## Provider Config Shape

legacy/current docs 기준 최소 예시:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@bogyie/opencode-kiro-plugin"],
  "provider": {
    "kiro": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Kiro",
      "options": {
        "baseURL": "https://example.invalid/v1",
        "apiKey": "{env:KIRO_API_KEY}"
      },
      "models": {
        "auto": {
          "name": "Kiro Auto",
          "limit": {
            "context": 200000,
            "output": 32000
          }
        }
      }
    }
  },
  "model": "kiro/auto"
}
```

이 config-only 방식은 Kiro가 OpenAI-compatible endpoint를 제공할 때만 유효합니다. 현재 공식 문서상 해당 endpoint가 확인되지 않았으므로 구현 문서에서는 fallback 또는 future path로만 취급합니다.

## Source Pointers

- plugin types: `packages/plugin/src/index.ts`
- provider config schema: `packages/core/src/v1/config/provider.ts`
- provider loader: `packages/opencode/src/provider/provider.ts`
- provider auth: `packages/opencode/src/provider/auth.ts`
- CLI provider command: `packages/opencode/src/cli/cmd/providers.ts`
- built-in provider plugins: `packages/core/src/plugin/provider/*`
- OpenAI-compatible plugin: `packages/core/src/plugin/provider/openai-compatible.ts`
- session runner model support: `packages/core/src/session/runner/model.ts`

## Version Caveat

OpenCode 문서와 source에는 legacy `provider`/`plugin` config와 v2 `providers`/`plugins` spec가 함께 보입니다. 초기 플러그인은 README에 지원 OpenCode 버전과 config key를 명시해야 합니다.
