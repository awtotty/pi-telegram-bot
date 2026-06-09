# pi-telegram-bot

Host-native Telegram bridge for the Pi coding agent. This is the small extraction of Harbor's Telegram chat path without Docker, web UI, terminals, updater, or SQLite.

## Status

Early MVP. It uses Telegram long polling and the Pi SDK directly on the host.

## Setup

```bash
npm install -g .
pi-telegram-bot setup
```

The setup wizard will:

1. test your Telegram bot token,
2. configure workspace and Pi agent paths,
3. optionally set a specific model, and
4. wait for a Telegram message so it can allowlist your account, and
5. optionally write a systemd user service.

If you skipped allowlisting in the wizard, use `senders` and `allow` later.

If you do not want to store the token in config, set `TELEGRAM_BOT_TOKEN` in the service environment before starting the service.

## Commands

CLI:

```bash
pi-telegram-bot setup
pi-telegram-bot senders
pi-telegram-bot allow <telegram-user-id>
pi-telegram-bot install-service
pi-telegram-bot start-service
pi-telegram-bot stop-service
pi-telegram-bot restart-service
pi-telegram-bot status-service
pi-telegram-bot logs
pi-telegram-bot uninstall-service
pi-telegram-bot config
```

Telegram:

- `/help` — show bot commands
- `/whoami` — show Telegram user id and chat id
- `/new [name]` — start a fresh Pi session for this chat
- `/status` — show configured paths

## systemd

The setup wizard can write a user service, or you can do it later:

```bash
pi-telegram-bot install-service
```

This writes the unit, runs `systemctl --user daemon-reload`, runs `systemctl --user enable --now pi-telegram-bot`, and prints recent logs.

Service commands:

```bash
pi-telegram-bot start-service
pi-telegram-bot stop-service
pi-telegram-bot restart-service
pi-telegram-bot status-service
pi-telegram-bot logs
```

Remove the service with:

```bash
pi-telegram-bot uninstall-service
```

## Files

Defaults:

- Config: `~/.config/pi-telegram-bot/config.json`
- Optional env file: `~/.config/pi-telegram-bot/.env`
- Default agent working directory: `~`
- Pi sessions: `~/.local/share/pi-telegram-bot/sessions`
- Pi agent auth/models: `~/.pi/agent`

## Reused ideas from Harbor

- Telegram long polling and update offset tracking
- allowlisted Telegram users
- recent sender discovery
- one Pi session per Telegram chat
- Telegram message chunking
- Pi SDK `createAgentSession` / `SessionManager` integration
