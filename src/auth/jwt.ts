import jwt from 'jsonwebtoken';
import { config } from '../config';
import { Unauthorized } from '../middleware/errors';

/**
 * JWT helpers. The token payload contains ONLY the user id (sub claim),
 * algorithm HS256, 8h expiry. Roles/memberships are never put in the token -
 * they are loaded from the database on every request.
 */

const TOKEN_TTL_SECONDS = 8 * 60 * 60;

export function signToken(userId: string): string {
  return jwt.sign({}, config.JWT_SECRET, {
    algorithm: 'HS256',
    subject: userId,
    expiresIn: TOKEN_TTL_SECONDS,
  });
}

/** Returns the user id from a valid token; throws Unauthorized for bad/expired tokens. */
export function verifyToken(token: string): string {
  let payload: string | jwt.JwtPayload;
  try {
    payload = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    throw new Unauthorized('Invalid or expired token');
  }

  if (typeof payload === 'string' || typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new Unauthorized('Invalid or expired token');
  }
  return payload.sub;
}
