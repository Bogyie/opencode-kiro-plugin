# opencode-kiro-plugin

OpenCode server plugin that registers Kiro as an OpenAI-compatible provider and adapts requests to Kiro backends.

Status: early implementation. The CodeWhisperer streaming transport, CLI chat fallback, model resolver, multimodal request mapping, streaming text, and tool-call chunk mapping are implemented with unit tests. The ACP backend currently exposes a JSON-RPC client and a selectable skeleton transport, but the full Kiro ACP session flow is not complete yet.

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
        "region": "us-east-1"
      }
    ]
  ]
}
```

Supported values:

- `auto`: use CodeWhisperer fetch transport when an API key is available; otherwise use CLI chat fallback.
- `fetch`: require the direct Kiro/CodeWhisperer fetch path. If no usable auth is available, requests fail with a structured backend/auth error.
- `cli-chat`: call `kiro-cli chat --no-interactive`. This is official and stable, but Kiro CLI does not currently expose a guaranteed per-request model flag.
- `acp`: select the ACP skeleton. JSON-RPC framing is implemented, but full Kiro ACP session transport currently returns `KIRO_ACP_NOT_IMPLEMENTED`.

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
5. Hidden/manual model mapping
6. Optimistic pass-through unless disabled

This keeps new Kiro model ids usable before the package is updated. Set `disableModelPassThrough: true` only when you need strict model governance.

## Troubleshooting

- `UNSUPPORTED_BACKEND`: selected mode has no usable transport. Check `backend` and auth.
- `KIRO_AUTH_ERROR`: login or API key is missing/invalid.
- `KIRO_RATE_LIMIT`: upstream quota or rate limit was hit.
- `KIRO_NETWORK_ERROR`: timeout or connectivity issue to Kiro/AWS endpoints.
- `KIRO_ACP_NOT_IMPLEMENTED`: ACP mode is selected, but the full session transport has not been implemented yet.

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
