import pino from "pino";
import { config } from "./config.ts";

/**
 * Structured logging with redaction. Request bodies are never logged whole;
 * only the fields listed as safe metadata are passed by callers.
 */
export const logger = pino({
  level: config.logLevel,
  base: { service: "ecommerce-api", env: config.env },
  redact: {
    paths: [
      "req.headers.cookie",
      "req.headers.authorization",
      "req.headers['x-csrf-token']",
      "req.headers['x-webhook-signature']",
      "password",
      "*.password",
      "*.provider_token",
      "*.token",
      "*.secret",
      "*.csrf_token",
      "payload.password",
      "payload.consumer_secret",
      "payload.passkey",
    ],
    censor: "[redacted]",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export const workerLogger = logger.child({ component: "worker" });
