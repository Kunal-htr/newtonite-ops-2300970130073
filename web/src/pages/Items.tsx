import { useEffect, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { fetchItems, fetchMe, PRIORITIES, STATUSES } from '../api';
import { ErrorBox, ItemRow } from '../components';

export function ItemsPage() {
  const [status, setStatus] = useState('');
  const [priority, setPriority] = useState('');
  const [team, setTeam] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // 300 ms debounce: the query below only changes after typing pauses.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const me = useQuery({ queryKey: ['me'], queryFn: fetchMe });

  const query = useInfiniteQuery({
    queryKey: ['items', 'filters', status, priority, team, debouncedSearch],
    queryFn: ({ pageParam }) =>
      fetchItems({
        status: status || undefined,
        priority: priority || undefined,
        team: team || undefined,
        q: debouncedSearch || undefined,
        limit: 25,
        cursor: pageParam,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  const items = query.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section>
      <h1>Items</h1>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <label>
          Status{' '}
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label>
          Priority{' '}
          <select value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="">All</option>
            {PRIORITIES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label>
          Team{' '}
          <select value={team} onChange={(e) => setTeam(e.target.value)}>
            <option value="">All my teams</option>
            {me.data?.memberships.map((membership) => (
              <option key={membership.teamId} value={membership.teamId}>
                {membership.teamId}
              </option>
            ))}
          </select>
        </label>
        <label>
          Search{' '}
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="search titles…"
          />
        </label>
      </div>
      {query.isLoading && <p>Loading…</p>}
      <ErrorBox error={query.error} />
      <ul>
        {items.map((item) => (
          <ItemRow key={item.id} item={item} />
        ))}
      </ul>
      {!query.isLoading && items.length === 0 && <p>No items match.</p>}
      {query.hasNextPage && (
        <button onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage}>
          {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}
    </section>
  );
}
