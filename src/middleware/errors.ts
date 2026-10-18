import type { NextFunction, Request, Response } from 'express';
import type { DenyReason } from '../authz/can';

/**
 * Typed errors (SYSTEM_DESIGN.md "Errors"): mapped to status codes in one handler.
 * Response shape: { "error": { "code": "...", "message": "..." } }
 */

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
  }
}

export class NotFound extends HttpError {
  constructor(message = 'Resource not found') {
    super(404, 'NOT_FOUND', message);
  }
}

export class Forbidden extends HttpError {
  constructor(message = 'Forbidden') {
    super(403, 'FORBIDDEN', message);
  }
}

export class Conflict extends HttpError {
  constructor(message = 'Conflict') {
    super(409, 'CONFLICT', message);
  }
}

export class Invalid extends HttpError {
  constructor(message = 'Invalid request') {
    super(422, 'INVALID', message);
  }
}

export class Unauthorized extends HttpError {
  constructor(message = 'Authentication required') {
    super(401, 'UNAUTHORIZED', message);
  }
}

/**
 * Maps a can() deny reason to the error the API should return:
 * not_in_team -> 404 (team membership is not revealed),
 * insufficient_role and own_item -> 403.
 */
export function denyReasonToError(reason: DenyReason): HttpError {
  switch (reason) {
    case 'not_in_team':
      return new NotFound('Resource not found');
    case 'insufficient_role':
      return new Forbidden('Insufficient role for this action');
    case 'own_item':
      return new Forbidden('You cannot approve your own item');
  }
}

/** Single error handler. Must be registered last. No stack traces are exposed. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }

  console.error('Unhandled error:', err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
}
