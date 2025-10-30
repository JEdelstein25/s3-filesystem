# S3 Virtual Filesystem

Amp was here

A lightweight toolkit that mounts S3 buckets as a read-only virtual filesystem, making it easy to work with cloud storage using familiar file operations. Perfect for browsing, reading, and searching through S3 data without downloading everything locally.

## Why?

Ever needed to quickly peek at files in S3 without spinning up the AWS console or downloading gigabytes of data? This tool lets you treat S3 buckets like local directories - just point it at a bucket and start reading files, listing contents, and searching through your cloud storage as if it were on your machine.

## Tools

- **read** - Read file contents from S3
- **list** - Browse directory structures
- **search** - Find files across your bucket

Built with Bun for speed and simplicity.