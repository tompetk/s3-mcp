#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createS3Client } from "./client.js";
import {
  loadConfig,
  printHelp,
  printVersion,
  readPackageVersion,
} from "./config.js";
import { registerTools } from "./tools.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(
      `s3-mcp: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  if (config === "help") {
    printHelp();
    return;
  }
  if (config === "version") {
    printVersion();
    return;
  }

  if (config.allowSelfSigned) {
    process.stderr.write(
      "s3-mcp: warning: S3_ALLOW_SELF_SIGNED / --insecure is enabled; TLS certificate verification is disabled for this client. Prefer S3_CA_BUNDLE when possible.\n",
    );
  }

  const client = createS3Client(config);
  const server = new McpServer({
    name: "s3-mcp",
    version: readPackageVersion(),
  });

  registerTools(server, client, config);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(
    `s3-mcp: connected (endpoint=${config.endpoint}, region=${config.region}, ` +
      `pathStyle=${config.forcePathStyle}, write=${config.allowWrite}` +
      (config.allowedBuckets ? `, buckets=${config.allowedBuckets.join(",")}` : "") +
      `)\n`,
  );
}

main().catch((err) => {
  process.stderr.write(
    `s3-mcp: fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
