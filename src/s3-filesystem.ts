import {
	GetObjectCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	S3Client,
} from '@aws-sdk/client-s3'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createGunzip } from 'node:zlib'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { URI } from 'vscode-uri'
import { findFiles as findFilesUtil } from './find-files.ts'
import { Decompress } from 'fzstd'

export interface S3Config {
	bucket: string
	region?: string	
	prefix: string
}

export interface S3Manifest {
	files: string[]
	lastUpdated: string
	version?: number
}

const MANIFEST_CACHE_TTL_MS = 5 * 60 * 1000

export class S3FileSystem {
	private config: S3Config
	private s3Client: S3Client
	private manifestCache: { data: S3Manifest; fetchedAt: number } | null = null

	constructor(config: S3Config) {
		this.config = config
		this.s3Client = new S3Client({
			region: config.region,
		})
	}

	private uriToS3Key(uri: URI): string {
		// Remove the bucket from the path and apply prefix
		let path = uri.path
		if (path.startsWith('/')) {
			path = path.slice(1)
		}
		return this.config.prefix ? `${this.config.prefix}${path}` : path
	}

	private s3KeyToURI(key: string): URI {
		// Remove prefix if present
		const path = key.startsWith(this.config.prefix)
			? key.slice(this.config.prefix.length)
			: key
		return URI.parse(`s3://${this.config.bucket}/${path}`)
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
			return manifest
		} catch (error: any) {
			if (error.code === 'ENOENT') {
				return null
			}
			console.warn('[fetchManifest] Failed to load local manifest:', error.message)
			return null
		}
	}

	async readFile(uri: URI): Promise<string> {
		const key = this.uriToS3Key(uri)
		try {
			const command = new GetObjectCommand({
				Bucket: this.config.bucket,
				Key: key,
			})
			const response = await this.s3Client.send(command)

			if (!response.Body) {
				throw new Error(`File not found: ${uri}`)
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
				throw new Error(`File not found: ${uri}`)
			}
			throw error
		}
	}

	async stat(uri: URI): Promise<{ size: number; isDirectory: boolean }> {
		const key = this.uriToS3Key(uri)
		const dirKey = key.endsWith('/') ? key : `${key}/`

		// Check if it's a directory
		try {
			const listCommand = new ListObjectsV2Command({
				Bucket: this.config.bucket,
				Prefix: dirKey,
				MaxKeys: 1,
			})
			const listResponse = await this.s3Client.send(listCommand)

			if (listResponse.Contents?.length || listResponse.CommonPrefixes?.length) {
				return { size: 0, isDirectory: true }
			}
		} catch {
			// Not a directory, try as file
		}

		// Try as file
		try {
			const command = new HeadObjectCommand({
				Bucket: this.config.bucket,
				Key: key,
			})
			const response = await this.s3Client.send(command)

			return {
				size: response.ContentLength ?? 0,
				isDirectory: false,
			}
		} catch (error: any) {
			if (error.name === 'NotFound' || error.name === 'NoSuchKey') {
				throw new Error(`File not found: ${uri}`)
			}
			throw error
		}
	}

	async readdir(uri: URI): Promise<Array<{ uri: URI; isDirectory: boolean }>> {
		const key = this.uriToS3Key(uri)
		const dirKey = key ? (key.endsWith('/') ? key : `${key}/`) : ''

		const command = new ListObjectsV2Command({
			Bucket: this.config.bucket,
			Prefix: dirKey,
			Delimiter: '/',
		})
		const response = await this.s3Client.send(command)

		const entries: Array<{ uri: URI; isDirectory: boolean }> = []

		// Add directories (CommonPrefixes)
		if (response.CommonPrefixes) {
			for (const prefix of response.CommonPrefixes) {
				if (prefix.Prefix) {
					entries.push({
						uri: this.s3KeyToURI(prefix.Prefix),
						isDirectory: true,
					})
				}
			}
		}

		// Add files (Contents)
		if (response.Contents) {
			for (const item of response.Contents) {
				if (item.Key && item.Key !== dirKey) {
					entries.push({
						uri: this.s3KeyToURI(item.Key),
						isDirectory: false,
					})
				}
			}
		}

		return entries
	}

	async findFiles(pattern: string, maxResults?: number): Promise<URI[]> {
		const manifest = await this.fetchManifest()
		return findFilesUtil(this.s3Client, this.config.bucket, pattern, {
			prefix: this.config.prefix,
			maxResults,
			manifest,
			s3KeyToURI: this.s3KeyToURI.bind(this),
		})
	}

	getConfig(): S3Config {
		return this.config
	}
}
