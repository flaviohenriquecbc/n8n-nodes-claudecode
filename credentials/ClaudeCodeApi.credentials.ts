import { ICredentialType, INodeProperties } from 'n8n-workflow';

export class ClaudeCodeApi implements ICredentialType {
	name = 'claudeCodeApi';
	displayName = 'Claude Code API Key';
	properties: INodeProperties[] = [
		{
			displayName: 'Anthropic API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
		},
	];
}
