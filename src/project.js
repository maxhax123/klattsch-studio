import {
  AUTOMATION_PARAM_KEYS,
  CLIP_COLORS,
  CLIP_EFFECT_KEYS,
  DEFAULT_MASTER,
  EFFECT_PARAMS,
  MAX_PITCH_OFFSET,
  MIN_PITCH_OFFSET,
  PROJECT_STORAGE_KEY,
  SNAP_BEAT,
} from './constants.js';
import { sentenceToClips } from './g2p.js';
import { makeId } from './id.js';
import { tokenize } from './engine/sequencer.js';

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function snapBeat(value) {
  return Math.round(value / SNAP_BEAT) * SNAP_BEAT;
}

export function getBeatMs(project) {
  return 60000 / project.master.tempo;
}

export function copyProject(project) {
  return structuredClone(project);
}

export function getSortedClips(project) {
  return [...project.clips].sort((a, b) => a.startBeat - b.startBeat || a.pitchOffset - b.pitchOffset);
}

export function estimateClipUnits(raw) {
  const parsed = tokenize(raw || '');
  let units = 0;
  let inGroup = false;
  let groupHasPhoneme = false;
  for (const token of parsed.tokens) {
    if (token.type === 'syllable_open') {
      inGroup = true;
      groupHasPhoneme = false;
      continue;
    }
    if (token.type === 'syllable_close') {
      if (inGroup && groupHasPhoneme) units += 1;
      inGroup = false;
      groupHasPhoneme = false;
      continue;
    }
    if (token.type !== 'phoneme') continue;
    if (inGroup) {
      groupHasPhoneme = true;
    } else {
      units += token.stressed ? 1.5 : 1;
    }
  }
  if (inGroup && groupHasPhoneme) units += 1;
  return Math.max(units, 1);
}

export function syncClipTiming(project, clip) {
  const beatMs = getBeatMs(project);
  const units = estimateClipUnits(clip.phonemes);
  clip.lengthBeats = snapBeat(Math.max(0.5, (clip.rateMs * units) / beatMs));
  return clip;
}

export function normalizeClip(project, clip, colorIndex = 0) {
  const normalized = {
    id: clip.id ?? makeId(),
    text: clip.text ?? 'New clip',
    phonemes: clip.phonemes?.trim() || 'HH AH L OW',
    startBeat: snapBeat(clip.startBeat ?? 0),
    lengthBeats: snapBeat(clip.lengthBeats ?? 1),
    rateMs: clamp(Number(clip.rateMs ?? project.master.rate), EFFECT_PARAMS.rate.min, EFFECT_PARAMS.rate.max),
    pitchOffset: clamp(Number(clip.pitchOffset ?? 0), MIN_PITCH_OFFSET, MAX_PITCH_OFFSET),
    color: clip.color ?? CLIP_COLORS[colorIndex % CLIP_COLORS.length],
    bank: clip.bank ?? project.master.bank,
    effects: {},
    automation: {},
  };

  for (const key of CLIP_EFFECT_KEYS) {
    const value = clip.effects?.[key];
    if (typeof value === 'number') {
      normalized.effects[key] = clamp(value, EFFECT_PARAMS[key].min, EFFECT_PARAMS[key].max);
    }
  }

  for (const key of AUTOMATION_PARAM_KEYS) {
    const automation = clip.automation?.[key];
    if (Array.isArray(automation) && automation.length) {
      normalized.automation[key] = automation
        .map((point) => ({
          id: point.id ?? makeId('kf'),
          time: clamp(Number(point.time ?? 0), 0, 1),
          value: clamp(Number(point.value ?? EFFECT_PARAMS[key].defaultValue), EFFECT_PARAMS[key].min, EFFECT_PARAMS[key].max),
        }))
        .sort((a, b) => a.time - b.time);
    }
  }

  return syncClipTiming(project, normalized);
}

export function createProject(seedSentence = 'Make your machine talk in tune.') {
  const project = {
    version: 1,
    master: structuredClone(DEFAULT_MASTER),
    clips: [],
  };
  project.clips = sentenceToClips(seedSentence, project.master).map((clip, index) =>
    normalizeClip(project, clip, index),
  );
  return project;
}

