import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager } from '@earendil-works/pi-coding-agent';
import { loadEnvFile, readConfig } from './config.js';
import type { EventSink } from './types.js';

type SessionRecord = {
  session: Awaited<ReturnType<typeof createAgentSession>>['session'];
  busy: boolean;
  sinks: Set<EventSink>;
};

export class PiSessionRegistry {
  private sessions = new Map<string, Promise<SessionRecord>>();

  clear(): void {
    for (const sessionPromise of this.sessions.values()) {
      void sessionPromise.then((record) => record.session.dispose()).catch(() => undefined);
    }
    this.sessions.clear();
  }

  async prompt(sessionId: string, text: string, sink: EventSink): Promise<void> {
    if (!text.trim()) throw new Error('Message text is required');
    console.info(`PiSessionRegistry.prompt session=${sessionId} textLength=${text.length}`);
    const record = await this.getOrCreate(sessionId, sink);
    if (record.busy) throw new Error(`Session ${sessionId} is already busy`);
    record.busy = true;
    record.sinks.add(sink);
    try {
      sink({ type: 'status', text: `Prompting pi session ${sessionId}` });
      console.info(`pi session=${sessionId} prompt started`);
      await record.session.prompt(text);
      console.info(`pi session=${sessionId} prompt finished`);
      sink({ type: 'done' });
    } finally {
      record.sinks.delete(sink);
      record.busy = false;
      console.info(`pi session=${sessionId} released`);
    }
  }

  private getOrCreate(sessionId: string, sink: EventSink): Promise<SessionRecord> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      console.info(`reusing cached pi session=${sessionId}`);
      return existing;
    }
    console.info(`creating cached pi session=${sessionId}`);
    const created = this.create(sessionId, sink);
    this.sessions.set(sessionId, created);
    return created;
  }

  private async create(sessionId: string, sink: EventSink): Promise<SessionRecord> {
    console.info(`loading pi session=${sessionId}`);
    await loadEnvFile();
    const config = await readConfig();
    console.info(`pi session config workspace=${config.workspaceDir}`);
    console.info(`pi session config piAgentDir=${config.piAgentDir}`);
    console.info(`pi session config sessionDir=${config.sessionDir}`);
    process.env.PI_CODING_AGENT_DIR = config.piAgentDir;
    process.env.PI_CODING_AGENT_SESSION_DIR = config.sessionDir;

    sink({ type: 'status', text: `Creating pi session ${sessionId}` });
    const authStorage = AuthStorage.create(join(config.piAgentDir, 'auth.json'));
    const modelRegistry = ModelRegistry.create(authStorage, join(config.piAgentDir, 'models.json'));
    const availableModels = modelRegistry.getAvailable();
    console.info(`available pi models=${availableModels.length}`);
    const configuredModel = config.selectedModel
      ? modelRegistry.find(config.selectedModel.provider, config.selectedModel.id)
      : undefined;
    const selected = configuredModel ?? availableModels[0];
    if (!selected) throw new Error('No authenticated Pi models are available. Run pi login/config first.');
    sink({ type: 'status', text: `Using model ${selected.provider}/${selected.id}` });
    console.info(`selected pi model=${selected.provider}/${selected.id}`);

    const { session } = await createAgentSession({
      agentDir: config.piAgentDir,
      cwd: config.workspaceDir,
      sessionManager: openOrCreateSessionManager(config.sessionDir, config.workspaceDir, sessionId),
      authStorage,
      modelRegistry,
      model: selected,
    });

    console.info(`created pi SDK session=${sessionId}`);
    const sinks = new Set<EventSink>();
    session.subscribe((event: unknown) => {
      const text = extractText(event);
      if (!text) return;
      for (const currentSink of sinks) {
        currentSink(text.kind === 'assistant'
          ? { type: 'assistant_delta', text: text.text }
          : { type: 'tool_event', text: text.text });
      }
    });

    return { session, busy: false, sinks };
  }
}

function openOrCreateSessionManager(sessionDir: string, workspaceDir: string, sessionId: string): SessionManager {
  const existing = findSessionFile(sessionDir, sessionId);
  if (existing) return SessionManager.open(existing, sessionDir, workspaceDir);
  return SessionManager.create(workspaceDir, sessionDir, { id: sessionId });
}

function findSessionFile(sessionDir: string, sessionId: string): string | undefined {
  if (!existsSync(sessionDir)) return undefined;
  const suffix = `_${sessionId}.jsonl`;
  return readdirSync(sessionDir)
    .filter((entry) => entry.endsWith(suffix))
    .map((entry) => join(sessionDir, entry))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

function extractText(event: unknown): { kind: 'assistant' | 'tool'; text: string } | undefined {
  const e = event as Record<string, any>;
  if (e.type === 'message_update') {
    const assistantEvent = e.assistantMessageEvent;
    if (assistantEvent?.type === 'text_delta') return { kind: 'assistant', text: assistantEvent.delta ?? '' };
    if (assistantEvent?.type === 'error') return { kind: 'tool', text: `[error] ${assistantEvent.error?.message ?? assistantEvent.message ?? JSON.stringify(assistantEvent)}\n` };
    if (assistantEvent?.type && assistantEvent.type !== 'text_start' && assistantEvent.type !== 'text_end') return { kind: 'tool', text: formatEventPayload(assistantEvent) };
  }
  if (e.type === 'error') return { kind: 'tool', text: `[error] ${e.error?.message ?? e.message ?? JSON.stringify(e)}\n` };
  if (typeof e.type === 'string' && e.type.includes('tool')) return { kind: 'tool', text: formatEventPayload(e) };
  return undefined;
}

function formatEventPayload(event: Record<string, any>): string {
  const type = typeof event.type === 'string' ? event.type : 'event';
  return `[${type}]\n${JSON.stringify(redactLargePayload(event), null, 2)}\n`;
}

function redactLargePayload(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[Max depth]';
  if (typeof value === 'string') return value.length > 5000 ? `${value.slice(0, 5000)}… [truncated ${value.length} chars]` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactLargePayload(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, redactLargePayload(child, depth + 1)]));
}
