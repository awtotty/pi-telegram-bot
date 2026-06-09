# pi-telegram-bot

Host-native Telegram bridge for the Pi coding agent. It runs as a small user service on your machine, receives Telegram messages, sends them to a local Pi agent session, and replies in Telegram.

## Setup

From this repository:

```bash
npm install -g .
pi-telegram-bot setup
```

The setup wizard will:

1. test your Telegram bot token,
2. configure the directory where the agent should run,
3. configure the Pi agent directory,
4. optionally select a specific model,
5. wait for a Telegram message so it can allowlist your account, and
6. optionally install and start a systemd user service.

If you skip allowlisting during setup, run:

```bash
pi-telegram-bot senders
pi-telegram-bot allow <telegram-user-id>
```

If you do not want to store the token in config, set `TELEGRAM_BOT_TOKEN` in the service environment before starting the service.

## Commands

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

Telegram commands:

- `/help` — show bot commands
- `/whoami` — show your Telegram user id and chat id
- `/new [name]` — start a fresh Pi session for this chat
- `/status` — show configured paths

## Service management

The setup wizard can install the systemd user service. You can also install it manually:

```bash
pi-telegram-bot install-service
```

This writes the unit, runs `systemctl --user daemon-reload`, enables and starts `pi-telegram-bot.service`, and prints recent logs.

Useful service commands:

```bash
pi-telegram-bot status-service
pi-telegram-bot logs
pi-telegram-bot restart-service
pi-telegram-bot stop-service
pi-telegram-bot start-service
```

Remove the service:

```bash
pi-telegram-bot uninstall-service
```

Full uninstall:

```bash
pi-telegram-bot uninstall-service
npm uninstall -g pi-telegram-bot
```

Optional data cleanup:

```bash
rm -rf ~/.config/pi-telegram-bot ~/.local/share/pi-telegram-bot
```

## Files

Defaults:

- Config: `~/.config/pi-telegram-bot/config.json`
- Optional env file: `~/.config/pi-telegram-bot/.env`
- Default agent working directory: `~`
- Pi sessions: `~/.local/share/pi-telegram-bot/sessions`
- Pi agent auth/models: `~/.pi/agent`

## How it works

- Telegram long polling receives updates from your bot.
- Only allowlisted Telegram users can send prompts to the agent.
- Each Telegram chat maps to a persistent Pi session.
- Replies are chunked to fit Telegram message limits.
- The service logs polling, message handling, session dispatch, replies, and errors to journald.
