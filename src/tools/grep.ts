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

/**
 * Grep implementation using ripgrep on cached files
 */
async function grepWithRipgrep(
	filesystem: S3FileSystem,
	cache: S3FileCache,
	pattern: string,
	options: {
		pathFilter?: string
		globFilter?: string
		caseSensitive?: boolean
		signal?: AbortSignal
	} = {},
): Promise<string[]> {
	const { pathFilter, globFilter, caseSensitive, signal } = options
	const startTime = Date.now()

	// Get cache stats
	const cacheStats = cache.getStats()
	console.log(
		`Searching ${cacheStats.entries} cached files (${cacheStats.sizeMB} MB) with ripgrep...`,
	)

	// If glob pattern is specified, ensure those files are cached
	if (globFilter) {
		const matchingFiles = await filesystem.findFiles(globFilter, 1000)
		const uncachedFiles = matchingFiles.filter((uri) => !cache.getCachedPath(uri))

		if (uncachedFiles.length > 0) {
			console.log(`Caching ${uncachedFiles.length} additional files for glob pattern...`)
			await cache.cacheFiles(uncachedFiles, { maxConcurrent: 10, signal })
		}
	}

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
		? `${cache.getCacheDir()}/${pathFilter}`
		: cache.getCacheDir()

	ripgrepArgs.push(searchPath)

	console.log(`Running ripgrep with args:`, ripgrepArgs.join(' '))

	// Run ripgrep
	return new Promise((resolve, reject) => {
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

		// Handle abort signal
		const abortHandler = () => {
			proc.kill()
			reject(new Error('Grep operation aborted'))
		}
		signal?.addEventListener('abort', abortHandler)

		// Timeout
		const timeout = setTimeout(() => {
			proc.kill()
			reject(new Error(`Grep operation timed out after ${GREP_TIMEOUT_MS / 1000}s`))
		}, GREP_TIMEOUT_MS)

		proc.on('close', (exitCode) => {
			clearTimeout(timeout)
			signal?.removeEventListener('abort', abortHandler)

			const elapsed = Date.now() - startTime
			console.log(`Ripgrep completed in ${elapsed}ms with exit code ${exitCode}`)

			// ripgrep exit code 1 means "no matches found" (not an error)
			if (exitCode !== null && exitCode >= 2) {
				reject(new Error(`ripgrep exited with code ${exitCode}: ${stderr}`))
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
			const results = [...matches]
			if (matches.length >= GREP_MAX_TOTAL_RESULTS) {
				results.push(
					`\nResults truncated: showing first ${GREP_MAX_TOTAL_RESULTS} matches.`,
				)
				results.push(
					`To see more results:\n` +
						`  • Use the 'path' parameter to search in a specific directory\n` +
						`  • Use the 'glob' parameter to filter by file type\n` +
						`  • Make your search pattern more specific`,
				)
			}

			resolve(results)
		})

		proc.on('error', (error) => {
			clearTimeout(timeout)
			signal?.removeEventListener('abort', abortHandler)
			reject(error)
		})
	})
}

/**
 * Fallback grep implementation using in-memory file reading
 */
async function grepFiles(
	filesystem: S3FileSystem,
	pattern: string,
	options: {
		pathFilter?: string
		globFilter?: string
		caseSensitive?: boolean
	} = {},
): Promise<string[]> {
	const { pathFilter, globFilter, caseSensitive } = options
	const results: string[] = []
	let totalMatches = 0

	// Find files to search
	const globPattern = globFilter || '**/*'
	const files = await filesystem.findFiles(globPattern, 1000)

	// Filter by path prefix if specified
	const filteredFiles = pathFilter ? files.filter((uri) => uri.path.includes(pathFilter)) : files

	const regex = new RegExp(pattern, caseSensitive ? '' : 'i')

	for (const fileURI of filteredFiles) {
		if (totalMatches >= GREP_MAX_TOTAL_RESULTS) {
			break
		}

		try {
			// Skip directories
			const stat = await filesystem.stat(fileURI)
			if (stat.isDirectory) {
				continue
			}

			const content = await filesystem.readFile(fileURI)
			const lines = content.split('\n')
			let fileMatches = 0

			for (let i = 0; i < lines.length; i++) {
				const line = lines[i]

				if (regex.test(line)) {
					const lineNum = i + 1
					const truncated =
						line.length > GREP_MAX_COLUMN_LENGTH
							? `${line.slice(0, GREP_MAX_COLUMN_LENGTH)}...`
							: line
					results.push(`${fileURI}:${lineNum}: ${truncated}`)
					fileMatches++
					totalMatches++

					if (
						fileMatches >= GREP_MAX_RESULTS_PER_FILE ||
						totalMatches >= GREP_MAX_TOTAL_RESULTS
					) {
						break
					}
				}
			}
		} catch (error) {
			// Skip files that can't be read
			continue
		}
	}

	// Add metadata about truncation
	if (results.length >= GREP_MAX_TOTAL_RESULTS) {
		results.push(`\nResults truncated: showing first ${GREP_MAX_TOTAL_RESULTS} matches.`)
		results.push(
			`To see more results:\n` +
				`  • Use the 'path' parameter to search in a specific directory\n` +
				`  • Use the 'glob' parameter to filter by file type\n` +
				`  • Make your search pattern more specific`,
		)
	}

	return results
}

export const grepTool = {
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

	// Use ripgrep if we have cached files, otherwise fallback to in-memory grep
	let results: string[]

	if (fileCache) {
		const cacheStats = fileCache.getStats()
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
	} else {
		console.log('No cache available, using in-memory grep...')
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
