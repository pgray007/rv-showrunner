import { useEffect, useRef, useState } from 'react';
import StatusBadge from '../components/StatusBadge';

const PAGE_SIZE = 40;

export default function Browse() {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all'); // all | tagged | untagged
  const [tagging, setTagging] = useState({}); // jellyfinId → true
  const searchTimeout = useRef(null);

  function load(q, p) {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ page: p, limit: PAGE_SIZE });
    if (q) params.set('search', q);
    fetch(`/api/jellyfin/items?${params}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) { setError(data.error); setItems([]); setTotal(0); return; }
        setItems(data.items || []);
        setTotal(data.total || 0);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load(search, page);
  }, [page]);

  function handleSearch(val) {
    setSearch(val);
    clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => {
      setPage(1);
      load(val, 1);
    }, 400);
  }

  async function toggleTag(item) {
    setTagging((t) => ({ ...t, [item.jellyfinId]: true }));
    try {
      if (item.hasRvTag) {
        await fetch(`/api/jellyfin/items/${item.jellyfinId}/tag`, { method: 'DELETE' });
      } else {
        await fetch(`/api/jellyfin/items/${item.jellyfinId}/tag`, { method: 'POST' });
      }
      setItems((prev) =>
        prev.map((i) =>
          i.jellyfinId === item.jellyfinId ? { ...i, hasRvTag: !i.hasRvTag } : i
        )
      );
    } finally {
      setTagging((t) => ({ ...t, [item.jellyfinId]: false }));
    }
  }

  const visible = items.filter((i) => {
    if (filter === 'tagged') return i.hasRvTag;
    if (filter === 'untagged') return !i.hasRvTag;
    return true;
  });

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-xl font-semibold">Browse Movies</h1>
        <div className="flex-1 min-w-48">
          <input
            className="input"
            placeholder="Search movies…"
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
          />
        </div>
        <div className="flex gap-1">
          {['all', 'tagged', 'untagged'].map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`btn text-xs ${filter === f ? 'bg-accent text-white' : 'btn-secondary'}`}
            >
              {f}
            </button>
          ))}
        </div>
        <span className="text-sm text-gray-500">{total} movies</span>
      </div>

      {loading && <div className="text-gray-500 text-sm">Loading…</div>}
      {!loading && error && (
        <div className="card p-4 text-sm text-red-400 space-y-1">
          <p className="font-medium">Could not reach Jellyfin</p>
          <p className="text-red-500/70">{error}</p>
          <p className="text-gray-500">Check your Jellyfin URL and API key in <a href="/settings" className="text-accent hover:underline">Settings</a>.</p>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
        {visible.map((item) => (
          <MovieCard
            key={item.jellyfinId}
            item={item}
            onToggle={() => toggleTag(item)}
            toggling={!!tagging[item.jellyfinId]}
          />
        ))}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-2">
          <button className="btn-secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>← Prev</button>
          <span className="text-sm text-gray-400">Page {page} / {totalPages}</span>
          <button className="btn-secondary" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>Next →</button>
        </div>
      )}
    </div>
  );
}

function MovieCard({ item, onToggle, toggling }) {
  return (
    <div className={`card overflow-hidden flex flex-col transition-all ${item.hasRvTag ? 'ring-2 ring-accent' : ''}`}>
      <div className="aspect-[2/3] bg-surface relative flex-shrink-0">
        {item.imageUrl ? (
          <img src={item.imageUrl} alt={item.title} className="w-full h-full object-cover" loading="lazy" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-600 text-xs text-center p-2">
            {item.title}
          </div>
        )}
        {item.jobStatus && (
          <div className="absolute top-1 right-1">
            <StatusBadge status={item.jobStatus} />
          </div>
        )}
      </div>
      <div className="p-2 flex flex-col gap-1 flex-1">
        <p className="text-xs font-medium line-clamp-2 leading-snug">{item.title}</p>
        <p className="text-xs text-gray-500">{item.year}</p>
        <button
          className={`mt-auto btn text-xs w-full ${item.hasRvTag ? 'bg-accent/20 text-accent hover:bg-accent hover:text-white border border-accent' : 'btn-secondary'}`}
          onClick={onToggle}
          disabled={toggling}
        >
          {toggling ? '…' : item.hasRvTag ? '✓ Tagged' : '+ Add to RV'}
        </button>
      </div>
    </div>
  );
}
