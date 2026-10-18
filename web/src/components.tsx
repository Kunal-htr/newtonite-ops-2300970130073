import { Link } from 'react-router-dom';
import type { ApiItem } from './api';

/** Shows a server error message (the API's {error:{code,message}} text). */
export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : 'Something went wrong';
  return <p style={{ color: 'crimson' }}>Error: {message}</p>;
}

/** 409 banner. Render only when the caller confirmed isConflict(error). */
export function ConflictBanner({ onReload }: { onReload: () => void }) {
  return (
    <p style={{ border: '1px solid crimson', padding: 8 }}>
      This item changed, reload <button onClick={onReload}>Reload</button>
    </p>
  );
}

export function ItemRow({ item }: { item: ApiItem }) {
  return (
    <li>
      <Link to={`/items/${item.id}`}>{item.title}</Link>{' '}
      <small>
        [{item.status} · {item.priority}]
      </small>
    </li>
  );
}