export function getProjectEndBeat(project) {
  const clips = getSortedClips(project);
  if (!clips.length) return 8;
  return Math.max(8, Math.ceil(clips[clips.length - 1].startBeat + clips[clips.length - 1].lengthBeats + 2));
}

export function getClipById(project, clipId) {
  return project.clips.find((clip) => clip.id === clipId) ?? null;
}

export function getClipBaseValue(project, clip, key) {
  if (key === 'rate') return clip.rateMs;
  if (key === 'pitchOffset') return clip.pitchOffset;
  return clip.effects[key] ?? project.master[key];
}

export function sampleAutomation(clip, key, ratio, fallbackValue) {
  const points = clip.automation[key];
  if (!Array.isArray(points) || points.length === 0) return fallbackValue;
  if (ratio <= points[0].time) return points[0].value;
  const last = points[points.length - 1];
  if (ratio >= last.time) return last.value;
  for (let index = 0; index < points.length - 1; index += 1) {
    const left = points[index];
    const right = points[index + 1];
    if (ratio >= left.time && ratio <= right.time) {
      const span = right.time - left.time || 1;
      const mix = (ratio - left.time) / span;
      return left.value + (right.value - left.value) * mix;
    }
  }
  return fallbackValue;
}

export function getPlaybackSegments(project, actualTotalMs = null) {
  const beatMs = getBeatMs(project);
  const totalBeatSpan = Math.max(1, getProjectEndBeat(project));
  const modelTotalMs = totalBeatSpan * beatMs;
  const scale = actualTotalMs ? actualTotalMs / modelTotalMs : 1;
  return getSortedClips(project).map((clip) => ({
    clipId: clip.id,
    label: clip.text,
    tStartMs: clip.startBeat * beatMs * scale,
    tEndMs: (clip.startBeat + clip.lengthBeats) * beatMs * scale,
  }));
}

function stateToDirectives(state, previousState = null) {
  const tokens = [];
  if (!previousState || previousState.bank !== state.bank) {
    tokens.push(`[bank=${state.bank}]`);
  }

  const params = [
    ['b', state.baseF0Hz, previousState?.baseF0Hz],
    ['r', state.rate, previousState?.rate],
    ['s', state.scale, previousState?.scale],
    ['v', state.vibratoDepth, previousState?.vibratoDepth],
    ['w', state.vibratoRate, previousState?.vibratoRate],
    ['m', state.tremoloDepth, previousState?.tremoloDepth],
    ['n', state.tremoloRate, previousState?.tremoloRate],
    ['h', state.aspiration, previousState?.aspiration],
    ['t', state.tilt, previousState?.tilt],
    ['g', state.effort, previousState?.effort],
  ];

  for (const [directive, current, previous] of params) {
    if (previousState && Math.abs(current - previous) < 0.0001) continue;
    const rounded = Number.isInteger(current) ? String(current) : Number(current).toFixed(2).replace(/\.?0+$/u, '');
    tokens.push(`${directive}${rounded}`);
  }
  return tokens;
}

function buildClipEvents(raw) {
  const parsed = tokenize(raw || '');
  const source = parsed.source;
  const events = [];
  let prefix = [];
  let inGroup = false;
  let group = [];

  const flushGroup = () => {
    if (!group.length) return;
    events.push({ text: [...prefix, '(', ...group, ')'].join(' '), ratioWeight: 1 });
    prefix = [];
    group = [];
    inGroup = false;
  };

  for (const token of parsed.tokens) {
    const rawToken = source.slice(token.srcStart, token.srcEnd);
    if (token.type === 'syllable_open') {
      inGroup = true;
      group = [];
      continue;
    }
    if (token.type === 'syllable_close') {
      flushGroup();
      continue;
    }
    if (token.type === 'phoneme') {
      if (inGroup) {
        group.push(rawToken);
      } else {
        events.push({ text: [...prefix, rawToken].join(' '), ratioWeight: token.stressed ? 1.5 : 1 });
        prefix = [];
      }
      continue;
    }
    prefix.push(rawToken);
  }

  if (group.length) {
    flushGroup();
  }
  if (prefix.length) {
    events.push({ text: prefix.join(' '), ratioWeight: 1 });
  }

  return events.length ? events : [{ text: raw.trim() || 'HH AH L OW', ratioWeight: 1 }];
}

