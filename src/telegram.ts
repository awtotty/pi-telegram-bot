import { loadEnvFile, readConfig, writeConfig } from './config.js';
import { PiSessionRegistry } from './pi-session.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Log = { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void };

type TelegramUpdate = {
  update_id: number;
  message?: any;
  edited_message?: any;
};

type PollStats = {
  startedAt: number;
  polls: number;
  emptyPolls: number;
  updates: number;
  messages: number;
  replies: number;
  errors: number;
  lastHeartbeatAt: number;
};

export async function testTelegramToken(botToken: string): Promise<{ id: string; username?: string; firstName?: string }> {
  const data = await telegramApi(botToken, 'getMe', {});
  return { id: String(data.result.id), username: data.result.username, firstName: data.result.first_name };
}

export async function discoverTelegramSenders(botToken: string, timeoutMs = 60_000): Promise<{ senders: Array<{ id: string; name: string; chatId: string }>; offset?: number }> {
  const seen = new Map<string, { id: string; name: string; chatId: string }>();
  const deadline = Date.now() + timeoutMs;
  let offset = 0;
  while (Date.now() < deadline && seen.size === 0) {
    const updates = await telegramApi(botToken, 'getUpdates', { timeout: Math.min(10, Math.ceil((deadline - Date.now()) / 1000)), offset });
    for (const update of updates.result ?? []) {
      offset = Math.max(offset, Number(update.update_id) + 1);
      const message = update.message ?? update.edited_message;
      const user = message?.from;
      const chatId = message?.chat?.id;
      if (!user?.id || !chatId) continue;
      const id = String(user.id);
      const name = [user.first_name, user.last_name, user.username ? `@${user.username}` : undefined].filter(Boolean).join(' ');
      seen.set(id, { id, name, chatId: String(chatId) });
    }
  }
  return { senders: [...seen.values()], offset: offset || undefined };
}

export async function runTelegramBot(log: Log = console): Promise<void> {
  await loadEnvFile();
  const sessions = new PiSessionRegistry();
  const startupConfig = await readConfig();
  const stats: PollStats = { startedAt: Date.now(), polls: 0, emptyPolls: 0, updates: 0, messages: 0, replies: 0, errors: 0, lastHeartbeatAt: 0 };
  log.info('pi-telegram-bot starting');
  log.info(`config: workspace=${startupConfig.workspaceDir}`);
  log.info(`config: piAgentDir=${startupConfig.piAgentDir}`);
  log.info(`config: sessionDir=${startupConfig.sessionDir}`);
  log.info(`config: allowedUsers=${startupConfig.telegram.allowedUsers.length}`);
  log.info(`config: tokenSource=${process.env.TELEGRAM_BOT_TOKEN ? 'environment' : startupConfig.telegram.botToken ? 'config' : 'missing'}`);
  log.info(`config: initialOffset=${startupConfig.telegram.offset ?? 0}`);
  process.once('SIGINT', () => {
    log.info('Shutting down...');
    sessions.clear();
    process.exit(0);
  });
  process.once('SIGTERM', () => {
    log.info('Shutting down...');
    sessions.clear();
    process.exit(0);
  });

  for (;;) {
    try {
      const config = await readConfig();
      const token = process.env.TELEGRAM_BOT_TOKEN ?? config.telegram.botToken;
      if (!token) {
        log.info('No Telegram token configured. Run `pi-telegram-bot setup` or set TELEGRAM_BOT_TOKEN in ~/.config/pi-telegram-bot/.env.');
        await sleep(5000);
        continue;
      }
      const offset = config.telegram.offset ?? 0;
      stats.polls += 1;
      log.info(`telegram poll start poll=${stats.polls} offset=${offset} timeout=25s`);
      const pollStartedAt = Date.now();
      const updates = await telegramApi(token, 'getUpdates', { timeout: 25, offset });
      const pollMs = Date.now() - pollStartedAt;
      const updateCount = (updates.result ?? []).length;
      stats.updates += updateCount;
      if (updateCount > 0) {
        const first = updates.result[0]?.update_id;
        const last = updates.result[updates.result.length - 1]?.update_id;
        log.info(`telegram poll result poll=${stats.polls} updates=${updateCount} firstUpdate=${first} lastUpdate=${last} durationMs=${pollMs}`);
      } else {
        stats.emptyPolls += 1;
        logHeartbeat(log, stats, offset, pollMs);
      }
      for (const update of updates.result ?? []) {
        try {
          const handled = await handleUpdate(update, token, sessions, log);
          if (handled === 'message') stats.messages += 1;
          if (handled === 'reply') {
            stats.messages += 1;
            stats.replies += 1;
          }
        } catch (error) {
          stats.errors += 1;
          log.error('Telegram update failed:', error);
          await notifyTelegramError(token, update, error).catch((notifyError) => log.error('Telegram notify failed:', notifyError));
        }
      }
      if ((updates.result ?? []).length > 0) {
        const latest = Math.max(...updates.result.map((update: TelegramUpdate) => Number(update.update_id) + 1));
        const fresh = await readConfig();
        fresh.telegram.offset = latest;
        await writeConfig(fresh);
        log.info(`saved Telegram offset=${latest}`);
      }
    } catch (error) {
      stats.errors += 1;
      log.error('Telegram polling failed:', error);
      await sleep(5000);
    }
  }
}

