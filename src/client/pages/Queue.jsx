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

function fmtDuration(seconds) {
  if (!seconds && seconds !== 0) return '—';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function pct(job) {
  if (job.status === 'complete') return 100;
  return Math.max(0, Math.min(100, Number(job.progress_pct || 0)));
}

function progressColor(value) {
  return value >= 100 ? 'bg-emerald-500' : 'bg-yellow-400';
}

function progressLabel(job) {
  if (job.status === 'complete') return 'Complete';
  if (job.eta_seconds) return `ETA ${fmtDuration(job.eta_seconds)}`;
  if (job.duration_ms) {
    return `${fmtDuration(Math.round((job.progress_ms || 0) / 1000))} / ${fmtDuration(Math.round(job.duration_ms / 1000))}`;
  }
  return 'Running';
}

export default function Queue() {
  const [jobs, setJobs] = useState([]);
  const [summary, setSummary] = useState(null);
  const [filter, setFilter] = useState('all');
  const [expanded, setExpanded] = useState(null);
  const [logs, setLogs] = useState({});
  const [retrying, setRetrying] = useState({});
  const [refreshing, setRefreshing] = useState(false);
  const [refreshResult, setRefreshResult] = useState(null);
  const [pruning, setPruning] = useState(false);
  const [pruneResult, setPruneResult] = useState(null);
  const logRefs = useRef({});
  const sseRef = useRef(null);

  function load() {
    const params = filter !== 'all' ? `?status=${filter}` : '';
    fetch(`/api/jobs${params}`).then((r) => r.json()).then((d) => {
      setJobs(d.jobs || []);
      setSummary(d.summary || null);
    });
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

  async function refreshQueue() {
    setRefreshing(true);
    setRefreshResult(null);
    try {
      const res = await fetch('/api/jobs/refresh', { method: 'POST' });
      const data = await res.json().catch(() => ({ ok: false, error: 'Invalid API response' }));
      setRefreshResult(data);
      load();
    } finally {
      setRefreshing(false);
    }
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
        <button className="btn-secondary text-xs ml-auto" onClick={refreshQueue} disabled={refreshing}>
          {refreshing ? 'Refreshing...' : 'Refresh queue'}
        </button>
        <button className="btn-secondary text-xs" onClick={pruneLogs} disabled={pruning}>
          {pruning ? 'Pruning…' : 'Prune Logs'}
        </button>
        {refreshResult && (
          <span className={`text-xs ${refreshResult.ok ? 'text-gray-500' : 'text-red-400'}`}>
            {refreshResult.ok
              ? `${refreshResult.enqueued || 0} added${refreshResult.deleted ? `, ${refreshResult.deleted} removed` : ''}`
              : refreshResult.reason || refreshResult.error || 'refresh failed'}
          </span>
        )}
        {pruneResult && <span className="text-xs text-gray-500">{pruneResult.deleted || 0} removed</span>}
      </div>

      {jobs.length === 0 && (
        <div className="text-gray-500 text-sm card p-8 text-center">No jobs yet — browse and tag movies to get started.</div>
      )}

      {summary && summary.total > 0 && (
        <div className="card p-4 space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-300">Overall progress</span>
            <span className="text-gray-500">
              {summary.complete}/{summary.total} complete
              {summary.estimatedEtaSeconds ? ` · ETA ${fmtDuration(summary.estimatedEtaSeconds)}${summary.etaEstimated ? ' est.' : ''}` : ''}
            </span>
          </div>
          <div className="h-2 rounded bg-surface overflow-hidden">
            <div
              className={`h-full ${progressColor(summary.overallPct || 0)} transition-all`}
              style={{ width: `${Math.round(summary.overallPct || 0)}%` }}
            />
          </div>
        </div>
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
                {['transcoding', 'complete'].includes(job.status) && (
                  <div className="mt-3 max-w-xl">
                    <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
                      <span>{pct(job).toFixed(job.status === 'complete' ? 0 : 1)}%</span>
                      <span>{progressLabel(job)}</span>
                    </div>
                    <div className="h-1.5 rounded bg-surface overflow-hidden">
                      <div className={`h-full ${progressColor(pct(job))} transition-all`} style={{ width: `${pct(job)}%` }} />
                    </div>
                  </div>
                )}
              </div>
              <div className="text-right flex-shrink-0 text-xs text-gray-500 space-y-1">
                <div>{fmtDate(job.updated_at)}</div>
                <div>
                  <span className="text-gray-600">Source size:</span> {fmtBytes(job.source_size)}
                </div>
                <div>
                  <span className="text-gray-600">RV-ready size:</span> {fmtBytes(job.rv_ready_size)}
                </div>
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