function getClipState(project, clip, ratio) {
  const pitchOffset = sampleAutomation(clip, 'pitchOffset', ratio, clip.pitchOffset);
  const semitoneRatio = 2 ** (pitchOffset / 12);
  const rate = sampleAutomation(clip, 'rate', ratio, clip.rateMs);
  return {
    bank: clip.bank || project.master.bank,
    baseF0Hz: project.master.baseF0 * semitoneRatio,
    rate,
    scale: sampleAutomation(clip, 'scale', ratio, getClipBaseValue(project, clip, 'scale')),
    vibratoDepth: sampleAutomation(clip, 'vibratoDepth', ratio, getClipBaseValue(project, clip, 'vibratoDepth')),
    vibratoRate: sampleAutomation(clip, 'vibratoRate', ratio, getClipBaseValue(project, clip, 'vibratoRate')),
    tremoloDepth: sampleAutomation(clip, 'tremoloDepth', ratio, getClipBaseValue(project, clip, 'tremoloDepth')),
    tremoloRate: sampleAutomation(clip, 'tremoloRate', ratio, getClipBaseValue(project, clip, 'tremoloRate')),
    aspiration: sampleAutomation(clip, 'aspiration', ratio, getClipBaseValue(project, clip, 'aspiration')),
    tilt: sampleAutomation(clip, 'tilt', ratio, getClipBaseValue(project, clip, 'tilt')),
    effort: sampleAutomation(clip, 'effort', ratio, getClipBaseValue(project, clip, 'effort')),
  };
}

function buildClipProtocol(project, clip) {
  const events = buildClipEvents(clip.phonemes);
  const totalWeight = events.reduce((sum, event) => sum + event.ratioWeight, 0) || 1;
  let traversed = 0;
  let previousState = null;
  const pieces = [];

  for (const event of events) {
    const ratio = totalWeight <= 1 ? 0 : traversed / (totalWeight - event.ratioWeight || 1);
    const state = getClipState(project, clip, ratio);
    const directives = stateToDirectives(state, previousState);
    pieces.push([...directives, event.text].join(' '));
    previousState = state;
    traversed += event.ratioWeight;
  }

  return pieces.join(' ');
}

export function buildProtocol(project) {
  const clips = getSortedClips(project);
  const beatMs = getBeatMs(project);
  const lines = ['# Generated by Klattsch Studio'];
  const ranges = [];
  let cursorBeat = 0;
  let charCount = `${lines[0]}\n`.length;

  for (const clip of clips) {
    const gapMs = Math.max(0, (clip.startBeat - cursorBeat) * beatMs);
    const chunkParts = [];
    if (gapMs >= 15) {
      chunkParts.push(`p${Math.round(gapMs)}`);
    }
    chunkParts.push(buildClipProtocol(project, clip));
    const line = chunkParts.join(' ');
    lines.push(line);
    ranges.push({
      clipId: clip.id,
      start: charCount,
      end: charCount + line.length,
    });
    charCount += line.length + 1;
    cursorBeat = clip.startBeat + clip.lengthBeats;
  }

  return {
    text: lines.join('\n'),
    ranges,
  };
}

export function duplicateClip(project, clip) {
  const clone = normalizeClip(project, {
    ...clip,
    id: makeId(),
    startBeat: clip.startBeat + clip.lengthBeats,
    text: `${clip.text} copy`,
  }, 0);
  project.clips.push(clone);
  return clone;
}

function splitTextLabel(text) {
  const midpoint = Math.max(1, Math.floor(text.length / 2));
  return [text.slice(0, midpoint).trim() || `${text} A`, text.slice(midpoint).trim() || `${text} B`];
}

