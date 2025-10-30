# S3 Virtual Filesystem

https://github.com/user-attachments/assets/ee9bb45e-448f-4bdb-b9c1-e4ad0836621a


This is a toolkit which mounts an S3 bucket as a read-only virtual filesystem. It provides filesystem-like tools for reading and searching files in AWS S3 buckets. Ideal for use in coding agents like Amp, Claude Code and Codex

# Tools

- **read**: Read a file from S3
- **list**: List directory contents
- **grep**: Search for text in files

# MCP

This includes an adapter to load the tools with an mcp server
