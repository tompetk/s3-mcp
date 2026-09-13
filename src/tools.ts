import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "./config.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function fail(message: string): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

const TLS_HINT_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

function collectErrorCodes(err: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = err;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const e = current as { code?: string; name?: string; cause?: unknown; errno?: string };
    if (typeof e.code === "string") codes.push(e.code);
    if (typeof e.name === "string") codes.push(e.name);
    if (typeof e.errno === "string") codes.push(e.errno);
    current = e.cause;
  }
  return codes;
}

function mapError(err: unknown): ToolResult {
  const e = err as {
    message?: string;
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };

  const codes = collectErrorCodes(err);
  const name = e.name ?? e.Code ?? codes[0] ?? "Error";
  const status = e.$metadata?.httpStatusCode;
  let message = e.message ?? String(err);

  const tlsHit = codes.find((c) => TLS_HINT_CODES.has(c));
  if (tlsHit) {
    message +=
      `\n\nTLS hint (${tlsHit}): set S3_CA_BUNDLE=/path/to/ca.pem to trust your CA, ` +
      `or S3_ALLOW_SELF_SIGNED=true / --insecure to skip verification (less secure).`;
  }

  const payload: Record<string, unknown> = {
    error: true,
    name,
    message,
  };
  if (status !== undefined) payload.httpStatusCode = status;
  if (codes.length > 0) payload.codes = [...new Set(codes)];

  return fail(JSON.stringify(payload, null, 2));
}

function assertBucketAllowed(config: Config, bucket: string): void {
  if (!config.allowedBuckets || config.allowedBuckets.length === 0) return;
  if (!config.allowedBuckets.includes(bucket)) {
    throw new Error(
      `Bucket "${bucket}" is not in S3_ALLOWED_BUCKETS (${config.allowedBuckets.join(", ")})`,
    );
  }
}

function assertWriteAllowed(config: Config): void {
  if (!config.allowWrite) {
    throw new Error(
      "Write tools are disabled. Set S3_ALLOW_WRITE=true (or pass --allow-write) to enable put/delete.",
    );
  }
}

