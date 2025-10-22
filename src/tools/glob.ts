import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { S3FileSystem } from '../s3-filesystem.ts'
import type { S3FileCache } from '../s3-file-cache.ts'

export const globTool = {
	name: 'glob',
	description: `Fast file pattern matching in S3.

Find files by name patterns. Returns matching S3 URIs.

## When to use:
- Find specific file types (e.g., all JSON files)
- Find files in specific directories or patterns
- Explore the file structure

## Pattern syntax:
- **/*.json - All JSON files in any directory
- data/**/*.txt - All text files under data/
- **/*test* - All files with "test" in their name

Results are sorted by modification time (most recent first).`,
	inputSchema: {
		type: 'object' as const,
		properties: {
			filePattern: {
				type: 'string' as const,
				description: 'Glob pattern like "**/*.json" or "data/**/*.txt"',
			},
			limit: {
				type: 'number' as const,
				description: 'Maximum number of results to return',
			},
			offset: {
				type: 'number' as const,
				description: 'Number of results to skip (for pagination)',
			},
		},
		required: ['filePattern'],
	},
}

export async function handleGlob(
	args: any,
	filesystem: S3FileSystem,
	fileCache?: S3FileCache,
): Promise<CallToolResult> {
	const filePattern = args?.filePattern
	if (!filePattern || typeof filePattern !== 'string') {
		throw new Error('filePattern argument is required')
	}
	const limit = typeof args?.limit === 'number' ? args.limit : undefined
	const offset = typeof args?.offset === 'number' ? args.offset : undefined

	console.log(`[glob] Searching for pattern: ${filePattern}, limit: ${limit}, offset: ${offset}`)
	let files = await filesystem.findFiles(filePattern, limit)
	console.log(`[glob] Found ${files.length} files`)

	// Apply offset if specified
	if (offset && offset > 0) {
		files = files.slice(offset)
	}

	// Apply limit after offset
	if (limit && files.length > limit) {
		files = files.slice(0, limit)
	}

	const filePaths = files.map((uri) => uri.toString())

	// Cache files for grep in background (fire and forget)
	if (fileCache && files.length > 0 && files.length <= 1000) {
		const cacheStats = fileCache.getStats()
		if (cacheStats.utilizationPercent < 90) {
			console.log(`Background caching ${files.length} files for future grep...`)
			fileCache.cacheFiles(files, { maxConcurrent: 10 }).then((results) => {
				const newStats = fileCache.getStats()
				console.log(`Cached ${newStats.entries} files (${newStats.sizeMB} MB)`)
			}).catch((error) => {
				console.warn('Background caching failed:', error.message)
			})
		}
	}

	return {
		content: [
			{
				type: 'text',
				text: filePaths.length > 0 ? filePaths.join('\n') : 'No files found',
			},
		],
	}
}
