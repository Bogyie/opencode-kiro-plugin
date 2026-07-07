# opencode-kiro-plugin

OpenCode server plugin that registers Kiro as an OpenAI-compatible provider and adapts requests to Kiro backends.

Status: early implementation. The CodeWhisperer streaming transport, CLI chat fallback, model resolver, multimodal request mapping, streaming text, and tool-call chunk mapping are implemented with unit tests. The ACP backend implements JSON-RPC stdio framing, initialize/session/model/prompt flow, streaming text from `AgentMessageChunk`, and basic `ToolCall` streaming; full ACP tool progress/result parity is still in progress.

## Install

For local development from this repository:

```sh
npm install
npm run build
```

Then add the plugin to your OpenCode config. See [examples/opencode.jsonc](examples/opencode.jsonc).

```jsonc
{
  "plugin": ["file:/absolute/path/to/opencode-kiro-plugin"],
  "provider": {
    "kiro": {
      "models": {
        "sonnet": {
          "name": "Sonnet alias"
        }
      }
    }
  }
}
```

When published to npm, replace the local `file:` entry with the package name.

## Auth

The plugin resolves credentials in this order:

1. `KIRO_API_KEY`
2. OpenCode auth input for provider `kiro`
3. `kiro-cli whoami` diagnostics for CLI session visibility

Direct fetch mode requires an API key/token usable by the Kiro/CodeWhisperer client. `cli-chat` mode uses the official `kiro-cli chat --no-interactive` surface and depends on the local Kiro CLI login state.

Use the `kiro_status` plugin tool to inspect provider id, backend, region, auth method, and fallback model preset count. Secrets are redacted in diagnostics.

## Backend Modes

Configure the backend through plugin options:

```jsonc
{
  "plugin": [
    [
      "file:/absolute/path/to/opencode-kiro-plugin",
      {
        "backend": "auto",
        "region": "us-east-1",
        "maxAttempts": 3,
        "requestTimeoutMs": 120000
      }
    ]
  ]
}
```

Supported values:

- `auto`: use CodeWhisperer fetch transport when an API key is available; otherwise use CLI chat fallback.
- `fetch`: require the direct Kiro/CodeWhisperer fetch path. If no usable auth is available, requests fail with a structured backend/auth error.
- `cli-chat`: call `kiro-cli chat --no-interactive`. This is official and stable, but Kiro CLI does not currently expose a guaranteed per-request model flag.
- `acp`: launch `kiro-cli acp`, initialize a session, optionally set the requested model, send the prompt, and collect `AgentMessageChunk` notifications until `TurnEnd`.

## Model Churn Handling

The resolver intentionally avoids a hard whitelist. Fallback presets are used for OpenCode UI metadata and cache bootstrap only.

Useful options:

```jsonc
{
  "plugin": [
    [
      "file:/absolute/path/to/opencode-kiro-plugin",
      {
        "modelCacheTtlSeconds": 21600,
        "modelAliases": {
          "sonnet": "claude-sonnet-4.6",
          "opus": "claude-opus-4.6"
        },
        "extraModels": {
          "claude-opus-4-9": {
            "name": "Claude Opus 4.9",
            "limit": { "context": 1000000, "output": 64000 },
            "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
            "tool_call": true
          }
        },
        "hiddenModels": {
          "claude-sonnet-4.6-1m": "claude-sonnet-4.6-1m"
        },
        "disabledModels": ["old-model"],
        "disableModelPassThrough": false
      }
    ]
  ]
}
```

Resolution order:

1. Alias mapping
2. Name normalization, for example `claude-sonnet-4-6` to `claude-sonnet-4.6`
3. Disabled model check
4. Dynamic cache hit
5. Extra model preset cache hit
6. Hidden/manual model mapping
7. Optimistic pass-through unless disabled

This keeps new Kiro model ids usable before the package is updated. Use `extraModels` when a new model should appear in OpenCode's model picker immediately. Set `disableModelPassThrough: true` only when you need strict model governance.

## Troubleshooting

- `UNSUPPORTED_BACKEND`: selected mode has no usable transport. Check `backend` and auth.
- `KIRO_AUTH_ERROR`: login or API key is missing/invalid.
- `KIRO_RATE_LIMIT`: upstream quota or rate limit was hit.
- `KIRO_NETWORK_ERROR`: timeout or connectivity issue to Kiro/AWS endpoints.
- `KIRO_ACP_TIMEOUT`: ACP did not send a `TurnEnd` notification before the prompt timeout.
- `KIRO_ACP_PROCESS_ERROR` or `KIRO_ACP_PROCESS_EXITED`: `kiro-cli acp` could not start or exited while a request was pending.

Direct fetch mode uses AWS SDK standard retry behavior. Tune `maxAttempts` and `requestTimeoutMs` if you need stricter failure boundaries in automation.

For local checks:

```sh
npm test
npm run typecheck
npm run build
```

## License And References

This project is MIT licensed. See [LICENSE](LICENSE).

Reference policy:

- `tickernelz/opencode-kiro-auth` is MIT licensed and used as implementation reference material.
- Kiro CLI/IDE licensing and AWS service terms are separate from this plugin license. Use the plugin only in compliance with the applicable Kiro/AWS terms.

Research notes are kept in [docs](docs).
