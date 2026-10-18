import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addComment,
  assignItem,
  claimItem,
  fetchActivity,
  fetchItem,
  isConflict,
  patchItem,
  transitionItem,
  PRIORITIES,
  STATUSES,
} from '../api';
import type { ItemDetail, ItemStatus } from '../api';
import { ConflictBanner, ErrorBox } from '../components';

export function ItemDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const itemQuery = useQuery({
    queryKey: ['item', id],
    queryFn: () => fetchItem(id),
    enabled: Boolean(id),
  });

  if (!id) return <p>Item not found.</p>;
  if (itemQuery.isLoading) return <p>Loading…</p>;
  if (!itemQuery.data) return <ErrorBox error={itemQuery.error ?? new Error('Item not found')} />;

  return <ItemDetailView key={itemQuery.data.id} item={itemQuery.data} />;
}

function renderPayload(payload: unknown): string {
  if (payload && typeof payload === 'object' && 'text' in payload) {
    return String((payload as { text: unknown }).text);
  }
  return JSON.stringify(payload);
}

function ItemDetailView({ item }: { item: ItemDetail }) {
  const queryClient = useQueryClient();
  const [commentText, setCommentText] = useState('');
  const [transitionTo, setTransitionTo] = useState('');
  const [reassignId, setReassignId] = useState('');

  const [editing, setEditing] = useState(false);
  const [editVersion, setEditVersion] = useState(0);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editPriority, setEditPriority] = useState(item.priority);
  const [editDue, setEditDue] = useState('');

  const activityQuery = useInfiniteQuery({
    queryKey: ['activity', item.id],
    queryFn: ({ pageParam }) => fetchActivity(item.id, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  function invalidateItem() {
    queryClient.invalidateQueries({ queryKey: ['item', item.id] });
    queryClient.invalidateQueries({ queryKey: ['activity', item.id] });
    queryClient.invalidateQueries({ queryKey: ['items'] });
  }

  const claim = useMutation({ mutationFn: () => claimItem(item.id), onSuccess: invalidateItem });
  const transition = useMutation({
    mutationFn: (to: ItemStatus) => transitionItem(item.id, item.version, to),
    onSuccess: () => {
      setTransitionTo('');
      invalidateItem();
    },
  });
  const reassign = useMutation({
    mutationFn: (assigneeId: string) => assignItem(item.id, item.version, assigneeId),
    onSuccess: () => {
      setReassignId('');
      invalidateItem();
    },
  });
  const saveEdit = useMutation({
    mutationFn: () =>
      patchItem(item.id, editVersion, {
        title: editTitle,
        description: editDescription,
        priority: editPriority,
        due_date: editDue ? new Date(editDue).toISOString() : null,
      }),
    onSuccess: () => {
      setEditing(false);
      invalidateItem();
    },
  });
  const comment = useMutation({
    mutationFn: () => addComment(item.id, commentText.trim()),
    onSuccess: () => {
      setCommentText('');
      queryClient.invalidateQueries({ queryKey: ['activity', item.id] });
    },
  });

  // The version the user saw when the form was opened is what gets sent:
  // if someone else saved meanwhile, the server answers 409.
  function openEdit() {
    setEditVersion(item.version);
    setEditTitle(item.title);
    setEditDescription(item.description ?? '');
    setEditPriority(item.priority);
    setEditDue(item.dueDate ? item.dueDate.slice(0, 16) : '');
    setEditing(true);
  }

  function reloadAfterConflict() {
    setEditing(false);
    setTransitionTo('');
    setReassignId('');
    invalidateItem();
  }

  const errors = [claim.error, transition.error, reassign.error, saveEdit.error, comment.error];
  const conflictError = errors.find(isConflict) ?? null;
  const otherError = errors.find((e) => e !== null && !isConflict(e)) ?? null;
  const events = activityQuery.data?.pages.flatMap((page) => page.events) ?? [];

  return (
    <section>
      <p>
        <Link to="/items">← Back to items</Link>
      </p>
      <h1>{item.title}</h1>

      {conflictError && <ConflictBanner onReload={reloadAfterConflict} />}
      {otherError && <ErrorBox error={otherError} />}

      <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 16px' }}>
        <dt>Status</dt>
        <dd>{item.status}</dd>
        <dt>Priority</dt>
        <dd>{item.priority}</dd>
        <dt>Type</dt>
        <dd>{item.type}</dd>
        <dt>Team</dt>
        <dd>{item.teamId}</dd>
        <dt>Assignee</dt>
        <dd>{item.assigneeId ?? '—'}</dd>
        <dt>Due</dt>
        <dd>{item.dueDate ?? '—'}</dd>
        <dt>Description</dt>
        <dd>{item.description ?? '—'}</dd>
        <dt>Version</dt>
        <dd>{item.version}</dd>
        <dt>Created by</dt>
        <dd>{item.createdBy}</dd>
        <dt>Created</dt>
        <dd>{item.createdAt}</dd>
        <dt>Updated</dt>
        <dd>{item.updatedAt}</dd>
      </dl>

      <h2>Actions</h2>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        {item.allowedActions.includes('claim') && (
          <button onClick={() => claim.mutate()} disabled={claim.isPending}>
            {claim.isPending ? 'Claiming…' : 'Claim'}
          </button>
        )}
        {item.allowedActions.includes('transition') && (
          <span>
            <select value={transitionTo} onChange={(e) => setTransitionTo(e.target.value)}>
              <option value="">Transition to…</option>
              {STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>{' '}
            <button
              onClick={() => transition.mutate(transitionTo as ItemStatus)}
              disabled={!transitionTo || transition.isPending}
            >
              {transition.isPending ? 'Working…' : 'Transition'}
            </button>
          </span>
        )}
        {item.allowedActions.includes('reassign') && (
          <span>
            <input
              placeholder="assignee user id (uuid)"
              value={reassignId}
              onChange={(e) => setReassignId(e.target.value)}
            />{' '}
            <button
              onClick={() => reassign.mutate(reassignId.trim())}
              disabled={!reassignId.trim() || reassign.isPending}
            >
              {reassign.isPending ? 'Working…' : 'Reassign'}
            </button>
          </span>
        )}
        {item.allowedActions.includes('edit') && !editing && <button onClick={openEdit}>Edit</button>}
      </div>

      {item.allowedActions.includes('edit') && editing && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (editTitle.trim()) saveEdit.mutate();
          }}
          style={{ marginTop: 12, border: '1px solid #999', padding: 8 }}
        >
          <h3>Edit (sends version {editVersion})</h3>
          <p>
            <label>
              Title
              <br />
              <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
            </label>
          </p>
          <p>
            <label>
              Description
              <br />
              <textarea value={editDescription} onChange={(e) => setEditDescription(e.target.value)} />
            </label>
          </p>
          <p>
            <label>
              Priority{' '}
              <select value={editPriority} onChange={(e) => setEditPriority(e.target.value)}>
                {PRIORITIES.map((priority) => (
                  <option key={priority} value={priority}>
                    {priority}
                  </option>
                ))}
              </select>
            </label>
          </p>
          <p>
            <label>
              Due
              <br />
              <input
                type="datetime-local"
                value={editDue}
                onChange={(e) => setEditDue(e.target.value)}
              />
            </label>
          </p>
          <button type="submit" disabled={!editTitle.trim() || saveEdit.isPending}>
            {saveEdit.isPending ? 'Saving…' : 'Save'}
          </button>{' '}
          <button type="button" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </form>
      )}

      <h2>Activity</h2>
      {activityQuery.isLoading && <p>Loading…</p>}
      <ErrorBox error={activityQuery.error} />
      <ul>
        {events.map((event) => (
          <li key={event.id}>
            <small>{event.createdAt}</small> <strong>{event.type}</strong> by {event.actorId} —{' '}
            {renderPayload(event.payload)}
          </li>
        ))}
      </ul>
      {activityQuery.hasNextPage && (
        <button
          onClick={() => activityQuery.fetchNextPage()}
          disabled={activityQuery.isFetchingNextPage}
        >
          {activityQuery.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}

      {item.allowedActions.includes('comment') && (
        <>
          <h3>Comment</h3>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (commentText.trim()) comment.mutate();
            }}
          >
            <textarea
              rows={3}
              cols={50}
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
            />
            <br />
            <button type="submit" disabled={!commentText.trim() || comment.isPending}>
              {comment.isPending ? 'Posting…' : 'Post comment'}
            </button>
          </form>
        </>
      )}
    </section>
  );
}
