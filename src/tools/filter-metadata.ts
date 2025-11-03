import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { S3FileSystem } from '../s3-filesystem.ts'

interface S3ObjectMetadata {
	key: string
	size?: number
	lastModified?: string
	eTag?: string
	storageClass?: string
}

export const filterMetadataTool = {
	name: 'filter_metadata',
	description: `Filter S3 files by metadata properties.

Search and filter files based on size, modification date, storage class, and regex patterns.
All filters are optional and can be combined for precise searches.

## When to use:
- Find files larger or smaller than a certain size
- Find files modified within a date range
- Find files in specific storage classes (STANDARD, GLACIER, etc.)
- Search files using regex patterns on keys/paths
- Combine multiple filters for refined searches

## Examples:

### Find large files (>100MB):
{ minSize: 104857600 }

### Find files modified in 2024:
{ modifiedAfter: "2024-01-01T00:00:00Z", modifiedBefore: "2024-12-31T23:59:59Z" }

### Find recently modified files (last 30 days):
{ modifiedAfter: "2024-10-01T00:00:00Z" }

### Find small log files (<1MB):
{ maxSize: 1048576, keyPattern: "\\.log$" }

### Find archived files in GLACIER:
{ storageClass: "GLACIER" }

### Find CSV files larger than 10MB modified this year:
{ minSize: 10485760, keyPattern: "\\.csv$", modifiedAfter: "2024-01-01T00:00:00Z" }

### Find all JSON files in specific directory:
{ keyPattern: "^data/processed/.*\\.json$" }

Results are sorted by modification time (most recent first).`,
	inputSchema: {
		type: 'object' as const,
		properties: {
			minSize: {
				type: 'number' as const,
				description: 'Minimum file size in bytes',
			},
			maxSize: {
				type: 'number' as const,
				description: 'Maximum file size in bytes',
			},
			modifiedAfter: {
				type: 'string' as const,
				description: 'Only files modified after this ISO date (e.g., "2024-01-01T00:00:00Z")',
			},
			modifiedBefore: {
				type: 'string' as const,
				description: 'Only files modified before this ISO date (e.g., "2024-12-31T23:59:59Z")',
			},
			storageClass: {
				type: 'string' as const,
				description: 'Filter by storage class (STANDARD, GLACIER, DEEP_ARCHIVE, INTELLIGENT_TIERING, etc.)',
			},
			keyPattern: {
				type: 'string' as const,
				description: 'Regex pattern to match against file keys/paths',
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
		required: [],
	},
}

export async function handleFilterMetadata(
	args: any,
	filesystem: S3FileSystem,
): Promise<CallToolResult> {
	const filters = {
		minSize: typeof args?.minSize === 'number' ? args.minSize : undefined,
		maxSize: typeof args?.maxSize === 'number' ? args.maxSize : undefined,
		modifiedAfter: typeof args?.modifiedAfter === 'string' ? args.modifiedAfter : undefined,
		modifiedBefore: typeof args?.modifiedBefore === 'string' ? args.modifiedBefore : undefined,
		storageClass: typeof args?.storageClass === 'string' ? args.storageClass : undefined,
		keyPattern: typeof args?.keyPattern === 'string' ? args.keyPattern : undefined,
	}
	const limit = typeof args?.limit === 'number' ? args.limit : undefined
	const offset = typeof args?.offset === 'number' ? args.offset : 0

	console.log('[filter_metadata] Filtering with:', filters)

	// Load manifest
	const manifest = await filesystem.fetchManifest()
	if (!manifest || !manifest.files) {
		return {
			content: [{ 
				type: 'text', 
				text: 'No manifest available. Generate one using: bun run util/generate-s3-manifest.ts <bucket> [prefix] [region]' 
			}],
			isError: true,
		}
	}

	// Filter manifest entries
	let results: S3ObjectMetadata[] = manifest.files as S3ObjectMetadata[]

	// Apply filters
	if (filters.minSize !== undefined) {
		results = results.filter((file) => file.size !== undefined && file.size >= filters.minSize!)
	}
	if (filters.maxSize !== undefined) {
		results = results.filter((file) => file.size !== undefined && file.size <= filters.maxSize!)
	}
	if (filters.modifiedAfter) {
		const afterDate = new Date(filters.modifiedAfter)
		results = results.filter((file) => 
			file.lastModified && new Date(file.lastModified) >= afterDate
		)
	}
	if (filters.modifiedBefore) {
		const beforeDate = new Date(filters.modifiedBefore)
		results = results.filter((file) => 
			file.lastModified && new Date(file.lastModified) <= beforeDate
		)
	}
	if (filters.storageClass) {
		results = results.filter((file) => file.storageClass === filters.storageClass)
	}
	if (filters.keyPattern) {
		const regex = new RegExp(filters.keyPattern)
		results = results.filter((file) => regex.test(file.key))
	}

	console.log(`[filter_metadata] Found ${results.length} matching files`)

	// Apply offset and limit
	if (offset > 0) {
		results = results.slice(offset)
	}
	if (limit && limit > 0) {
		results = results.slice(0, limit)
	}

	const output = results.map((item: S3ObjectMetadata) => {
		const size = item.size ? `${(item.size / 1024).toFixed(2)} KB` : 'unknown'
		const modified = item.lastModified || 'unknown'
		const storageClass = item.storageClass || 'unknown'
		return `s3://${filesystem['config'].bucket}/${item.key} (${size}, modified: ${modified}, class: ${storageClass})`
	})

	return {
		content: [
			{
				type: 'text',
				text: output.length > 0 ? output.join('\n') : 'No files match the specified filters',
			},
		],
	}
}
