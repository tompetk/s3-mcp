import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  forcePathStyle: boolean;
  allowSelfSigned: boolean;
  caBundle?: string;
  allowWrite: boolean;
  allowedBuckets?: string[];
  maxReadBytes: number;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} must be a boolean (true/false), got: ${process.env[name]}`);
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${raw}`);
  }
  return n;
}

function parseBucketList(value: string | undefined): string[] | undefined {
  if (!value?.trim()) return undefined;
  const buckets = value
    .split(",")
    .map((b) => b.trim())
    .filter(Boolean);
  return buckets.length > 0 ? buckets : undefined;
}

function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function printHelp(): void {
  const version = readPackageVersion();
  process.stdout.write(`s3-mcp ${version}

Minimal MCP server for S3-compatible storage (AWS S3, RustFS, MinIO, Cloudflare R2, …).

Usage:
  s3-mcp [options]
  s3-mcp --stdio          (accepted for drop-in compatibility; ignored)

Options (override env vars):
  --endpoint <url>          S3 API endpoint (S3_ENDPOINT)
  --region <name>           Region (S3_REGION, default: us-east-1)
  --path-style              Force path-style addressing (default)
  --no-path-style           Use virtual-hosted-style addressing
  --insecure                Allow self-signed TLS certificates (S3_ALLOW_SELF_SIGNED)
  --ca-bundle <path>        Trust a custom CA PEM file (S3_CA_BUNDLE)
  --allow-write             Enable put/delete tools (S3_ALLOW_WRITE)
  --bucket <name>           Restrict tools to this bucket (repeatable; S3_ALLOWED_BUCKETS)
  --max-read-bytes <n>      Cap for s3_read_object (S3_MAX_READ_BYTES, default: 262144)
  --help, -h                Show this help
  --version, -v             Show version

Required environment variables:
  S3_ENDPOINT
  S3_ACCESS_KEY_ID
  S3_SECRET_ACCESS_KEY

Secrets are env-only by design (argv is visible in process listings).
`);
}

export function printVersion(): void {
  process.stdout.write(`${readPackageVersion()}\n`);
}

interface CliOverrides {
  endpoint?: string;
  region?: string;
  forcePathStyle?: boolean;
  allowSelfSigned?: boolean;
  caBundle?: string;
  allowWrite?: boolean;
  buckets?: string[];
  maxReadBytes?: number;
  help?: boolean;
  version?: boolean;
}

function parseArgs(argv: string[]): CliOverrides {
  const out: CliOverrides = {};
  const buckets: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    const need = (flag: string): string => {
      const next = argv[++i];
      if (!next || next.startsWith("-")) {
        throw new Error(`${flag} requires a value`);
      }
      return next;
    };

    switch (arg) {
      case "--help":
      case "-h":
        out.help = true;
        break;
      case "--version":
      case "-v":
        out.version = true;
        break;
      case "--stdio":
        // Drop-in compatibility with s3-mcp-server configs; transport is always stdio.
        break;
      case "--endpoint":
        out.endpoint = need(arg);
        break;
      case "--region":
        out.region = need(arg);
        break;
      case "--path-style":
        out.forcePathStyle = true;
        break;
      case "--no-path-style":
        out.forcePathStyle = false;
        break;
      case "--insecure":
        out.allowSelfSigned = true;
        break;
      case "--ca-bundle":
        out.caBundle = need(arg);
        break;
      case "--allow-write":
        out.allowWrite = true;
        break;
      case "--bucket":
        buckets.push(need(arg));
        break;
      case "--max-read-bytes": {
        const raw = need(arg);
        const n = Number.parseInt(raw, 10);
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error(`--max-read-bytes must be a positive integer, got: ${raw}`);
        }
        out.maxReadBytes = n;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${arg} (try --help)`);
    }
  }

  if (buckets.length > 0) out.buckets = buckets;
  return out;
}

export function loadConfig(argv: string[] = process.argv.slice(2)): Config | "help" | "version" {
  const cli = parseArgs(argv);
  if (cli.help) return "help";
  if (cli.version) return "version";

  const endpoint = (cli.endpoint ?? process.env.S3_ENDPOINT)?.trim();
  const accessKeyId = process.env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY?.trim();

  if (!endpoint) throw new Error("S3_ENDPOINT is required (or pass --endpoint)");
  if (!accessKeyId) throw new Error("S3_ACCESS_KEY_ID is required");
  if (!secretAccessKey) throw new Error("S3_SECRET_ACCESS_KEY is required");

  try {
    // Validate URL shape early; S3Client otherwise fails with a less helpful error.
    new URL(endpoint);
  } catch {
    throw new Error(`S3_ENDPOINT is not a valid URL: ${endpoint}`);
  }

  const allowedBuckets =
    cli.buckets ?? parseBucketList(process.env.S3_ALLOWED_BUCKETS);

  const caBundle = (cli.caBundle ?? process.env.S3_CA_BUNDLE)?.trim() || undefined;

  return {
    endpoint,
    accessKeyId,
    secretAccessKey,
    region: (cli.region ?? process.env.S3_REGION)?.trim() || "us-east-1",
    forcePathStyle: cli.forcePathStyle ?? envBool("S3_FORCE_PATH_STYLE", true),
    allowSelfSigned: cli.allowSelfSigned ?? envBool("S3_ALLOW_SELF_SIGNED", false),
    caBundle,
    allowWrite: cli.allowWrite ?? envBool("S3_ALLOW_WRITE", false),
    allowedBuckets,
    maxReadBytes: cli.maxReadBytes ?? envInt("S3_MAX_READ_BYTES", 262_144),
  };
}

export { readPackageVersion };
