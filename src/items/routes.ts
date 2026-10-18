import { Router } from 'express';
import { z } from 'zod';
import { authUser, requireAuth } from '../auth/middleware';
import { HttpError, Invalid, NotFound } from '../middleware/errors';
import { hashRequest, requireIdempotencyKey } from '../middleware/idempotency';
import {
  addComment,
  assignItem,
  claimItem,
  createItem,
  getItemDetail,
  listActivity,
  listItems,
  patchItem,
  transitionItem,
} from './service';

/**
 * Item routes: parse + validate input only. No SQL here, no permission
 * decisions here (services call can()).
 */

export const itemsRouter = Router();

const ITEM_TYPES = ['incident', 'customer_issue', 'payment', 'compliance', 'task'] as const;
const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
const STATUSES = ['OPEN', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'RESOLVED', 'CLOSED'] as const;
const VIEWS = ['assigned_to_me', 'unassigned_urgent', 'awaiting_my_approval'] as const;

// All item routes require a Bearer token.
itemsRouter.use('/items', requireAuth);

const uuidParam = z.uuid();

/** Opaque keyset cursor for (createdAt, id): base64url(JSON). */
const cursorSchema = z.object({ createdAt: z.iso.datetime(), id: z.uuid() });

function parseCursor(raw: string | undefined): { createdAt: string; id: string } | undefined {
  if (raw === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new HttpError(400, 'INVALID_CURSOR', 'Cursor is invalid');
  }
  const parsed = cursorSchema.safeParse(json);
  if (!parsed.success) throw new HttpError(400, 'INVALID_CURSOR', 'Cursor is invalid');
  return parsed.data;
}

const listQuerySchema = z.object({
  status: z.enum(STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  assignee: z.union([z.uuid(), z.literal('me')]).optional(),
  team: z.uuid().optional(),
  q: z.string().min(1).max(200).optional(),
  view: z.enum(VIEWS).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
});

itemsRouter.get('/items', async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new HttpError(400, 'INVALID_QUERY', 'Invalid query parameters');

  const { cursor, ...filters } = parsed.data;
  const result = await listItems(authUser(req), { ...filters, cursor: parseCursor(cursor) });
  res.status(200).json(result);
});

itemsRouter.get('/items/:id', async (req, res) => {
  const id = uuidParam.safeParse(req.params.id);
  if (!id.success) throw new NotFound('Item not found');

  res.status(200).json(await getItemDetail(authUser(req), id.data));
});

const createItemSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  type: z.enum(ITEM_TYPES),
  priority: z.enum(PRIORITIES),
  team_id: z.uuid(),
  due_date: z.iso.datetime().optional(),
});

itemsRouter.post('/items', async (req, res) => {
  const idempotencyKey = requireIdempotencyKey(req); // missing -> 400 MISSING_IDEMPOTENCY_KEY

  const parsed = createItemSchema.safeParse(req.body);
  if (!parsed.success) throw new Invalid('Invalid item payload');

  const result = await createItem(authUser(req), parsed.data, idempotencyKey, hashRequest(req.rawBody));
  res.status(result.statusCode).json(result.responseBody);
});

/** Optimistic-concurrency token: missing, null, float or string -> 400. */
function requireIntegerVersion(body: unknown): number {
  const version = (body as { version?: unknown } | null | undefined)?.version;
  if (!Number.isInteger(version)) {
    throw new HttpError(400, 'INVALID_BODY', 'version is required and must be an integer');
  }
  return version as number;
}

itemsRouter.post('/items/:id/claim', async (req, res) => {
  const id = uuidParam.safeParse(req.params.id);
  if (!id.success) throw new NotFound('Item not found');

  const result = await claimItem(authUser(req), id.data);
  res.status(result.statusCode).json(result.responseBody);
});

const patchItemSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().nullable().optional(),
  priority: z.enum(PRIORITIES).optional(),
  due_date: z.iso.datetime().nullable().optional(),
});

itemsRouter.patch('/items/:id', async (req, res) => {
  const id = uuidParam.safeParse(req.params.id);
  if (!id.success) throw new NotFound('Item not found');

  const version = requireIntegerVersion(req.body); // missing/invalid -> 400

  const parsed = patchItemSchema.safeParse(req.body);
  if (!parsed.success) throw new Invalid('Invalid item payload');
  if (Object.keys(parsed.data).length === 0) {
    throw new HttpError(400, 'INVALID_BODY', 'At least one editable field is required');
  }

  const result = await patchItem(authUser(req), id.data, { version, fields: parsed.data });
  res.status(result.statusCode).json(result.responseBody);
});

itemsRouter.post('/items/:id/transition', async (req, res) => {
  const id = uuidParam.safeParse(req.params.id);
  if (!id.success) throw new NotFound('Item not found');

  const version = requireIntegerVersion(req.body);
  const rawTo = (req.body as { to?: unknown } | null | undefined)?.to;
  // Unknown targets fall through to the workflow lookup in the service -> 422.

  const result = await transitionItem(authUser(req), id.data, {
    to: typeof rawTo === 'string' ? rawTo : '',
    version,
  });
  res.status(result.statusCode).json(result.responseBody);
});

const assignItemSchema = z.object({ assignee_id: z.uuid() });

itemsRouter.post('/items/:id/assign', async (req, res) => {
  const id = uuidParam.safeParse(req.params.id);
  if (!id.success) throw new NotFound('Item not found');

  const version = requireIntegerVersion(req.body);

  const parsed = assignItemSchema.safeParse(req.body);
  if (!parsed.success) throw new Invalid('Invalid assign payload');

  const result = await assignItem(authUser(req), id.data, { assigneeId: parsed.data.assignee_id, version });
  res.status(result.statusCode).json(result.responseBody);
});

const commentSchema = z.object({ text: z.string().min(1) });

itemsRouter.post('/items/:id/comments', async (req, res) => {
  const id = uuidParam.safeParse(req.params.id);
  if (!id.success) throw new NotFound('Item not found');

  const idempotencyKey = requireIdempotencyKey(req); // missing -> 400 MISSING_IDEMPOTENCY_KEY

  const parsed = commentSchema.safeParse(req.body);
  if (!parsed.success) throw new Invalid('Invalid comment payload');

  const result = await addComment(authUser(req), id.data, parsed.data.text, idempotencyKey, hashRequest(req.rawBody));
  res.status(result.statusCode).json(result.responseBody);
});

const activityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().regex(/^\d+$/, 'Cursor is invalid').optional(),
});

itemsRouter.get('/items/:id/activity', async (req, res) => {
  const id = uuidParam.safeParse(req.params.id);
  if (!id.success) throw new NotFound('Item not found');

  const parsed = activityQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new HttpError(400, 'INVALID_QUERY', 'Invalid query parameters');

  res.status(200).json(await listActivity(authUser(req), id.data, parsed.data.limit, parsed.data.cursor));
});
