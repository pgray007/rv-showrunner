'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const cfg = require('../config');

const DEFAULT_DRI_DEVICE = '/dev/dri/renderD128';

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

function buildArgs(inputPath, outputPath, profile, hwAccel, hwDevice = DEFAULT_DRI_DEVICE) {
  const args = [];
  const { audioCodec, videoBitrate, maxrate, bufsize, audioBitrate, audioChannels } = profile;
  hwAccel = normalizeHwAccel(hwAccel);

  args.push(...hwInitArgs(hwAccel, hwDevice));
  args.push('-i', inputPath);

  args.push('-vf', videoFilter(profile, hwAccel));

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

  // Map only first video + first audio; no data streams
  args.push('-map', '0:v:0', '-map', '0:a:0?');

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

function run({ inputPath, outputPath, profile, hwAccel, hwDevice, ffmpegPath, onLog, onProgress, signal }) {
  return new Promise((resolve, reject) => {
    const args = buildArgs(inputPath, outputPath, profile, hwAccel, hwDevice);
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
  });
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
