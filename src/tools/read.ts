import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { URI } from 'vscode-uri'
import type { S3FileSystem } from '../s3-filesystem.ts'

export const readTool = {
	name: 'Read',
	description: `Read a file or list a directory from S3. If the path is a directory, it returns a line-numbered list of entries.

- The path parameter must be an S3 URI (s3://bucket/path/to/file).
- By default, returns the first 1000 lines. To read more, call with different read_range.
- Use Grep to find specific content in large files.
- Results show the file path, line number, and line content.`,
	inputSchema: {
		type: 'object' as const,
		properties: {
			path: {
				type: 'string' as const,
				description: 'S3 URI to read (e.g., s3://bucket/path/to/file.txt)',
			},
			read_range: {
				type: 'array' as const,
				items: { type: 'number' as const },
				minItems: 2,
				maxItems: 2,
				description: 'Line range to read [start, end] (1-indexed). Example: [500, 700]',
			},
		},
		required: ['path'],
	},
}

export async function handleRead(
	args: any,
	filesystem: S3FileSystem,
): Promise<CallToolResult> {
	const path = args?.path
	if (!path || typeof path !== 'string') {
		throw new Error('path argument is required')
	}
	const readRange =
		args?.read_range && Array.isArray(args.read_range)
			? ([args.read_range[0], args.read_range[1]] as [number, number])
			: undefined

	const uri = URI.parse(path)

	try {
		// If path ends with /, try listing as directory first
		if (path.endsWith('/')) {
			try {
				const entries = await filesystem.readdir(uri)
				const entryNames = entries.map((entry) => {
					const name = entry.uri.path.split('/').filter(Boolean).pop() || ''
					return entry.isDirectory ? `${name}/` : name
				})

				const numbered = entryNames.map((entry, idx) => `${idx + 1}: ${entry}`).join('\n')
				return {
					content: [{ type: 'text', text: numbered }],
				}
			} catch {
				// If readdir fails, fall through to stat/read
			}
		}

		const stat = await filesystem.stat(uri)

		if (stat.isDirectory) {
			// List directory
			const entries = await filesystem.readdir(uri)
			const entryNames = entries.map((entry) => {
				const name = entry.uri.path.split('/').filter(Boolean).pop() || ''
				return entry.isDirectory ? `${name}/` : name
			})

			const numbered = entryNames.map((entry, idx) => `${idx + 1}: ${entry}`).join('\n')
			return {
				content: [{ type: 'text', text: numbered }],
			}
		}

		// Read file content
		let content = await filesystem.readFile(uri)

		// Apply read_range if specified
		if (readRange) {
			const [start, end] = readRange
			const lines = content.split('\n')
			const selectedLines = lines.slice(start - 1, end)
			content = selectedLines.map((line, idx) => `${start + idx}: ${line}`).join('\n')
		} else {
			// Number lines by default (first 1000)
			const lines = content.split('\n').slice(0, 1000)
			content = lines.map((line, idx) => `${idx + 1}: ${line}`).join('\n')
		}

		return {
			content: [{ type: 'text', text: content }],
		}
	} catch (error: any) {
		throw new Error(`Failed to read ${path}: ${error.message}`)
	}
}
