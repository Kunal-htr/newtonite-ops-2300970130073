import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/server';
import {
  authHeader,
  countEvents,
  createItem,
  createTeam,
  createUser,
  getEvents,
  getItem,
  type TestUser,
} from './helpers';

/**
 * Behaviour: workflow rules live in src/items/workflow.ts and are enforced by
 * can(). Unknown transitions 422; known transitions with a wrong actor 403;
 * a lead approving someone else's item succeeds and logs one STATUS_CHANGED
 * event with from/to.
 */
describe('workflow transitions', () => {
  let teamId: string;
  let lead: TestUser;
  let member: TestUser;

  beforeAll(async () => {
    teamId = await createTeam('Workflow Team');
    lead = await createUser('workflow-lead@test.local', [{ teamId, role: 'lead' }]);
    member = await createUser('workflow-member@test.local', [{ teamId, role: 'member' }]);
  });

  it('rejects a transition without a rule (OPEN -> CLOSED) with 422 INVALID_TRANSITION', async () => {
    const item = await createItem({ teamId, createdBy: lead.id });

    const response = await request(app)
      .post(`/items/${item.id}/transition`)
      .set(authHeader(lead.token))
      .send({ to: 'CLOSED', version: item.version })
      .expect(422);
    expect(response.body.error.code).toBe('INVALID_TRANSITION');

    const stored = await getItem(item.id);
    expect(stored.status).toBe('OPEN');
    expect(stored.version).toBe(1);
    expect(await countEvents(item.id)).toBe(0);
  });

  it('forbids a member from approving (AWAITING_APPROVAL -> RESOLVED) with 403', async () => {
    const item = await createItem({
      teamId,
      createdBy: lead.id,
      status: 'AWAITING_APPROVAL',
      assigneeId: member.id,
    });

    const response = await request(app)
      .post(`/items/${item.id}/transition`)
      .set(authHeader(member.token))
      .send({ to: 'RESOLVED', version: item.version })
      .expect(403);
    expect(response.body.error.code).toBe('FORBIDDEN');

    const stored = await getItem(item.id);
    expect(stored.status).toBe('AWAITING_APPROVAL');
    expect(await countEvents(item.id)).toBe(0);
  });

  it('forbids a lead from approving their own assigned item (own_item)', async () => {
    const item = await createItem({
      teamId,
      createdBy: member.id,
      status: 'AWAITING_APPROVAL',
      assigneeId: lead.id,
    });

    const response = await request(app)
      .post(`/items/${item.id}/transition`)
      .set(authHeader(lead.token))
      .send({ to: 'RESOLVED', version: item.version })
      .expect(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
    expect(response.body.error.message).toMatch(/own item/i);

    const stored = await getItem(item.id);
    expect(stored.status).toBe('AWAITING_APPROVAL');
    expect(await countEvents(item.id)).toBe(0);
  });

  it("lets a lead approve someone else's item and logs one matching STATUS_CHANGED event", async () => {
    const item = await createItem({
      teamId,
      createdBy: member.id,
      status: 'AWAITING_APPROVAL',
      assigneeId: member.id,
    });

    const response = await request(app)
      .post(`/items/${item.id}/transition`)
      .set(authHeader(lead.token))
      .send({ to: 'RESOLVED', version: item.version })
      .expect(200);
    expect(response.body.status).toBe('RESOLVED');
    expect(response.body.version).toBe(2);

    const stored = await getItem(item.id);
    expect(stored.status).toBe('RESOLVED');

    const events = await getEvents(item.id);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('STATUS_CHANGED');
    expect(events[0].payload).toEqual({ from: 'AWAITING_APPROVAL', to: 'RESOLVED' });
    expect(events[0].actor_id).toBe(lead.id);
  });
});
