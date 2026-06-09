import { useEffect, useRef, useState } from 'react';
import StatusBadge from '../components/StatusBadge';

const PAGE_SIZE = 40;
const SORT_OPTIONS = [
  { value: 'title', label: 'Title' },
  { value: 'newest', label: 'Newest added' },
];

function fmtDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString();
}

export default function Browse() {
  const [items, setItems] = useState([]);
  const [genres, setGenres] = useState([]);
  const [selectedItem, setSelectedItem] = useState(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all'); // all | tagged | untagged
  const [sort, setSort] = useState('title');
  const [genre, setGenre] = useState('');
  const [tagging, setTagging] = useState({});
  const [sourceLabel, setSourceLabel] = useState('media server');
  const searchTimeout = useRef(null);

  function load(q, p, f = filter, s = sort, g = genre) {
    // Browse talks to source-neutral endpoints; the server decides whether
    // Jellyfin or Plex is active.
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ page: p, limit: PAGE_SIZE });
    if (q) params.set('search', q);
    if (f !== 'all') params.set('tagState', f);
    if (s !== 'title') params.set('sort', s);
    if (g) params.set('genre', g);
    fetch(`/api/media/items?${params}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) { setError(data.error); setItems([]); setTotal(0); return; }
        setItems(data.items || []);
        setTotal(data.total || 0);
        setSourceLabel(data.sourceLabel || 'media server');
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load(search, page);
  }, [page]);

  useEffect(() => {
    fetch('/api/media/genres')
      .then((r) => r.json())
      .then((data) => setGenres(data.genres || []))
      .catch(() => setGenres([]));
  }, []);

  function handleSearch(val) {
    setSearch(val);
    clearTimeout(searchTimeout.current);
    // Debounce search so typing does not issue a request per keystroke.
    searchTimeout.current = setTimeout(() => {
      setPage(1);
      load(val, 1);
    }, 400);
  }

  function handleFilter(nextFilter) {
    setFilter(nextFilter);
    setPage(1);
    load(search, 1, nextFilter);
  }

  function handleSort(nextSort) {
    setSort(nextSort);
    setPage(1);
    load(search, 1, filter, nextSort, genre);
  }

  function handleGenre(nextGenre) {
    setGenre(nextGenre);
    setPage(1);
    load(search, 1, filter, sort, nextGenre);
  }

  async function toggleTag(item) {
    const id = itemId(item);
    // Track each item independently so one card can show a busy state without
    // freezing the whole grid.
    setTagging((t) => ({ ...t, [id]: true }));
    try {
      if (item.hasRvTag) {
        await fetch(`/api/media/items/${encodeURIComponent(id)}/tag`, { method: 'DELETE' });
      } else {
        await fetch(`/api/media/items/${encodeURIComponent(id)}/tag`, { method: 'POST' });
      }
      setItems((prev) =>
        prev
          .map((i) =>
            itemId(i) === id ? { ...i, hasRvTag: !i.hasRvTag } : i
          )
          .filter((i) => {
            if (filter === 'tagged') return i.hasRvTag;
            if (filter === 'untagged') return !i.hasRvTag;
            return true;
          })
      );
      if ((filter === 'tagged' && item.hasRvTag) || (filter === 'untagged' && !item.hasRvTag)) {
        setTotal((t) => Math.max(0, t - 1));
      }
    } finally {
      setTagging((t) => ({ ...t, [id]: false }));
    }
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const renderPagination = () => (
    <Pagination
      page={page}
      totalPages={totalPages}
      onPrev={() => setPage(page - 1)}
      onNext={() => setPage(page + 1)}
    />
  );

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
              onClick={() => handleFilter(f)}
              className={`btn text-xs ${filter === f ? 'bg-accent text-white' : 'btn-secondary'}`}
            >
              {f}
            </button>
          ))}
        </div>
        <select
          className="input w-auto min-w-36"
          value={sort}
          onChange={(e) => handleSort(e.target.value)}
        >
          {SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <select
          className="input w-auto min-w-40"
          value={genre}
          onChange={(e) => handleGenre(e.target.value)}
        >
          <option value="">All genres</option>
          {genres.map((g) => (
            <option key={g.id || g.name} value={g.name}>{g.name}</option>
          ))}
        </select>
        <span className="text-sm text-gray-500">{total} movies</span>
      </div>

      {loading && <div className="text-gray-500 text-sm">Loading…</div>}
      {!loading && error && (
        <div className="card p-4 text-sm text-red-400 space-y-1">
          <p className="font-medium">Could not reach {sourceLabel}</p>
          <p className="text-red-500/70">{error}</p>
          <p className="text-gray-500">Check your {sourceLabel} connection in <a href="/settings" className="text-accent hover:underline">Settings</a>.</p>
        </div>
      )}

      {renderPagination()}

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
        {items.map((item) => (
          <MovieCard
            key={itemId(item)}
            item={item}
            onSelect={() => setSelectedItem(item)}
            onToggle={() => toggleTag(item)}
            toggling={!!tagging[itemId(item)]}
          />
        ))}
      </div>

      {renderPagination()}

      {selectedItem && (
        <MovieDetails item={selectedItem} onClose={() => setSelectedItem(null)} />
      )}
    </div>
  );
}

function itemId(item) {
  // sourceItemId is the current ID contract; fallbacks keep older responses
  // and compatibility aliases working.
  return String(item.sourceItemId || item.id || item.jellyfinId);
}

function Pagination({ page, totalPages, onPrev, onNext }) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-center gap-2 pt-2">
      <button className="btn-secondary" disabled={page <= 1} onClick={onPrev}>← Prev</button>
      <span className="text-sm text-gray-400">Page {page} / {totalPages}</span>
      <button className="btn-secondary" disabled={page >= totalPages} onClick={onNext}>Next →</button>
    </div>
  );
}

function MovieCard({ item, onSelect, onToggle, toggling }) {
  return (
    <div className={`card overflow-hidden flex flex-col transition-all ${item.hasRvTag ? 'ring-2 ring-accent' : ''}`}>
      <button
        type="button"
        className="aspect-[2/3] bg-surface relative flex-shrink-0 text-left overflow-hidden focus:outline-none focus:ring-2 focus:ring-accent"
        onClick={onSelect}
      >
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
      </button>
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

function MovieDetails({ item, onClose }) {
  useEffect(() => {
    // Let keyboard users close the details modal without moving focus.
    function handleKeyDown(e) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const ratings = [
    item.officialRating ? ['Rating', item.officialRating] : null,
    item.communityRating != null ? ['Audience', `${Number(item.communityRating).toFixed(1)} / 10`] : null,
    item.criticRating != null ? ['Critic', `${Math.round(Number(item.criticRating))}%`] : null,
  ].filter(Boolean);
  const details = [
    item.year,
    item.runtime ? `${item.runtime} min` : null,
    fmtDate(item.premiereDate) ? `Released ${fmtDate(item.premiereDate)}` : null,
    fmtDate(item.dateCreated) ? `Added ${fmtDate(item.dateCreated)}` : null,
  ].filter(Boolean);
  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 p-4 flex items-center justify-center"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="card w-full max-w-3xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="grid md:grid-cols-[220px,1fr] gap-4 p-4">
          <div className="aspect-[2/3] bg-surface overflow-hidden rounded">
            {item.imageUrl ? (
              <img src={item.imageUrl} alt={item.title} className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-gray-600 text-sm text-center p-4">
                {item.title}
              </div>
            )}
          </div>
          <div className="space-y-3 min-w-0">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="text-lg font-semibold leading-snug">{item.title}</h2>
                <div className="text-sm text-gray-500">
                  {details.join(' · ') || '—'}
                </div>
              </div>
              <button className="btn-ghost text-xs" onClick={onClose}>Close</button>
            </div>
            {ratings.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {ratings.map(([label, value]) => (
                  <div key={label} className="bg-surface border border-border rounded px-2 py-1 text-xs">
                    <span className="text-gray-500">{label}:</span> <span className="text-gray-200">{value}</span>
                  </div>
                ))}
              </div>
            )}
            {item.genres?.length > 0 && (
              <div className="text-xs text-gray-400">{item.genres.join(' · ')}</div>
            )}
            {item.studios?.length > 0 && (
              <div className="text-xs text-gray-500">{item.studios.join(' · ')}</div>
            )}
            <p className="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap">
              {item.overview || 'No description available.'}
            </p>
            {item.sourcePath && (
              <div className="text-xs text-gray-600 break-all">{item.sourcePath}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
