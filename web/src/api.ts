/**
 * Single fetch wrapper for the Newtonite Ops API.
 *
 * - Attaches the Bearer token (kept in memory + sessionStorage).
 * - Sends a fresh crypto.randomUUID() Idempotency-Key for each create/comment
 *   click; a replay of the same key returns the stored response.
 * - Throws ApiError carrying the HTTP status and the parsed error body;
 *   409 conflicts also carry the latest item sent by the server.
 * - A 401 (except a failed login) clears the token and redirects to /login.
 *
 * The UI holds no permission or workflow rules: it renders exactly the
 * allowedActions the server returns and shows server errors verbatim.
 */

export type ItemStatus = 'OPEN' | 'IN_PROGRESS' | 'AWAITING_APPROVAL' | 'RESOLVED' | 'CLOSED';
export type Priority = 'low' | 'medium' | 'high' | 'urgent';
export type Action =
  | 'read'
  | 'create'
  | 'edit'
  | 'comment'
  | 'claim'
  | 'transition'
  | 'approve'
  | 'reject'
  | 'close'
  | 'reassign';

// Enum data for filter and transition options - no rules are encoded here.
export const STATUSES: ItemStatus[] = ['OPEN', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'RESOLVED', 'CLOSED'];
export const PRIORITIES: Priority[] = ['low', 'medium', 'high', 'urgent'];

/** Mirrors the server's ApiItem shape exactly (camelCase, ISO timestamps). */
export interface ApiItem {
  id: string;
  title: string;
  description: string | null;
  type: string;
  priority: string;
  status: ItemStatus;
  teamId: string;
  assigneeId: string | null;
  createdBy: string;
  dueDate: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** GET /items/:id adds allowedActions (server-computed). */
export interface ItemDetail extends ApiItem {
  allowedActions: Action[];
}

export interface ApiActivityEvent {
  id: string;
  itemId: string;
  actorId: string;
  type: string;
  payload: unknown;
  createdAt: string;
}

export interface Membership {
  teamId: string;
  role: string;
}

/** GET /me. */
export interface ApiUser {
  id: string;
  name: string;
  email: string;
  memberships: Membership[];
}

export interface ItemListPage {
  items: ApiItem[];
  nextCursor: string | null;
}

export interface ActivityPage {
  events: ApiActivityEvent[];
  nextCursor: string | null;
}

export interface LoginResponse {
  token: string;
  user: { id: string; name: string; email: string };
}

interface ErrorBody {
  error?: { code?: string; message?: string };
  item?: ApiItem;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly item: ApiItem | undefined;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    const parsed = body as ErrorBody | null | undefined;
    super(parsed?.error?.message ?? `Request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.code = parsed?.error?.code ?? 'UNKNOWN';
    this.item = parsed?.item;
    this.body = body;
  }
}

/** 409 = optimistic-concurrency or state conflict; caller shows the banner. */
export function isConflict(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 409;
}

// ---- Token -----------------------------------------------------------------

const TOKEN_KEY = 'newtonite_ops_token';
let memoryToken: string | null = sessionStorage.getItem(TOKEN_KEY);

export function getToken(): string | null {
  return memoryToken;
}

export function setToken(token: string): void {
  memoryToken = token;
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  memoryToken = null;
  sessionStorage.removeItem(TOKEN_KEY);
}

// ---- Fetch wrapper ---------------------------------------------------------

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
  idempotencyKey?: string;
}

async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (memoryToken) headers.Authorization = `Bearer ${memoryToken}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new ApiError(0, { error: { code: 'NETWORK_ERROR', message: 'Network request failed' } });
  }

  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!response.ok) {
    // A failed login is a form error; anywhere else 401 means the session is
    // gone, so send the user back to the login page.
    if (response.status === 401 && path !== '/auth/login') {
      clearToken();
      window.location.assign('/login');
    }
    throw new ApiError(response.status, body);
  }
  return body as T;
}

// ---- Auth ------------------------------------------------------------------

export async function login(email: string, password: string): Promise<LoginResponse> {
  const result = await apiFetch<LoginResponse>('/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  setToken(result.token);
  return result;
}

/** GET /me: the only place memberships (team ids) come from. */
export function fetchMe(): Promise<ApiUser> {
  return apiFetch<ApiUser>('/me');
}

// ---- Items -----------------------------------------------------------------

export interface ItemFilters {
  view?: string;
  status?: string;
  priority?: string;
  team?: string;
  assignee?: string;
  q?: string;
  limit?: number;
  cursor?: string | null;
}

function toQueryString(filters: ItemFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function fetchItems(filters: ItemFilters): Promise<ItemListPage> {
  return apiFetch<ItemListPage>(`/items${toQueryString(filters)}`);
}

export function fetchItem(itemId: string): Promise<ItemDetail> {
  return apiFetch<ItemDetail>(`/items/${itemId}`);
}

export function fetchActivity(itemId: string, cursor: string | null): Promise<ActivityPage> {
  return apiFetch<ActivityPage>(`/items/${itemId}/activity${toQueryString({ limit: 25, cursor })}`);
}

export interface CreateItemInput {
  title: string;
  description?: string;
  type: string;
  priority: string;
  team_id: string;
  due_date?: string;
}

/** POST /items -> 201 with the created item. Fresh key per click. */
export function createItem(input: CreateItemInput): Promise<ApiItem> {
  return apiFetch<ApiItem>('/items', {
    method: 'POST',
    body: input,
    idempotencyKey: crypto.randomUUID(),
  });
}

export function claimItem(itemId: string): Promise<ApiItem> {
  return apiFetch<ApiItem>(`/items/${itemId}/claim`, { method: 'POST' });
}

export interface PatchFields {
  title?: string;
  description?: string | null;
  priority?: string;
  due_date?: string | null;
}

export function patchItem(itemId: string, version: number, fields: PatchFields): Promise<ApiItem> {
  return apiFetch<ApiItem>(`/items/${itemId}`, {
    method: 'PATCH',
    body: { version, ...fields },
  });
}

export function transitionItem(itemId: string, version: number, to: ItemStatus): Promise<ApiItem> {
  return apiFetch<ApiItem>(`/items/${itemId}/transition`, {
    method: 'POST',
    body: { version, to },
  });
}

export function assignItem(itemId: string, version: number, assigneeId: string): Promise<ApiItem> {
  return apiFetch<ApiItem>(`/items/${itemId}/assign`, {
    method: 'POST',
    body: { version, assignee_id: assigneeId },
  });
}

/** POST /items/:id/comments -> 201 with the COMMENTED event. Fresh key per click. */
export function addComment(itemId: string, text: string): Promise<ApiActivityEvent> {
  return apiFetch<ApiActivityEvent>(`/items/${itemId}/comments`, {
    method: 'POST',
    body: { text },
    idempotencyKey: crypto.randomUUID(),
  });
}
