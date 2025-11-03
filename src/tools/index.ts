import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { readTool, handleRead } from './read.ts'
import { grepTool, handleGrep } from './grep.ts'
import { globTool, handleGlob } from './glob.ts'
import { filterMetadataTool, handleFilterMetadata } from './filter-metadata.ts'
import type { S3FileSystem } from '../s3-filesystem.ts'
import type { S3FileCache } from '../s3-file-cache.ts'

export const tools = [readTool, grepTool, globTool, filterMetadataTool]

export type ToolHandler = (
	args: any,
	filesystem: S3FileSystem,
	fileCache?: S3FileCache,
) => Promise<CallToolResult>

export const toolHandlers: Record<string, ToolHandler> = {
	read: handleRead,
	grep: handleGrep,
	glob: handleGlob,
	filter_metadata: handleFilterMetadata,
}

export type ToolName = keyof typeof toolHandlers
