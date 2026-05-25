'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const cfg = require('../config');

const DRI_DEVICE = '/dev/dri/renderD128';

function hwInitArgs(hwAccel) {
  if (hwAccel === 'vaapi') {
    return ['-vaapi_device', DRI_DEVICE];
  }
  if (hwAccel === 'qsv') {
    return ['-qsv_device', DRI_DEVICE];
  }
  return [];
}

function videoFilter(profile, hwAccel) {
  const { maxWidth, maxHeight } = profile;
  if (hwAccel === 'vaapi') {
    return `format=nv12,hwupload,scale_vaapi=w=${maxWidth}:h=${maxHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
  }
  if (hwAccel === 'qsv') {
    return `scale=w=${maxWidth}:h=${maxHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2,format=nv12`;
  }
  return `scale=w=${maxWidth}:h=${maxHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p`;
}

function videoEncoder(hwAccel) {
  if (hwAccel === 'vaapi') return 'h264_vaapi';
  if (hwAccel === 'qsv') return 'h264_qsv';
  return 'libx264';
}

// Probe whether a hardware accel mode is usable
async function probeHwAccel(hwAccel, ffmpegPath) {
  if (hwAccel === 'none') return { available: true, mode: 'none' };
  if (!fs.existsSync(DRI_DEVICE)) {
    return { available: false, mode: 'none', reason: `${DRI_DEVICE} not present` };
  }
  return new Promise((resolve) => {
    // Run a quick null transcode to verify hw encoder is available
    const probeProfile = {
      maxWidth: 128,
      maxHeight: 72,
    };
    const args = [
      ...hwInitArgs(hwAccel),
      '-f', 'lavfi', '-i', 'color=black:s=128x72:r=1:d=1',
      '-vf', videoFilter(probeProfile, hwAccel),
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
    const proc = spawn(ffmpegPath, args, { stdio: 'ignore' });
    proc.on('close', (code) => {
      if (code === 0) finish({ available: true, mode: hwAccel });
      else finish({ available: false, mode: 'none', reason: `${hwAccel} test encode failed (exit ${code})` });
    });
    proc.on('error', (err) => finish({ available: false, mode: 'none', reason: err.message }));
    timer = setTimeout(() => {
      proc.kill('SIGKILL');
      finish({ available: false, mode: 'none', reason: 'probe timeout' });
    }, 15000);
  });
}

function buildArgs(inputPath, outputPath, profile, hwAccel) {
  const args = [];
  const { audioCodec, videoBitrate, maxrate, bufsize, audioBitrate, audioChannels } = profile;

  args.push(...hwInitArgs(hwAccel));
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
  args.push('-y', outputPath);

  return args;
}

function run({ inputPath, outputPath, profile, hwAccel, ffmpegPath, onLog, signal }) {
  return new Promise((resolve, reject) => {
    const args = buildArgs(inputPath, outputPath, profile, hwAccel);
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

    const handleOutput = (data) => {
      const lines = data.toString().split('\n').filter(Boolean);
      lines.forEach((line) => onLog(line));
    };

    proc.stdout.on('data', handleOutput);
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

function testEncode({ outputPath, profile, hwAccel, ffmpegPath }) {
  return new Promise((resolve) => {
    const args = [
      ...hwInitArgs(hwAccel),
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=2',
      '-vf', videoFilter(profile, hwAccel),
      '-c:v', videoEncoder(hwAccel),
      ...(hwAccel === 'none' ? ['-preset', 'slow', '-crf', '18'] : []),
      '-b:v', profile.videoBitrate,
      '-maxrate', profile.maxrate,
      '-bufsize', profile.bufsize,
      '-c:a', profile.audioCodec === 'aac' ? 'aac' : profile.audioCodec,
      '-b:a', profile.audioBitrate,
      '-ac', String(profile.audioChannels),
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
        elapsedMs: Date.now() - started,
        outputPath,
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

module.exports = { probeHwAccel, buildArgs, run, testEncode };
