# End-to-End Validation

This checklist verifies the plugin against a real OpenCode + Kiro environment. Unit tests cover adapters with fixtures; these checks require local Kiro auth and should be run before publishing a release.

## Prerequisites

- Build the package:

```sh
npm install
npm run build
```

- Point OpenCode at this local plugin using `examples/opencode.jsonc` as a starting point.
- Run the diagnostic tool from OpenCode and confirm `kiro_status` reports the expected backend, region, and auth method.

## Backend: fetch

Use this when you have a token/API key that works with the CodeWhisperer/Kiro transport.

Config:

```jsonc
{
  "plugin": [
    [
      "file:/absolute/path/to/opencode-kiro-plugin",
      {
        "backend": "fetch",
        "region": "us-east-1",
        "maxAttempts": 3,
        "requestTimeoutMs": 120000
      }
    ]
  ]
}
```

Environment:

```sh
export KIRO_API_KEY="..."
```

Checks:

- Text prompt returns a normal assistant response.
- `stream: true` prompt renders incrementally.
- A prompt that triggers tool use returns OpenAI-compatible `tool_calls` in both streaming and non-streaming modes.
- A data URL image or PDF prompt reaches Kiro without external URL fetching.
- Invalid/expired auth returns `KIRO_AUTH_ERROR`, not a raw SDK exception.
- Rate/quota failure returns `KIRO_RATE_LIMIT`.
- Lowering `requestTimeoutMs` produces `KIRO_TIMEOUT`.

## Backend: cli-chat

Use this as the simplest official CLI fallback.

Config:

```jsonc
{
  "plugin": [
    [
      "file:/absolute/path/to/opencode-kiro-plugin",
      {
        "backend": "cli-chat",
        "trustAllTools": false
      }
    ]
  ]
}
```

Environment:

```sh
kiro-cli whoami
kiro-cli chat --no-interactive "Say hello"
```

Checks:

- OpenCode prompt returns the same kind of text response as `kiro-cli chat --no-interactive`.
- Unauthenticated CLI state returns `KIRO_AUTH_ERROR`.
- CLI failures return `KIRO_CLI_FAILED` with a readable message.
- Model selection is documented as best-effort only; Kiro CLI does not currently expose a guaranteed per-request model flag for this path.

## Backend: acp

Use this to validate the official Agent Client Protocol path.

Config:

```jsonc
{
  "plugin": [
    [
      "file:/absolute/path/to/opencode-kiro-plugin",
      {
        "backend": "acp"
      }
    ]
  ]
}
```

Environment:

```sh
kiro-cli whoami
kiro-cli acp
```

Stop the standalone `kiro-cli acp` process after confirming it starts; the plugin will spawn its own process.

Checks:

- Text prompt creates an ACP session and returns assistant text.
- Streaming prompt emits `AgentMessageChunk` text through OpenAI-compatible SSE.
- Tool invocation emits OpenAI-compatible tool-call deltas.
- Permission requests are rejected by default; repeat with `trustAllTools: true` only in a disposable workspace if you need to verify allow flows.
- File input is sent as ACP embedded `resource` content; image input is sent as ACP `image` content.
- Timeout waiting for `TurnEnd` returns `KIRO_ACP_TIMEOUT`.
- Missing `kiro-cli` or a process crash returns `KIRO_ACP_PROCESS_ERROR` or `KIRO_ACP_PROCESS_EXITED`.

## Model Churn Check

Before publishing, verify that new model ids can be used without a code release:

```jsonc
{
  "plugin": [
    [
      "file:/absolute/path/to/opencode-kiro-plugin",
      {
        "extraModels": {
          "new-model-id": {
            "name": "New Model",
            "limit": { "context": 200000, "output": 64000 },
            "modalities": { "input": ["text"], "output": ["text"] },
            "tool_call": true
          }
        },
        "modelAliases": {
          "new-model": "new-model-id"
        },
        "modelDiscoveryCommand": ["kiro-cli", "models", "--json"]
      }
    ]
  ]
}
```

Checks:

- If your installed `kiro-cli` has a model-list command, set `modelDiscoveryCommand` to that command and confirm discovered models appear in provider metadata.
- The model appears in OpenCode provider metadata.
- The alias resolves to the configured id.
- Unknown models still pass through when `disableModelPassThrough` is false.
- Unknown models return suggestions when `disableModelPassThrough` is true.

## Release Gate

Run these local checks after any E2E pass:

```sh
npm test
npm run typecheck
npm run build
npm run smoke:package
npm pack --dry-run
```

Record any real Kiro/API limitations in `CHANGELOG.md` before publishing.
