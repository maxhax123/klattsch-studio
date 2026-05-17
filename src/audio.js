import {
  AUDIO_SAMPLE_RATE,
  DEFAULT_VIDEO_MIME_CANDIDATES,
} from './constants.js';
import { buildProtocol, getPlaybackSegments, getProjectEndBeat, getBeatMs, getSortedClips } from './project.js';
import { compileString } from './engine/sequencer.js';
import { encodeWav } from './engine/wav.js';
import { renderToBuffer } from './engine/synth-core.js';

function ensureArrayBufferUrl(blob, name) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function getVideoMimeType() {
  return DEFAULT_VIDEO_MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) ?? 'video/webm';
}

function renderStatusMessage(result) {
  if (!result.warnings.length) return 'Ready.';
  return result.warnings.join(' ');
}

function floatToInt16(float32Array) {
  const output = new Int16Array(float32Array.length);
  for (let index = 0; index < float32Array.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, float32Array[index]));
    output[index] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
  }
  return output;
}

function encodeMp3(float32Array, sampleRate) {
  const encoder = new window.lamejs.Mp3Encoder(1, sampleRate, 192);
  const pcm = floatToInt16(float32Array);
  const blocks = [];
  const blockSize = 1152;
  for (let index = 0; index < pcm.length; index += blockSize) {
    const chunk = pcm.subarray(index, index + blockSize);
    const buffer = encoder.encodeBuffer(chunk);
    if (buffer.length) blocks.push(buffer);
  }
  const flush = encoder.flush();
  if (flush.length) blocks.push(flush);
  return new Blob(blocks, { type: 'audio/mpeg' });
}

function buildAccuratePlaybackSegments(project, protocol, result) {
  const fallbackSegments = getPlaybackSegments(project, result.totalMs);
  if (!Array.isArray(result.phrases) || !result.phrases.length) {
    return fallbackSegments;
  }

  const sortedClips = getSortedClips(project);
  return protocol.ranges.map((range, index) => {
    const clip = sortedClips[index];
    const overlaps = result.phrases.filter(
      (phrase) => phrase.srcEnd > range.start && phrase.srcStart < range.end,
    );
    if (!clip) {
      return fallbackSegments[index];
    }
    if (!overlaps.length) {
      return {
        ...fallbackSegments[index],
        beatStart: clip.startBeat,
        beatEnd: clip.startBeat + clip.lengthBeats,
      };
    }
    return {
      clipId: clip.id,
      label: clip.text,
      tStartMs: overlaps[0].tStartMs,
      tEndMs: overlaps[overlaps.length - 1].tEndMs,
      beatStart: clip.startBeat,
      beatEnd: clip.startBeat + clip.lengthBeats,
    };
  });
}

export class StudioAudio {
  constructor({ onStatus, onPlayback }) {
    this.onStatus = onStatus;
    this.onPlayback = onPlayback;
    this.ctx = null;
    this.gainNode = null;
    this.currentRaf = 0;
    this.currentSource = null;
  }

  async ensureLiveContext(volume = 1) {
    if (this.ctx) {
      this.gainNode.gain.value = volume;
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    this.ctx = new AudioContext();
    this.gainNode = this.ctx.createGain();
    this.gainNode.gain.value = volume;
    this.gainNode.connect(this.ctx.destination);
  }

  stop() {
    if (this.currentSource) {
      try {
        this.currentSource.stop();
      } catch (_error) {
        // Already stopped.
      }
      this.currentSource.disconnect();
      this.currentSource = null;
    }
    if (this.currentRaf) {
      cancelAnimationFrame(this.currentRaf);
      this.currentRaf = 0;
    }
    this.onPlayback?.({
      isPlaying: false,
      currentMs: 0,
      totalMs: 0,
      activeClipId: null,
    });
  }

  compile(project) {
    const protocol = buildProtocol(project);
    const result = compileString(protocol.text, {
      bank: project.master.bank,
      baseF0: project.master.baseF0,
    });
    return {
      protocol,
      result,
      playbackSegments: buildAccuratePlaybackSegments(project, protocol, result),
    };
  }

  async play(project) {
    await this.ensureLiveContext(project.master.outputVolume);
    const rendered = await this.renderBuffer(project);
    const buffer = this.ctx.createBuffer(1, rendered.buffer.length, rendered.sampleRate);
    buffer.getChannelData(0).set(rendered.buffer);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gainNode);
    source.onended = () => {
      if (this.currentSource === source) {
        this.currentSource = null;
      }
    };
    this.stop();
    this.currentSource = source;
    source.start();
    this.onStatus?.(renderStatusMessage(rendered.result), rendered.result.warnings.length ? 'warn' : 'info');

    const startedAt = this.ctx.currentTime;
    const tick = () => {
      const currentMs = (this.ctx.currentTime - startedAt) * 1000;
      const active =
        rendered.playbackSegments.find((segment) => currentMs >= segment.tStartMs && currentMs < segment.tEndMs)
        ?? null;
      this.onPlayback?.({
        isPlaying: currentMs < rendered.result.totalMs && this.currentSource !== null,
        currentMs,
        totalMs: rendered.result.totalMs,
        activeClipId: active?.clipId ?? null,
      });
      if (currentMs < rendered.result.totalMs && this.currentSource) {
        this.currentRaf = requestAnimationFrame(tick);
      } else {
        this.currentRaf = 0;
      }
    };
    if (this.currentRaf) cancelAnimationFrame(this.currentRaf);
    this.currentRaf = requestAnimationFrame(tick);
    return rendered;
  }

