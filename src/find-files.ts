import {
	ListObjectsV2Command,
	type ListObjectsV2CommandInput,
	type S3Client,
} from '@aws-sdk/client-s3'
import { minimatch } from 'minimatch'
import type { S3ObjectMetadata } from './s3-filesystem.ts'

export interface S3Manifest {
	files: S3ObjectMetadata[]
	lastUpdated: string
	version?: number
}

/**
 * Extract the fixed (non-glob) prefix from a glob pattern.
 * This allows us to optimize S3 listing by narrowing the prefix.
 *
 * @example
 * extractFixedPrefix('src/components/*.ts') // returns 'src/components/'
 * extractFixedPrefix('**\/*.ts') // returns ''
 */
export function extractFixedPrefix(pattern: string): string {
	const parts = pattern.split('/')
	const fixedParts: string[] = []

	for (const part of parts) {
		// Stop when we encounter a glob character
		if (part.includes('*') || part.includes('?') || part.includes('[') || part.includes('{')) {
			break
		}
		fixedParts.push(part)
	}

	return fixedParts.length > 0 ? fixedParts.join('/') + '/' : ''
}

/**
 * Match a path against a glob pattern using minimatch
 */
export function matchGlob(pattern: string, path: string): boolean {
	return minimatch(path, pattern, { dot: true })
}

/**
 * Find files in S3 bucket matching a glob pattern.
 * Uses manifest if available for faster lookups, falls back to ListObjectsV2.
 */
export async function findFiles(
	s3Client: S3Client,
	bucket: string,
	pattern: string,
	options: {
		prefix?: string
		maxResults?: number
		manifest?: S3Manifest | null
		keyToS3Uri: (key: string) => string
	},
): Promise<string[]> {
	const { prefix = '', maxResults, manifest, keyToS3Uri } = options

	console.log(`[findFiles] Pattern: ${pattern}, maxResults: ${maxResults}`)

	// Try manifest first
	if (manifest) {
		console.log(`[findFiles] Using manifest with ${manifest.files.length} files`)

		// Extract fixed prefix to optimize filtering
		const fixedPrefix = extractFixedPrefix(pattern)
		const fullPrefix = prefix ? `${prefix}${fixedPrefix}` : fixedPrefix

		const matched: string[] = []
		for (const fileMetadata of manifest.files) {
			const file = fileMetadata.key
			// Quick prefix check before glob matching
			if (!fullPrefix || file.startsWith(fullPrefix)) {
				if (matchGlob(pattern, file)) {
					matched.push(keyToS3Uri(file))
					if (maxResults && matched.length >= maxResults) {
						return matched
					}
				}
			}
		}
		return matched
	}

	// Fallback to list objects
	// Extract fixed prefix from pattern to optimize S3 listing
	const fixedPrefix = extractFixedPrefix(pattern)
	const fullPrefix = prefix ? `${prefix}${fixedPrefix}` : fixedPrefix

	console.log(
		`[findFiles] No manifest, listing S3 objects in bucket: ${bucket}, prefix: ${fullPrefix || '(root)'}`,
	)
	const files: string[] = []
	let continuationToken: string | undefined
	let iterationCount = 0

	do {
		iterationCount++
		console.log(`[findFiles] Listing iteration ${iterationCount}`)

		const listParams: ListObjectsV2CommandInput = {
			Bucket: bucket,
			Prefix: fullPrefix,
			MaxKeys: maxResults ? Math.min(1000, maxResults - files.length) : 1000,
			ContinuationToken: continuationToken,
		}

		const command = new ListObjectsV2Command(listParams)
		const response = await s3Client.send(command)
		console.log(
			`[findFiles] Response: ${response.Contents?.length || 0} objects, KeyCount: ${response.KeyCount}`,
		)

		if (response.Contents) {
			for (const item of response.Contents) {
				if (item.Key && !item.Key.endsWith('/')) {
					// Match against the full pattern (with prefix if present)
					const matchPath = item.Key.startsWith(prefix) ? item.Key.slice(prefix.length) : item.Key

					if (matchGlob(pattern, matchPath)) {
						files.push(keyToS3Uri(item.Key))
						if (maxResults && files.length >= maxResults) {
							console.log(`[findFiles] Reached maxResults limit: ${maxResults}`)
							return files
						}
					}
				}
			}
		}

		continuationToken = response.NextContinuationToken

		// Stop early if we've reached maxResults
		if (maxResults && files.length >= maxResults) {
			console.log(`[findFiles] Stopping early at maxResults: ${maxResults}`)
			break
		}
	} while (continuationToken)

	console.log(`[findFiles] Total files found: ${files.length}`)
	return files
}
