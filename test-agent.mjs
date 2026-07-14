/**
 * Local test for the Agent operation plugin install + run flow.
 * Add credentials to .env (which is gitignored) then run:
 *   source .env && node test-agent.mjs
 */

import { spawn } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

const require = createRequire(import.meta.url);
const pkgDir = path.dirname(require.resolve('@anthropic-ai/claude-code/package.json'));
const wrapperPath = path.join(pkgDir, 'cli-wrapper.cjs');

const githubToken = process.env.GITHUB_TOKEN;
const marketplaceUrl = process.env.MARKETPLACE_URL;
const skillName = process.env.SKILL;
const prompt = process.env.PROMPT || 'say hello in one sentence';

if (!marketplaceUrl || !skillName) {
  console.error('Usage: MARKETPLACE_URL=... SKILL=name@source [GITHUB_TOKEN=...] [PROMPT=...] node test-agent.mjs');
  process.exit(1);
}

const writableHome = '/tmp';

// Write .gitconfig for private GitHub auth (same approach as agentQuery in claudeCodeQuery.ts)
if (githubToken) {
  const gitconfigContent = `[url "https://x-access-token:${githubToken}@github.com/"]\n\tinsteadOf = https://github.com/\n`;
  fs.writeFileSync(path.join(writableHome, '.gitconfig'), gitconfigContent, { encoding: 'utf8' });
  console.log('✅ Wrote .gitconfig for GitHub auth');
}

const baseEnv = { ...process.env, HOME: writableHome };
// Remove env var that conflicts with claude CLI's internal env parsing
delete baseEnv.MARKETPLACE_URL;

function runCommand(args) {
  return new Promise((resolve, reject) => {
    console.log(`\n▶ node cli-wrapper.cjs ${args.join(' ')}`);
    const proc = spawn(process.execPath, [wrapperPath, ...args], {
      env: baseEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    proc.stderr?.on('data', (d) => (stderr += d.toString()));
    proc.stdout?.on('data', (d) => process.stdout.write(d));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Exited with code ${code}${stderr ? ': ' + stderr.trim() : ''}`));
    });
    proc.on('error', reject);
  });
}

async function runAgent(agentArgs) {
  return new Promise((resolve, reject) => {
    console.log(`\n▶ node cli-wrapper.cjs ${agentArgs.join(' ')}`);
    const proc = spawn(process.execPath, [wrapperPath, ...agentArgs], {
      env: baseEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stderrChunks = [];
    proc.stderr?.on('data', (d) => stderrChunks.push(d));

    const rl = readline.createInterface({ input: proc.stdout });
    let messageCount = 0;

    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);
        messageCount++;
        if (msg.type === 'result') {
          console.log('\nRESULT:', msg.result);
          console.log('Cost:', msg.total_cost_usd, '| Turns:', msg.num_turns);
        } else if (msg.type === 'assistant') {
          const texts = (msg.message?.content || [])
            .filter((b) => b.type === 'text')
            .map((b) => b.text);
          if (texts.length) process.stdout.write(texts.join(''));
        }
      } catch {
        // non-JSON line
      }
    });

    rl.on('close', () => {
      const stderr = Buffer.concat(stderrChunks).toString().trim();
      if (stderr) console.log('\nstderr:', stderr);
      console.log(`\nmessages received: ${messageCount}`);
      if (messageCount === 0) reject(new Error('No messages received'));
      else resolve();
    });

    proc.on('error', reject);
  });
}

try {
  await runCommand(['plugin', 'marketplace', 'add', marketplaceUrl]);
  console.log('✅ Marketplace added');

  await runCommand(['plugin', 'install', skillName]);
  console.log('✅ Skill installed');

  // Read SKILL.md and use as system prompt
  const skill = skillName.split('@')[0];
  const installedPluginsPath = path.join(writableHome, '.claude', 'plugins', 'installed_plugins.json');
  let systemPrompt = '';
  try {
    const installed = JSON.parse(fs.readFileSync(installedPluginsPath, 'utf8'));
    const entries = installed[skillName] || [];
    const installPath = entries[0]?.installPath;
    if (installPath) {
      const skillMdPath = path.join(installPath, 'skills', skill, 'SKILL.md');
      if (fs.existsSync(skillMdPath)) {
        const raw = fs.readFileSync(skillMdPath, 'utf8');
        systemPrompt = raw.replace(/^---[\s\S]*?---\n?/, '').trim();
        console.log(`✅ Loaded SKILL.md (${systemPrompt.length} chars)`);
      }
    }
  } catch (e) {
    console.warn('Could not read SKILL.md:', e.message);
  }

  const agentArgs = ['--output-format', 'stream-json', '--verbose', '-p', prompt,
    '--max-turns', '5', '--permission-mode', 'bypassPermissions'];
  if (systemPrompt) agentArgs.push('--system-prompt', systemPrompt);

  await runAgent(agentArgs);
  console.log('\n✅ Agent run complete');
} catch (err) {
  console.error('\n❌', err.message);
  process.exit(1);
}
