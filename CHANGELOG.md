# Changelog

## 0.1.0 - Unreleased

Initial OpenCode Kiro provider plugin implementation.

### Added

- OpenCode server plugin entrypoint with `config`, `auth`, `provider`, and `tool` hooks.
- Kiro provider config injection using `@ai-sdk/openai-compatible`.
- Model resolver with normalization, aliases, hidden/manual models, disabled models, pass-through behavior, and configurable extra model presets.
- Optional `modelDiscoveryCommand` support for refreshing model cache/provider metadata from user-configured CLI/API output.
- Auth diagnostics for `KIRO_API_KEY`, OpenCode auth input, and `kiro-cli whoami`.
- `kiro_status` diagnostic tool.
- OpenAI-compatible request adapter for system prompts, chat history, multimodal data URL images/documents, tool specs, and tool results.
- OpenAI-compatible generation options for temperature, token limit, and reasoning/thinking effort are preserved as best-effort model request fields in direct fetch mode.
- CodeWhisperer metadata token usage is mapped to OpenAI-compatible non-streaming usage fields on a best-effort basis.
- CodeWhisperer/Kiro transport with streaming text, tool-call deltas, configurable retry attempts, and request timeout.
- CLI fallback using `kiro-cli chat --no-interactive`.
- CLI fallback responses are wrapped as OpenAI-compatible SSE for streaming OpenCode calls and sanitized to remove terminal prompt/credits output.
- CLI fallback child process timeout can be controlled with `requestTimeoutMs`.
- Direct fetch backend now exposes `endpoint`, `profileArn`, `userAgent`, and `agentMode` plugin options.
- ACP fallback using `kiro-cli acp` JSON-RPC stdio with initialize/session/model/prompt flow.
- ACP streaming for `AgentMessageChunk`, basic `ToolCall` events, and embedded document resources.
- ACP tool-call update handling now ignores progress/result-only updates that do not carry invocation payloads and deduplicates repeated tool calls by id in non-streaming responses.
- ACP agent-origin request handling for permission requests, with default reject and `trustAllTools` allow mode.
- ACP stdio client ignores non-JSON stdout log lines emitted by `kiro-cli acp --verbose` before JSON-RPC messages.
- Clean build artifacts before packaging and add a built package import smoke check.
- Structured error normalization for auth, quota/rate limit, upstream, network, unsupported backend, ACP, and timeout failures.
- README, local OpenCode config example, implementation notes, license notes, and package metadata tests.

### Notes

- ACP tool progress/result parity and real Kiro CLI end-to-end validation are still in progress.
