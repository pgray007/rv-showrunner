import { useEffect, useState } from 'react';

function fmtBytes(b) {
  if (!b) return '0 B';
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

export default function Storage() {
  const [data, setData] = useState(null);
  const [deleting, setDeleting] = useState({});

  function load() {
    fetch('/api/storage')
      .then((r) => r.json())
      .then(setData)
      .catch((err) => {
        console.error('Storage load failed:', err);
        setData({ files: [], bytesUsed: 0, outputRoot: '—', error: err.message });
      });
  }

  useEffect(() => {
    load();
  }, []);

  async function deleteItem(item) {
    const job = await fetch(`/api/jobs?status=complete`).then((r) => r.json())
      .then((d) => d.jobs?.find((j) => j.output_path && j.output_path.startsWith(item.path)));
    if (!job) { alert('Could not find matching job to delete.'); return; }
    if (!confirm(`Delete "${item.name}" from RV storage?`)) return;
    setDeleting((d) => ({ ...d, [item.path]: true }));
    try {
      await fetch(`/api/jobs/${job.id}?deleteFiles=true`, { method: 'DELETE' });
      load();
    } finally {
      setDeleting((d) => ({ ...d, [item.path]: false }));
    }
  }

  if (!data) return <div className="text-gray-500 text-sm">Loading…</div>;

  const files = data.files || [];
  const totalSize = files.reduce((acc, f) => acc + (f.size || 0), 0);
  const reported = data.bytesUsed || 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <h1 className="text-xl font-semibold">RV Storage</h1>
        <span className="text-sm text-gray-400">{data.outputRoot}</span>
        <button className="btn-ghost text-xs ml-auto" onClick={load}>↻ Refresh</button>
      </div>

      <div className="card p-5 flex items-center gap-6">
        <div>
          <p className="text-xs text-gray-500 mb-1">Total Used</p>
          <p className="text-2xl font-bold">{fmtBytes(reported)}</p>
        </div>
        <div>
          <p className="text-xs text-gray-500 mb-1">Items</p>
          <p className="text-2xl font-bold">{files.length}</p>
        </div>
      </div>

      {files.length === 0 ? (
        <div className="card p-8 text-center text-gray-500 text-sm">
          No files in {data.outputRoot} yet.
        </div>
      ) : (
        <div className="card divide-y divide-border">
          {files.map((f) => (
            <div key={f.path} className="flex items-center gap-4 px-4 py-3 hover:bg-surface/50 transition-colors">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{f.name}</p>
                <p className="text-xs text-gray-500">{f.type}</p>
              </div>
              <span className="text-sm text-gray-400 flex-shrink-0">{fmtBytes(f.size)}</span>
              <button
                className="btn-ghost text-xs text-red-400 hover:text-red-300 flex-shrink-0"
                onClick={() => deleteItem(f)}
                disabled={deleting[f.path]}
              >
                {deleting[f.path] ? '…' : 'Delete'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
