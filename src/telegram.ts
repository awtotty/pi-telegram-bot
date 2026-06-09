import { readConfig, writeConfig } from './config.js';
import { PiSessionRegistry } from './pi-session.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Log = { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void };

type TelegramUpdate = {
  update_id: number;
  message?: any;
  edited_message?: any;
};

export async function testTelegramToken(botToken: string): Promise<{ id: string; username?: string; firstName?: string }> {
  const data = await telegramApi(botToken, 'getMe', {});
  return { id: String(data.result.id), username: data.result.username, firstName: data.result.first_name };
}

export async function discoverTelegramSenders(botToken: string, timeoutMs = 60_000): Promise<Array<{ id: string; name: string; chatId: string }>> {
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
  return [...seen.values()];
}

export async function runTelegramBot(log: Log = console): Promise<void> {
  const sessions = new PiSessionRegistry();
  const startupConfig = await readConfig();
  log.info('pi-telegram-bot starting');
  log.info(`config: workspace=${startupConfig.workspaceDir}`);
  log.info(`config: piAgentDir=${startupConfig.piAgentDir}`);
  log.info(`config: sessionDir=${startupConfig.sessionDir}`);
  log.info(`config: allowedUsers=${startupConfig.telegram.allowedUsers.length}`);
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
        log.info(`No Telegram token configured. Run: pi-telegram-bot init --token <token>`);
        await sleep(5000);
        continue;
      }
      const offset = config.telegram.offset ?? 0;
      log.info(`polling Telegram getUpdates offset=${offset}`);
      const updates = await telegramApi(token, 'getUpdates', { timeout: 25, offset });
      const updateCount = (updates.result ?? []).length;
      if (updateCount > 0) log.info(`received ${updateCount} Telegram update(s)`);
      for (const update of updates.result ?? []) {
        try {
          await handleUpdate(update, token, sessions, log);
        } catch (error) {
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
      log.error('Telegram polling failed:', error);
      await sleep(5000);
    }
  }
}

async function handleUpdate(update: TelegramUpdate, botToken: string, sessions: PiSessionRegistry, log: Log): Promise<void> {
  const message = update.message ?? update.edited_message;
  const text = message?.text?.trim();
  const chatId = message?.chat?.id;
  const user = message?.from;
  if (!text || !chatId || !user?.id) return;

  await rememberSender(user);
  const userId = String(user.id);
  log.info(`handling Telegram message update=${update.update_id} user=${userId} chat=${chatId} textLength=${text.length}`);
  const config = await readConfig();
  const allowed = config.telegram.allowedUsers;
  if (allowed.length === 0) {
    log.info(`Recorded Telegram user ${userId}; waiting for allowlist approval.`);
    await sendTelegramMessage(botToken, chatId, `I saw your message. Ask the host owner to allow your Telegram user id:\n${userId}`);
    return;
  }
  if (!allowed.includes(userId)) {
    log.info(`Ignored non-allowlisted Telegram user ${userId}.`);
    return;
  }

  const command = await handleCommand(text, chatId, userId, botToken, log);
  if (command) return;

  const sessionId = await getOrCreateChatSession(String(chatId), log);
  log.info(`dispatching chat=${chatId} to pi session=${sessionId}`);
  const chunks: string[] = [];
  await sessions.prompt(sessionId, text, (event) => {
    if (event.type === 'assistant_delta') chunks.push(event.text);
    if (event.type === 'error') chunks.push(`\nError: ${event.message}`);
  });
  const reply = chunks.join('').trim() || 'Done.';
  log.info(`pi session=${sessionId} completed; replyLength=${reply.length}`);
  await sendTelegramMessage(botToken, chatId, reply);
  log.info(`sent Telegram reply chat=${chatId}`);
}

async function handleCommand(text: string, chatId: number | string, userId: string, botToken: string, log: Log): Promise<boolean> {
  const [command, ...args] = text.split(/\s+/);
  switch (command?.toLowerCase()) {
    case '/help':
      log.info(`handling command /help chat=${chatId}`);
      await sendTelegramMessage(botToken, chatId, 'Commands:\n/help — show this help\n/whoami — show your Telegram user id\n/new [name] — start a fresh Pi session for this chat\n/status — show configured paths');
      return true;
    case '/whoami':
      log.info(`handling command /whoami chat=${chatId}`);
      await sendTelegramMessage(botToken, chatId, `Telegram user id: ${userId}\nChat id: ${chatId}`);
      return true;
    case '/new': {
      const config = await readConfig();
      const sessionId = crypto.randomUUID();
      config.chatSessions[String(chatId)] = sessionId;
      await writeConfig(config);
      const name = args.join(' ').trim();
      log.info(`handling command /new chat=${chatId} session=${sessionId}`);
      await sendTelegramMessage(botToken, chatId, `Started new Pi session${name ? ` (${name})` : ''}:\n${sessionId}`);
      return true;
    }
    case '/status': {
      const config = await readConfig();
      log.info(`handling command /status chat=${chatId}`);
      await sendTelegramMessage(botToken, chatId, `pi-telegram-bot status\nworkspace: ${config.workspaceDir}\npiAgentDir: ${config.piAgentDir}\nsessionDir: ${config.sessionDir}\nallowedUsers: ${config.telegram.allowedUsers.length}`);
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

async function rememberSender(user: any): Promise<void> {
  const config = await readConfig();
  const name = [user.first_name, user.last_name, user.username ? `@${user.username}` : undefined].filter(Boolean).join(' ');
  const id = String(user.id);
  config.telegram.recentSenders = [{ id, name, lastSeenAt: new Date().toISOString() }, ...config.telegram.recentSenders.filter((sender) => sender.id !== id)].slice(0, 10);
  await writeConfig(config);
  console.info(`remembered Telegram sender id=${id} name=${name || '(unknown)'}`);
}

async function notifyTelegramError(botToken: string, update: TelegramUpdate, error: unknown): Promise<void> {
  const chatId = update.message?.chat?.id ?? update.edited_message?.chat?.id;
  if (!chatId) return;
  const message = error instanceof Error ? error.message : String(error);
  await sendTelegramMessage(botToken, chatId, `pi-telegram-bot error: ${message}`);
}

export async function sendTelegramMessage(botToken: string, chatId: number | string, text: string): Promise<void> {
  const chunks = chunkText(text, 3900);
  console.info(`sending Telegram message chat=${chatId} chunks=${chunks.length} totalLength=${text.length}`);
  for (const chunk of chunks) await telegramApi(botToken, 'sendMessage', { chat_id: chatId, text: chunk });
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

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks.length ? chunks : ['Done.'];
}
