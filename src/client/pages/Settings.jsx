import { useEffect, useState } from 'react';

const HW_OPTIONS = ['none', 'vaapi', 'qsv'];
const UNSYNC_OPTIONS = ['keep', 'delete'];

export default function Settings() {
  const [config, setConfig] = useState(null);
  const [profiles, setProfiles] = useState([]);
  const [health, setHealth] = useState(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [readiness, setReadiness] = useState(null);
  const [ffmpegTest, setFfmpegTest] = useState(null);
  const [testingFfmpeg, setTestingFfmpeg] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch('/api/settings').then((r) => r.json()),
      fetch('/api/profiles').then((r) => r.json()),
      fetch('/health').then((r) => r.json()).catch(() => null),
      fetch('/api/diagnostics/readiness').then((r) => r.json()).catch(() => null),
    ])
      .then(([cfg, prof, h, ready]) => {
        setConfig(cfg);
        setProfiles(prof.profiles || []);
        setHealth(h);
        setReadiness(ready);
      })
      .catch((err) => {
        console.error('Settings load failed:', err);
        setConfig({});
      });
  }, []);

  function field(key, value) {
    setConfig((c) => ({ ...c, [key]: value }));
  }

  async function runReadiness() {
    setReadiness(null);
    const res = await fetch('/api/diagnostics/readiness');
    setReadiness(await res.json());
  }

  async function runFfmpegTest() {
    setTestingFfmpeg(true);
    setFfmpegTest(null);
    try {
      const res = await fetch('/api/diagnostics/ffmpeg-test', { method: 'POST' });
      const data = await res.json().catch(() => ({ ok: false, reason: 'Invalid API response' }));
      setFfmpegTest(data);
    } catch {
      setFfmpegTest({ ok: false, reason: 'API server unreachable' });
    } finally {
      setTestingFfmpeg(false);
    }
  }

  async function save() {
    setSaving(true);
    setSaved(false);
    try {
      await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/settings/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jellyfinUrl: config.jellyfinUrl, jellyfinApiKey: config._hasApiKey && config.jellyfinApiKey.startsWith('***') ? undefined : config.jellyfinApiKey }),
      });
      let data;
      const text = await res.text();
      try {
        data = JSON.parse(text);
      } catch {
        data = { ok: false, error: 'API server unreachable — check the terminal' };
      }
      setTestResult(data);
    } catch {
      setTestResult({ ok: false, error: 'API server unreachable — check the terminal' });
    } finally {
      setTesting(false);
    }
  }

  if (!config) return <div className="text-gray-500 text-sm">Loading...</div>;

  return (
    <div className="max-w-2xl space-y-8">
      <h1 className="text-xl font-semibold">Settings</h1>

      {/* Jellyfin */}
      <section className="card p-6 space-y-4">
        <h2 className="font-medium text-gray-200">Jellyfin Connection</h2>
        <div>
          <label className="label">Server URL</label>
          <input className="input" value={config.jellyfinUrl || ''} onChange={(e) => field('jellyfinUrl', e.target.value)} placeholder="http://jellyfin:8096" />
        </div>
        <div>
          <label className="label">API Key</label>
          <input className="input" type="password" value={config.jellyfinApiKey || ''} onChange={(e) => field('jellyfinApiKey', e.target.value)} placeholder={config._hasApiKey ? '(saved)' : 'Paste API key'} />
        </div>
        <div>
          <label className="label">Jellyfin Media Path (host path Jellyfin uses)</label>
          <input className="input" value={config.jellyfinMediaPath || ''} onChange={(e) => field('jellyfinMediaPath', e.target.value)} placeholder="/mnt/user/Media" />
          <p className="text-xs text-gray-500 mt-1">Maps to <code className="text-gray-400">{config.sourceMediaRoot || '/media'}</code> inside the container.</p>
        </div>
        <div className="flex items-center gap-3">
          <button className="btn-secondary" onClick={testConnection} disabled={testing}>
            {testing ? 'Testing…' : 'Test Connection'}
          </button>
          {testResult && (
            <span className={`text-sm ${testResult.ok ? 'text-green-400' : 'text-red-400'}`}>
              {testResult.ok ? `✓ ${testResult.serverName} v${testResult.version}` : `✗ ${testResult.error}`}
            </span>
          )}
        </div>
      </section>

      {/* Sync behavior */}
      <section className="card p-6 space-y-4">
        <h2 className="font-medium text-gray-200">Sync Behavior</h2>
        <div>
          <label className="label">RV Tag</label>
          <input className="input" value={config.rvTag || ''} onChange={(e) => field('rvTag', e.target.value)} placeholder="RV-SYNC" />
        </div>
        <div>
          <label className="label">When tag is removed</label>
          <select className="input" value={config.unsyncBehavior || 'keep'} onChange={(e) => field('unsyncBehavior', e.target.value)}>
            <option value="keep">Keep file in /rv-ready</option>
            <option value="delete">Delete file from /rv-ready</option>
          </select>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Scan Interval (minutes)</label>
            <input className="input" type="number" min={1} value={config.scanIntervalMinutes || 10} onChange={(e) => field('scanIntervalMinutes', Number(e.target.value))} />
          </div>
          <div>
            <label className="label">Max Concurrent Transcodes</label>
            <input className="input" type="number" min={1} max={8} value={config.maxConcurrentTranscodes || 1} onChange={(e) => field('maxConcurrentTranscodes', Number(e.target.value))} />
          </div>
        </div>
      </section>

      {/* Transcoding */}
      <section className="card p-6 space-y-4">
        <h2 className="font-medium text-gray-200">Transcoding</h2>
        <div>
          <label className="label">Default Profile</label>
          <select className="input" value={config.transcodeProfile || ''} onChange={(e) => field('transcodeProfile', e.target.value)}>
            {profiles.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Hardware Acceleration</label>
          <select className="input" value={config.hwAccel || 'none'} onChange={(e) => field('hwAccel', e.target.value)}>
            <option value="none">Software (CPU)</option>
            <option value="vaapi">Intel VAAPI</option>
            <option value="qsv">Intel Quick Sync (QSV)</option>
          </select>
        </div>

        <div className="flex items-center gap-3">
          <button className="btn-secondary" onClick={runFfmpegTest} disabled={testingFfmpeg}>
            {testingFfmpeg ? 'Testing…' : 'Test ffmpeg'}
          </button>
          {ffmpegTest && (
            <span className={`text-sm ${ffmpegTest.ok ? 'text-green-400' : 'text-red-400'}`}>
              {ffmpegTest.ok ? `✓ ${ffmpegTest.mode} encode in ${(ffmpegTest.elapsedMs / 1000).toFixed(1)}s` : `✗ ${ffmpegTest.reason || 'ffmpeg failed'}`}
            </span>
          )}
        </div>

        {/* Health summary */}
        {health && (
          <div className="bg-surface rounded p-3 text-xs space-y-1">
            {Object.entries(health.checks || {}).map(([key, val]) => (
              <div key={key} className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${val?.ok ? 'bg-green-400' : 'bg-red-400'}`} />
                <span className="text-gray-400 w-20 flex-shrink-0">{key}</span>
                <span className="text-gray-500 truncate">{val?.ok ? (val.version || val.path || val.mode || 'ok') : val?.reason || 'error'}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card p-6 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-medium text-gray-200">Unraid Readiness</h2>
          <button className="btn-secondary text-xs" onClick={runReadiness}>Refresh</button>
        </div>
        {!readiness && <div className="text-sm text-gray-500">Checking…</div>}
        {readiness && (
          <div className="space-y-2">
            <div className={`text-sm ${readiness.ok ? 'text-green-400' : 'text-yellow-400'}`}>
              {readiness.ok ? 'Ready for Unraid container testing.' : 'Resolve required checks before container testing.'}
            </div>
            <div className="bg-surface rounded p-3 text-xs space-y-2">
              {Object.entries(readiness.checks || {}).map(([key, val]) => (
                <div key={key} className="grid grid-cols-[96px_16px_1fr] gap-2 items-start">
                  <span className="text-gray-400">{key}</span>
                  <span className={val?.ok ? 'text-green-400' : 'text-red-400'}>{val?.ok ? '●' : '●'}</span>
                  <span className="text-gray-500 break-words">
                    {val?.ok
                      ? (val.path || val.serverName || val.name || val.sampleTitle || 'ok')
                      : (val?.reason || 'error')}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      <div className="flex items-center gap-3">
        <button className="btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save Settings'}
        </button>
        {saved && <span className="text-green-400 text-sm">Saved.</span>}
      </div>
    </div>
  );
}