async function handleUpdate(update: TelegramUpdate, botToken: string, sessions: PiSessionRegistry, log: Log): Promise<'ignored' | 'message' | 'reply'> {
  const message = update.message ?? update.edited_message;
  const text = message?.text?.trim();
  const chatId = message?.chat?.id;
  const user = message?.from;
  if (!message) {
    log.info(`ignored Telegram update=${update.update_id} reason=no_message`);
    return 'ignored';
  }
  if (!text) {
    const messageKeys = Object.keys(message).filter((key) => key !== 'from' && key !== 'chat').join(',') || 'unknown';
    log.info(`ignored Telegram update=${update.update_id} reason=no_text messageType=${messageKeys}`);
    return 'ignored';
  }
  if (!chatId || !user?.id) {
    log.info(`ignored Telegram update=${update.update_id} reason=missing_chat_or_user`);
    return 'ignored';
  }

  await rememberSender(user, log);
  const userId = String(user.id);
  log.info(`handling Telegram message update=${update.update_id} user=${userId} chat=${chatId} textLength=${text.length}`);
  const config = await readConfig();
  const allowed = config.telegram.allowedUsers;
  if (allowed.length === 0) {
    log.info(`recorded Telegram user=${userId}; no allowlist entries yet; sent approval instructions`);
    await sendTelegramMessage(botToken, chatId, `I saw your message. Ask the host owner to allow your Telegram user id:\n${userId}`, log);
    return 'message';
  }
  if (!allowed.includes(userId)) {
    log.info(`ignored Telegram user=${userId} reason=not_allowlisted allowlistSize=${allowed.length}`);
    return 'ignored';
  }

  const command = await handleCommand(text, chatId, userId, botToken, log);
  if (command) return 'reply';

  const sessionId = await getOrCreateChatSession(String(chatId), log);
  log.info(`dispatching chat=${chatId} to pi session=${sessionId}`);
  const chunks: string[] = [];
  let assistantDeltaCount = 0;
  let toolEventCount = 0;
  await sessions.prompt(sessionId, text, (event) => {
    if (event.type === 'assistant_delta') {
      assistantDeltaCount += 1;
      chunks.push(event.text);
    }
    if (event.type === 'tool_event') toolEventCount += 1;
    if (event.type === 'error') chunks.push(`\nError: ${event.message}`);
  });
  const reply = chunks.join('').trim() || 'Done.';
  log.info(`pi session=${sessionId} completed; replyLength=${reply.length} assistantDeltas=${assistantDeltaCount} toolEvents=${toolEventCount}`);
  await sendTelegramMessage(botToken, chatId, reply, log);
  log.info(`sent Telegram reply chat=${chatId}`);
  return 'reply';
}

