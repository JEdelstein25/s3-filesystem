import type { S3FileSystem } from './s3-filesystem.ts'

const GREP_MAX_TOTAL_RESULTS = 100
const GREP_MAX_RESULTS_PER_FILE = 10
const GREP_MAX_COLUMN_LENGTH = 200

export async function grepFiles(
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
