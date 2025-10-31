# S3 Virtual Filesystem
This is a toolkit which mounts an S3 bucket as a read-only virtual filesystem. It provides filesystem-like tools for reading and searching files in AWS S3 buckets. Ideal for use in coding agents like Amp, Claude Code and Codex


https://github.com/user-attachments/assets/f49d74b8-0d90-4d2d-b471-be203f00059c





Perfect for navigating large blob storage and performing agentic search over compressed files.

# Tools

- **read**: Read a file from S3
- **glob**: Search for glob patterns in file names
- **grep**: Search for text in files

# Caching

This uses a multilayer cache. Before using it you should generate a manifest of the bucket metadata. This will improve speed. 

The tools dynamically cache full file contents as needed, and also cache the results of the list and grep tools.

# MCP

This includes an adapter to load the tools with an mcp server
