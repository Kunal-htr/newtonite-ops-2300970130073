import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool } from '../db/pool';
import { Invalid, Unauthorized } from '../middleware/errors';
import { authUser, requireAuth } from './middleware';
import { signToken } from './jwt';

export const authRouter = Router();

/**
 * Precomputed hash so an unknown email still performs exactly one bcrypt
 * comparison - wrong email and wrong password take the same time and return
 * the same 401 message.
 */
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('timing-safety-placeholder', 10);

const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});

authRouter.post('/auth/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) throw new Invalid('email and password are required');

  const { email, password } = parsed.data;

  const { rows } = await pool.query<{ id: string; name: string; email: string; password_hash: string }>(
    'SELECT id, name, email, password_hash FROM users WHERE email = $1',
    [email]
  );
  const user = rows[0];

  const passwordMatches = await bcrypt.compare(password, user ? user.password_hash : DUMMY_PASSWORD_HASH);
  if (!user || !passwordMatches) throw new Unauthorized('Invalid email or password');

  const token = signToken(user.id);
  res.status(200).json({ token, user: { id: user.id, name: user.name, email: user.email } });
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.status(200).json(authUser(req));
});
