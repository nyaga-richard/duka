import type { Response } from "express";
import { ZodError } from "zod";
import { AppError } from "../errors.ts";
import { logger } from "../logger.ts";

export function sendData(
  res: Response,
  requestId: string,
  data: unknown,
  status = 200,
) {
  res
    .status(status)
    .json({ data: data ?? null, meta: { request_id: requestId } });
}

/** Express 5 error handler: one JSON shape for every failure. */
export function errorHandler() {
  return (error: unknown, req: any, res: Response, _next: any) => {
    const requestId = (req as any).requestId ?? "unknown";
    let status = 500;
    let code = "INTERNAL_ERROR";
    let message =
      "An unexpected error occurred. Quote the request ID to support.";
    let details: unknown;

    if (error instanceof ZodError) {
      status = 422;
      code = "VALIDATION_ERROR";
      message = "Please correct the highlighted input";
      details = error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }));
    } else if (error instanceof AppError) {
      ({ status, code, message, details } = error);
    } else if ((error as any)?.type === "entity.too.large") {
      status = 413;
      code = "PAYLOAD_TOO_LARGE";
      message = "Request body is too large";
    } else if ((error as any)?.type === "entity.parse.failed") {
      status = 400;
      code = "INVALID_JSON";
      message = "Malformed JSON body";
    } else if ((error as any)?.code === "23505") {
      status = 409;
      code = "CONFLICT";
      message = "That record already exists";
    } else if ((error as any)?.code === "23503") {
      status = 422;
      code = "VALIDATION_ERROR";
      message = "A referenced record does not exist";
    } else if ((error as any)?.code === "23514") {
      status = 409;
      code = "CONFLICT";
      message = "The database rejected an inconsistent value";
    } else if (
      ["22P02", "22007", "22008", "22003"].includes((error as any)?.code)
    ) {
      status = 400;
      code = "VALIDATION_ERROR";
      message = "Invalid identifier, date or number";
    } else if (["40001", "40P01", "55P03"].includes((error as any)?.code)) {
      status = 409;
      code = "CONFLICT";
      message = "This record is busy. Retry with the same idempotency key";
    }

    if (status >= 500) {
      logger.error(
        {
          requestId,
          err: (error as Error)?.message,
          stack: (error as Error)?.stack,
        },
        "request failed",
      );
    }

    res.status(status).json({
      error: {
        code,
        message,
        ...(details ? { details } : {}),
        request_id: requestId,
      },
    });
  };
}
