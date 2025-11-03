import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { LRUCache } from 'lru-cache'
import { URI } from 'vscode-uri'

import type { S3FileSystem } from './s3-filesystem.ts'

/**
 * Maximum cache size in bytes (2 GB)
 */
const MAX_CACHE_SIZE_BYTES = 2 * 1024 * 1024 * 1024

/**
 * Maximum size for a single file in the cache (100 MB)
 */
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024

/**
 * Maximum number of files to cache
 */
const MAX_CACHE_ENTRIES = 10000

/**
 * Entry in the file cache
 */
interface CacheEntry {
	localPath: string
	size: number
	uri: string
	lastAccessed: number
}

/**
 * LRU cache for S3 files that downloads and stores them locally
 */
export class S3FileCache {
	private cache: LRUCache<string, CacheEntry>
	private cacheDir: string
	private currentSize: number = 0
	private filesystem: S3FileSystem
	private initPromise: Promise<void>

	constructor(filesystem: S3FileSystem, cacheDir?: string) {
		this.filesystem = filesystem
		this.cacheDir = cacheDir || path.join(os.tmpdir(), 's3-mcp-cache')

		this.cache = new LRUCache<string, CacheEntry>({
			max: MAX_CACHE_ENTRIES,
			maxSize: MAX_CACHE_SIZE_BYTES,
			sizeCalculation: (entry) => Math.max(1, entry.size || 0),
			dispose: async (entry, key) => {
				await this.removeFile(entry, key)
			},
		})

		this.initPromise = this.initCacheDir()
	}

	private async initCacheDir(): Promise<void> {
		try {
			await fs.mkdir(this.cacheDir, { recursive: true })
			console.log(`S3 file cache initialized: ${this.cacheDir}`)
		} catch (error) {
			console.error('Failed to initialize S3 file cache directory:', error)
			throw error
		}
	}

	private getCacheKey(uri: URI | string): string {
		const uriStr = typeof uri === 'string' ? uri : uri.toString()
		return createHash('sha256').update(uriStr).digest('hex')
	}

	private getLocalPath(uri: URI): string {
		const uriObj = typeof uri === 'string' ? URI.parse(uri) : uri
		const bucket = uriObj.authority || uriObj.path.split('/')[0]
		const key = uriObj.path.startsWith('/') ? uriObj.path.slice(1) : uriObj.path
		const cleanBucket = bucket.replace(/^s3:\/\//, '')
		return path.join(this.cacheDir, cleanBucket, key)
	}

	private async removeFile(entry: CacheEntry, key: string): Promise<void> {
		try {
			await fs.unlink(entry.localPath)
			this.currentSize -= entry.size
		} catch (error) {
			console.warn('Failed to remove cached file:', error)
		}
	}

	async cacheFile(uri: URI, options?: { signal?: AbortSignal }): Promise<string | null> {
		await this.initPromise

		const key = this.getCacheKey(uri)

		// Check if already cached
		const existing = this.cache.get(key)
		if (existing) {
			existing.lastAccessed = Date.now()
			return existing.localPath
		}

		try {
		// Download file content
		const uriString = uri.toString()
		const content = await this.filesystem.readFile(uriString)
			const localPath = this.getLocalPath(uri)

			// Ensure directory exists
			await fs.mkdir(path.dirname(localPath), { recursive: true })

			// Write to local file
			await fs.writeFile(localPath, content, 'utf8')

			// Verify file size
			const actualStat = await fs.stat(localPath)
			const actualSize = actualStat.size

			// Add to cache
			const entry: CacheEntry = {
				localPath,
				size: actualSize,
				uri: uri.toString(),
				lastAccessed: Date.now(),
			}

			this.cache.set(key, entry)
			this.currentSize += actualSize

			return localPath
		} catch (error: any) {
			console.error(`Failed to cache S3 file ${uri.toString()}:`, error.message)
			throw error
		}
	}

	async cacheFiles(
		uris: URI[],
		options?: { signal?: AbortSignal; maxConcurrent?: number },
	): Promise<Map<string, string | null>> {
		const maxConcurrent = options?.maxConcurrent ?? 10
		const results = new Map<string, string | null>()

		// Process in batches to limit concurrency
		for (let i = 0; i < uris.length; i += maxConcurrent) {
			const batch = uris.slice(i, i + maxConcurrent)
			const batchResults = await Promise.allSettled(
				batch.map((uri) =>
					this.cacheFile(uri, options).then((localPath) => ({ uri, localPath })),
				),
			)

			for (const result of batchResults) {
				if (result.status === 'fulfilled') {
					results.set(result.value.uri.toString(), result.value.localPath)
				} else {
					console.error('Failed to cache file in batch:', result.reason)
				}
			}

			// Check for abort
			if (options?.signal?.aborted) {
				console.log(`File caching aborted (cached ${results.size} files)`)
				break
			}
		}

		return results
	}

	getCachedPath(uri: URI): string | null {
		const key = this.getCacheKey(uri)
		const entry = this.cache.get(key)
		if (entry) {
			entry.lastAccessed = Date.now()
			return entry.localPath
		}
		return null
	}

	getStats(): {
		entries: number
		sizeBytes: number
		sizeMB: number
		maxSizeBytes: number
		maxSizeMB: number
		utilizationPercent: number
	} {
		return {
			entries: this.cache.size,
			sizeBytes: this.currentSize,
			sizeMB: Math.round(this.currentSize / (1024 * 1024)),
			maxSizeBytes: MAX_CACHE_SIZE_BYTES,
			maxSizeMB: Math.round(MAX_CACHE_SIZE_BYTES / (1024 * 1024)),
			utilizationPercent: Math.round((this.currentSize / MAX_CACHE_SIZE_BYTES) * 100),
		}
	}

	async clear(): Promise<void> {
		console.log(`Clearing S3 file cache (${this.cache.size} entries)`)

		this.cache.clear()
		this.currentSize = 0

		try {
			await fs.rm(this.cacheDir, { recursive: true, force: true })
			await fs.mkdir(this.cacheDir, { recursive: true })
		} catch (error) {
			console.error('Failed to clear cache directory:', error)
		}
	}

	getCacheDir(): string {
		return this.cacheDir
	}
}
