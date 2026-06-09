#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { configPath, ensureDirs, readConfig, writeConfig } from './config.js';
import { discoverTelegramSenders, runTelegramBot, testTelegramToken } from './telegram.js';

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (command === 'run-service') {
    await runTelegramBot();
    return;
  }
  if (command === 'wizard' || command === 'setup') {
    await setupWizard();
    return;
  }
  if (command === 'allow') {
    const userId = args[0]?.trim();
    if (!userId) throw new Error('Usage: pi-telegram-bot allow <telegram-user-id>');
    const config = await readConfig();
    config.telegram.allowedUsers = [...new Set([...config.telegram.allowedUsers, userId])];
    await writeConfig(config);
    console.log(`Allowed Telegram user ${userId}`);
    return;
  }
  if (command === 'senders') {
    const config = await readConfig();
    if (config.telegram.recentSenders.length === 0) console.log('No recent senders yet. Start the bot and send it a Telegram message.');
    for (const sender of config.telegram.recentSenders) console.log(`${sender.id}\t${sender.name}\t${sender.lastSeenAt}`);
    return;
  }
  if (command === 'config') {
    console.log(configPath);
    console.log(JSON.stringify(await readConfig(), null, 2));
    return;
  }
  if (command === 'install-service') {
    await installService();
    return;
  }
  if (command === 'start-service') {
    await startService();
    return;
  }
  if (command === 'stop-service') {
    await stopService();
    return;
  }
  if (command === 'restart-service') {
    await restartService();
    return;
  }
  if (command === 'status-service') {
    await statusService();
    return;
  }
  if (command === 'logs') {
    await followLogs();
    return;
  }
  if (command === 'uninstall-service') {
    await uninstallService();
    return;
  }
  help();
}

async function setupWizard(): Promise<void> {
  await ensureDirs();
  const rl = createInterface({ input, output });
  try {
    const config = await readConfig();
    console.log('\npi-telegram-bot setup wizard\n');
    console.log('This will configure a host-native Telegram bot that talks to your local Pi agent.');
    console.log('Create a bot with @BotFather first if you do not already have a token.\n');

    const existingToken = process.env.TELEGRAM_BOT_TOKEN ?? config.telegram.botToken;
    const tokenAnswer = await ask(rl, existingToken ? 'Telegram bot token [keep existing]: ' : 'Telegram bot token: ');
    const token = tokenAnswer || existingToken;
    if (!token) throw new Error('A Telegram bot token is required.');
    const bot = await testTelegramToken(token);
    config.telegram.botToken = process.env.TELEGRAM_BOT_TOKEN ? config.telegram.botToken : token;
    console.log(`✓ Connected to @${bot.username ?? bot.firstName ?? bot.id}`);

    const workspace = await ask(rl, `Agent working directory — where Telegram-controlled Pi should run [${config.workspaceDir}]: `);
    if (workspace) config.workspaceDir = workspace;
    const piAgentDir = await ask(rl, `Pi agent directory [${config.piAgentDir}]: `);
    if (piAgentDir) config.piAgentDir = piAgentDir;

    const currentModel = config.selectedModel ? `${config.selectedModel.provider}/${config.selectedModel.id}` : 'auto first available model';
    const modelChoice = await ask(rl, `Model provider/id, or blank for ${currentModel}: `);
    if (modelChoice) {
      const [provider, ...modelParts] = modelChoice.split('/');
      const id = modelParts.join('/');
      if (!provider || !id) throw new Error('Model must be in provider/id format, for example anthropic/claude-sonnet-4.');
      config.selectedModel = { provider, id };
    }

    await writeConfig(config);
    console.log(`✓ Wrote ${configPath}`);

    const doDiscover = (await ask(rl, '\nAllow your Telegram account now? Send the bot any message when prompted. [Y/n]: ')).toLowerCase();
    if (doDiscover !== 'n' && doDiscover !== 'no') {
      const botName = bot.username ? `@${bot.username}` : 'your bot';
      console.log(`Send any message to ${botName}. Waiting up to 60 seconds...`);
      const senders = await discoverTelegramSenders(token, 60_000);
      if (senders.length === 0) {
        console.log('No sender found. You can run `pi-telegram-bot senders` later, then `pi-telegram-bot allow <id>`.');
      } else {
        senders.forEach((sender, index) => console.log(`${index + 1}. ${sender.id}\t${sender.name}\tchat ${sender.chatId}`));
        const choice = await ask(rl, 'Allow which sender? [1]: ');
        const index = choice ? Number(choice) - 1 : 0;
        const selected = senders[index];
        if (!selected) throw new Error('Invalid sender selection.');
        const fresh = await readConfig();
        fresh.telegram.allowedUsers = [...new Set([...fresh.telegram.allowedUsers, selected.id])];
        await writeConfig(fresh);
        console.log(`✓ Allowed ${selected.name || selected.id}`);
      }
    }

    const serviceAnswer = (await ask(rl, '\nInstall a systemd user service so the bot runs in the background? [Y/n]: ')).toLowerCase();
    if (serviceAnswer !== 'n' && serviceAnswer !== 'no') {
      await installService();
    } else {
      console.log('\nSetup complete. Start the bot later with:\n  pi-telegram-bot install-service\n');
    }
  } finally {
    rl.close();
  }
}

