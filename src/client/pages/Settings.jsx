import { useEffect, useState } from 'react';

const UNSYNC_OPTIONS = ['keep', 'delete'];
const BLANK_PROFILE = {
  name: '',
  container: 'mp4',
  videoCodec: 'h264',
  audioCodec: 'aac',
  maxWidth: 1920,
  maxHeight: 1080,
  videoBitrate: '6M',
  maxrate: '8M',
  bufsize: '12M',
  audioBitrate: '192k',
  audioChannels: 2,
  subtitleMode: 'burn-forced-only',
  tonemapMode: 'auto',
  tonemapAlgorithm: 'hable',
  audioSelectionMode: 'smart',
  preferredAudioLanguages: ['eng', 'en'],
  preferDefaultAudio: true,
  ignoreCommentaryAudio: true,
};

export default function Settings() {
  const [config, setConfig] = useState(null);
  const [profiles, setProfiles] = useState([]);
  const [health, setHealth] = useState(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [ffmpegTest, setFfmpegTest] = useState(null);
  const [testingFfmpeg, setTestingFfmpeg] = useState(false);
  const [hardwareDevices, setHardwareDevices] = useState([]);
  const [hardwareState, setHardwareState] = useState(null);
  const [hardwareReload, setHardwareReload] = useState(null);
  const [profileDraft, setProfileDraft] = useState(null);
  const [profileMode, setProfileMode] = useState(null);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch('/api/settings').then((r) => r.json()),
      fetch('/api/profiles').then((r) => r.json()),
      fetch('/health').then((r) => r.json()).catch(() => null),
      fetch('/api/diagnostics/hardware-devices').then((r) => r.json()).catch(() => null),
    ])
      .then(([cfg, prof, h, hw]) => {
        setConfig(cfg);
        setProfiles(prof.profiles || []);
        setHealth(h);
        setHardwareDevices(hw?.devices || []);
        setHardwareState(hw?.state || null);
      })
      .catch((err) => {
        console.error('Settings load failed:', err);
        setConfig({});
      });
  }, []);

  function field(key, value) {
    setConfig((c) => ({ ...c, [key]: value }));
  }

  async function refreshProfiles() {
    const prof = await fetch('/api/profiles').then((r) => r.json());
    setProfiles(prof.profiles || []);
    return prof.profiles || [];
  }

  function draftFromProfile(profile, name = profile?.name || '') {
    return {
      ...BLANK_PROFILE,
      ...profile,
      name,
      builtin: undefined,
      editable: undefined,
      source: undefined,
    };
  }

  function startNewProfile() {
    setProfileMode('new');
    setProfileError(null);
    setProfileDraft({ ...BLANK_PROFILE });
  }

  function startEditProfile(profile) {
    if (!profile) return;
    setProfileMode(profile.editable ? 'edit' : 'view');
    setProfileError(null);
    setProfileDraft(draftFromProfile(profile));
  }

  function startDuplicateProfile(profile) {
    if (!profile) return;
    setProfileMode('duplicate');
    setProfileError(null);
    setProfileDraft(draftFromProfile(profile, `${profile.name}-custom`));
  }

  function profileField(key, value) {
    setProfileDraft((profile) => ({ ...profile, [key]: value }));
  }

  function languageValue(value) {
    return Array.isArray(value) ? value.join(', ') : value || '';
  }

  async function saveProfileDraft() {
    setProfileSaving(true);
    setProfileError(null);
    try {
      const res = await fetch('/api/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(profileDraft),
      });
      const data = await res.json().catch(() => ({ error: 'Invalid API response' }));
      if (!res.ok) throw new Error(data.error || 'Profile save failed');
      await refreshProfiles();
      field('transcodeProfile', data.profile?.name || profileDraft.name);
      setProfileMode('edit');
      setProfileDraft(draftFromProfile(data.profile || profileDraft));
    } catch (err) {
      setProfileError(err.message);
    } finally {
      setProfileSaving(false);
    }
  }

  async function deleteProfile(profile) {
    if (!profile) return;
    if (!confirm(`Delete transcode profile "${profile.name}"?`)) return;
    setProfileSaving(true);
    setProfileError(null);
    try {
      const res = await fetch(`/api/profiles/${encodeURIComponent(profile.name)}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({ error: 'Invalid API response' }));
      if (!res.ok) throw new Error(data.error || 'Profile delete failed');
      const nextProfiles = await refreshProfiles();
      if (config.transcodeProfile === profile.name) {
        field('transcodeProfile', nextProfiles[0]?.name || '');
      }
      setProfileDraft(null);
      setProfileMode(null);
    } catch (err) {
      setProfileError(err.message);
    } finally {
      setProfileSaving(false);
    }
  }

  async function runFfmpegTest() {
    setTestingFfmpeg(true);
    setFfmpegTest(null);
    try {
      const res = await fetch('/api/diagnostics/ffmpeg-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
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
      const res = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
      const data = await res.json().catch(() => null);
      if (data?.config) setConfig(data.config);
      if (data?.hardwareReload) {
        setHardwareReload(data.hardwareReload);
        setHardwareState(data.hardwareReload.after || data.hardwareReload.before || hardwareState);
      }
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
      const payload = config.mediaSource === 'plex'
        ? {
            mediaSource: 'plex',
            plexUrl: config.plexUrl,
            plexToken: config._hasPlexToken && config.plexToken.startsWith('***') ? undefined : config.plexToken,
          }
        : {
            mediaSource: 'jellyfin',
            jellyfinUrl: config.jellyfinUrl,
            jellyfinApiKey: config._hasApiKey && config.jellyfinApiKey.startsWith('***') ? undefined : config.jellyfinApiKey,
          };
      const res = await fetch('/api/settings/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
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
  const selectedProfile = profiles.find((p) => p.name === config.transcodeProfile) || profiles[0] || null;
  const profileReadOnly = profileMode === 'view';

  return (
    <div className="max-w-2xl space-y-8">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Settings</h1>
        <span className="text-xs text-gray-500">Version {config.appVersion || '0.98-pre'}</span>
      </div>

      {/* Media Source */}
      <section className="card p-6 space-y-4">
        <h2 className="font-medium text-gray-200">Media Source</h2>
        <div>
          <label className="label">Active Source</label>
          <select className="input" value={config.mediaSource || 'jellyfin'} onChange={(e) => { field('mediaSource', e.target.value); setTestResult(null); }}>
            <option value="jellyfin">Jellyfin</option>
            <option value="plex">Plex</option>
          </select>
        </div>

        {(config.mediaSource || 'jellyfin') === 'jellyfin' ? (
          <>
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
              <p className="text-xs text-gray-500 mt-1">Use the Folder path from Jellyfin Libraries -&gt; Manage library.</p>
            </div>
          </>
        ) : (
          <>
            <div>
              <label className="label">Server URL</label>
              <input className="input" value={config.plexUrl || ''} onChange={(e) => field('plexUrl', e.target.value)} placeholder="http://plex:32400" />
            </div>
            <div>
              <label className="label">Token</label>
              <input className="input" type="password" value={config.plexToken || ''} onChange={(e) => field('plexToken', e.target.value)} placeholder={config._hasPlexToken ? '(saved)' : 'Paste Plex token'} />
            </div>
            <div>
              <label className="label">Plex Media Path (host path Plex uses)</label>
              <input className="input" value={config.plexMediaPath || ''} onChange={(e) => field('plexMediaPath', e.target.value)} placeholder="/mnt/user/Media" />
              <p className="text-xs text-gray-500 mt-1">Use the file path Plex reports for movies in your library.</p>
            </div>
          </>
        )}
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
          <label className="label">Media metadata tag for synced media</label>
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
          <div className="flex items-center gap-2">
            <select className="input" value={config.transcodeProfile || ''} onChange={(e) => field('transcodeProfile', e.target.value)}>
              {profiles.map((p) => <option key={p.name} value={p.name}>{p.name}{p.editable ? '' : ' (built-in)'}</option>)}
            </select>
            <button className="btn-secondary text-xs" type="button" onClick={() => startEditProfile(selectedProfile)} disabled={!selectedProfile}>
              {selectedProfile?.editable ? 'Edit' : 'View'}
            </button>
            <button className="btn-secondary text-xs" type="button" onClick={() => startDuplicateProfile(selectedProfile)} disabled={!selectedProfile}>Duplicate</button>
            <button className="btn-secondary text-xs" type="button" onClick={startNewProfile}>New</button>
          </div>
        </div>
        {profileDraft && (
          <div className="rounded border border-border bg-surface p-4 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-medium text-gray-200">
                  {profileMode === 'new' ? 'New Profile' : profileMode === 'duplicate' ? 'Duplicate Profile' : profileMode === 'view' ? 'Profile Details' : 'Edit Profile'}
                </h3>
                <p className="text-xs text-gray-500">
                  {profileReadOnly ? 'Built-in profiles are read-only. Duplicate one to customize it.' : 'Changes affect new jobs that use this profile.'}
                </p>
              </div>
              <button className="btn-ghost text-xs" type="button" onClick={() => { setProfileDraft(null); setProfileMode(null); setProfileError(null); }}>Close</button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Name</label>
                <input className="input" value={profileDraft.name || ''} disabled={profileReadOnly || profileMode === 'edit'} onChange={(e) => profileField('name', e.target.value)} placeholder="tablet-720p" />
              </div>
              <div>
                <label className="label">Container</label>
                <select className="input" value={profileDraft.container || 'mp4'} disabled={profileReadOnly} onChange={(e) => profileField('container', e.target.value)}>
                  <option value="mp4">mp4</option>
                </select>
              </div>
              <div>
                <label className="label">Max Width</label>
                <input className="input" type="number" min={16} max={7680} value={profileDraft.maxWidth || ''} disabled={profileReadOnly} onChange={(e) => profileField('maxWidth', Number(e.target.value))} />
              </div>
              <div>
                <label className="label">Max Height</label>
                <input className="input" type="number" min={16} max={7680} value={profileDraft.maxHeight || ''} disabled={profileReadOnly} onChange={(e) => profileField('maxHeight', Number(e.target.value))} />
              </div>
              <div>
                <label className="label">Video Codec</label>
                <select className="input" value={profileDraft.videoCodec || 'h264'} disabled={profileReadOnly} onChange={(e) => profileField('videoCodec', e.target.value)}>
                  <option value="h264">h264</option>
                </select>
              </div>
              <div>
                <label className="label">Video Bitrate</label>
                <input className="input" value={profileDraft.videoBitrate || ''} disabled={profileReadOnly} onChange={(e) => profileField('videoBitrate', e.target.value)} placeholder="6M" />
              </div>
              <div>
                <label className="label">Maxrate</label>
                <input className="input" value={profileDraft.maxrate || ''} disabled={profileReadOnly} onChange={(e) => profileField('maxrate', e.target.value)} placeholder="8M" />
              </div>
              <div>
                <label className="label">Buffer Size</label>
                <input className="input" value={profileDraft.bufsize || ''} disabled={profileReadOnly} onChange={(e) => profileField('bufsize', e.target.value)} placeholder="12M" />
              </div>
              <div>
                <label className="label">Audio Codec</label>
                <select className="input" value={profileDraft.audioCodec || 'aac'} disabled={profileReadOnly} onChange={(e) => profileField('audioCodec', e.target.value)}>
                  <option value="aac">aac</option>
                </select>
              </div>
              <div>
                <label className="label">Audio Bitrate</label>
                <input className="input" value={profileDraft.audioBitrate || ''} disabled={profileReadOnly} onChange={(e) => profileField('audioBitrate', e.target.value)} placeholder="192k" />
              </div>
              <div>
                <label className="label">Audio Channels</label>
                <input className="input" type="number" min={1} max={8} value={profileDraft.audioChannels || ''} disabled={profileReadOnly} onChange={(e) => profileField('audioChannels', Number(e.target.value))} />
              </div>
              <div>
                <label className="label">Subtitle Mode</label>
                <select className="input" value={profileDraft.subtitleMode || 'burn-forced-only'} disabled={profileReadOnly} onChange={(e) => profileField('subtitleMode', e.target.value)}>
                  <option value="burn-forced-only">Burn forced only</option>
                  <option value="none">None</option>
                </select>
              </div>
              <div>
                <label className="label">HDR Tonemapping</label>
                <select className="input" value={profileDraft.tonemapMode || 'auto'} disabled={profileReadOnly} onChange={(e) => profileField('tonemapMode', e.target.value)}>
                  <option value="auto">Auto</option>
                  <option value="always">Always</option>
                  <option value="none">None</option>
                </select>
              </div>
              <div>
                <label className="label">Tonemap Algorithm</label>
                <select className="input" value={profileDraft.tonemapAlgorithm || 'hable'} disabled={profileReadOnly} onChange={(e) => profileField('tonemapAlgorithm', e.target.value)}>
                  <option value="hable">hable</option>
                  <option value="mobius">mobius</option>
                  <option value="reinhard">reinhard</option>
                </select>
              </div>
              <div>
                <label className="label">Audio Selection</label>
                <select className="input" value={profileDraft.audioSelectionMode || 'smart'} disabled={profileReadOnly} onChange={(e) => profileField('audioSelectionMode', e.target.value)}>
                  <option value="smart">Smart</option>
                  <option value="first">First track</option>
                </select>
              </div>
              <div>
                <label className="label">Preferred Audio Languages</label>
                <input className="input" value={languageValue(profileDraft.preferredAudioLanguages)} disabled={profileReadOnly} onChange={(e) => profileField('preferredAudioLanguages', e.target.value.split(',').map((item) => item.trim()).filter(Boolean))} placeholder="eng, en" />
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-300">
                <input type="checkbox" checked={profileDraft.preferDefaultAudio !== false} disabled={profileReadOnly} onChange={(e) => profileField('preferDefaultAudio', e.target.checked)} />
                Prefer default audio track
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-300">
                <input type="checkbox" checked={profileDraft.ignoreCommentaryAudio !== false} disabled={profileReadOnly} onChange={(e) => profileField('ignoreCommentaryAudio', e.target.checked)} />
                Ignore commentary tracks
              </label>
            </div>

            {profileError && <div className="text-sm text-red-400">{profileError}</div>}
            <div className="flex items-center gap-2">
              {profileReadOnly ? (
                <button className="btn-secondary text-xs" type="button" onClick={() => startDuplicateProfile(profileDraft)}>Duplicate</button>
              ) : (
                <button className="btn-secondary text-xs" type="button" onClick={saveProfileDraft} disabled={profileSaving}>
                  {profileSaving ? 'Saving...' : 'Save Profile'}
                </button>
              )}
              {profileMode === 'edit' && (
                <button className="btn-ghost text-xs text-red-400 hover:text-red-300" type="button" onClick={() => deleteProfile(profileDraft)} disabled={profileSaving || config.transcodeProfile === profileDraft.name}>
                  Delete
                </button>
              )}
              {profileMode === 'edit' && config.transcodeProfile === profileDraft.name && (
                <span className="text-xs text-gray-500">Selected default profiles cannot be deleted.</span>
              )}
            </div>
          </div>
        )}
        <div>
          <label className="label">Hardware Acceleration</label>
          <select className="input" value={config.hwAccel || 'none'} onChange={(e) => field('hwAccel', e.target.value)}>
            <option value="none">Software (CPU)</option>
            <option value="vaapi">Intel VAAPI</option>
          </select>
        </div>
        {config.hwAccel !== 'none' && (
          <div>
            <label className="label">Encoding Device</label>
            <select className="input" value={config.hwDevice || '/dev/dri/renderD128'} onChange={(e) => field('hwDevice', e.target.value)}>
              {hardwareDevices.length === 0 && (
                <option value={config.hwDevice || '/dev/dri/renderD128'}>{config.hwDevice || '/dev/dri/renderD128'}</option>
              )}
              {hardwareDevices.map((device) => (
                <option key={device.path} value={device.path}>{device.label || device.path}</option>
              ))}
            </select>
            <p className="text-xs text-gray-500 mt-1">
              Active: <code className="text-gray-400">{hardwareState?.activeMode || 'unknown'}</code>
              {hardwareState?.activeDevice && <> on <code className="text-gray-400">{hardwareState.activeDevice}</code></>}
            </p>
          </div>
        )}

        {hardwareReload?.deferred && (
          <div className="rounded bg-yellow-950/40 border border-yellow-800 px-3 py-2 text-sm text-yellow-300">
            Hardware settings were saved, but a transcode is active. The active job keeps its current command; new jobs use the change after the queue goes idle. Restart the container to force it sooner.
          </div>
        )}
        {hardwareReload && !hardwareReload.deferred && !hardwareReload.unchanged && (
          <div className="rounded bg-green-950/40 border border-green-800 px-3 py-2 text-sm text-green-300">
            Hardware settings applied to the idle queue.
          </div>
        )}

        <div className="flex items-center gap-3">
          <button className="btn-secondary" onClick={runFfmpegTest} disabled={testingFfmpeg}>
            {testingFfmpeg ? 'Testing…' : 'Test ffmpeg'}
          </button>
          {ffmpegTest && (
            <div className="min-w-0 flex-1">
              <div className={`text-sm ${ffmpegTest.ok ? 'text-green-400' : 'text-red-400'}`}>
                {ffmpegTest.ok ? `✓ ${ffmpegTest.mode} encode in ${(ffmpegTest.elapsedMs / 1000).toFixed(1)}s` : `✗ ${ffmpegTest.reason || 'ffmpeg failed'}`}
              </div>
              {!ffmpegTest.ok && ffmpegTest.stderr && (
                <pre className="mt-2 max-h-40 overflow-auto rounded bg-black/40 p-2 text-xs text-red-200 whitespace-pre-wrap">{ffmpegTest.stderr}</pre>
              )}
              {!ffmpegTest.ok && ffmpegTest.cmd && (
                <pre className="mt-2 max-h-28 overflow-auto rounded bg-black/40 p-2 text-xs text-gray-400 whitespace-pre-wrap">{ffmpegTest.cmd}</pre>
              )}
            </div>
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

      <div className="flex items-center gap-3">
        <button className="btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save Settings'}
        </button>
        {saved && <span className="text-green-400 text-sm">Saved.</span>}
      </div>
    </div>
  );
}
