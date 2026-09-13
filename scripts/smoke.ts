#!/usr/bin/env tsx
/**
 * Live round-trip smoke test against a real S3-compatible endpoint.
 *
 * Required env:
 *   S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY
 * Optional:
 *   S3_REGION, S3_ALLOW_SELF_SIGNED, S3_CA_BUNDLE, S3_FORCE_PATH_STYLE,
 *   S3_BUCKET (existing bucket to use; otherwise creates a throwaway one)
 *   S3_SMOKE_READ_ONLY=true  (list/head/ranged-get only; for read-only credentials)
 */
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { createS3Client } from "../src/client.js";
import { loadConfig } from "../src/config.js";

async function streamToBuffer(body: unknown): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  if (
    typeof (body as { transformToByteArray?: () => Promise<Uint8Array> }).transformToByteArray ===
    "function"
  ) {
    return Buffer.from(
      await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray(),
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer | Uint8Array>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function isAccessDenied(err: unknown): boolean {
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e.name === "AccessDenied" ||
    e.Code === "AccessDenied" ||
    e.$metadata?.httpStatusCode === 403
  );
}

async function main(): Promise<void> {
  // Force writes on for the smoke path regardless of S3_ALLOW_WRITE.
  process.env.S3_ALLOW_WRITE = "true";
  const readOnly = ["1", "true", "yes"].includes(
    (process.env.S3_SMOKE_READ_ONLY ?? "").trim().toLowerCase(),
  );

  const loaded = loadConfig([]);
  if (loaded === "help" || loaded === "version") {
    throw new Error("unexpected help/version from loadConfig");
  }
  const config = loaded;
  const client = createS3Client(config);

  const existingBucket = process.env.S3_BUCKET?.trim();
  const stamp = Date.now().toString(36);
  const bucket = existingBucket ?? `s3-mcp-smoke-${stamp}`;
  let createdBucket = !existingBucket && !readOnly;
  const key = `smoke/${stamp}.txt`;
  const payload = `s3-mcp smoke ${stamp}\n`;

  console.log(
    JSON.stringify({
      step: "config",
      endpoint: config.endpoint,
      bucket,
      key,
      readOnly,
    }),
  );

  try {
    const listed = await client.send(new ListBucketsCommand({}));
    console.log(
      JSON.stringify({
        step: "list_buckets",
        ok: true,
        count: listed.Buckets?.length ?? 0,
      }),
    );

    if (readOnly) {
      const target =
        existingBucket ?? listed.Buckets?.[0]?.Name ?? undefined;
      if (!target) throw new Error("read-only smoke needs S3_BUCKET or at least one bucket");
      const objects = await client.send(
        new ListObjectsV2Command({ Bucket: target, MaxKeys: 5 }),
      );
      console.log(
        JSON.stringify({
          step: "list_objects",
          ok: true,
          bucket: target,
          keyCount: objects.KeyCount ?? 0,
        }),
      );
      const first = objects.Contents?.[0]?.Key;
      if (first) {
        const head = await client.send(
          new HeadObjectCommand({ Bucket: target, Key: first }),
        );
        console.log(
          JSON.stringify({
            step: "head",
            ok: true,
            key: first,
            contentLength: head.ContentLength,
            etag: head.ETag,
          }),
        );
        const got = await client.send(
          new GetObjectCommand({
            Bucket: target,
            Key: first,
            Range: "bytes=0-63",
          }),
        );
        const body = await streamToBuffer(got.Body);
        console.log(
          JSON.stringify({
            step: "get_range",
            ok: body.length > 0 && body.length <= 64,
            bytes: body.length,
            contentRange: got.ContentRange,
          }),
        );
      }
      console.log(JSON.stringify({ step: "summary", ok: true, mode: "read-only" }));
      return;
    }

    if (createdBucket) {
      try {
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
        console.log(JSON.stringify({ step: "create_bucket", ok: true, bucket }));
      } catch (err) {
        if (isAccessDenied(err)) {
          console.log(
            JSON.stringify({
              step: "create_bucket",
              ok: false,
              skipped: true,
              note: "AccessDenied — re-run with S3_BUCKET=<writable> or S3_SMOKE_READ_ONLY=true",
            }),
          );
          throw err;
        }
        throw err;
      }
    }

    try {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: Buffer.from(payload, "utf8"),
          ContentType: "text/plain",
          Metadata: { smoke: "true" },
        }),
      );
    } catch (err) {
      if (isAccessDenied(err)) {
        console.log(
          JSON.stringify({
            step: "put",
            ok: false,
            skipped: true,
            note: "AccessDenied — credentials appear read-only; use S3_SMOKE_READ_ONLY=true",
          }),
        );
        throw err;
      }
      throw err;
    }
    console.log(JSON.stringify({ step: "put", ok: true }));

    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    console.log(
      JSON.stringify({
        step: "head",
        ok: head.ContentLength === Buffer.byteLength(payload),
        contentLength: head.ContentLength,
        metadata: head.Metadata ?? {},
        etag: head.ETag,
      }),
    );

    const got = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await streamToBuffer(got.Body);
    const text = body.toString("utf8");
    console.log(
      JSON.stringify({
        step: "get",
        ok: text === payload,
        bytes: body.length,
      }),
    );
    if (text !== payload) throw new Error("get body mismatch");

    const objects = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: "smoke/" }),
    );
    const keys = (objects.Contents ?? []).map((o) => o.Key);
    console.log(
      JSON.stringify({
        step: "list_objects",
        ok: keys.includes(key),
        keys,
      }),
    );
    if (!keys.includes(key)) throw new Error("list missing smoke key");

    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    console.log(JSON.stringify({ step: "delete", ok: true }));

    console.log(JSON.stringify({ step: "summary", ok: true }));
  } finally {
    try {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    } catch {
      // best-effort
    }
    if (createdBucket) {
      try {
        await client.send(new DeleteBucketCommand({ Bucket: bucket }));
        console.log(JSON.stringify({ step: "teardown_bucket", ok: true }));
      } catch (err) {
        console.log(
          JSON.stringify({
            step: "teardown_bucket",
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
    client.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
