import { spawn } from 'child_process';
import * as fs from 'fs';
import * as readline from 'readline';
import * as path from 'path';
import * as os from 'os';

function runCommand(
	execPath: string,
	args: string[],
	cwd: string,
	env?: Record<string, string>,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const proc = spawn(execPath, args, { cwd, env: { ...process.env, ...env } });
		const stderrChunks: Buffer[] = [];
		proc.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
		proc.on('close', (code) => {
			if (code === 0) {
				resolve();
			} else {
				const stderr = Buffer.concat(stderrChunks).toString().trim();
				const detail = stderr ? `: ${stderr}` : '';
				reject(new Error(`Command exited with code ${code}${detail}`));
			}
		});
		proc.on('error', reject);
	});
}

const GH_VERSION = '2.74.0';

// Returns a directory containing the gh binary, downloading it to /tmp if needed.
async function ensureGhCli(writableHome: string, sh: string): Promise<string> {
	const ghDir = path.join(writableHome, 'gh-cli');
	const ghBin = path.join(ghDir, 'gh');
	try {
		fs.accessSync(ghBin, fs.constants.X_OK);
		return ghDir;
	} catch {
		/* not cached */
	}

	for (const p of ['/usr/bin/gh', '/usr/local/bin/gh', '/bin/gh']) {
		try {
			fs.accessSync(p, fs.constants.X_OK);
			return path.dirname(p);
		} catch {
			/* skip */
		}
	}

	const arch = os.arch() === 'arm64' ? 'arm64' : 'amd64';
	const tarName = `gh_${GH_VERSION}_linux_${arch}.tar.gz`;
	const url = `https://github.com/cli/cli/releases/download/v${GH_VERSION}/${tarName}`;
	fs.mkdirSync(ghDir, { recursive: true });
	await new Promise<void>((resolve, reject) => {
		const proc = spawn(
			sh,
			[
				'-c',
				`curl -fsSL "${url}" | tar xz -C "${ghDir}" --strip-components=2 "gh_${GH_VERSION}_linux_${arch}/bin/gh"`,
			],
			{ env: process.env as Record<string, string> },
		);
		proc.on('close', (code) =>
			code === 0 ? resolve() : reject(new Error(`gh download failed: exit ${code}`)),
		);
		proc.on('error', reject);
	});
	fs.chmodSync(ghBin, 0o755);
	return ghDir;
}

export type SDKMessage = {
	type: string;
	subtype?: string;
	message?: {
		role?: string;
		content?: Array<{ type: string; text?: string; name?: string; input?: unknown; id?: string }>;
	};
	result?: string;
	error?: string;
	duration_ms?: number;
	total_cost_usd?: number;
	session_id?: string;
	model?: string;
	tools?: unknown[];
	is_error?: boolean;
	num_turns?: number;
};

type AgentQueryOptions = {
	marketplaceUrl: string;
	skillName: string;
	githubToken?: string;
	anthropicApiKey?: string;
	prompt: string;
	options?: QueryOptions['options'];
};

