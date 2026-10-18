import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment parsing - fail fast (SYSTEM_DESIGN.md "config.ts env parsing (fail fast)").
 * DATABASE_URL and JWT_SECRET are required; PORT falls back to 3000.
 */
const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required (e.g. postgres://user:password@host:5432/dbname)'),
  JWT_SECRET: z.string().min(1, 'JWT_SECRET is required (use a long random string)'),
  PORT: z.coerce.number().int().positive().default(3000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const lines = parsed.error.issues.map(
    (issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`
  );
  console.error(`Invalid environment configuration:\n${lines.join('\n')}`);
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