  async renderBuffer(project) {
    const compiled = this.compile(project);
    const rendered = renderToBuffer({
      sampleRate: AUDIO_SAMPLE_RATE,
      schedule: compiled.result.schedule,
      totalMs: compiled.result.totalMs,
    });
    return {
      ...compiled,
      buffer: rendered,
      sampleRate: AUDIO_SAMPLE_RATE,
    };
  }

  async exportWav(project, filename) {
    const rendered = await this.renderBuffer(project);
    const { bytes } = encodeWav(rendered.buffer, rendered.sampleRate, {
      metadata: {
        software: 'Klattsch Studio',
        comment: rendered.protocol.text,
      },
    });
    ensureArrayBufferUrl(new Blob([bytes], { type: 'audio/wav' }), `${filename}.wav`);
    this.onStatus?.(`Rendered WAV: ${filename}.wav`, 'success');
  }

  async exportMp3(project, filename) {
    const rendered = await this.renderBuffer(project);
    const blob = encodeMp3(rendered.buffer, rendered.sampleRate);
    ensureArrayBufferUrl(blob, `${filename}.mp3`);
    this.onStatus?.(`Rendered MP3: ${filename}.mp3`, 'success');
  }

  async exportVideo(project, filename) {
    const rendered = await this.renderBuffer(project);
    const compiled = rendered;
    const mimeType = getVideoMimeType();
    const extension = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
    const width = 1440;
    const height = 810;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context2d = canvas.getContext('2d');

    const actx = new AudioContext();
    const audioBuffer = actx.createBuffer(1, rendered.buffer.length, rendered.sampleRate);
    audioBuffer.getChannelData(0).set(rendered.buffer);
    const synth = actx.createBufferSource();
    synth.buffer = audioBuffer;
    const analyser = actx.createAnalyser();
    analyser.fftSize = 1024;
    const destination = actx.createMediaStreamDestination();
    synth.connect(analyser);
    analyser.connect(destination);
    analyser.connect(actx.destination);

    const stream = new MediaStream([
      ...canvas.captureStream(30).getVideoTracks(),
      ...destination.stream.getAudioTracks(),
    ]);
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 3_000_000 });
    const chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };

    const playbackSegments = compiled.playbackSegments;
    const totalBeats = getProjectEndBeat(project);
    const beatMs = getBeatMs(project);
    const frequencyData = new Uint8Array(analyser.frequencyBinCount);
    const startTime = performance.now();

    const draw = () => {
      const elapsedMs = performance.now() - startTime;
      analyser.getByteFrequencyData(frequencyData);
      const active = playbackSegments.find((segment) => elapsedMs >= segment.tStartMs && elapsedMs < segment.tEndMs);
      const playheadBeat = (elapsedMs / beatMs) * (compiled.result.totalMs / Math.max(totalBeats * beatMs, 1));

      context2d.fillStyle = '#0a0d11';
      context2d.fillRect(0, 0, width, height);
      const gradient = context2d.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, 'rgba(255, 127, 39, 0.16)');
      gradient.addColorStop(1, 'rgba(30, 40, 58, 0.1)');
      context2d.fillStyle = gradient;
      context2d.fillRect(0, 0, width, height);

      context2d.fillStyle = '#f8fafc';
      context2d.font = '700 42px "Space Grotesk", sans-serif';
      context2d.fillText(project.master.title, 64, 72);
      context2d.font = '500 20px "IBM Plex Mono", monospace';
      context2d.fillStyle = '#9ca3af';
      context2d.fillText(`Tempo ${project.master.tempo} BPM  |  Bank ${project.master.bank}`, 64, 106);

      const timelineX = 64;
      const timelineY = 150;
      const timelineWidth = width - 128;
      const laneHeight = 20;
      const laneCount = 12;

      for (let beat = 0; beat <= totalBeats; beat += 1) {
        const x = timelineX + (beat / totalBeats) * timelineWidth;
        context2d.strokeStyle = beat % 4 === 0 ? 'rgba(255,255,255,0.24)' : 'rgba(255,255,255,0.08)';
        context2d.beginPath();
        context2d.moveTo(x, timelineY);
        context2d.lineTo(x, timelineY + laneCount * laneHeight);
        context2d.stroke();
      }

      for (let lane = 0; lane < laneCount; lane += 1) {
        const y = timelineY + lane * laneHeight;
        context2d.strokeStyle = 'rgba(255,255,255,0.06)';
        context2d.beginPath();
        context2d.moveTo(timelineX, y);
        context2d.lineTo(timelineX + timelineWidth, y);
        context2d.stroke();
      }

      for (const clip of project.clips) {
        const x = timelineX + (clip.startBeat / totalBeats) * timelineWidth;
        const w = (clip.lengthBeats / totalBeats) * timelineWidth;
        const y = timelineY + (6 - Math.round(clip.pitchOffset / 2)) * laneHeight;
        context2d.fillStyle = active?.clipId === clip.id ? '#ff8c42' : '#2dd4bf';
        context2d.globalAlpha = active?.clipId === clip.id ? 1 : 0.8;
        context2d.fillRect(x, y, w, laneHeight - 4);
        context2d.globalAlpha = 1;
        context2d.fillStyle = '#111827';
        context2d.font = '600 15px "Space Grotesk", sans-serif';
        context2d.fillText(clip.text, x + 8, y + 15);
      }

      const playheadX = timelineX + (playheadBeat / totalBeats) * timelineWidth;
      context2d.strokeStyle = '#f97316';
      context2d.lineWidth = 2;
      context2d.beginPath();
      context2d.moveTo(playheadX, timelineY - 12);
      context2d.lineTo(playheadX, timelineY + laneCount * laneHeight + 12);
      context2d.stroke();

      const meterX = 64;
      const meterY = 470;
      const barWidth = 8;
      const barGap = 6;
      for (let index = 0; index < 36; index += 1) {
        const magnitude = frequencyData[index] / 255;
        const barHeight = 12 + magnitude * 160;
        context2d.fillStyle = magnitude > 0.75 ? '#f97316' : magnitude > 0.45 ? '#fb7185' : '#38bdf8';
        context2d.fillRect(meterX + index * (barWidth + barGap), meterY + 180 - barHeight, barWidth, barHeight);
      }

      context2d.fillStyle = '#f8fafc';
      context2d.font = '700 26px "Space Grotesk", sans-serif';
      context2d.fillText(active?.label ?? 'Timeline render', 64, 700);
      context2d.fillStyle = '#94a3b8';
      context2d.font = '500 17px "IBM Plex Mono", monospace';
      context2d.fillText(`${Math.min(elapsedMs, compiled.result.totalMs).toFixed(0)} ms / ${compiled.result.totalMs.toFixed(0)} ms`, 64, 734);

      if (elapsedMs < compiled.result.totalMs + 120) {
        requestAnimationFrame(draw);
      }
    };

    recorder.start();
    await actx.resume();
    synth.start();
    const drawPromise = new Promise((resolve) => {
      draw();
      setTimeout(resolve, compiled.result.totalMs + 280);
    });
    await drawPromise;
    recorder.stop();
    await new Promise((resolve) => {
      recorder.onstop = resolve;
    });
    await actx.close();
    const blob = new Blob(chunks, { type: mimeType });
    ensureArrayBufferUrl(blob, `${filename}.${extension}`);
    this.onStatus?.(`Rendered video: ${filename}.${extension}`, 'success');
  }
}
