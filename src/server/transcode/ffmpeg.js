'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const cfg = require('../config');

const DEFAULT_DRI_DEVICE = '/dev/dri/renderD128';
const FILTER_PROBE_TIMEOUT_MS = 5000;
const ffmpegFilterCache = new Map();

const HW_MODES = {
  vaapi: {
    label: 'Intel VAAPI',
    initArgs: (device) => ['-vaapi_device', device, '-hwaccel', 'vaapi', '-hwaccel_device', device, '-hwaccel_output_format', 'vaapi'],
    testInitArgs: (device) => ['-vaapi_device', device],
    filter: ({ maxWidth, maxHeight }) => `scale_vaapi=w=${maxWidth}:h=${maxHeight}:format=nv12:force_original_aspect_ratio=decrease:force_divisible_by=2`,
    testFilter: ({ maxWidth, maxHeight }) => `format=nv12,hwupload,scale_vaapi=w=${maxWidth}:h=${maxHeight}:format=nv12:force_original_aspect_ratio=decrease:force_divisible_by=2`,
    encoder: 'h264_vaapi',
  },
};

function hwCandidates(hwAccel) {
  return [normalizeHwAccel(hwAccel)];
}

function normalizeHwAccel(hwAccel) {
  if (['qsv', 'qsvDerived', 'qsvViaVaapi'].includes(hwAccel)) return 'vaapi';
  return hwAccel;
}

function hwInitArgs(hwAccel, hwDevice = DEFAULT_DRI_DEVICE) {
  return HW_MODES[normalizeHwAccel(hwAccel)]?.initArgs(hwDevice) || [];
}

function hwTestInitArgs(hwAccel, hwDevice = DEFAULT_DRI_DEVICE) {
  const mode = HW_MODES[normalizeHwAccel(hwAccel)];
  return (mode?.testInitArgs || mode?.initArgs)?.(hwDevice) || [];
}

function videoFilter(profile, hwAccel) {
  const { maxWidth, maxHeight } = profile;
  if (HW_MODES[normalizeHwAccel(hwAccel)]) return HW_MODES[normalizeHwAccel(hwAccel)].filter({ maxWidth, maxHeight });
  return `scale=w=${maxWidth}:h=${maxHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p`;
}

