import { spawn } from 'node:child_process'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import picomatch from 'picomatch'
import type { S3FileSystem } from '../s3-filesystem.ts'
import type { S3FileCache } from '../s3-file-cache.ts'

const GREP_MAX_TOTAL_RESULTS = 100
const GREP_MAX_RESULTS_PER_FILE = 10
const GREP_MAX_COLUMN_LENGTH = 200
const GREP_TIMEOUT_MS = 45000

/**
 * Get the ripgrep executable path
 */
function getRipgrepPath(): string {
	// @vscode/ripgrep provides the binary
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const ripgrep = require('@vscode/ripgrep')
		return ripgrep.rgPath
	} catch {
		// Fallback to system ripgrep
		return 'rg'
	}
}

export const grepTool = {
	name: 'grep',
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
}

export async function handleGrep(
	args: any,
	filesystem: S3FileSystem,
	fileCache?: S3FileCache,
): Promise<CallToolResult> {
	const pattern = args?.pattern
	if (!pattern || typeof pattern !== 'string') {
		throw new Error('pattern argument is required')
	}
	const pathFilter = typeof args?.path === 'string' ? args.path : undefined
	const globFilter = typeof args?.glob === 'string' ? args.glob : undefined
	const caseSensitive = Boolean(args?.caseSensitive)

	if (!fileCache) {
		throw new Error('Cache is not available. Cannot perform grep without cached files.')
	}

	const cacheStats = fileCache.getStats()
	if (cacheStats.entries === 0) {
		throw new Error('No files cached. Cannot perform grep on empty cache.')
	}

	const startTime = Date.now()
	console.log(
		`Searching ${cacheStats.entries} cached files (${cacheStats.sizeMB} MB) with ripgrep...`,
	)

	// Build ripgrep arguments
	const ripgrepArgs: string[] = [
		'--with-filename',
		'--line-number',
		'--no-heading',
		'--no-require-git',
		'--no-messages',
		'--max-columns',
		GREP_MAX_COLUMN_LENGTH.toString(),
		'--trim',
		'--max-count',
		GREP_MAX_RESULTS_PER_FILE.toString(),
	]

	if (!caseSensitive) {
		ripgrepArgs.push('-i')
	}

	ripgrepArgs.push('--regexp', pattern)

	// Search in specific path if provided
	const searchPath = pathFilter
		? `${fileCache.getCacheDir()}/${pathFilter}`
		: fileCache.getCacheDir()

	ripgrepArgs.push(searchPath)

	console.log(`Running ripgrep with args:`, ripgrepArgs.join(' '))

	// Run ripgrep
	const results = await new Promise<string[]>((resolve, reject) => {
		const ripgrepPath = getRipgrepPath()
		const proc = spawn(ripgrepPath, ripgrepArgs, {
			stdio: ['ignore', 'pipe', 'pipe'],
		})

		let stdout = ''
		let stderr = ''

		proc.stdout?.on('data', (data: Buffer) => {
			stdout += data.toString()
		})

		proc.stderr?.on('data', (data: Buffer) => {
			stderr += data.toString()
		})

		// Timeout
		const timeout = setTimeout(() => {
			proc.kill()
			reject(new Error(`Grep operation timed out after ${GREP_TIMEOUT_MS / 1000}s`))
		}, GREP_TIMEOUT_MS)

		proc.on('close', (exitCode) => {
			clearTimeout(timeout)

			const elapsed = Date.now() - startTime
			console.log(`Ripgrep completed in ${elapsed}ms with exit code ${exitCode}`)
			if (stderr) {
				console.log(`Ripgrep stderr: ${stderr}`)
			}

			// ripgrep exit code 1 means "no matches found" (not an error)
			if (exitCode !== null && exitCode >= 2) {
				const errorMsg = stderr || 'Unknown ripgrep error. Check that the cache directory exists and contains files.'
				reject(new Error(`ripgrep exited with code ${exitCode}: ${errorMsg}`))
				return
			}

			// Parse results
			const matchesGlobPattern = globFilter
				? picomatch(globFilter, { nocase: !caseSensitive, dot: true })
				: undefined

			const matches = stdout
				.trim()
				.split('\n')
				.filter((line) => {
					if (line.length === 0) {
						return false
					}
					if (matchesGlobPattern) {
						const [filename] = line.split(':', 1)
						if (filename && !matchesGlobPattern(filename)) {
							return false
						}
					}
					return true
				})
				.slice(0, GREP_MAX_TOTAL_RESULTS)

			// Add truncation message if needed
			const output = [...matches]
			if (matches.length >= GREP_MAX_TOTAL_RESULTS) {
				output.push(
					`\nResults truncated: showing first ${GREP_MAX_TOTAL_RESULTS} matches.`,
				)
				output.push(
					`To see more results:\n` +
						`  • Use the 'path' parameter to search in a specific directory\n` +
						`  • Use the 'glob' parameter to filter by file type\n` +
						`  • Make your search pattern more specific`,
				)
			}

			resolve(output)
		})

		proc.on('error', (error) => {
			clearTimeout(timeout)
			reject(error)
		})
	})

	return {
		content: [
			{
				type: 'text',
				text: results.length > 0 ? results.join('\n') : 'No matches found',
			},
		],
	}
}
