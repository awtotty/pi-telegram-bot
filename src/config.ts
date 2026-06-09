import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BotConfig } from './types.js';

export const configDir = process.env.PI_TELEGRAM_CONFIG_DIR ?? join(homedir(), '.config', 'pi-telegram-bot');
export const dataDir = process.env.PI_TELEGRAM_DATA_DIR ?? join(homedir(), '.local', 'share', 'pi-telegram-bot');
export const configPath = join(configDir, 'config.json');
export const envPath = join(configDir, '.env');

export async function ensureDirs(): Promise<void> {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await mkdir(join(dataDir, 'sessions'), { recursive: true, mode: 0o700 });
}

export function defaultConfig(): BotConfig {
  return {
    telegram: { allowedUsers: [], recentSenders: [] },
    workspaceDir: process.env.PI_TELEGRAM_WORKSPACE ?? homedir(),
    piAgentDir: process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'),
    sessionDir: process.env.PI_CODING_AGENT_SESSION_DIR ?? join(dataDir, 'sessions'),
    chatSessions: {},
  };
}

export async function readConfig(): Promise<BotConfig> {
  await ensureDirs();
  const defaults = defaultConfig();
  if (!existsSync(configPath)) return defaults;
  const parsed = JSON.parse(await readFile(configPath, 'utf8')) as Partial<BotConfig>;
  return {
    ...defaults,
    ...parsed,
    telegram: { ...defaults.telegram, ...(parsed.telegram ?? {}) },
    chatSessions: parsed.chatSessions ?? {},
  };
}

export async function writeConfig(config: BotConfig): Promise<void> {
  await ensureDirs();
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export async function loadEnvFile(): Promise<void> {
  if (!existsSync(envPath)) return;
  const raw = await readFile(envPath, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1);
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
