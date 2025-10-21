import { createServer } from 'node:http'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import {
	CallToolRequestSchema,
	type CallToolResult,
	ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

import { S3FileCache } from './s3-file-cache.ts'
import { type S3Config, S3FileSystem } from './s3-filesystem.ts'
import { tools, toolHandlers, type ToolName } from './tools/index.ts'

let filesystem: S3FileSystem
let fileCache: S3FileCache

async function initializeS3Config(): Promise<void> {
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
	
	// Check for manifest at startup
	const manifest = await filesystem.fetchManifest()
	if (manifest) {
		console.log(`✓ Manifest loaded: ${manifest.files.length} files indexed`)
	} else {
		console.log('⚠ No manifest found - file searches will be slower')
		console.log('  To generate a manifest, run: bun run util/generate-s3-manifest.ts')
	}
}

const server = new McpServer(
	{
		name: 's3-filesystem',
		version: '0.1.0',
	},
	{ capabilities: { tools: {} } },
)

server.server.setRequestHandler(ListToolsRequestSchema, () => {
	return { tools }
})

server.server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
	console.log('Tool request:', request.params.name, JSON.stringify(request.params.arguments))
	const { name, arguments: args } = request.params

	try {
		const handler = toolHandlers[name as ToolName]
		if (!handler) {
			throw new Error(`Unknown tool: ${name}`)
		}

		// All handlers now accept fileCache as optional parameter
		return await handler(args, filesystem, fileCache)
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
await initializeS3Config()

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
