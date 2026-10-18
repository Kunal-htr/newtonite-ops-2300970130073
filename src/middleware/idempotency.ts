import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { HttpError } from './errors';

/**
 * Idempotency helpers (SYSTEM_DESIGN.md "middleware/ idempotency").
 * The raw body is captured by express.json({ verify }) in server.ts so the
 * request_hash is SHA-256 over the exact bytes the client sent.
 */

declare global {
  namespace Express {
    interface Request {
      /** Raw request body bytes, captured by express.json({ verify }). */
      rawBody?: Buffer;
    }
  }
}

/** Idempotency-Key is mandatory on write endpoints; missing key -> 400. */
export function requireIdempotencyKey(req: Request): string {
  const key = req.header('Idempotency-Key')?.trim();
  if (!key) {
    throw new HttpError(400, 'MISSING_IDEMPOTENCY_KEY', 'Idempotency-Key header is required');
  }
  return key;
}

/** SHA-256 of the raw request body string. */
export function hashRequest(rawBody: Buffer | undefined): string {
  return createHash('sha256').update(rawBody ?? Buffer.alloc(0)).digest('hex');
}
