# S3 Virtual Filesystem
This is a toolkit which mounts an S3 bucket as a read-only virtual filesystem. It provides filesystem-like tools for reading and searching files in AWS S3 buckets. Ideal for use in coding agents like Amp, Claude Code and Codex

https://github.com/user-attachments/assets/ee9bb45e-448f-4bdb-b9c1-e4ad0836621a


Perfect for navigating large blob storage and performing agentic search over compressed files.

## Quick Start

**1. Generate a manifest** (indexes your bucket for fast searches):
```bash
bun run util/generate-s3-manifest.ts <bucket> [prefix] [region]
```

**2. Start the MCP server**:
```bash
S3_BUCKET=your-bucket S3_REGION=us-east-1 bun run src/server.ts
```

**3. Configure Amp** (add to `.amp/settings.json`):
```json
{	
	"amp.mcpServers": {
		"s3_filesystem": {
			"url": "http://localhost:7011/sse"
		}
	}
}
```

## Tools

- **read** - Read files or list directories
- **glob** - Find files by pattern (`**/*.json`)
- **grep** - Search file contents (requires cache)
- **filter_metadata** - Filter by size, date, storage class

## Features

- **Fast** - Manifest-based directory listings (no S3 API calls)
- **Smart** - Auto-decompresses `.gz` and `.zst` files
- **Cached** - LRU cache for frequently accessed files

## AWS Credentials

Uses standard AWS credential resolution:
- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`
- `~/.aws/credentials`
- IAM roles

## License

GPL-3.0