export function splitClip(project, clip, splitIndex) {
  const tokens = clip.phonemes.split(/\s+/u).filter(Boolean);
  const safeIndex = clamp(splitIndex, 1, tokens.length - 1);
  const leftTokens = tokens.slice(0, safeIndex);
  const rightTokens = tokens.slice(safeIndex);
  if (!leftTokens.length || !rightTokens.length) return null;

  const [leftText, rightText] = splitTextLabel(clip.text);
  const leftUnits = estimateClipUnits(leftTokens.join(' '));
  const rightUnits = estimateClipUnits(rightTokens.join(' '));
  const totalUnits = leftUnits + rightUnits;
  const leftLength = snapBeat(Math.max(0.5, clip.lengthBeats * (leftUnits / totalUnits)));
  const rightLength = snapBeat(Math.max(0.5, clip.lengthBeats - leftLength));

  clip.text = leftText;
  clip.phonemes = leftTokens.join(' ');
  clip.lengthBeats = leftLength;
  syncClipTiming(project, clip);

  const rightClip = normalizeClip(project, {
    ...clip,
    id: makeId(),
    text: rightText,
    phonemes: rightTokens.join(' '),
    startBeat: clip.startBeat + clip.lengthBeats,
    lengthBeats: rightLength,
  }, 0);
  project.clips.push(rightClip);
  return rightClip;
}

export function importProtocol(project, rawCode) {
  const parsed = tokenize(rawCode);
  const clips = [];
  const beatMs = getBeatMs(project);
  let currentParts = [];
  let currentStartBeat = 0;
  let cursorBeat = 0;

  const flush = () => {
    if (!currentParts.length) return;
    const phonemes = currentParts.join(' ').trim();
    const clip = normalizeClip(project, {
      id: makeId(),
      text: phonemes.slice(0, 18),
      phonemes,
      startBeat: currentStartBeat,
      rateMs: project.master.rate,
      pitchOffset: 0,
      color: CLIP_COLORS[clips.length % CLIP_COLORS.length],
      bank: project.master.bank,
      effects: {},
      automation: {},
    }, clips.length);
    clips.push(clip);
    cursorBeat = clip.startBeat + clip.lengthBeats;
    currentParts = [];
  };

  for (const token of parsed.tokens) {
    const rawToken = parsed.source.slice(token.srcStart, token.srcEnd);
    if (token.type === 'pause') {
      flush();
      cursorBeat += snapBeat(token.ms / beatMs);
      currentStartBeat = cursorBeat;
      continue;
    }
    if (token.type === 'directive' && token.key === 'pause') {
      flush();
      cursorBeat += snapBeat(Math.abs(token.value) / beatMs);
      currentStartBeat = cursorBeat;
      continue;
    }
    if (!currentParts.length) {
      currentStartBeat = cursorBeat;
    }
    currentParts.push(rawToken);
  }
  flush();

  project.clips = clips.length ? clips : createProject('HH AH L OW').clips;
  return project;
}

export function exportSong(project) {
  return JSON.stringify(project, null, 2);
}

export function importSong(raw) {
  const incoming = JSON.parse(raw);
  const project = {
    version: 1,
    master: {
      ...structuredClone(DEFAULT_MASTER),
      ...(incoming.master ?? {}),
    },
    clips: [],
  };
  project.clips = Array.isArray(incoming.clips)
    ? incoming.clips.map((clip, index) => normalizeClip(project, clip, index))
    : [];
  if (!project.clips.length) {
    project.clips = createProject().clips;
  }
  return project;
}

export function saveProject(project) {
  localStorage.setItem(PROJECT_STORAGE_KEY, exportSong(project));
}

export function loadProject() {
  const raw = localStorage.getItem(PROJECT_STORAGE_KEY);
  if (!raw) return null;
  try {
    return importSong(raw);
  } catch (_error) {
    return null;
  }
}

export function createBlankClip(project, startBeat = 0, pitchOffset = 0) {
  const clip = normalizeClip(project, {
    id: makeId(),
    text: 'new word',
    phonemes: 'HH AH L OW',
    startBeat,
    rateMs: project.master.rate,
    pitchOffset,
    color: CLIP_COLORS[project.clips.length % CLIP_COLORS.length],
    bank: project.master.bank,
    effects: {},
    automation: {},
  }, project.clips.length);
  project.clips.push(clip);
  return clip;
}
