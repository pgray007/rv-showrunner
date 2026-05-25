import { useEffect, useRef, useState } from 'react';
import StatusBadge from '../components/StatusBadge';

const STATUS_FILTERS = ['all', 'queued', 'transcoding', 'complete', 'failed', 'cancelled', 'deleted'];

function fmtBytes(b) {
  if (!b) return '—';
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString();
}

export default function Queue() {
  const [jobs, setJobs] = useState([]);
  const [filter, setFilter] = useState('all');
  const [expanded, setExpanded] = useState(null);
  const [logs, setLogs] = useState({});
  const [retrying, setRetrying] = useState({});
  const [pruning, setPruning] = useState(false);
  const [pruneResult, setPruneResult] = useState(null);
  const logRefs = useRef({});
  const sseRef = useRef(null);

  function load() {
    const params = filter !== 'all' ? `?status=${filter}` : '';
    fetch(`/api/jobs${params}`).then((r) => r.json()).then((d) => setJobs(d.jobs || []));
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [filter]);

  function toggleExpand(jobId) {
    if (expanded === jobId) {
      setExpanded(null);
      if (sseRef.current) { sseRef.current.close(); sseRef.current = null; }
      return;
    }
    setExpanded(jobId);
    setLogs((l) => ({ ...l, [jobId]: [] }));
    if (sseRef.current) sseRef.current.close();

    const es = new EventSource(`/api/jobs/${jobId}/logs/stream`);
    sseRef.current = es;
    es.onmessage = (e) => {
      const entry = JSON.parse(e.data);
      setLogs((l) => {
        const existing = l[jobId] || [];
        return { ...l, [jobId]: [...existing, entry] };
      });
      // Auto-scroll
      setTimeout(() => {
        const el = logRefs.current[jobId];
        if (el) el.scrollTop = el.scrollHeight;
      }, 0);
    };
  }

  async function retry(job) {
    setRetrying((r) => ({ ...r, [job.id]: true }));
    try {
      await fetch(`/api/jobs/${job.id}/retry`, { method: 'POST' });
      load();
    } finally {
      setRetrying((r) => ({ ...r, [job.id]: false }));
    }
  }

  async function deleteJob(job) {
    if (!confirm(`Remove job for "${job.title}"?`)) return;
    await fetch(`/api/jobs/${job.id}`, { method: 'DELETE' });
    load();
  }

  async function cancelJob(job) {
    if (!confirm(`Cancel job for "${job.title}"?`)) return;
    await fetch(`/api/jobs/${job.id}/cancel`, { method: 'POST' });
    load();
  }

  async function pruneLogs() {
    setPruning(true);
    setPruneResult(null);
    try {
      const res = await fetch('/api/jobs/logs/prune', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keepLast: 1000 }),
      });
      setPruneResult(await res.json());
    } finally {
      setPruning(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-xl font-semibold">Queue</h1>
        <div className="flex gap-1 flex-wrap">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`btn text-xs ${filter === f ? 'bg-accent text-white' : 'btn-secondary'}`}
            >
              {f}
            </button>
          ))}
        </div>
        <span className="text-sm text-gray-500">{jobs.length} jobs</span>
        <button className="btn-secondary text-xs ml-auto" onClick={pruneLogs} disabled={pruning}>
          {pruning ? 'Pruning…' : 'Prune Logs'}
        </button>
        {pruneResult && <span className="text-xs text-gray-500">{pruneResult.deleted || 0} removed</span>}
      </div>

      {jobs.length === 0 && (
        <div className="text-gray-500 text-sm card p-8 text-center">No jobs yet — browse and tag movies to get started.</div>
      )}

      <div className="space-y-2">
        {jobs.map((job) => (
          <div key={job.id} className="card overflow-hidden">
            <div
              className="flex items-center gap-3 p-4 cursor-pointer hover:bg-surface/50 transition-colors"
              onClick={() => toggleExpand(job.id)}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sm truncate">{job.title}</span>
                  {job.year && <span className="text-xs text-gray-500">({job.year})</span>}
                </div>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <StatusBadge status={job.status} />
                  <span className="text-xs text-gray-500">{job.profile}</span>
                  {job.output_path && (
                    <span className="text-xs text-gray-600 truncate max-w-xs">{job.output_path}</span>
                  )}
                </div>
              </div>
              <div className="text-right flex-shrink-0 text-xs text-gray-500 space-y-1">
                <div>{fmtDate(job.updated_at)}</div>
                {job.source_size && <div>{fmtBytes(job.source_size)}</div>}
              </div>
              <div className="flex gap-1 flex-shrink-0">
                {['failed', 'cancelled'].includes(job.status) && (
                  <button
                    className="btn-secondary text-xs"
                    onClick={(e) => { e.stopPropagation(); retry(job); }}
                    disabled={retrying[job.id]}
                  >
                    {retrying[job.id] ? '…' : 'Retry'}
                  </button>
                )}
                {['queued', 'transcoding'].includes(job.status) && (
                  <button
                    className="btn-ghost text-xs text-yellow-400 hover:text-yellow-300"
                    onClick={(e) => { e.stopPropagation(); cancelJob(job); }}
                  >
                    Cancel
                  </button>
                )}
                {['complete', 'failed', 'cancelled', 'deleted'].includes(job.status) && (
                  <button
                    className="btn-ghost text-xs text-red-400 hover:text-red-300"
                    onClick={(e) => { e.stopPropagation(); deleteJob(job); }}
                  >
                    Delete
                  </button>
                )}
              </div>
              <span className="text-gray-600 text-xs">{expanded === job.id ? '▲' : '▼'}</span>
            </div>

            {expanded === job.id && (
              <div className="border-t border-border">
                {job.error_log && (
                  <div className="p-3 bg-red-950/40 text-red-300 text-xs font-mono whitespace-pre-wrap">
                    {job.error_log}
                  </div>
                )}
                <div
                  ref={(el) => { logRefs.current[job.id] = el; }}
                  className="p-3 bg-black/40 text-xs font-mono text-gray-400 max-h-64 overflow-y-auto space-y-0.5"
                >
                  {(logs[job.id] || []).map((entry, i) => (
                    <div key={i} className="leading-relaxed">{entry.line}</div>
                  ))}
                  {!(logs[job.id] || []).length && <div className="text-gray-600">No logs yet…</div>}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
