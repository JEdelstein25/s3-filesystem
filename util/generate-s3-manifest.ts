#!/usr/bin/env tsx
/**
 * Generate a manifest file for an S3 bucket to speed up file searches.
 *
 * Usage:
 *   bun run util/generate-s3-manifest.ts <bucket> [prefix] [region]
 *
 * Examples:
 *   bun run util/generate-s3-manifest.ts covid19-lake enigma-jhu us-east-1
 *   bun run util/generate-s3-manifest.ts 1000genomes "" us-east-1
 *
 * This will create a local manifest JSON file containing a list of all files in the bucket.
 */

/* eslint-disable no-console */

import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'

interface S3Manifest {
	files: string[]
	lastUpdated: string
	version?: number
}

const MANIFEST_KEY = '.amp-manifest.json'

async function generateManifest(bucket: string, prefix?: string, region?: string) {
	// AWS SDK will automatically load credentials from:
	// - Environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
	// - Shared credentials file (~/.aws/credentials)
	// - IAM role for EC2/ECS
	const s3Client = new S3Client({ region: region || 'us-east-1' })

	console.log(`Generating manifest for s3://${bucket}${prefix ? `/${prefix}` : ''}`)
	console.log('This may take a while for large buckets...')

	const files: string[] = []
	let continuationToken: string | undefined
	let pageCount = 0

	// List all objects in the bucket
	do {
		pageCount++
		console.log(`Fetching page ${pageCount}...`)

		const command = new ListObjectsV2Command({
			Bucket: bucket,
			Prefix: prefix,
			MaxKeys: 1000,
			ContinuationToken: continuationToken,
		})

		const response = await s3Client.send(command)

		if (response.Contents) {
			for (const item of response.Contents) {
				if (item.Key && item.Key !== MANIFEST_KEY) {
					files.push(item.Key)
				}
			}
		}

		console.log(`  Found ${response.Contents?.length || 0} objects (${files.length} total)`)

		continuationToken = response.NextContinuationToken
	} while (continuationToken)

	// Create manifest
	const manifest: S3Manifest = {
		files,
		lastUpdated: new Date().toISOString(),
		version: 1,
	}

	// Save manifest locally
	const manifestContent = JSON.stringify(manifest, null, 2)
	const fs = await import('node:fs/promises')
	const localPath = `${bucket.replace(/[^a-z0-9]/gi, '-')}-manifest.json`
	
	await fs.writeFile(localPath, manifestContent, 'utf8')

	console.log(`\nTotal files: ${files.length}`)
	console.log(`Manifest size: ${(manifestContent.length / 1024).toFixed(2)} KB`)
	console.log(`✓ Manifest saved to: ${localPath}`)
}

// Parse command line arguments
const args = process.argv.slice(2)

if (args.length < 1) {
	console.error('Usage: bun run util/generate-s3-manifest.ts <bucket> [prefix] [region]')
	console.error('Example: bun run util/generate-s3-manifest.ts 1000genomes "" us-east-1')
	console.error('\nMake sure AWS credentials are configured in .env or ~/.aws/credentials')
	process.exit(1)
}

const [bucket, prefix, region] = args

generateManifest(bucket, prefix, region).catch((error) => {
	console.error('Error generating manifest:', error)
	process.exit(1)
})