async function handleCommand(text: string, chatId: number | string, userId: string, botToken: string, log: Log): Promise<boolean> {
  const [command, ...args] = text.split(/\s+/);
  switch (command?.toLowerCase()) {
    case '/help':
      log.info(`handling command /help chat=${chatId}`);
      await sendTelegramMessage(botToken, chatId, 'Commands:\n/help — show this help\n/whoami — show your Telegram user id\n/new [name] — start a fresh Pi session for this chat\n/status — show configured paths', log);
      return true;
    case '/whoami':
      log.info(`handling command /whoami chat=${chatId}`);
      await sendTelegramMessage(botToken, chatId, `Telegram user id: ${userId}\nChat id: ${chatId}`, log);
      return true;
    case '/new': {
      const config = await readConfig();
      const sessionId = crypto.randomUUID();
      config.chatSessions[String(chatId)] = sessionId;
      await writeConfig(config);
      const name = args.join(' ').trim();
      log.info(`handling command /new chat=${chatId} session=${sessionId}`);
      await sendTelegramMessage(botToken, chatId, `Started new Pi session${name ? ` (${name})` : ''}:\n${sessionId}`, log);
      return true;
    }
    case '/status': {
      const config = await readConfig();
      log.info(`handling command /status chat=${chatId}`);
      await sendTelegramMessage(botToken, chatId, `pi-telegram-bot status\nworkspace: ${config.workspaceDir}\npiAgentDir: ${config.piAgentDir}\nsessionDir: ${config.sessionDir}\nallowedUsers: ${config.telegram.allowedUsers.length}`, log);
      return true;
    }
    default:
      return false;
  }
}

async function getOrCreateChatSession(chatId: string, log: Log): Promise<string> {
  const config = await readConfig();
  const existing = config.chatSessions[chatId];
  if (existing) {
    log.info(`found existing pi session=${existing} for chat=${chatId}`);
    return existing;
  }
  const sessionId = crypto.randomUUID();
  config.chatSessions[chatId] = sessionId;
  await writeConfig(config);
  log.info(`created new pi session=${sessionId} for chat=${chatId}`);
  return sessionId;
}

async function rememberSender(user: any, log: Log): Promise<void> {
  const config = await readConfig();
  const name = [user.first_name, user.last_name, user.username ? `@${user.username}` : undefined].filter(Boolean).join(' ');
  const id = String(user.id);
  config.telegram.recentSenders = [{ id, name, lastSeenAt: new Date().toISOString() }, ...config.telegram.recentSenders.filter((sender) => sender.id !== id)].slice(0, 10);
  await writeConfig(config);
  log.info(`remembered Telegram sender id=${id} name=${name || '(unknown)'}`);
}

async function notifyTelegramError(botToken: string, update: TelegramUpdate, error: unknown): Promise<void> {
  const chatId = update.message?.chat?.id ?? update.edited_message?.chat?.id;
  if (!chatId) return;
  console.error('Notifying Telegram user about internal error:', error);
  await sendTelegramMessage(botToken, chatId, 'pi-telegram-bot error: something failed. Check logs with `pi-telegram-bot logs`.');
}

export async function sendTelegramMessage(botToken: string, chatId: number | string, text: string, log: Log = console): Promise<void> {
  const chunks = chunkText(text, 3900);
  log.info(`sending Telegram message chat=${chatId} chunks=${chunks.length} totalLength=${text.length}`);
  for (let i = 0; i < chunks.length; i += 1) {
    await telegramApi(botToken, 'sendMessage', { chat_id: chatId, text: chunks[i] });
    log.info(`sent Telegram message chunk chat=${chatId} chunk=${i + 1}/${chunks.length} length=${chunks[i].length}`);
  }
}

async function telegramApi(botToken: string, method: string, body: Record<string, unknown>): Promise<any> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.description ?? `Telegram ${method} failed`);
  return data;
}

function logHeartbeat(log: Log, stats: PollStats, offset: number, pollMs: number): void {
  const now = Date.now();
  if (now - stats.lastHeartbeatAt < 60_000) return;
  stats.lastHeartbeatAt = now;
  const uptimeSec = Math.round((now - stats.startedAt) / 1000);
  log.info(`telegram heartbeat uptimeSec=${uptimeSec} polls=${stats.polls} emptyPolls=${stats.emptyPolls} updates=${stats.updates} messages=${stats.messages} replies=${stats.replies} errors=${stats.errors} offset=${offset} lastPollMs=${pollMs}`);
}

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks.length ? chunks : ['Done.'];
}
