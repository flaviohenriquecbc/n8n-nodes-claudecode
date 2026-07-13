import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export class ClaudeCodePluginApi implements ICredentialType {
	name = 'claudeCodePluginApi';
	displayName = 'Claude Code Plugin Marketplace';
	documentationUrl = '';
	properties: INodeProperties[] = [
		{
			displayName: 'Marketplace URL',
			name: 'marketplaceUrl',
			type: 'string',
			default: '',
			placeholder: 'https://github.com/your-org/your-plugin-repo',
			description: 'URL of the Claude Code plugin marketplace repository',
		},
	];
}
