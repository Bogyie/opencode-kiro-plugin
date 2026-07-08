# opencode-kiro-plugin

OpenCode server plugin that registers Kiro as an OpenAI-compatible provider and adapts requests to Kiro backends.

Status: early implementation. The direct Kiro REST/EventStream transport, CLI chat fallback, model resolver, multimodal request mapping, streaming text, and tool-call chunk mapping are implemented with unit tests. The ACP backend implements JSON-RPC stdio framing, initialize/session/model/prompt flow, streaming text from `AgentMessageChunk`, and basic `ToolCall` streaming; full ACP tool progress/result parity is still in progress.

## Install

After the package is published to npm, add it directly to your OpenCode config:

```jsonc
{
  "plugin": ["@bogyie/opencode-kiro-plugin"]
}
```

For local development from this repository:

```sh
npm install
npm run build
```

Then add the plugin to your OpenCode config. See [examples/opencode.jsonc](examples/opencode.jsonc).

```jsonc
{
  "plugin": ["file:/absolute/path/to/opencode-kiro-plugin"]
}
```

## Auth

The plugin resolves credentials in this order:

1. `KIRO_API_KEY`
2. OpenCode auth input for provider `kiro`, including stored Kiro device-flow credentials
3. Local Kiro CLI session token from the Kiro CLI SQLite store
4. `kiro-cli whoami` diagnostics for CLI session visibility

During OpenCode startup, the plugin checks Kiro auth in the blocking `config` hook. If no `KIRO_API_KEY` or active `kiro-cli` session exists, it starts the configured login flow once and waits for completion before provider registration continues. Personal login methods use `kiro-cli login --use-device-flow`. IAM Identity Center login uses direct OIDC device authorization for the configured Start URL and region, so it opens the Identity Center device URL and avoids localhost callback failures. After auth succeeds, startup runs best-effort model discovery with `kiro-cli chat --list-models --format json` when the Kiro CLI session is available. If startup discovery fails, the plugin keeps the last stored model list. If no stored list exists yet, it injects an `auto` placeholder model so Kiro still appears in OpenCode's provider connector.

You can open OpenCode's provider connector, choose Kiro, and select `Kiro device login`. Personal login methods use `kiro-cli login --use-device-flow`, wait for the local Kiro CLI session to become authenticated, then store a local transport marker in OpenCode auth. IAM Identity Center login uses the OIDC device authorization flow directly, waits for token completion, and stores a `kiro-device:` credential in OpenCode auth. Configure `login.method` as `builder-id`, `google`, `github`, or `organization` to preselect the login method. The plugin maps `builder-id`, `google`, and `github` to `--license free`; it maps `organization` to the IAM Identity Center device flow. If no OpenCode connector credential or API key is configured, direct fetch still reads the active Kiro CLI session token and calls Kiro's REST/EventStream endpoint directly. If an API/model call using a CLI-backed local transport fails with an auth error, the selected transport starts the configured Kiro CLI login flow and retries the request once. Requests using stored `kiro-device:` credentials refresh tokens directly and do not fall back to opening Kiro CLI login pages. `cli-chat` mode uses the official `kiro-cli chat --no-interactive` surface and depends on the local Kiro CLI login state. `acp` mode uses the official `kiro-cli acp` surface, but is still treated as an explicit backend while its real-world protocol behavior is validated across Kiro CLI versions.

For personal Kiro login with GitHub:

```jsonc
{
  "plugin": [
    [
      "@bogyie/opencode-kiro-plugin",
      {
        "login": {
          "method": "github"
        }
      }
    ]
  ]
}
```

For AWS IAM Identity Center login, configure the default device-flow Start URL separately from the API region:

```jsonc
{
  "plugin": [
    [
      "@bogyie/opencode-kiro-plugin",
      {
        "region": "ap-northeast-2",
        "login": {
          "method": "organization",
          "identityProvider": "https://example.awsapps.com/start",
          "region": "ap-northeast-2"
        }
      }
    ]
  ]
}
```

For IAM Identity Center, configure `login.method: "organization"`, `login.identityProvider`, and `login.region` in plugin options. The connector opens the Identity Center device URL for that Start URL and region, then waits until the device authorization completes.

