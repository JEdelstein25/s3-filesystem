import { createServer } from 'node:http'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import {
	CallToolRequestSchema,
	type CallToolResult,
	ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { URI } from 'vscode-uri'

import { grepFiles } from './grep.ts'
import { grepWithRipgrep } from './grep-ripgrep.ts'
import { S3FileCache } from './s3-file-cache.ts'
import { type S3Config, S3FileSystem } from './s3-filesystem.ts'

let filesystem: S3FileSystem
let fileCache: S3FileCache

function initializeS3Config(): void {
	const bucket = process.env.S3_BUCKET
	const region = process.env.S3_REGION || process.env.AWS_REGION
	const prefix = process.env.S3_PREFIX || ''

	if (!bucket) {
		throw new Error('S3_BUCKET environment variable is required')
	}

	const config: S3Config = {
		bucket,
		region,
		prefix: prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix,
	}

	filesystem = new S3FileSystem(config)
	fileCache = new S3FileCache(filesystem)

	console.log(
		`S3 MCP Server initialized: bucket=${config.bucket}, region=${config.region || 'default'}, prefix=${config.prefix}`,
	)
}

async function readFile(
	path: string,
	readRange?: [number, number],
): Promise<{
	content: string
	absolutePath: string
	isDirectory?: boolean
	directoryEntries?: string[]
}> {
	const uri = URI.parse(path)

	try {
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
				absolutePath: path,
				content: numbered,
				isDirectory: true,
				directoryEntries: entryNames,
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
			absolutePath: path,
			content,
		}
	} catch (error: any) {
		throw new Error(`Failed to read ${path}: ${error.message}`)
	}
}

const server = new McpServer(
	{
		name: 's3-filesystem',
		version: '0.1.0',
	},
	{ capabilities: { tools: {} } },
)

const TOOLS = [
	{
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
	},
	{
		name: 'Grep',
		description: `Search for exact text patterns in S3 files using regex.

WHEN TO USE:
- Find exact text matches like variable names, function calls, or specific strings
- Locate all occurrences of a specific term
- Search for code patterns with exact syntax

SEARCH STRATEGY:
- Use 'path' parameter to narrow search to specific prefixes
- Use 'glob' parameter to filter by file type (e.g., "**/*.txt", "**/*.json")
- Use regex patterns for complex searches
- Use caseSensitive for case-sensitive searches

Results limited to 100 total matches, 10 per file.`,
		inputSchema: {
			type: 'object' as const,
			properties: {
				pattern: {
					type: 'string' as const,
					description: 'The pattern to search for (regex supported)',
				},
				path: {
					type: 'string' as const,
					description: 'Prefix path to search in (e.g., "data/")',
				},
				glob: {
					type: 'string' as const,
					description: 'Glob pattern to filter files (e.g., "**/*.txt")',
				},
				caseSensitive: {
					type: 'boolean' as const,
					description: 'Whether to search case-sensitively',
				},
			},
			required: ['pattern'],
		},
	},
	{
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
	},
]

server.server.setRequestHandler(ListToolsRequestSchema, () => {
	return { tools: TOOLS }
})

