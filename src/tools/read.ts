import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { S3FileSystem } from '../s3-filesystem.ts'

export const readTool = {
	name: 'read',
	description: `Read a file or list a directory from S3.

- For files: returns line-numbered content (first 1000 lines by default, use read_range for more)
- For directories: returns list of files and subdirectories (names only, with / suffix for directories)
- Path must be an S3 URI (s3://bucket/path/to/file or s3://bucket/path/to/dir/)
- Use Grep to find specific content in large files
- Directory listings require a manifest (generated via generate-s3-manifest.ts)`,
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
		return {
			content: [{ type: 'text', text: 'path argument is required' }],
			isError: true,
		}
	}
	const readRange =
		args?.read_range && Array.isArray(args.read_range)
			? ([args.read_range[0], args.read_range[1]] as [number, number])
			: undefined

	// Try listing as directory first if path ends with /
	if (path.endsWith('/')) {
		let currentPath = path
		let collapsedPath = ''
		
		// Collapse single-child directories
		while (true) {
			const entries = filesystem.listDirectory(currentPath)
			if (entries === null) {
				return {
					content: [{ 
						type: 'text', 
						text: 'No manifest available. Generate one using: bun run util/generate-s3-manifest.ts <bucket> [prefix] [region]' 
					}],
					isError: true,
				}
			}
			
			if (entries.length === 0) {
				return {
					content: [{ type: 'text', text: 'Directory not found or empty' }],
				}
			}
			
			// If there's only one entry and it's a directory, continue collapsing
			if (entries.length === 1 && entries[0].endsWith('/')) {
				collapsedPath += entries[0]
				currentPath = currentPath + entries[0]
				continue
			}
			
			// Found multiple entries or a file, stop collapsing
			const header = collapsedPath ? `Showing ${collapsedPath}\n\n` : ''
			const numbered = entries.map((entry, idx) => `${idx + 1}: ${entry}`).join('\n')
			return {
				content: [{ type: 'text', text: header + numbered }],
			}
		}
	}

	// Read file content
	try {
		let content = await filesystem.readFile(path)

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
		return {
			content: [{
				type: 'text',
				text: `Failed to read ${path}: ${error.message}`,
			}],
			isError: true,
		}
	}
}
