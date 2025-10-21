import { spawn } from 'node:child_process'

import picomatch from 'picomatch'
import { URI } from 'vscode-uri'

import type { S3FileCache } from './s3-file-cache.ts'
import type { S3FileSystem } from './s3-filesystem.ts'

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
export async function grepWithRipgrep(
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