server.server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
	console.log('Tool request:', request.params.name, JSON.stringify(request.params.arguments))
	const { name, arguments: args } = request.params

	try {
		switch (name) {
			case 'Read': {
				const path = args?.path
				if (!path || typeof path !== 'string') {
					throw new Error('path argument is required')
				}
				const readRange =
					args?.read_range && Array.isArray(args.read_range)
						? ([args.read_range[0], args.read_range[1]] as [number, number])
						: undefined
				const result = await readFile(path, readRange)
				return {
					content: [{ type: 'text', text: result.content }],
				}
			}
			case 'Grep': {
				const pattern = args?.pattern
				if (!pattern || typeof pattern !== 'string') {
					throw new Error('pattern argument is required')
				}
				const pathFilter = typeof args?.path === 'string' ? args.path : undefined
				const globFilter = typeof args?.glob === 'string' ? args.glob : undefined
				const caseSensitive = Boolean(args?.caseSensitive)

				// Use ripgrep if we have cached files, otherwise fallback to in-memory grep
				const cacheStats = fileCache.getStats()
				let results: string[]

				if (cacheStats.entries > 0) {
					console.log('Using ripgrep on cached files...')
					results = await grepWithRipgrep(filesystem, fileCache, pattern, {
						pathFilter,
						globFilter,
						caseSensitive,
					})
				} else {
					console.log('No cached files, using in-memory grep...')
					results = await grepFiles(filesystem, pattern, {
						pathFilter,
						globFilter,
						caseSensitive,
					})
				}

				return {
					content: [
						{
							type: 'text',
							text: results.length > 0 ? results.join('\n') : 'No matches found',
						},
					],
				}
			}
			case 'glob': {
				const filePattern = args?.filePattern
				if (!filePattern || typeof filePattern !== 'string') {
					throw new Error('filePattern argument is required')
				}
				const limit = typeof args?.limit === 'number' ? args.limit : undefined
				const offset = typeof args?.offset === 'number' ? args.offset : undefined

				let files = await filesystem.findFiles(filePattern, limit)

				// Apply offset if specified
				if (offset && offset > 0) {
					files = files.slice(offset)
				}

				// Apply limit after offset
				if (limit && files.length > limit) {
					files = files.slice(0, limit)
				}

				// Cache files for grep
				if (files.length > 0 && files.length <= 1000) {
					const cacheStats = fileCache.getStats()
					if (cacheStats.utilizationPercent < 90) {
						console.log(`Caching ${files.length} files for grep...`)
						await fileCache.cacheFiles(files, { maxConcurrent: 10 })
						const newStats = fileCache.getStats()
						console.log(
							`Cached ${newStats.entries} files (${newStats.sizeMB} MB)`,
						)
					}
				}

				const filePaths = files.map((uri) => uri.toString())

				return {
					content: [
						{
							type: 'text',
							text: filePaths.length > 0 ? filePaths.join('\n') : 'No files found',
						},
					],
				}
			}
			default:
				throw new Error(`Unknown tool: ${name}`)
		}
	} catch (error: any) {
		console.error('Tool error:', error)
		return {
			content: [
				{
					type: 'text',
					text: `Error: ${error.message}`,
				},
			],
			isError: true,
		}
	}
})

// Initialize S3 configuration
initializeS3Config()

const transports = new Map<string, SSEServerTransport>()

const httpServer = createServer(async (req, res) => {
	console.log(`${req.method} ${req.url}`)

	res.setHeader('Access-Control-Allow-Origin', '*')
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

	if (req.url === '/sse' && req.method === 'GET') {
		const transport = new SSEServerTransport('/messages', res)
		transports.set(transport.sessionId, transport)
		await server.connect(transport)
		console.log('Connected to client', transport.sessionId)

		req.on('close', () => {
			transport.close()
			transports.delete(transport.sessionId)
			console.log('Client disconnected', transport.sessionId)
		})
		return
	}

	if (req.url?.startsWith('/messages?') && req.method === 'POST') {
		const sessionId = new URL(req.url, 'http://localhost').searchParams.get('sessionId')
		const transport = sessionId ? transports.get(sessionId) : undefined
		if (transport) {
			try {
				await transport.handlePostMessage(req, res)
			} catch (error) {
				console.log(`Session ${sessionId}: error handling message:`, error)
			}
		} else {
			res.writeHead(400).end()
		}
		return
	}

	if (req.method === 'OPTIONS') {
		res.writeHead(200).end()
		return
	}

	res.writeHead(404).end()
})

const port = process.env.PORT ? parseInt(process.env.PORT) : 7011
httpServer.listen(port)
console.log(`S3 MCP server listening on :${port}`)
