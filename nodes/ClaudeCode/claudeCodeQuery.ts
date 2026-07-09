import { spawn } from 'child_process';
import * as readline from 'readline';
import * as path from 'path';

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