async function streamToBuffer(body: unknown): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (
    typeof (body as { transformToByteArray?: () => Promise<Uint8Array> }).transformToByteArray ===
    "function"
  ) {
    const bytes = await (
      body as { transformToByteArray: () => Promise<Uint8Array> }
    ).transformToByteArray();
    return Buffer.from(bytes);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer | Uint8Array | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function looksLikeUtf8(buf: Buffer): boolean {
  // Reject obvious binary: NUL bytes or replacement characters after decode.
  if (buf.includes(0)) return false;
  const text = buf.toString("utf8");
  if (text.includes("\uFFFD")) return false;
  return true;
}

export function registerTools(server: McpServer, client: S3Client, config: Config): void {
  server.registerTool(
    "s3_list_buckets",
    {
      title: "List S3 buckets",
      description: "List all available S3 buckets visible to the configured credentials.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async () => {
      try {
        const out = await client.send(new ListBucketsCommand({}));
        let buckets = (out.Buckets ?? []).map((b) => ({
          name: b.Name,
          creationDate: b.CreationDate?.toISOString(),
        }));
        if (config.allowedBuckets && config.allowedBuckets.length > 0) {
          const allowed = new Set(config.allowedBuckets);
          buckets = buckets.filter((b) => b.name && allowed.has(b.name));
        }
        return ok({ buckets, count: buckets.length });
      } catch (err) {
        return mapError(err);
      }
    },
  );

  server.registerTool(
    "s3_list_objects",
    {
      title: "List S3 objects",
      description:
        "List objects in a bucket. Optional prefix/delimiter for folder-style browsing. " +
        "Note: S3 ListObjectsV2 does not return user metadata — use s3_head_object for that.",
      inputSchema: {
        bucket: z.string().describe("Bucket name"),
        prefix: z.string().optional().describe("Key prefix filter"),
        delimiter: z
          .string()
          .optional()
          .describe('Delimiter for common prefixes (e.g. "/")'),
        maxKeys: z
          .number()
          .int()
          .positive()
          .max(1000)
          .optional()
          .describe("Max keys to return (default 1000)"),
        continuationToken: z
          .string()
          .optional()
          .describe("Pagination token from a previous response"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ bucket, prefix, delimiter, maxKeys, continuationToken }) => {
      try {
        assertBucketAllowed(config, bucket);
        const out = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            Delimiter: delimiter,
            MaxKeys: maxKeys ?? 1000,
            ContinuationToken: continuationToken,
          }),
        );
        return ok({
          bucket,
          prefix: prefix ?? null,
          delimiter: delimiter ?? null,
          keyCount: out.KeyCount ?? 0,
          isTruncated: out.IsTruncated ?? false,
          nextContinuationToken: out.NextContinuationToken ?? null,
          objects: (out.Contents ?? []).map((o) => ({
            key: o.Key,
            size: o.Size,
            lastModified: o.LastModified?.toISOString(),
            etag: o.ETag,
            storageClass: o.StorageClass,
          })),
          commonPrefixes: (out.CommonPrefixes ?? [])
            .map((p) => p.Prefix)
            .filter((p): p is string => Boolean(p)),
        });
      } catch (err) {
        return mapError(err);
      }
    },
  );

  server.registerTool(
    "s3_head_object",
    {
      title: "Head S3 object",
      description:
        "Fetch object metadata without downloading the body (size, ETag, content-type, user metadata).",
      inputSchema: {
        bucket: z.string().describe("Bucket name"),
        key: z.string().describe("Object key"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ bucket, key }) => {
      try {
        assertBucketAllowed(config, bucket);
        const out = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return ok({
          bucket,
          key,
          contentLength: out.ContentLength,
          contentType: out.ContentType,
          etag: out.ETag,
          lastModified: out.LastModified?.toISOString(),
          metadata: out.Metadata ?? {},
          storageClass: out.StorageClass,
          versionId: out.VersionId,
        });
      } catch (err) {
        return mapError(err);
      }
    },
  );

  server.registerTool(
    "s3_read_object",
    {
      title: "Read S3 object",
      description:
        "Read object content. Uses a Range request capped by maxBytes so large objects never stream in full. " +
        "encoding=auto returns UTF-8 text when decodable, otherwise base64.",
      inputSchema: {
        bucket: z.string().describe("Bucket name"),
        key: z.string().describe("Object key"),
        encoding: z
          .enum(["auto", "utf8", "base64"])
          .optional()
          .describe("How to encode the body (default: auto)"),
        maxBytes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Max bytes to read (default: ${config.maxReadBytes})`),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ bucket, key, encoding, maxBytes }) => {
      try {
        assertBucketAllowed(config, bucket);
        const limit = maxBytes ?? config.maxReadBytes;
        const out = await client.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: key,
            // Inclusive Range: 0..(limit-1) → at most `limit` bytes.
            Range: `bytes=0-${limit - 1}`,
          }),
        );

        const body = await streamToBuffer(out.Body);
        const contentLength = out.ContentLength;
        // Content-Range: bytes 0-N/TOTAL — use TOTAL when available.
        let totalSize: number | undefined;
        const contentRange = out.ContentRange;
        if (contentRange) {
          const m = /\/(\d+)$/.exec(contentRange);
          if (m) totalSize = Number.parseInt(m[1]!, 10);
        }
        if (totalSize === undefined && typeof contentLength === "number") {
          // Without a Range response ContentLength is the full object size when untruncated.
          totalSize = contentLength;
        }

        const truncated =
          totalSize !== undefined ? totalSize > body.length : body.length >= limit;
        const enc = encoding ?? "auto";

        let content: string;
        let usedEncoding: "utf8" | "base64";
        if (enc === "base64") {
          content = body.toString("base64");
          usedEncoding = "base64";
        } else if (enc === "utf8") {
          content = body.toString("utf8");
          usedEncoding = "utf8";
        } else if (looksLikeUtf8(body)) {
          content = body.toString("utf8");
          usedEncoding = "utf8";
        } else {
          content = body.toString("base64");
          usedEncoding = "base64";
        }

        return ok({
          bucket,
          key,
          content,
          encoding: usedEncoding,
          bytesRead: body.length,
          totalSize: totalSize ?? null,
          truncated,
          contentType: out.ContentType,
          etag: out.ETag,
          lastModified: out.LastModified?.toISOString(),
        });
      } catch (err) {
        return mapError(err);
      }
    },
  );

  server.registerTool(
    "s3_put_object",
    {
      title: "Put S3 object",
      description:
        "Upload object content. Requires S3_ALLOW_WRITE=true. " +
        "Pass encoding=base64 to upload binary data from a base64 string.",
      inputSchema: {
        bucket: z.string().describe("Bucket name"),
        key: z.string().describe("Object key"),
        content: z.string().describe("Object body (text or base64)"),
        encoding: z
          .enum(["utf8", "base64"])
          .optional()
          .describe("How to decode content (default: utf8)"),
        contentType: z.string().optional().describe("Content-Type header"),
        metadata: z
          .record(z.string())
          .optional()
          .describe("User metadata key/value map"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ bucket, key, content, encoding, contentType, metadata }) => {
      try {
        assertWriteAllowed(config);
        assertBucketAllowed(config, bucket);
        const body =
          (encoding ?? "utf8") === "base64"
            ? Buffer.from(content, "base64")
            : Buffer.from(content, "utf8");

        const out = await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: contentType,
            Metadata: metadata,
          }),
        );
        return ok({
          bucket,
          key,
          etag: out.ETag,
          versionId: out.VersionId,
          bytes: body.length,
        });
      } catch (err) {
        return mapError(err);
      }
    },
  );

  server.registerTool(
    "s3_delete_object",
    {
      title: "Delete S3 object",
      description:
        "Delete an object. Requires S3_ALLOW_WRITE=true. Idempotent: missing keys (NoSuchKey/404) are treated as success.",
      inputSchema: {
        bucket: z.string().describe("Bucket name"),
        key: z.string().describe("Object key"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ bucket, key }) => {
      try {
        assertWriteAllowed(config);
        assertBucketAllowed(config, bucket);
        try {
          await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
          return ok({ bucket, key, deleted: true });
        } catch (err) {
          const e = err as {
            name?: string;
            Code?: string;
            $metadata?: { httpStatusCode?: number };
          };
          const name = e.name ?? e.Code;
          const status = e.$metadata?.httpStatusCode;
          if (name === "NoSuchKey" || name === "NotFound" || status === 404) {
            return ok({ bucket, key, deleted: true, alreadyMissing: true });
          }
          throw err;
        }
      } catch (err) {
        return mapError(err);
      }
    },
  );
}
