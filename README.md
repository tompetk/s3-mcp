# s3-mcp

Minimal [Model Context Protocol](https://modelcontextprotocol.io) server for **S3-compatible** storage — AWS S3, [RustFS](https://rustfs.com), MinIO, Cloudflare R2, and similar.

- Path-style addressing by default (required for many self-hosted endpoints whose TLS cert does not cover `bucket.endpoint` subdomains)
- Opt-in self-signed / custom-CA TLS trust, scoped to the S3 client only
- Read-only by default; writes require an explicit flag
- Optional bucket allow-list
- Env vars + CLI flag overrides; secrets stay env-only

## Tools

| Tool | Access | Description |
|------|--------|-------------|
| `s3_list_buckets` | read | List buckets |
| `s3_list_objects` | read | List objects (`prefix`, `delimiter`, pagination). Listing does **not** return user metadata — use `s3_head_object`. |
| `s3_head_object` | read | Size, ETag, content-type, user metadata |
| `s3_read_object` | read | Read body via a capped `Range` request (`encoding`: `auto` \| `utf8` \| `base64`) |
| `s3_put_object` | write | Upload text or base64 content |
| `s3_delete_object` | write | Delete object (idempotent: missing key → success) |

Write tools refuse with a clear error unless `S3_ALLOW_WRITE=true` (or `--allow-write`).

## Install / run

### npx (recommended)

```json
{
  "mcpServers": {
    "s3": {
      "command": "npx",
      "args": ["-y", "s3-mcp"],
      "env": {
        "S3_ENDPOINT": "https://rustfs.example.com",
        "S3_ACCESS_KEY_ID": "<key>",
        "S3_SECRET_ACCESS_KEY": "<secret>",
        "S3_REGION": "us-east-1",
        "S3_ALLOW_SELF_SIGNED": "true"
      }
    }
  }
}
```

A bare `--stdio` arg is accepted and ignored (drop-in compatible with configs written for `s3-mcp-server`).

### npx straight from GitHub

```json
{
  "mcpServers": {
    "s3": {
      "command": "npx",
      "args": ["-y", "github:tompetk/s3-mcp"],
      "env": {
        "S3_ENDPOINT": "https://rustfs.example.com",
        "S3_ACCESS_KEY_ID": "<key>",
        "S3_SECRET_ACCESS_KEY": "<secret>",
        "S3_REGION": "us-east-1",
        "S3_ALLOW_SELF_SIGNED": "true"
      }
    }
  }
}
```

Keep `-y`: without it npx asks for install confirmation on stdin, which is the MCP transport, so the server never starts. The first run takes roughly 40 seconds because npm installs TypeScript and runs the `prepare` build; later runs use the npx cache. The published npm package ships prebuilt `dist/`, so `["-y", "s3-mcp"]` starts instantly.

### From source

```bash
git clone https://github.com/tompetk/s3-mcp.git
cd s3-mcp
npm install
npm run build
node dist/index.js --help
```

Point your MCP client at `node` + the absolute path to `dist/index.js`.

## Configuration examples

### RustFS / MinIO (self-hosted, often self-signed)

```json
{
  "mcpServers": {
    "s3": {
      "command": "npx",
      "args": ["-y", "s3-mcp", "--insecure"],
      "env": {
        "S3_ENDPOINT": "https://rustfs.example.com",
        "S3_ACCESS_KEY_ID": "<key>",
        "S3_SECRET_ACCESS_KEY": "<secret>",
        "S3_REGION": "us-east-1",
        "S3_FORCE_PATH_STYLE": "true",
        "S3_ALLOW_WRITE": "false"
      }
    }
  }
}
```

Prefer a custom CA when you have one:

```bash
S3_CA_BUNDLE=/path/to/ca.pem
```

`--insecure` / `S3_ALLOW_SELF_SIGNED=true` disables certificate verification for **this client only** (never sets `NODE_TLS_REJECT_UNAUTHORIZED`). Prefer `S3_CA_BUNDLE` when possible.

### Cloudflare R2

```json
{
  "mcpServers": {
    "s3": {
      "command": "npx",
      "args": ["-y", "s3-mcp", "--no-path-style"],
      "env": {
        "S3_ENDPOINT": "https://<ACCOUNT_ID>.r2.cloudflarestorage.com",
        "S3_ACCESS_KEY_ID": "<key>",
        "S3_SECRET_ACCESS_KEY": "<secret>",
        "S3_REGION": "auto"
      }
    }
  }
}
```

## Environment variables & flags

| Env | Flag | Default | Notes |
|-----|------|---------|-------|
| `S3_ENDPOINT` | `--endpoint` | _(required)_ | S3 API URL |
| `S3_ACCESS_KEY_ID` | — | _(required)_ | Env only (argv is visible in `ps`) |
| `S3_SECRET_ACCESS_KEY` | — | _(required)_ | Env only |
| `S3_REGION` | `--region` | `us-east-1` | Use `auto` for R2 |
| `S3_FORCE_PATH_STYLE` | `--path-style` / `--no-path-style` | `true` | Path-style is the safe default for self-hosted |
| `S3_ALLOW_SELF_SIGNED` | `--insecure` | `false` | Skip TLS verify (logs a stderr warning) |
| `S3_CA_BUNDLE` | `--ca-bundle` | — | PEM file to trust |
| `S3_ALLOW_WRITE` | `--allow-write` | `false` | Enable put/delete |
| `S3_ALLOWED_BUCKETS` | `--bucket` (repeatable) | — | Comma-separated allow-list |
| `S3_MAX_READ_BYTES` | `--max-read-bytes` | `262144` | Cap for `s3_read_object` |
| — | `--stdio` | — | Accepted, ignored |
| — | `--help` / `--version` | — | |

CLI flags override env vars.

## Security

- **Read-only by default.** Pointing this at production buckets without `S3_ALLOW_WRITE` cannot mutate data via the MCP tools.
- **Bucket allow-list.** Set `S3_ALLOWED_BUCKETS=prod-logs,prod-artifacts` (or repeat `--bucket`) so the agent cannot touch other buckets the credentials can see.
- **TLS.** Prefer `S3_CA_BUNDLE` over `--insecure`. Self-signed mode is convenient for lab endpoints; it is not a substitute for trusting the right CA.
- **Secrets.** Keep keys in the MCP client's `env` block or a secret store — never commit them. `.env` is gitignored; use `.env.example` as a template for local smoke tests.

## Development

```bash
npm install
npm run build
npm run typecheck

# Live round-trip (creates a throwaway bucket unless S3_BUCKET is set)
export S3_ENDPOINT=https://rustfs.example.com
export S3_ACCESS_KEY_ID=...
export S3_SECRET_ACCESS_KEY=...
npm run smoke

# Read-only credentials (list + head + ranged get)
S3_SMOKE_READ_ONLY=true S3_BUCKET=test npm run smoke
```


## Publishing

Tags matching `v*` trigger GitHub Actions to build and `npm publish --provenance --access public`. Add an `NPM_TOKEN` repository secret once.

```bash
git tag v1.0.0
git push origin v1.0.0
```

## License

MIT
