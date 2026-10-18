import type { NextFunction, Request, Response } from 'express';
import { pool } from '../db/pool';
import type { UserMembership } from '../authz/can';
import { Unauthorized } from '../middleware/errors';
import { verifyToken } from './jwt';

/**
 * Auth middleware (SYSTEM_DESIGN.md "Authentication and Authorization"):
 * verify the Bearer token, then load the user row and ALL memberships from
 * the database on every request. Roles are never stored in the token.
 */

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  memberships: UserMembership[];
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

function extractBearerToken(header: string | undefined): string | undefined {
  if (!header?.startsWith('Bearer ')) return undefined;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : undefined;
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = extractBearerToken(req.headers.authorization);
  if (!token) throw new Unauthorized('Authentication required');

  const userId = verifyToken(token); // throws Unauthorized if invalid or expired

  const { rows } = await pool.query<{ id: string; name: string; email: string }>(
    'SELECT id, name, email FROM users WHERE id = $1',
    [userId]
  );
  const user = rows[0];
  if (!user) throw new Unauthorized('Invalid or expired token');

  const { rows: membershipRows } = await pool.query<{ team_id: string; role: UserMembership['role'] }>(
    'SELECT team_id, role FROM memberships WHERE user_id = $1 ORDER BY team_id',
    [userId]
  );

  req.user = {
    id: user.id,
    name: user.name,
    email: user.email,
    memberships: membershipRows.map((row) => ({ teamId: row.team_id, role: row.role })),
  };

  next();
}

/** The authenticated user attached by requireAuth; throws Unauthorized if absent. */
export function authUser(req: Request): AuthUser {
  if (!req.user) throw new Unauthorized('Authentication required');
  return req.user;
}