export async function* agentQuery(opts: AgentQueryOptions): AsyncGenerator<SDKMessage> {
	const pkgDir = path.dirname(require.resolve('@anthropic-ai/claude-code/package.json'));
	const wrapperPath = path.join(pkgDir, 'cli-wrapper.cjs');
	const cwd = opts.options?.cwd || process.cwd();
	// Use /tmp as HOME so the Claude CLI can write ~/.claude in read-only container environments
	const writableHome = '/tmp';

	// Write a .gitconfig in the writable home so git rewrites GitHub URLs to
	// include the token. The claude CLI sees the clean URL; git handles auth.
	if (opts.githubToken) {
		const gitconfigPath = path.join(writableHome, '.gitconfig');
		const gitconfigContent = `[url "https://x-access-token:${opts.githubToken}@github.com/"]\n\tinsteadOf = https://github.com/\n`;
		fs.writeFileSync(gitconfigPath, gitconfigContent, { encoding: 'utf8' });
	}

	const baseEnv: Record<string, string> = { HOME: writableHome };

	await runCommand(
		process.execPath,
		[wrapperPath, 'plugin', 'marketplace', 'add', opts.marketplaceUrl],
		cwd,
		baseEnv,
	);
	await runCommand(
		process.execPath,
		[wrapperPath, 'plugin', 'install', opts.skillName],
		cwd,
		baseEnv,
	);

	const skillName = opts.skillName.split('@')[0];
	const o = opts.options ?? {};

	// Skills are SKILL.md definitions, not --agent processes.
	// Find the installed SKILL.md and use its content as the system prompt.
	const installedPluginsPath = path.join(
		writableHome,
		'.claude',
		'plugins',
		'installed_plugins.json',
	);
	let skillSystemPrompt = o.systemPrompt || '';
	try {
		const installedPlugins = JSON.parse(fs.readFileSync(installedPluginsPath, 'utf8'));
		const entries: Array<{ installPath: string }> = installedPlugins[opts.skillName] || [];
		const installPath = entries[0]?.installPath;
		if (installPath) {
			const skillMdPath = path.join(installPath, 'skills', skillName, 'SKILL.md');
			if (fs.existsSync(skillMdPath)) {
				const raw = fs.readFileSync(skillMdPath, 'utf8');
				// Strip YAML frontmatter (--- ... ---)
				skillSystemPrompt = raw.replace(/^---[\s\S]*?---\n?/, '').trim();
			}
		}
	} catch {
		// If we can't read the skill, fall back to running without a system prompt
	}

	const args: string[] = ['--output-format', 'stream-json', '--verbose', '-p', opts.prompt];
	if (o.model) args.push('--model', o.model);
	if (o.maxTurns) args.push('--max-turns', String(o.maxTurns));
	if (skillSystemPrompt) args.push('--system-prompt', skillSystemPrompt);
	if (o.permissionMode) args.push('--permission-mode', o.permissionMode);
	if (o.allowedTools?.length) args.push('--allowedTools', o.allowedTools.join(','));
	if (o.disallowedTools?.length) args.push('--disallowedTools', o.disallowedTools.join(','));

	// The claude CLI only accepts bash or zsh (not sh). It checks CLAUDE_CODE_SHELL first,
	// then SHELL (only if it contains "bash" or "zsh"), then probes common paths.
	// In containers without bash/zsh (e.g. Alpine n8n), we write a /tmp/bash shim that
	// delegates to /bin/sh — the CLI only checks that the path string contains "bash".
	const existingShell =
		process.env.CLAUDE_CODE_SHELL ||
		(process.env.SHELL?.match(/bash|zsh/) ? process.env.SHELL : undefined);
	const nativeBash = [
		'/bin/bash',
		'/usr/bin/bash',
		'/usr/local/bin/bash',
		'/bin/zsh',
		'/usr/bin/zsh',
		'/usr/local/bin/zsh',
	].find((p) => {
		try {
			fs.accessSync(p, fs.constants.X_OK);
			return true;
		} catch {
			return false;
		}
	});
	let shellPath = existingShell || nativeBash;
	if (!shellPath) {
		// No bash/zsh found — create a shim at /tmp/bash that wraps /bin/sh.
		// The claude CLI accepts any path containing "bash"; /bin/sh handles the actual execution.
		const shimPath = path.join(writableHome, 'bash');
		fs.writeFileSync(shimPath, '#!/bin/sh\nexec /bin/sh "$@"\n', { encoding: 'utf8', mode: 0o755 });
		shellPath = shimPath;
	}

	const procEnv: Record<string, string> = {
		...(process.env as Record<string, string>),
		HOME: writableHome,
	};
	if (shellPath) {
		procEnv.CLAUDE_CODE_SHELL = shellPath;
		procEnv.SHELL = shellPath;
	}
	if (opts.anthropicApiKey) procEnv.ANTHROPIC_API_KEY = opts.anthropicApiKey;
	// Forward GitHub token so the gh CLI (used by skills) authenticates automatically.
	// GH_TOKEN is the canonical env var; GITHUB_TOKEN is a fallback accepted by gh.
	if (opts.githubToken) {
		procEnv.GH_TOKEN = opts.githubToken;
		procEnv.GITHUB_TOKEN = opts.githubToken;
	}

	// Ensure the gh CLI binary is available (download to /tmp if missing).
	try {
		const ghBinDir = await ensureGhCli(writableHome, shellPath || '/bin/sh');
		const existingPath =
			procEnv.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
		procEnv.PATH = `${ghBinDir}:${existingPath}`;
	} catch {
		/* non-fatal: skill may not need gh */
	}

	const proc = spawn(process.execPath, [wrapperPath, ...args], {
		cwd,
		env: procEnv,
	});

	const stderrChunks: Buffer[] = [];
	const nonJsonLines: string[] = [];
	proc.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

	const rl = readline.createInterface({ input: proc.stdout });
	const queue: SDKMessage[] = [];
	let done = false;
	let exitCode: number | null = null;
	let messageCount = 0;
	let resolver: ((v: SDKMessage | null) => void) | null = null;

	proc.on('close', (code) => {
		exitCode = code;
	});

	rl.on('line', (line) => {
		if (!line.trim()) return;
		try {
			const msg = JSON.parse(line) as SDKMessage;
			messageCount++;
			if (resolver) {
				const r = resolver;
				resolver = null;
				r(msg);
			} else {
				queue.push(msg);
			}
		} catch {
			nonJsonLines.push(line.substring(0, 200));
		}
	});

	rl.on('close', () => {
		done = true;
		if (resolver) {
			const r = resolver;
			resolver = null;
			r(null);
		}
	});

	while (true) {
		if (queue.length > 0) {
			yield queue.shift()!;
		} else if (done) {
			break;
		} else {
			const msg = await new Promise<SDKMessage | null>((r) => {
				resolver = r;
			});
			if (msg !== null) yield msg;
		}
	}

	await new Promise<void>((r) => proc.on('close', r));

	if (messageCount === 0) {
		const stderr = Buffer.concat(stderrChunks).toString().trim();
		const detail = [
			`exit code: ${exitCode}`,
			stderr ? `stderr: ${stderr}` : '',
			nonJsonLines.length ? `stdout (non-JSON): ${nonJsonLines.join(' | ')}` : '',
			`args: ${args.join(' ').substring(0, 300)}`,
		]
			.filter(Boolean)
			.join('\n');
		throw new Error(`Claude agent produced no output.\n${detail}`);
	}
}

