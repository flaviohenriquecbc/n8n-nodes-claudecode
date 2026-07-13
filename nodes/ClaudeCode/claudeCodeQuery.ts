import { spawn } from 'child_process';
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
		proc.on('close', (code) => {
			if (code === 0) resolve();
			else reject(new Error(`Command exited with code ${code}: ${args.join(' ')}`));
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
	const authEnv: Record<string, string> = opts.githubToken
		? { GH_TOKEN: opts.githubToken, GITHUB_TOKEN: opts.githubToken }
		: {};

	await runCommand(
		process.execPath,
		[wrapperPath, 'plugin', 'marketplace', 'add', opts.marketplaceUrl],
		cwd,
		authEnv,
	);
	await runCommand(
		process.execPath,
		[wrapperPath, 'plugin', 'install', opts.skillName],
		cwd,
		authEnv,
	);

	const agentName = opts.skillName.split('@')[0];
	const o = opts.options ?? {};

	const args: string[] = [
		'--agent',
		agentName,
		'--output-format',
		'stream-json',
		'-p',
		opts.prompt,
	];
	if (o.model) args.push('--model', o.model);
	if (o.maxTurns) args.push('--max-turns', String(o.maxTurns));
	if (o.systemPrompt) args.push('--system-prompt', o.systemPrompt);
	if (o.permissionMode) args.push('--permission-mode', o.permissionMode);
	if (o.allowedTools?.length) args.push('--allowedTools', o.allowedTools.join(','));
	if (o.disallowedTools?.length) args.push('--disallowedTools', o.disallowedTools.join(','));

	const proc = spawn(process.execPath, [wrapperPath, ...args], {
		cwd,
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

	const args: string[] = ['--output-format', 'stream-json', '--print'];
	if (o.model) args.push('--model', o.model);
	if (o.maxTurns) args.push('--max-turns', String(o.maxTurns));
	if (o.systemPrompt) args.push('--system-prompt', o.systemPrompt);
	if (o.continue) args.push('--continue');
	if (o.permissionMode) args.push('--permission-mode', o.permissionMode);
	if (o.allowedTools?.length) args.push('--allowedTools', o.allowedTools.join(','));
	if (o.disallowedTools?.length) args.push('--disallowedTools', o.disallowedTools.join(','));
	args.push(opts.prompt);

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
