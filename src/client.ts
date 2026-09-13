import { readFileSync } from "node:fs";
import https from "node:https";
import { S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import type { Config } from "./config.js";

/**
 * Build an S3Client for any S3-compatible endpoint.
 *
 * TLS trust is scoped to this client via NodeHttpHandler + https.Agent —
 * we never set NODE_TLS_REJECT_UNAUTHORIZED, so other Node work in the
 * process keeps full certificate verification.
 */
export function createS3Client(config: Config): S3Client {
  const agentOptions: https.AgentOptions = {};

  if (config.caBundle) {
    agentOptions.ca = readFileSync(config.caBundle);
  }
  if (config.allowSelfSigned) {
    agentOptions.rejectUnauthorized = false;
  }

  const needsCustomAgent = Boolean(config.caBundle || config.allowSelfSigned);

  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: config.forcePathStyle,
    ...(needsCustomAgent
      ? {
          requestHandler: new NodeHttpHandler({
            httpsAgent: new https.Agent(agentOptions),
          }),
        }
      : {}),
  });
}
