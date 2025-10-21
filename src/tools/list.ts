import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { URI } from 'vscode-uri'
import type { S3FileSystem } from '../s3-filesystem.ts'

export const listTool = {
	name: 'list',
	description: `List the contents of an S3 directory.

Returns entries with their names and types (file or directory).

## When to use:
- Browse directory contents
- Explore S3 bucket structure
- Navigate through folders

Returns a list of entries with trailing "/" for directories.`,
	inputSchema: {
		type: 'object' as const,
		properties: {
			path: {
				type: 'string' as const,
				description: 'S3 URI to list (e.g., s3://bucket/path/to/dir/)',
			},
		},
		required: ['path'],
	},
}

export async function handleList(
	args: any,
	filesystem: S3FileSystem,
): Promise<CallToolResult> {
	const path = args?.path
	if (!path || typeof path !== 'string') {
		throw new Error('path argument is required')
	}
	const uri = URI.parse(path)
	const entries = await filesystem.readdir(uri)
	const entryNames = entries.map((entry) => {
		const name = entry.uri.path.split('/').filter(Boolean).pop() || ''
		return entry.isDirectory ? `${name}/` : name
	})
	return {
		content: [
			{
				type: 'text',
				text: entryNames.length > 0 ? entryNames.join('\n') : 'Empty directory',
			},
		],
	}
}
