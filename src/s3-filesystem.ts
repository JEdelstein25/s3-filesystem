import {
	GetObjectCommand,
	S3Client,
	type ObjectStorageClass,
} from '@aws-sdk/client-s3'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createGunzip } from 'node:zlib'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { findFiles as findFilesUtil } from './find-files.ts'
import { Decompress } from 'fzstd'

export interface S3Config {
	bucket: string
	region?: string	
	prefix: string
}

export interface S3ObjectMetadata {
	key: string
	size?: number
	lastModified?: string
	eTag?: string
	storageClass?: ObjectStorageClass
}

export interface S3Manifest {
	files: S3ObjectMetadata[]
	lastUpdated: string
	version?: number
}

export interface DirectoryEntry {
	name: string
	isDirectory: boolean
	uri: string
}

class DirectorySchema {
	private dirs: Map<string, Set<string>> = new Map()

	constructor(manifest: S3Manifest, bucket: string) {
		this.buildFromManifest(manifest, bucket)
	}

	private buildFromManifest(manifest: S3Manifest, bucket: string) {
		for (const file of manifest.files) {
			const key = typeof file === 'string' ? file : file.key
			const parts = key.split('/').filter(Boolean)
			
			// Build directory structure
			for (let i = 0; i < parts.length; i++) {
				const currentPath = parts.slice(0, i).join('/') + (i > 0 ? '/' : '')
				const item = parts[i]
				const isLastPart = i === parts.length - 1
				const itemName = isLastPart ? item : item + '/'
				
				if (!this.dirs.has(currentPath)) {
					this.dirs.set(currentPath, new Set())
				}
				this.dirs.get(currentPath)!.add(itemName)
			}
		}
	}

	listDirectory(path: string): string[] {
		// Normalize path
		const normalizedPath = path.endsWith('/') ? path : path + '/'
		const cleanPath = normalizedPath.startsWith('/') ? normalizedPath.slice(1) : normalizedPath
		const lookupPath = cleanPath === '/' ? '' : cleanPath
		
		const entries = this.dirs.get(lookupPath)
		if (!entries) {
			return []
		}
		
		return Array.from(entries).sort()
	}
}

const MANIFEST_CACHE_TTL_MS = 5 * 60 * 1000

export class S3FileSystem {
	private config: S3Config
	private s3Client: S3Client
	private manifestCache: { data: S3Manifest; fetchedAt: number } | null = null
	private directorySchema: DirectorySchema | null = null

	constructor(config: S3Config) {
		this.config = config
		this.s3Client = new S3Client({
			region: config.region,
		})
	}

	private applyPrefix(key: string): string {
		return this.config.prefix ? `${this.config.prefix}${key}` : key
	}

	private removePrefix(key: string): string {
		return key.startsWith(this.config.prefix)
			? key.slice(this.config.prefix.length)
			: key
	}

	keyToS3Uri(key: string): string {
		const cleanKey = this.removePrefix(key)
		return `s3://${this.config.bucket}/${cleanKey}`
	}

	s3UriToKey(uri: string): string {
		// Parse s3://bucket/key format
		const match = uri.match(/^s3:\/\/([^/]+)\/(.+)$/)
		if (!match) {
			throw new Error(`Invalid S3 URI: ${uri}`)
		}
		const [, bucket, key] = match
		if (bucket !== this.config.bucket) {
			throw new Error(`URI bucket ${bucket} does not match configured bucket ${this.config.bucket}`)
		}
		return this.applyPrefix(key)
	}

	async fetchManifest(): Promise<S3Manifest | null> {
		if (this.manifestCache) {
			const age = Date.now() - this.manifestCache.fetchedAt
			if (age < MANIFEST_CACHE_TTL_MS) {
				return this.manifestCache.data
			}
		}

		try {
			// Look for local manifest file in .manifest directory
			const manifestFilename = `${this.config.bucket.replace(/[^a-z0-9]/gi, '-')}-manifest.json`
			const manifestPath = path.join('.manifest', manifestFilename)
			
			const content = await readFile(manifestPath, 'utf8')
			const manifest = JSON.parse(content) as S3Manifest

			this.manifestCache = { data: manifest, fetchedAt: Date.now() }
			
			// Build directory schema from manifest
			this.directorySchema = new DirectorySchema(manifest, this.config.bucket)
			
			return manifest
		} catch (error: any) {
			if (error.code === 'ENOENT') {
				return null
			}
			console.warn('[fetchManifest] Failed to load local manifest:', error.message)
			return null
		}
	}

	async readFile(s3Uri: string): Promise<string> {
		const key = this.s3UriToKey(s3Uri)
		try {
			const command = new GetObjectCommand({
				Bucket: this.config.bucket,
				Key: key,
			})
			const response = await this.s3Client.send(command)

			if (!response.Body) {
				throw new Error(`File not found: ${s3Uri}`)
			}

			const bodyStream = response.Body as Readable

			// Detect compression by file extension
			const isGzip = key.endsWith('.gz')
			const isZstd = key.endsWith('.zst') || key.endsWith('.zstd')

			if (isGzip) {
				// Streaming gzip decompression
				const chunks: Buffer[] = []
				const gunzip = createGunzip()
				
				gunzip.on('data', (chunk) => chunks.push(chunk))
				
				await pipeline(bodyStream, gunzip)
				return Buffer.concat(chunks).toString('utf-8')
			} else if (isZstd) {
				// Streaming zstd decompression
				const chunks: Buffer[] = []
				const decompress = new Decompress((chunk) => {
					chunks.push(Buffer.from(chunk))
				})

				for await (const chunk of bodyStream) {
					decompress.push(chunk)
				}
				decompress.push(new Uint8Array(0), true) // Finalize

				return Buffer.concat(chunks).toString('utf-8')
			}

			// No compression, read as text
			const chunks: Buffer[] = []
			for await (const chunk of bodyStream) {
				chunks.push(Buffer.from(chunk))
			}
			return Buffer.concat(chunks).toString('utf-8')
		} catch (error: any) {
			if (error.name === 'NotFound' || error.name === 'NoSuchKey') {
				throw new Error(`File not found: ${s3Uri}`)
			}
			throw error
		}
	}



	listDirectory(s3Uri: string): string[] | null {
		if (!this.directorySchema) {
			return null
		}

		const key = this.s3UriToKey(s3Uri)
		return this.directorySchema.listDirectory(key)
	}

	async findFiles(pattern: string, maxResults?: number): Promise<string[]> {
		const manifest = await this.fetchManifest()
		return findFilesUtil(this.s3Client, this.config.bucket, pattern, {
			prefix: this.config.prefix,
			maxResults,
			manifest,
			keyToS3Uri: this.keyToS3Uri.bind(this),
		})
	}

	getConfig(): S3Config {
		return this.config
	}
}