async function startService(): Promise<void> {
  console.log('Starting pi-telegram-bot.service...');
  await runSystemctl(['--user', 'start', 'pi-telegram-bot']);
  console.log('✓ Service started. Recent logs:');
  await showRecentLogs();
}

async function stopService(): Promise<void> {
  console.log('Stopping pi-telegram-bot.service...');
  await runSystemctl(['--user', 'stop', 'pi-telegram-bot']);
  console.log('✓ Service stopped.');
}

async function restartService(): Promise<void> {
  console.log('Restarting pi-telegram-bot.service...');
  await runSystemctl(['--user', 'restart', 'pi-telegram-bot']);
  console.log('✓ Service restarted. Recent logs:');
  await showRecentLogs();
}

async function statusService(): Promise<void> {
  await runCommand('systemctl', ['--user', 'status', 'pi-telegram-bot', '--no-pager'], true);
}

async function followLogs(): Promise<void> {
  console.log('Following pi-telegram-bot.service logs. Press Ctrl+C to stop following logs; the service will keep running.');
  await runCommand('journalctl', ['--user', '-u', 'pi-telegram-bot', '-f'], true);
}

async function uninstallService(): Promise<void> {
  const servicePath = `${homedir()}/.config/systemd/user/pi-telegram-bot.service`;
  console.log('Uninstalling pi-telegram-bot systemd user service...');
  await runSystemctl(['--user', 'stop', 'pi-telegram-bot'], true);
  await runSystemctl(['--user', 'disable', 'pi-telegram-bot'], true);
  try {
    await import('node:fs/promises').then((fs) => fs.rm(servicePath, { force: true }));
    console.log(`✓ Removed ${servicePath}`);
  } catch (error) {
    console.log(`Could not remove ${servicePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  await runSystemctl(['--user', 'daemon-reload'], true);
  await runSystemctl(['--user', 'reset-failed', 'pi-telegram-bot'], true);
  console.log('\n✓ Service removed.');
  console.log('\nTo uninstall the global CLI too, run:');
  console.log('  npm uninstall -g pi-telegram-bot');
  console.log('\nTo delete config/session data too, run:');
  console.log('  rm -rf ~/.config/pi-telegram-bot ~/.local/share/pi-telegram-bot');
}

async function installService(): Promise<void> {
  console.log('Installing pi-telegram-bot systemd user service...');
  const servicePath = `${homedir()}/.config/systemd/user/pi-telegram-bot.service`;
  const execPath = await resolveCliPath();
  const execStart = `${process.execPath} ${execPath} run-service`;
  console.log(`Service ExecStart: ${execStart}`);
  const unit = `[Unit]
Description=Pi Telegram Bot
After=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=5
WorkingDirectory=${homedir()}
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
`;
  await mkdir(dirname(servicePath), { recursive: true });
  await writeFile(servicePath, unit, { mode: 0o644 });
  console.log(`✓ Wrote ${servicePath}`);

  console.log('Reloading systemd user units...');
  await runSystemctl(['--user', 'daemon-reload']);
  console.log('Enabling and starting pi-telegram-bot.service...');
  await runSystemctl(['--user', 'enable', '--now', 'pi-telegram-bot']);

  console.log('\n✓ Service installed and started.');
  console.log('\nFollow logs with:');
  console.log('  journalctl --user -u pi-telegram-bot -f');
  console.log('\nRecent logs:');
  await showRecentLogs();
}

async function resolveCliPath(): Promise<string> {
  if (process.argv[1]?.includes('/dist/')) return process.argv[1];
  try {
    const { stdout } = await execFileAsync('sh', ['-lc', 'command -v pi-telegram-bot']);
    const found = stdout.trim();
    if (found) return found;
  } catch {
    // fall through
  }
  throw new Error('Could not find pi-telegram-bot on PATH. Run `npm install -g .` first.');
}

async function runSystemctl(args: string[], allowFailure = false): Promise<void> {
  const command = `systemctl ${args.join(' ')}`;
  process.stdout.write(`$ ${command}\n`);
  try {
    const { stdout, stderr } = await execFileAsync('systemctl', args);
    if (stdout.trim()) process.stdout.write(stdout);
    if (stderr.trim()) process.stderr.write(stderr);
  } catch (error) {
    const message = `Failed to run ${command}: ${error instanceof Error ? error.message : String(error)}`;
    if (allowFailure) {
      console.log(message);
      return;
    }
    throw new Error(message);
  }
}

async function runCommand(command: string, args: string[], inherit = false): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: inherit ? 'inherit' : 'pipe' });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${signal ?? code}`));
    });
  });
}

async function showRecentLogs(): Promise<void> {
  try {
    const { stdout, stderr } = await execFileAsync('journalctl', ['--user', '-u', 'pi-telegram-bot', '-n', '20', '--no-pager']);
    if (stdout.trim()) process.stdout.write(stdout);
    if (stderr.trim()) process.stderr.write(stderr);
  } catch (error) {
    console.log(`Could not read recent logs: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function ask(rl: ReturnType<typeof createInterface>, prompt: string): Promise<string> {
  return (await rl.question(prompt)).trim();
}

function help(): void {
  console.log(`pi-telegram-bot

Usage:
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

Environment:
  TELEGRAM_BOT_TOKEN can provide the token instead of storing it in config.json.
  PI_TELEGRAM_CONFIG_DIR overrides ~/.config/pi-telegram-bot.
  PI_TELEGRAM_DATA_DIR overrides ~/.local/share/pi-telegram-bot.
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
