# S3 Virtual Filesystem
This is a toolkit which mounts an S3 bucket as a read-only virtual filesystem. It provides filesystem-like tools for reading and searching files in AWS S3 buckets. Ideal for use in coding agents like Amp, Claude Code and Codex

https://github.com/user-attachments/assets/ee9bb45e-448f-4bdb-b9c1-e4ad0836621a


Perfect for navigating large blob storage and performing agentic search over compressed files.

## Features

- **Fast directory navigation** with automatic path collapsing for single-child directories
- **Metadata filtering** by size, modification date, and storage class
- **Pattern matching** with glob support
- **Automatic decompression** for gzip and zstd compressed files
- **Multi-layer caching** for optimal performance
- **MCP server** for integration with AI coding assistants

# Tools

- **read**: Read a file from S3
- **glob**: Search for glob patterns in file names
- **grep**: Search for text in files

# Caching

The toolkit uses a multi-layer caching system:

1. **Manifest cache** - Pre-indexed bucket metadata (5 min TTL)
2. **File content cache** - LRU cache for frequently accessed files
3. **Directory schema cache** - In-memory directory structure

Background file caching occurs automatically when using glob with <1000 results.

# MCP Integration

This includes an MCP server adapter for seamless integration with AI coding assistants. Configure your MCP client to connect to the server endpoint.

# Supported Formats

- **Compression**: gzip (`.gz`), zstd (`.zst`, `.zstd`)
- **Text files**: Any UTF-8 encoded file
- **Archives**: WARC, CDX, and other Common Crawl formats

# AWS Credentials

The toolkit uses standard AWS credential resolution:
- Environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`)
- Shared credentials file (`~/.aws/credentials`)
- IAM roles (for EC2/ECS)

# License

MIT
