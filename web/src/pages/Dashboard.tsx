import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { fetchItems } from '../api';
import { ErrorBox, ItemRow } from '../components';

const TABS = [
  { view: 'assigned_to_me', label: 'Assigned to me' },
  { view: 'unassigned_urgent', label: 'Unassigned urgent' },
  { view: 'awaiting_my_approval', label: 'Awaiting my approval' },
] as const;

type View = (typeof TABS)[number]['view'];

export function DashboardPage() {
  const [view, setView] = useState<View>('assigned_to_me');

  const query = useInfiniteQuery({
    queryKey: ['items', 'view', view],
    queryFn: ({ pageParam }) => fetchItems({ view, limit: 25, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    refetchInterval: 15_000,
  });

  const items = query.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section>
      <h1>Dashboard</h1>
      <nav style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {TABS.map((tab) => (
          <button key={tab.view} onClick={() => setView(tab.view)} disabled={tab.view === view}>
            {tab.label}
          </button>
        ))}
      </nav>
      {query.isLoading && <p>Loading…</p>}
      <ErrorBox error={query.error} />
      <ul>
        {items.map((item) => (
          <ItemRow key={item.id} item={item} />
        ))}
      </ul>
      {!query.isLoading && items.length === 0 && <p>No items.</p>}
      {query.hasNextPage && (
        <button onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage}>
          {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}
    </section>
  );
}