type QueryOptions = {
	prompt: string;
	options?: {
		model?: string;
		maxTurns?: number;
		systemPrompt?: string;
		cwd?: string;
		continue?: boolean;
		allowedTools?: string[];
		disallowedTools?: string[];
		permissionMode?: string;
		fallbackModel?: string;
		maxThinkingTokens?: number;
	};
};

export async function* query(opts: QueryOptions): AsyncGenerator<SDKMessage> {
	const pkgDir = path.dirname(require.resolve('@anthropic-ai/claude-code/package.json'));
	const wrapperPath = path.join(pkgDir, 'cli-wrapper.cjs');
	const o = opts.options ?? {};

	const args: string[] = ['--output-format', 'stream-json', '--verbose', '-p', opts.prompt];
	if (o.model) args.push('--model', o.model);
	if (o.maxTurns) args.push('--max-turns', String(o.maxTurns));
	if (o.systemPrompt) args.push('--system-prompt', o.systemPrompt);
	if (o.continue) args.push('--continue');
	if (o.permissionMode) args.push('--permission-mode', o.permissionMode);
	if (o.allowedTools?.length) args.push('--allowedTools', o.allowedTools.join(','));
	if (o.disallowedTools?.length) args.push('--disallowedTools', o.disallowedTools.join(','));

	const proc = spawn(process.execPath, [wrapperPath, ...args], {
		cwd: o.cwd || process.cwd(),
		env: process.env,
	});

	const rl = readline.createInterface({ input: proc.stdout });
	const queue: SDKMessage[] = [];
	let done = false;
	let resolver: ((v: SDKMessage | null) => void) | null = null;

	rl.on('line', (line) => {
		if (!line.trim()) return;
		try {
			const msg = JSON.parse(line) as SDKMessage;
			if (resolver) {
				const r = resolver;
				resolver = null;
				r(msg);
			} else {
				queue.push(msg);
			}
		} catch {
			/* skip non-JSON lines */
		}
	});

	rl.on('close', () => {
		done = true;
		if (resolver) {
			const r = resolver;
			resolver = null;
			r(null);
		}
	});

	while (true) {
		if (queue.length > 0) {
			yield queue.shift()!;
		} else if (done) {
			break;
		} else {
			const msg = await new Promise<SDKMessage | null>((r) => {
				resolver = r;
			});
			if (msg !== null) yield msg;
		}
	}

	await new Promise<void>((r) => proc.on('close', r));
}