function tonemapFilter(profile) {
  const { maxWidth, maxHeight } = profile;
  const algorithm = profile.tonemapAlgorithm || 'hable';
  return [
    'zscale=t=linear:npl=100',
    'format=gbrpf32le',
    `tonemap=tonemap=${algorithm}:desat=0`,
    'zscale=t=bt709:m=bt709:p=bt709:r=tv',
    `scale=w=${maxWidth}:h=${maxHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
    'format=yuv420p',
  ].join(',');
}

function vaapiTonemapFilter(profile) {
  const { maxWidth, maxHeight } = profile;
  return [
    'tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709',
    `scale_vaapi=w=${maxWidth}:h=${maxHeight}:format=nv12:force_original_aspect_ratio=decrease:force_divisible_by=2`,
  ].join(',');
}

function testVideoFilter(profile, hwAccel) {
  const { maxWidth, maxHeight } = profile;
  const mode = HW_MODES[normalizeHwAccel(hwAccel)];
  if (mode) return (mode.testFilter || mode.filter)({ maxWidth, maxHeight });
  return `scale=w=${maxWidth}:h=${maxHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p`;
}

function videoEncoder(hwAccel) {
  if (HW_MODES[normalizeHwAccel(hwAccel)]) return HW_MODES[normalizeHwAccel(hwAccel)].encoder;
  return 'libx264';
}

// Probe whether a hardware accel mode is usable
async function probeHwAccel(hwAccel, ffmpegPath, hwDevice = DEFAULT_DRI_DEVICE) {
  hwAccel = normalizeHwAccel(hwAccel);
  if (hwAccel === 'none') return { available: true, mode: 'none' };
  if (!fs.existsSync(hwDevice)) {
    return { available: false, mode: 'none', reason: `${hwDevice} not present`, device: hwDevice };
  }
  let lastResult = null;
  for (const mode of hwCandidates(hwAccel)) {
    lastResult = await runProbe(mode, ffmpegPath, hwDevice);
    if (lastResult.available) return lastResult;
  }
  return lastResult || { available: false, mode: 'none', reason: `${hwAccel} test encode failed`, device: hwDevice };
}

function runProbe(hwAccel, ffmpegPath, hwDevice = DEFAULT_DRI_DEVICE) {
  return new Promise((resolve) => {
    // Run a quick null transcode to verify hw encoder is available
    const probeProfile = {
      maxWidth: 128,
      maxHeight: 72,
    };
    const args = [
      ...hwTestInitArgs(hwAccel, hwDevice),
      '-f', 'lavfi', '-i', 'color=black:s=128x72:r=1:d=1',
      '-vf', testVideoFilter(probeProfile, hwAccel),
      '-c:v', videoEncoder(hwAccel), '-f', 'null', '-frames:v', '1', '-',
    ];
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    let stderr = '';
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    proc.stderr.on('data', (data) => {
      stderr = `${stderr}${data.toString()}`.slice(-4000);
    });
    proc.on('close', (code) => {
      if (code === 0) finish({ available: true, mode: hwAccel, device: hwDevice });
      else finish({ available: false, mode: 'none', reason: `${hwAccel} test encode failed (exit ${code})`, stderr, device: hwDevice });
    });
    proc.on('error', (err) => finish({ available: false, mode: 'none', reason: err.message }));
    timer = setTimeout(() => {
      proc.kill('SIGKILL');
      finish({ available: false, mode: 'none', reason: 'probe timeout' });
    }, 15000);
  });
}

function buildArgs(inputPath, outputPath, profile, hwAccel, hwDevice = DEFAULT_DRI_DEVICE, decisions = null) {
  const args = [];
  const { audioCodec, videoBitrate, maxrate, bufsize, audioBitrate, audioChannels } = profile;
  hwAccel = decisions?.effectiveHwAccel || normalizeHwAccel(hwAccel);

  args.push(...hwInitArgs(hwAccel, hwDevice));
  args.push('-i', inputPath);

  args.push('-vf', videoFilterForDecision(profile, hwAccel, decisions));

  // Video codec
  args.push('-c:v', videoEncoder(hwAccel));
  if (hwAccel === 'none') {
    args.push('-preset', 'slow', '-crf', '18');
  }

  args.push(
    '-b:v', videoBitrate,
    '-maxrate', maxrate,
    '-bufsize', bufsize,
  );

  // Audio
  args.push('-c:a', audioCodec === 'aac' ? 'aac' : audioCodec);
  args.push('-b:a', audioBitrate, '-ac', String(audioChannels));

  // Map selected video + audio; no data streams
  args.push('-map', '0:v:0', '-map', decisions?.audio?.map || '0:a:0?');

  if (decisions?.tonemap?.applied) {
    args.push('-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709');
  }

  // Subtitle handling: burn forced subtitles (software only — hw path skips for now)
  if (profile.subtitleMode === 'burn-forced-only' && hwAccel === 'none') {
    // TODO: detect and burn forced subtitle track
  }

  args.push('-map_chapters', '-1');
  args.push('-movflags', '+faststart');
  args.push('-progress', 'pipe:1', '-nostats');
  args.push('-y', outputPath);

  return args;
}

function videoFilterForDecision(profile, hwAccel, decisions = null) {
  if (!decisions?.tonemap?.applied) return videoFilter(profile, hwAccel);
  if (decisions.tonemap.engine === 'vaapi') return vaapiTonemapFilter(profile);
  return tonemapFilter(profile);
}

async function prepareTranscode(inputPath, profile, hwAccel, ffmpegPath) {
  let media = null;
  try {
    media = await probeStreams(inputPath, ffmpegPath);
  } catch (err) {
    return {
      effectiveHwAccel: normalizeHwAccel(hwAccel),
      probeError: err.message,
      tonemap: {
        mode: profile.tonemapMode || 'auto',
        applied: false,
        hdrDetected: false,
        reason: `stream probe failed: ${err.message}`,
      },
      audio: {
        mode: profile.audioSelectionMode || 'smart',
        map: '0:a:0?',
        selectedIndex: null,
        reason: `stream probe failed; falling back to first audio: ${err.message}`,
      },
    };
  }

  const video = media.streams.find((stream) => stream.codec_type === 'video');
  const tonemap = decideTonemap(video, profile);
  const normalizedHwAccel = normalizeHwAccel(hwAccel);
  const tonemapEngine = await chooseTonemapEngine(video, tonemap, normalizedHwAccel, ffmpegPath);
  const effectiveHwAccel = tonemap.applied && tonemapEngine.engine !== 'vaapi' ? 'none' : normalizedHwAccel;
  return {
    effectiveHwAccel,
    probeError: null,
    tonemap: {
      ...tonemap,
      engine: tonemapEngine.engine,
      engineReason: tonemapEngine.reason,
      hardwareAccelerationDisabled: tonemap.applied && normalizedHwAccel !== 'none' && tonemapEngine.engine !== 'vaapi',
    },
    audio: selectAudioStream(media.streams, profile),
  };
}

function run({ inputPath, outputPath, profile, hwAccel, hwDevice, ffmpegPath, onLog, onProgress, onTranscodeInfo, signal }) {
  return prepareTranscode(inputPath, profile, hwAccel, ffmpegPath).then((decisions) => new Promise((resolve, reject) => {
    onTranscodeInfo?.(formatTranscodeInfo(decisions));
    logTranscodeDecisions(onLog, decisions);
    const args = buildArgs(inputPath, outputPath, profile, hwAccel, hwDevice, decisions);
    const cmd = [ffmpegPath, ...args].join(' ');
    onLog(`[ffmpeg] ${cmd}`);

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let cancelled = false;
    let exited = false;

    const cancel = () => {
      cancelled = true;
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!exited) proc.kill('SIGKILL');
      }, 5000).unref();
    };
    if (signal?.aborted) cancel();
    signal?.addEventListener('abort', cancel, { once: true });

    let progressBuffer = '';
    const handleProgress = (data) => {
      progressBuffer += data.toString();
      const lines = progressBuffer.split('\n');
      progressBuffer = lines.pop() || '';
      const update = {};
      for (const line of lines) {
        const idx = line.indexOf('=');
        if (idx === -1) continue;
        update[line.slice(0, idx)] = line.slice(idx + 1);
      }
      if (Object.keys(update).length) onProgress?.(update);
    };
    const handleOutput = (data) => {
      const lines = data.toString().split('\n').filter(Boolean);
      lines.forEach((line) => {
        onLog(line);
        const durationMatch = line.match(/\bDuration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (durationMatch) onProgress?.({ duration: `${durationMatch[1]}:${durationMatch[2]}:${durationMatch[3]}` });
        const match = line.match(/\btime=(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (match) onProgress?.({ out_time: `${match[1]}:${match[2]}:${match[3]}` });
      });
    };

    proc.stdout.on('data', handleProgress);
    proc.stderr.on('data', handleOutput);

    proc.on('close', (code) => {
      exited = true;
      signal?.removeEventListener('abort', cancel);
      if (cancelled) reject(Object.assign(new Error('transcode cancelled'), { cmd, cancelled: true }));
      else if (code === 0) resolve(cmd);
      else reject(Object.assign(new Error(`ffmpeg exited ${code}`), { cmd }));
    });

    proc.on('error', (err) => {
      signal?.removeEventListener('abort', cancel);
      reject(Object.assign(err, { cmd }));
    });
  }));
}

function probeStreams(inputPath, ffmpegPath) {
  return new Promise((resolve, reject) => {
    const ffprobePath = path.join(path.dirname(ffmpegPath), 'ffprobe');
    const args = [
      '-v', 'error',
      '-print_format', 'json',
      '-show_streams',
      inputPath,
    ];
    const proc = spawn(ffprobePath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('stream probe timeout'));
    }, 10000);
    proc.stdout.on('data', (data) => {
      stdout = `${stdout}${data.toString()}`.slice(-2_000_000);
    });
    proc.stderr.on('data', (data) => {
      stderr = `${stderr}${data.toString()}`.slice(-4000);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr.trim() || `ffprobe exited ${code}`));
      try {
        const parsed = JSON.parse(stdout || '{}');
        resolve({ streams: Array.isArray(parsed.streams) ? parsed.streams : [] });
      } catch (err) {
        reject(new Error(`ffprobe returned invalid JSON: ${err.message}`));
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function decideTonemap(video, profile) {
  const mode = profile.tonemapMode || 'auto';
  const hdrDetected = isHdrVideo(video);
  if (mode === 'none') {
    return { mode, applied: false, hdrDetected, algorithm: profile.tonemapAlgorithm || 'hable', reason: 'disabled by profile' };
  }
  if (mode === 'always') {
    return { mode, applied: true, hdrDetected, algorithm: profile.tonemapAlgorithm || 'hable', reason: 'forced by profile' };
  }
  if (hdrDetected) {
    return { mode, applied: true, hdrDetected, algorithm: profile.tonemapAlgorithm || 'hable', reason: describeHdr(video) };
  }
  return { mode, applied: false, hdrDetected, algorithm: profile.tonemapAlgorithm || 'hable', reason: 'source does not look HDR' };
}

async function chooseTonemapEngine(video, tonemap, hwAccel, ffmpegPath) {
  if (!tonemap.applied) return { engine: null, reason: 'tonemapping not applied' };
  if (hwAccel !== 'vaapi') return { engine: 'software', reason: 'VAAPI is not active' };
  if (!isHdr10Video(video)) return { engine: 'software', reason: 'VAAPI tonemapping only supports HDR10 input' };
  if (!await hasFfmpegFilter(ffmpegPath, 'tonemap_vaapi')) {
    return { engine: 'software', reason: 'ffmpeg does not provide tonemap_vaapi' };
  }
  return { engine: 'vaapi', reason: 'Intel VAAPI tonemap_vaapi available' };
}

function hasFfmpegFilter(ffmpegPath, filterName) {
  const cacheKey = `${ffmpegPath}:${filterName}`;
  if (!ffmpegFilterCache.has(cacheKey)) {
    ffmpegFilterCache.set(cacheKey, probeFfmpegFilter(ffmpegPath, filterName));
  }
  return ffmpegFilterCache.get(cacheKey);
}

function probeFfmpegFilter(ffmpegPath, filterName) {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-filters'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let settled = false;
    const finish = (available) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Boolean(available));
    };
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      finish(false);
    }, FILTER_PROBE_TIMEOUT_MS);
    proc.stdout.on('data', (data) => {
      stdout = `${stdout}${data.toString()}`.slice(-2_000_000);
    });
    proc.on('close', (code) => {
      finish(code === 0 && new RegExp(`\\b${escapeRegExp(filterName)}\\b`).test(stdout));
    });
    proc.on('error', () => finish(false));
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isHdrVideo(video) {
  if (!video) return false;
  const values = [
    video.color_transfer,
    video.color_primaries,
    video.color_space,
    video.pix_fmt,
    ...(video.side_data_list || []).map((item) => `${item.side_data_type || ''} ${item.transfer_characteristics || ''}`),
  ].map((value) => String(value || '').toLowerCase());
  return values.some((value) => (
    value.includes('smpte2084') ||
    value.includes('arib-std-b67') ||
    value.includes('bt2020') ||
    value.includes('mastering display metadata') ||
    value.includes('content light level metadata') ||
    value.includes('pq') ||
    value.includes('hlg')
  ));
}

function isHdr10Video(video) {
  if (!video) return false;
  const transfer = String(video.color_transfer || '').toLowerCase();
  const primaries = String(video.color_primaries || '').toLowerCase();
  const space = String(video.color_space || '').toLowerCase();
  const sideData = (video.side_data_list || []).map((item) => String(item.side_data_type || '').toLowerCase());
  return transfer.includes('smpte2084') &&
    (primaries.includes('bt2020') || space.includes('bt2020') || sideData.some((value) => value.includes('mastering display metadata')));
}

function describeHdr(video) {
  if (!video) return 'no video stream metadata';
  return [
    video.color_transfer ? `transfer ${video.color_transfer}` : null,
    video.color_primaries ? `primaries ${video.color_primaries}` : null,
    video.color_space ? `space ${video.color_space}` : null,
  ].filter(Boolean).join(', ') || 'HDR metadata detected';
}

function selectAudioStream(streams, profile) {
  const audioStreams = streams.filter((stream) => stream.codec_type === 'audio');
  if (!audioStreams.length) {
    return { mode: profile.audioSelectionMode || 'smart', map: '0:a:0?', selectedIndex: null, reason: 'no audio streams found' };
  }
  if ((profile.audioSelectionMode || 'smart') === 'first') {
    return describeAudioChoice(audioStreams[0], 'first audio selected by profile', profile);
  }

  const preferredLanguages = normalizeLanguageList(profile.preferredAudioLanguages || ['eng', 'en']);
  const candidates = audioStreams
    .filter((stream) => !(profile.ignoreCommentaryAudio !== false && isCommentaryAudio(stream)))
    .map((stream) => ({
      stream,
      score: audioScore(stream, preferredLanguages, profile),
    }));
  const scored = candidates.length ? candidates : audioStreams.map((stream) => ({ stream, score: audioScore(stream, preferredLanguages, profile) - 1000 }));
  scored.sort((a, b) => b.score - a.score || Number(a.stream.index) - Number(b.stream.index));
  const selected = scored[0].stream;
  const reason = audioReason(selected, preferredLanguages, profile, candidates.length === 0);
  return describeAudioChoice(selected, reason, profile);
}

function audioScore(stream, preferredLanguages, profile) {
  let score = 0;
  const language = normalizeLanguage(stream.tags?.language);
  const title = String(stream.tags?.title || '');
  const disposition = stream.disposition || {};
  if (preferredLanguages.includes(language)) score += 100;
  if (profile.preferDefaultAudio !== false && Number(disposition.default) === 1) score += 60;
  if (Number(disposition.comment) === 1 || isCommentaryAudio(stream)) score -= 200;
  if (Number(disposition.visual_impaired) === 1 || Number(disposition.hearing_impaired) === 1) score -= 50;
  if (/\b(descriptive|audio description|sdh|hearing impaired)\b/i.test(title)) score -= 40;
  score += Math.min(Number(stream.channels || 0), 8);
  return score;
}

function audioReason(stream, preferredLanguages, profile, usedCommentaryFallback) {
  const pieces = [];
  const language = normalizeLanguage(stream.tags?.language);
  if (preferredLanguages.includes(language)) pieces.push(`preferred language ${language}`);
  if (profile.preferDefaultAudio !== false && Number(stream.disposition?.default) === 1) pieces.push('default track');
  if (usedCommentaryFallback) pieces.push('all tracks looked like commentary');
  if (!pieces.length) pieces.push('highest scoring track');
  return pieces.join(', ');
}

function describeAudioChoice(stream, reason, profile) {
  const title = stream.tags?.title || '';
  const language = normalizeLanguage(stream.tags?.language) || 'unknown';
  return {
    mode: profile.audioSelectionMode || 'smart',
    map: `0:${stream.index}?`,
    selectedIndex: Number(stream.index),
    streamIndex: Number(stream.index),
    codec: stream.codec_name || null,
    channels: stream.channels || null,
    language,
    title,
    default: Number(stream.disposition?.default) === 1,
    commentary: isCommentaryAudio(stream),
    reason,
  };
}

function isCommentaryAudio(stream) {
  const title = String(stream.tags?.title || '');
  return Number(stream.disposition?.comment) === 1 ||
    /\b(commentary|director'?s?\s+commentary|cast\s+commentary|crew\s+commentary)\b/i.test(title);
}

function normalizeLanguageList(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(',');
  return list.map(normalizeLanguage).filter(Boolean);
}

function normalizeLanguage(value) {
  return String(value || '').trim().toLowerCase();
}

function formatTranscodeInfo(decisions) {
  return {
    tonemap: decisions.tonemap,
    audio: decisions.audio,
    effectiveHwAccel: decisions.effectiveHwAccel,
    probeError: decisions.probeError,
  };
}

function logTranscodeDecisions(onLog, decisions) {
  const tone = decisions.tonemap;
  const toneMethod = tone.engine === 'vaapi' ? 'Intel VAAPI' : tone.algorithm;
  const toneEngine = tone.engine === 'software' ? ' in software' : '';
  onLog(`[transcode] Tonemapping: ${tone.applied ? `applied ${toneMethod}${toneEngine}` : 'not applied'} (${tone.reason})`);
  if (tone.applied && tone.engineReason) {
    onLog(`[transcode] Tonemapping engine: ${tone.engineReason}`);
  }
  if (tone.hardwareAccelerationDisabled) {
    onLog('[transcode] Tonemapping requires software filtering; hardware acceleration disabled for this job');
  }
  const audio = decisions.audio;
  const details = [
    `stream ${audio.selectedIndex ?? 'none'}`,
    audio.language ? `language ${audio.language}` : null,
    audio.title ? `title "${audio.title}"` : null,
    audio.default ? 'default' : null,
    audio.commentary ? 'commentary' : null,
  ].filter(Boolean).join(', ');
  onLog(`[transcode] Audio selection: ${details || audio.map} (${audio.reason})`);
}

function testEncode({ outputPath, profile, hwAccel, hwDevice = DEFAULT_DRI_DEVICE, ffmpegPath }) {
  hwAccel = normalizeHwAccel(hwAccel);
  const candidates = hwAccel === 'none' ? ['none'] : hwCandidates(hwAccel);
  return testEncodeCandidates({ outputPath, profile, hwDevice, ffmpegPath, candidates });
}

async function testEncodeCandidates({ outputPath, profile, hwDevice, ffmpegPath, candidates }) {
  let lastResult = null;
  const attempts = [];
  for (const mode of candidates) {
    lastResult = await runTestEncode({ outputPath, profile, hwAccel: mode, hwDevice, ffmpegPath });
    attempts.push({ mode, ok: lastResult.ok, reason: lastResult.reason, cmd: lastResult.cmd, stderr: lastResult.stderr });
    if (lastResult.ok) return { ...lastResult, requestedMode: candidates[0], attempts };
  }
  const stderr = attempts
    .map((attempt) => [
      `[${attempt.mode}] ${attempt.reason || 'ffmpeg failed'}`,
      attempt.stderr,
    ].filter(Boolean).join('\n'))
    .join('\n\n')
    .slice(-4000);
  return { ...lastResult, requestedMode: candidates[0], attempts, stderr };
}

function runTestEncode({ outputPath, profile, hwAccel, hwDevice = DEFAULT_DRI_DEVICE, ffmpegPath }) {
  return new Promise((resolve) => {
    const args = [
      ...hwTestInitArgs(hwAccel, hwDevice),
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=2',
      '-vf', testVideoFilter(profile, hwAccel),
      '-c:v', videoEncoder(hwAccel),
      ...(hwAccel === 'none' ? ['-preset', 'slow', '-crf', '18'] : []),
      '-b:v', profile.videoBitrate,
      '-maxrate', profile.maxrate,
      '-bufsize', profile.bufsize,
      '-c:a', profile.audioCodec === 'aac' ? 'aac' : profile.audioCodec,
      '-b:a', profile.audioBitrate,
      '-ac', String(profile.audioChannels),
      '-progress', 'pipe:1',
      '-nostats',
      '-movflags', '+faststart',
      '-y', outputPath,
    ];
    const started = Date.now();
    let stderr = '';

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve({ ok: false, reason: 'ffmpeg test timeout', elapsedMs: Date.now() - started, stderr });
    }, 20000);

    proc.stderr.on('data', (data) => {
      stderr = `${stderr}${data.toString()}`.slice(-4000);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        mode: hwAccel,
        device: hwDevice,
        elapsedMs: Date.now() - started,
        outputPath,
        cmd: [ffmpegPath, ...args].join(' '),
        reason: code === 0 ? null : `ffmpeg exited ${code}`,
        stderr,
      });
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: err.message, elapsedMs: Date.now() - started, stderr });
    });
  });
}

function probeDurationMs(inputPath, ffmpegPath) {
  return new Promise((resolve, reject) => {
    const ffprobePath = path.join(path.dirname(ffmpegPath), 'ffprobe');
    const args = [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      inputPath,
    ];
    const proc = spawn(ffprobePath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('duration probe timeout'));
    }, 5000);
    proc.stdout.on('data', (data) => {
      stdout = `${stdout}${data.toString()}`.slice(-4000);
    });
    proc.stderr.on('data', (data) => {
      stderr = `${stderr}${data.toString()}`.slice(-4000);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr.trim() || `ffprobe exited ${code}`));
      const seconds = Number(stdout.trim());
      resolve(Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null);
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

module.exports = { probeHwAccel, buildArgs, run, testEncode, probeDurationMs };
