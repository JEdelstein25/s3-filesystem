import {
	GetObjectCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	S3Client,
} from '@aws-sdk/client-s3'
import { URI } from 'vscode-uri'
import { findFiles as findFilesUtil } from './find-files.ts'

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

const MANIFEST_KEY = '.amp-manifest.json'
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
				console.log('[fetchManifest] Using cached manifest')
				return this.manifestCache.data
			}
		}

		try {
			const manifestKey = this.config.prefix
				? `${this.config.prefix}${MANIFEST_KEY}`
				: MANIFEST_KEY
			console.log(`[fetchManifest] Fetching manifest from key: ${manifestKey}`)
			const command = new GetObjectCommand({
				Bucket: this.config.bucket,
				Key: manifestKey,
			})
			const response = await this.s3Client.send(command)

			if (!response.Body) {
				return null
			}

			const content = await response.Body.transformToString()
			const manifest = JSON.parse(content) as S3Manifest

			console.log(`[fetchManifest] Loaded manifest with ${manifest.files.length} files`)
			this.manifestCache = { data: manifest, fetchedAt: Date.now() }
			return manifest
		} catch (error: any) {
			if (error.name === 'NotFound' || error.name === 'NoSuchKey') {
				console.log('[fetchManifest] Manifest not found')
				return null
			}
			console.warn('[fetchManifest] Failed to fetch S3 manifest:', error.message)
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

			return await response.Body.transformToString()
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
