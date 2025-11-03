import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { LRUCache } from 'lru-cache'

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

	private getCacheKey(s3Uri: string): string {
		return createHash('sha256').update(s3Uri).digest('hex')
	}

	private getLocalPath(s3Uri: string): string {
		// Parse s3://bucket/key format
		const match = s3Uri.match(/^s3:\/\/([^/]+)\/(.+)$/)
		if (!match) {
			throw new Error(`Invalid S3 URI: ${s3Uri}`)
		}
		const [, bucket, key] = match
		return path.join(this.cacheDir, bucket, key)
	}

	private async removeFile(entry: CacheEntry, key: string): Promise<void> {
		try {
			await fs.unlink(entry.localPath)
			this.currentSize -= entry.size
		} catch (error) {
			console.warn('Failed to remove cached file:', error)
		}
	}

	async cacheFile(s3Uri: string, options?: { signal?: AbortSignal }): Promise<string | null> {
		await this.initPromise

		const key = this.getCacheKey(s3Uri)

		// Check if already cached
		const existing = this.cache.get(key)
		if (existing) {
			existing.lastAccessed = Date.now()
			return existing.localPath
		}

		try {
			// Download file content
			const content = await this.filesystem.readFile(s3Uri)
			const localPath = this.getLocalPath(s3Uri)

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
				uri: s3Uri,
				lastAccessed: Date.now(),
			}

			this.cache.set(key, entry)
			this.currentSize += actualSize

			return localPath
		} catch (error: any) {
			console.error(`Failed to cache S3 file ${s3Uri}:`, error.message)
			throw error
		}
	}

	async cacheFiles(
		s3Uris: string[],
		options?: { signal?: AbortSignal; maxConcurrent?: number },
	): Promise<Map<string, string | null>> {
		const maxConcurrent = options?.maxConcurrent ?? 10
		const results = new Map<string, string | null>()

		// Process in batches to limit concurrency
		for (let i = 0; i < s3Uris.length; i += maxConcurrent) {
			const batch = s3Uris.slice(i, i + maxConcurrent)
			const batchResults = await Promise.allSettled(
				batch.map((s3Uri) =>
					this.cacheFile(s3Uri, options).then((localPath) => ({ s3Uri, localPath })),
				),
			)

			for (const result of batchResults) {
				if (result.status === 'fulfilled') {
					results.set(result.value.s3Uri, result.value.localPath)
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

	getCachedPath(s3Uri: string): string | null {
		const key = this.getCacheKey(s3Uri)
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
