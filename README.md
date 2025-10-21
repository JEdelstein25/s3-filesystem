# S3 MCP Server

An MCP (Model Context Protocol) server that provides filesystem-like tools for reading and searching files in AWS S3 buckets.

## Features

- **Read**: Read files or list directories from S3 with line numbering
- **Grep**: Search for text patterns using ripgrep on cached files (with fallback to in-memory regex)
- **glob**: Find files matching glob patterns with manifest support and automatic file caching

The server implements a self-contained S3 filesystem with:
- **Manifest caching** (5 minutes TTL) for fast file discovery
- **LRU file cache** (2GB max) - glob automatically downloads files for fast grep
- **Ripgrep integration** - grep uses ripgrep on cached files for speed
- **Fallback mode** - grep falls back to in-memory search if no files are cached

**Dependencies:**
- `@aws-sdk/client-s3` - AWS S3 client
- `@modelcontextprotocol/sdk` - MCP protocol implementation
- `@vscode/ripgrep` - Fast text search binary
- `lru-cache` - LRU cache for file caching
- `picomatch` - Glob pattern matching
- `vscode-uri` - Microsoft's URI parsing library

## Setup

### Environment Variables

Required:
- `S3_BUCKET`: The S3 bucket name (e.g., `1000genomes`)

Optional:
- `S3_PREFIX`: Prefix/path within the bucket (e.g., `changelog_details/`)
- `S3_REGION` or `AWS_REGION`: AWS region (defaults to AWS SDK default)
- `PORT`: Server port (default: 7011)

AWS credentials should be configured via:
- Environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`)
- AWS credentials file (`~/.aws/credentials`)
- IAM role (when running on EC2/ECS)

### Running the Server

```bash
# From the amp-s3 root directory
cd contrib/mcp-s3
S3_BUCKET=1000genomes S3_PREFIX=changelog_details/ node src/server.ts
```

Note: Since this uses the workspace's shared node_modules (managed by pnpm), run it from the workspace root context.

## Manifest Support

For better performance with large buckets, you can generate a manifest file:

```bash
# From the amp-s3 root directory
pnpm tsx core/scripts/generate-s3-manifest.ts \
  --bucket 1000genomes \
  --prefix changelog_details/ \
  --output 1000genomes-manifest.json \
  --upload
```

The manifest (`.amp-manifest.json`) is cached for 5 minutes to reduce API calls.

## Usage with Amp

### 1. Start the MCP Server

First, start the S3 MCP server in a terminal:

```bash
cd contrib/mcp-s3
S3_BUCKET=1000genomes S3_PREFIX=changelog_details/ node --experimental-strip-types --no-warnings=ExperimentalWarning src/server.ts
```

The server will start on port 7011 by default.

### 2. Configure Amp

Add the MCP server to your Amp settings. You can do this in:
- **VS Code**: `.vscode/settings.json` or User/Workspace Settings
- **CLI**: `~/.config/amp/settings.json`
- **Web**: User settings

```json
{
  "amp.mcpServers": {
    "s3-1000genomes": {
      "url": "http://localhost:7011/sse"
    }
  }
}
```

Or start it as a subprocess (Amp manages the process):

```json
{
  "amp.mcpServers": {
    "s3-1000genomes": {
      "command": "node",
      "args": [
        "--experimental-strip-types",
        "--no-warnings=ExperimentalWarning",
        "/absolute/path/to/amp-s3/contrib/mcp-s3/src/server.ts"
      ],
      "env": {
        "S3_BUCKET": "1000genomes",
        "S3_PREFIX": "changelog_details/"
      }
    }
  }
}
```

### 3. Grant Permissions

Add MCP permissions to allow the server:

```json
{
  "amp.mcpPermissions": [
    {
      "matches": { "command": "node" },
      "allow": true
    }
  ]
}
```

Or for URL-based:

```json
{
  "amp.mcpPermissions": [
    {
      "matches": { "url": "http://localhost:7011/sse" },
      "allow": true
    }
  ]
}
```

### 4. Use the Tools

Now you can use the S3 tools in Amp threads:
- "Read the file s3://1000genomes/changelog_details/README.md"
- "Find all .txt files in S3 using glob **/*.txt"
- "Search for 'error' in all log files using Grep"
- "List the contents of s3://1000genomes/changelog_details/"
