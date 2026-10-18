import { Router } from 'express';
import { z } from 'zod';
import { authUser, requireAuth } from '../auth/middleware';
import { HttpError, Invalid, NotFound } from '../middleware/errors';
import { hashRequest, requireIdempotencyKey } from '../middleware/idempotency';
import { createItem, getItemDetail, listActivity, listItems } from './service';

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
itemsRouter.use(requireAuth);

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