Use the `kiro_status` plugin tool to inspect provider id, backend, region, auth method, and discovered model count. Use `kiro_refresh_models` when you explicitly want to run the configured model discovery command and update the in-memory and stored model cache. Secrets are redacted in diagnostics.

## Backend Modes

Configure the backend through plugin options:

```jsonc
{
  "plugin": [
    [
      "@bogyie/opencode-kiro-plugin",
      {
        "backend": "auto",
        "region": "us-east-1",
        // Optional Kiro device login defaults:
        // "login": {
        //   "method": "organization",
        //   "identityProvider": "https://example.awsapps.com/start",
        //   "region": "ap-northeast-2"
        // },
        "endpoint": "https://q.us-east-1.amazonaws.com",
        "maxAttempts": 3,
        "requestTimeoutMs": 120000,
        "agentMode": "vibe"
      }
    ]
  ]
}
```

Supported values:

- `auto`: use the direct Kiro REST/EventStream fetch transport. It uses `KIRO_API_KEY` or OpenCode auth when present, otherwise the active Kiro CLI session token.
- `fetch`: require the direct Kiro REST/EventStream fetch path. If no usable auth is available, requests fail with a structured backend/auth error.
- `cli-chat`: spawn `kiro-cli chat --no-interactive --model <model>` and stream stdout chunks as they arrive. Chunk granularity is controlled by Kiro CLI.
- `acp`: launch `kiro-cli acp`, initialize a session, optionally set the requested model, send the prompt, and collect `AgentMessageChunk` notifications until `TurnEnd`.

`trustAllTools` affects both `cli-chat` and ACP permission handling. In ACP mode, permission requests are rejected by default and allowed only when `trustAllTools: true`.

## Model Churn Handling

The resolver intentionally avoids a hard whitelist. At startup, after auth succeeds, the plugin reads the current Kiro CLI model list with `kiro-cli chat --list-models --format json` when `kiro-cli whoami` succeeds, then stores successful results in a local cache. Direct IAM Identity Center device auth is available immediately for chat requests, but it does not write a Kiro CLI session, so CLI-based model discovery may keep using the previous cache until the Kiro CLI is also logged in. Failed or skipped refreshes do not clear the last successful cache. If there is no successful cache yet, startup falls back to the `auto` placeholder so the provider can still be connected before discovery succeeds.

Useful options:

```jsonc
{
  "plugin": [
    [
      "@bogyie/opencode-kiro-plugin",
      {
        "modelCacheTtlSeconds": 21600,
        "modelDiscovery": "auto",
        "modelDiscoveryCommand": ["kiro-cli", "chat", "--list-models", "--format", "json"],
        "modelAliases": {
          "sonnet": "claude-sonnet-5",
          "opus": "claude-opus-4.8"
        },
        "extraModels": {
          "claude-opus-4.9": {
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
5. Explicit `extraModels` cache hit
6. Hidden/manual model mapping
7. Optimistic pass-through unless disabled

This keeps new Kiro model ids usable before the package is updated without advertising unavailable models in OpenCode's picker after discovery has succeeded. The stored model cache lives at `$OPENCODE_KIRO_MODEL_CACHE` when set, otherwise `$XDG_CACHE_HOME/opencode-kiro-plugin/models.json` or `~/.cache/opencode-kiro-plugin/models.json`. Use `extraModels` only when you explicitly want a model to appear even though it is not listed by your installed Kiro CLI. Set `disableModelPassThrough: true` only when you need strict model governance.

The plugin injects `provider.kiro` with the `auto` placeholder needed for OpenCode's provider connector. Define `provider.kiro.models` yourself only when you need explicit model-picker metadata such as a display name or context limit. Use plugin `modelAliases` for aliases that should resolve one requested model id to another.

`modelDiscoveryCommand` defaults to `["kiro-cli", "chat", "--list-models", "--format", "json"]`. Set `modelDiscovery` to `"off"` to disable startup discovery and `kiro_refresh_models`; in that mode the plugin uses any stored cache and then the `auto` fallback. `/v1/models` uses only the discovery/cache path: it never invokes the chat transport or login fallback, and returns the cached list or `auto` if discovery fails. For the default Kiro CLI discovery command, startup and forced refresh first check `kiro-cli whoami`; if the CLI is not authenticated, discovery is skipped instead of prompting for another login. OpenCode title-generation requests also suppress login fallback so startup helper traffic cannot open a second Kiro login window. A successful connector login also triggers a forced model refresh only when that refresh can run without prompting. Discovery stdout can be a JSON array, `{ "models": [...] }`, `{ "data": [...] }`, Kiro CLI list-models JSON, Kiro CLI plain list output, or one model id per line.

## Troubleshooting

- `UNSUPPORTED_BACKEND`: selected mode has no usable transport. Check `backend` and auth.
- `KIRO_AUTH_ERROR`: login or API key is missing/invalid.
- `KIRO_RATE_LIMIT`: upstream quota or rate limit was hit.
- `KIRO_NETWORK_ERROR`: timeout or connectivity issue to Kiro/AWS endpoints.
- `KIRO_ACP_TIMEOUT`: ACP did not send a `TurnEnd` notification before the prompt timeout.
- `KIRO_ACP_PROCESS_ERROR` or `KIRO_ACP_PROCESS_EXITED`: `kiro-cli acp` could not start or exited while a request was pending.

Direct fetch mode calls Kiro's `generateAssistantResponse` endpoint and can fall back from the `q` endpoint to the CodeWhisperer endpoint on quota or upstream failures. Tune `maxAttempts` and `requestTimeoutMs` if you need stricter failure boundaries in automation. Fetch mode also accepts `endpoint`, `profileArn`, `userAgent`, and `agentMode` for controlled environments. `cli-chat` uses `requestTimeoutMs` for the `kiro-cli chat --no-interactive` child process, and ACP uses it while waiting for `session/prompt` completion and `TurnEnd`.

OpenAI-compatible `temperature`, `max_tokens`, and `max_completion_tokens` are preserved for direct fetch mode through Kiro's `inferenceConfig` fields on a best-effort basis.

When Kiro emits token metadata in direct fetch mode, non-streaming responses map it to OpenAI-compatible `usage` fields.
When Kiro emits reasoning text, it is preserved separately from assistant text as `reasoning_content`.

For local checks:

```sh
npm test
npm run typecheck
npm run build
```

For a real Kiro smoke test that uses your local `kiro-cli` login, runs runtime model discovery, verifies the plugin does not advertise models absent from the real CLI list, and checks both non-streaming and streaming assistant responses:

```sh
npm run smoke:kiro
```

For the same real checks under the test runner, including actual `kiro-cli chat --list-models --format json` and real local plugin API calls:

```sh
npm run test:real
```

To also run the real IAM Identity Center device login flow and wait for completion, set the explicit opt-in variables:

```sh
OPENCODE_KIRO_REAL_LOGIN=1 \
KIRO_REAL_IDENTITY_PROVIDER=https://example.awsapps.com/start \
KIRO_REAL_IDENTITY_REGION=ap-northeast-2 \
npm run test:real
```

For real Kiro/OpenCode validation, use [docs/e2e-validation.md](docs/e2e-validation.md).

## Release

The npm package is published through npm Trusted Publishing with the GitHub Actions environment named `npm`. No `NPM_TOKEN` repository secret is required.

Configure the npm package trusted publisher to use:

- repository owner: `bogyie`
- repository name: `opencode-kiro-plugin`
- workflow filename: `npm-publish.yml`
- environment name: `npm`

To publish a new version, update `package.json` and `package-lock.json` to the release version and merge the change to `main`. `package.json.version` is the source of truth: when it changes on `main`, the `Publish npm package` workflow publishes that package version to npm and creates the matching GitHub Release tag, for example `v0.1.0`.

The workflow runs tests, typecheck, package smoke validation, `npm pack --dry-run`, and then `npm publish --access public`.

## License And References

This project is MIT licensed. See [LICENSE](LICENSE).

Reference policy:

- `tickernelz/opencode-kiro-auth` is MIT licensed and used as implementation reference material.
- Kiro CLI/IDE licensing and AWS service terms are separate from this plugin license. Use the plugin only in compliance with the applicable Kiro/AWS terms.

Research notes are kept in [docs](docs).
