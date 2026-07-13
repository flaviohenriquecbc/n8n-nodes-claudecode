import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export class ClaudeCodePluginApi implements ICredentialType {
	name = 'claudeCodePluginApi';
	displayName = 'Claude Code Plugin GitHub Token';
	documentationUrl = '';
	properties: INodeProperties[] = [
		{
			displayName: 'GitHub Token',
			name: 'githubToken',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			placeholder: 'ghp_...',
			description:
				'Personal access token (or fine-grained token) with read access to the plugin marketplace repository.',
		},
	];
}
