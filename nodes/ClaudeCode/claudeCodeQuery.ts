import { spawn } from 'child_process';
import * as fs from 'fs';
import * as readline from 'readline';
import * as path from 'path';

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

	const proc = spawn(process.execPath, [wrapperPath, ...args], {
		cwd,
		env: { ...process.env, HOME: writableHome },
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
