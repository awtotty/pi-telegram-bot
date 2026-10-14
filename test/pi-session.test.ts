import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Keep tests away from personal credentials, extensions, and persisted sessions.
const root = await mkdtemp(join(tmpdir(), 'pi-telegram-test-'));
process.env.PI_TELEGRAM_CONFIG_DIR = join(root, 'config');
process.env.PI_TELEGRAM_DATA_DIR = join(root, 'data');
process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
const { readConfig, writeConfig } = await import('../src/config.js');
const { PiSessionRegistry } = await import('../src/pi-session.js');

await test('pi 1.2 SDK integration (no provider requests)', async (t) => {
  const agentDir = join(root, 'agent');
  const workspaceDir = join(root, 'workspace');
  await mkdir(join(agentDir, 'extensions'), { recursive: true });
  await mkdir(workspaceDir);
  await writeFile(join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      'telegram-test': {
        baseUrl: 'http://127.0.0.1:1',
        api: 'openai-completions',
        apiKey: 'test-only-not-a-real-key',
        models: [{ id: 'test-model', name: 'Test model', contextWindow: 8192, maxTokens: 1024 }],
      },
    },
  }));
  const marker = join(root, 'startup.json');
  await writeFile(join(agentDir, 'extensions', 'startup.js'), `
    import { writeFileSync } from 'node:fs';
    export default function (pi) {
      pi.on('session_start', (_event, ctx) => {
        writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ mode: ctx.mode, hasUI: ctx.hasUI, tools: pi.getAllTools().map(t => t.name) }));
      });
      pi.registerCommand('telegram-test', {
        description: 'Exercise headless extension commands without calling a provider',
        handler: async () => {},
      });
    }
  `);
  const config = await readConfig();
  config.workspaceDir = workspaceDir;
  config.selectedModel = { provider: 'telegram-test', id: 'test-model' };
  await writeConfig(config);
  const registry = new PiSessionRegistry();
  t.after(async () => {
    registry.clear();
    await rm(root, { recursive: true, force: true });
  });

  await t.test('uses async model runtime and starts extensions headlessly', async () => {
    const info = await registry.getModelInfo('sdk-test');
    assert.equal(info.current, 'telegram-test/test-model');
    assert.ok(info.available.includes('telegram-test/test-model'));
    const startup = JSON.parse(await readFile(marker, 'utf8'));
    assert.equal(startup.mode, 'print');
    assert.equal(startup.hasUI, false);
    assert.ok(startup.tools.includes('codemode'));
    assert.ok(startup.tools.includes('tool_search'));
  });

  await t.test('persists model choices per session', async () => {
    await registry.setModel('sdk-test', 'telegram-test/test-model');
    assert.deepEqual((await readConfig()).sessionModels['sdk-test'], config.selectedModel);
    await assert.rejects(registry.setModel('sdk-test', 'missing/model'), /not available/);
  });

  await t.test('dispatches extension commands and emits done', async () => {
    const events: { type: string }[] = [];
    await registry.prompt('sdk-test', '/telegram-test', event => events.push(event));
    assert.equal(events.at(-1)?.type, 'done');
  });

  await t.test('rejects unavailable configured models and retries failed creation', async () => {
    const current = await readConfig();
    current.sessionModels['retry-test'] = { provider: 'missing', id: 'unavailable' };
    await writeConfig(current);
    await assert.rejects(registry.getModelInfo('retry-test'), /not available or authenticated/);
    current.sessionModels['retry-test'] = config.selectedModel!;
    await writeConfig(current);
    assert.equal((await registry.getModelInfo('retry-test')).current, 'telegram-test/test-model');
  });

  await t.test('logs extension load and startup handler failures without hiding them', async () => {
    const brokenLoad = join(agentDir, 'extensions', 'broken-load.js');
    const brokenHandler = join(agentDir, 'extensions', 'broken-handler.js');
    await writeFile(brokenLoad, 'export default function () { throw new Error("test-load-failure"); }');
    await writeFile(brokenHandler, 'export default function (pi) { pi.on("session_start", () => { throw new Error("test-handler-failure"); }); }');
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
    try {
      await registry.getModelInfo('extension-diagnostics');
      assert.ok(errors.some(line => line.includes('extension load error') && line.includes('test-load-failure')));
      assert.ok(errors.some(line => line.includes('event=session_start') && line.includes('test-handler-failure')));
    } finally {
      console.error = originalError;
      await rm(brokenLoad);
      await rm(brokenHandler);
    }
  });

  await t.test('honors disabled builtin extension settings', async () => {
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
      extensions: ['-builtin:mcp', '-builtin:codemode', '-builtin:tool_search'],
    }));
    await registry.getModelInfo('disabled-builtins');
    const startup = JSON.parse(await readFile(marker, 'utf8'));
    assert.ok(!startup.tools.includes('codemode'));
    assert.ok(!startup.tools.includes('tool_search'));
  });
});
