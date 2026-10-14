# Pi integration and extension review

Reviewed 2026-10-14 against the npm `latest` release, Pi **1.2.0**.

## Project integration

The bot uses the SDK, not a `pi` subprocess. Updating a global Pi installation does not update the bot's SDK dependency. This upgrade moves `@earendil-works/pi-coding-agent` from 0.80.7 to ^1.2.0 and updates the lockfile. Node.js **22.19.0 or newer** is required.

Changes:

- Replace removed `AuthStorage` / `ModelRegistry` SDK construction with async `ModelRuntime.create()` and `getAvailable()`.
- Select configured models from the authenticated available list, rather than accepting a model merely because it exists in the catalog.
- Supply built-in MCP, codemode, and tool-search extensions through `DefaultResourceLoader`. Like the CLI, they are replaceable and respect `-builtin:<name>` settings. MCP activates discovery tools as needed; they are not forced on for every session.
- Call `session.bindExtensions({ mode: 'print', ... })` so `session_start` hooks actually run. Log extension load errors, warnings, and runtime handler errors to the service logs.
- Evict failed initialization promises so a configuration correction can take effect without restarting the bot.

The automated SDK tests use temporary configuration, a local test model, and no provider requests. They cover headless startup, model selection/persistence, extension command dispatch, failed initialization recovery, extension-load/startup error logging, and disabling built-in extensions. They do **not** exercise the installed personal extensions, live MCP connections, or a real Telegram/model round trip.

## Where extensions come from

There are no checked-in extension files or `.pi/settings.json` in this repository. The bot discovers personal packages/extensions from `piAgentDir` and trusted project resources from `workspaceDir`. These are configurable and need not point to this repository.

The inspected local bot configuration uses `/home/agent/.pi/agent` and workspace `/home/agent`. Consequently it inherits this machine's personal extension stack, not a project-owned, reproducibly pinned stack. No personal settings or extension files were changed by this review.

## Installed package inventory

All seven installed npm packages matched their published npm `latest` version at review time. Being current does not prove headless or multi-session compatibility.

| Package | Installed/latest | Bot assessment |
| --- | --- | --- |
| `pi-web-access` | 0.40.0 | Useful for search/fetch. Network credentials and external providers still need configuration. Curator/terminal interactions are not exposed in Telegram. |
| `pi-subagents` | 0.78.0 | Useful if explicitly wanted. Contains headless result-draining logic, but actual child execution and concurrent-chat isolation need live testing. Child processes need the intended `pi` executable on the service PATH. |
| `pi-mcp-adapter` | 5.3.0 | Configured with `extensions: ["-index.ts"]`, so its extension entry point is disabled. Keep it disabled when using built-in MCP. Enabling its `/mcp` registration replaces built-in MCP rather than augmenting it. |
| `@aliou/pi-processes` | 0.13.2 | Background-process tools can be useful; dock/log overlays are terminal UI and not available in Telegram. Review cleanup and async delivery across chat/session lifetimes before relying on long-lived jobs. |
| `pi-powerline-footer` | 0.20.1 | Primarily terminal presentation; unnecessary for the bot. Has UI guards, but loading it still adds code and hooks. Prefer excluding it from a bot-specific agent profile. Its prompt handler already guards Pi 1.2 custom-message runs. |
| `@capyup/pi-goal` | 0.6.0 | **Headless confirmation differs from TUI:** `shouldAutoConfirmProposal()` returns true whenever `hasUI` is false. Telegram does not receive the TUI confirmation dialog. Do not assume goals require user confirmation; disable this extension in the bot profile unless this behavior is explicitly desired or a Telegram approval bridge is implemented. |
| `context-mode` | 1.0.169 | Useful for bounded outputs, but its Pi adapter and MCP service are separate parts. Verify the configured MCP server and storage isolation per workspace/session. CLI/TUI hooks are not automatically a Telegram UI. |

The inspected package manifests do not list Pi host packages as runtime dependencies. Several extensions still use `ctx.modelRegistry`; Pi 1.2 explicitly retains that synchronous extension compatibility facade. That is different from the removed SDK factory options migrated in this project.

## Additional local extensions and declarations

### FML: concrete Pi 1.2 compatibility issue

`/home/agent/.pi/agent/extensions/fml.js:3097-3105` handles `before_agent_start` by calling `event.prompt.slice(...)`. Pi 1.2 also emits this event for custom-message-triggered runs, which do not have `prompt`. After the handler's first-prompt early return, a custom run can therefore throw.

Fix in the owning FML source/generator: check `event.messageType === 'custom'` and return before counting or reading a user prompt. Reinstall/regenerate the managed extension afterward. The bot now logs such handler errors, but logging is not a compatibility fix. This shared extension was not patched here.

### Herdr

`/home/agent/.pi/agent/extensions/herdr-agent-state.ts` is managed by Herdr and gated by its environment variables. Its `session_start` handler also requires `ctx.hasUI`, so a print-mode bot session does not report itself as a terminal pane. Leave managed files alone; this integration is not useful for Telegram UI.

### Stale local package

Personal settings declare `../../../../workspace/pi-missions`, which resolves to `/workspace/pi-missions`. That directory is absent. Remove or correct the declaration in the personal configuration if it is no longer intentional. The bot will now log extension-load diagnostics, making missing/failed extensions easier to spot.

## Recommended bot profile

Use a dedicated `piAgentDir` rather than silently sharing every interactive extension:

1. Configure the bot with its own agent directory and only the credentials/models it needs. Treat that directory as sensitive.
2. Keep only desired tool extensions (for example web access, processes, and optional subagents/context-mode).
3. Omit terminal-only footer/dock components and the stale local package. Keep the legacy MCP adapter disabled when using built-in MCP.
4. Exclude goal automation unless headless auto-confirmation is acceptable. Add an explicit Telegram approval flow before claiming confirmation parity with TUI.
5. Pin chosen package versions in that profile and test two simultaneous chats plus service shutdown/restart before deployment.

Pi runs with the service user's OS permissions; the workspace is not a sandbox. Keep the Telegram allowlist narrow. Project trust still applies to protected project resources; the bot does not auto-approve them.

**Transport limitation:** the bot currently forwards assistant text and tool events only while a prompt has an active sink. Extension notifications, custom UI dialogs, and unsolicited idle/background output do not have a general Telegram bridge. A successful extension load alone does not mean every feature works through Telegram.

## References

- [Pi 1.2.0 changelog](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/CHANGELOG.md)
- [SDK](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/sdk.md)
- [SDK MCP example](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/examples/sdk/14-codemode-mcp.ts)
- [Extension contracts](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/extensions.md)
- [MCP replacement and SDK behavior](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/mcp.md)
