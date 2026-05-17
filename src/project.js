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
import { protocolToWordLabel, sentenceToClips } from './g2p.js';
import { makeId } from './id.js';
import { banks } from './engine/banks/index.js';
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

function normalizeExactImport(exactImport) {
  if (!exactImport || typeof exactImport !== 'object') return null;
  if (typeof exactImport.body !== 'string' || !exactImport.body.trim()) return null;
  return {
    body: exactImport.body.trim(),
    leadInMs: Number.isFinite(exactImport.leadInMs) ? Math.max(0, Number(exactImport.leadInMs)) : null,
    anchorStartBeat: Number.isFinite(exactImport.anchorStartBeat) ? Number(exactImport.anchorStartBeat) : 0,
    audioSignature: typeof exactImport.audioSignature === 'string' ? exactImport.audioSignature : '',
  };
}

function stringifyAutomation(points) {
  return (Array.isArray(points) ? points : [])
    .map((point) => `${Number(point.time).toFixed(4)}:${Number(point.value).toFixed(4)}`)
    .join('|');
}

export function getClipAudioSignature(project, clip) {
  const masterAudio = {
    baseF0: Number(project.master.baseF0).toFixed(4),
    bank: project.master.bank,
    rate: Number(project.master.rate).toFixed(4),
    scale: Number(project.master.scale).toFixed(4),
    vibratoDepth: Number(project.master.vibratoDepth).toFixed(4),
    vibratoRate: Number(project.master.vibratoRate).toFixed(4),
    tremoloDepth: Number(project.master.tremoloDepth).toFixed(4),
    tremoloRate: Number(project.master.tremoloRate).toFixed(4),
    aspiration: Number(project.master.aspiration).toFixed(4),
    tilt: Number(project.master.tilt).toFixed(4),
    effort: Number(project.master.effort).toFixed(4),
  };
  const clipAudio = {
    phonemes: clip.phonemes.trim().replace(/\s+/gu, ' '),
    bank: clip.bank,
    rateMs: Number(clip.rateMs).toFixed(4),
    pitchOffset: Number(clip.pitchOffset).toFixed(4),
    effects: Object.fromEntries(
      CLIP_EFFECT_KEYS.map((key) => [key, Number((clip.effects[key] ?? project.master[key])).toFixed(4)]),
    ),
    automation: Object.fromEntries(
      AUTOMATION_PARAM_KEYS.map((key) => [key, stringifyAutomation(clip.automation[key])]),
    ),
  };
  return JSON.stringify({ masterAudio, clipAudio });
}

function getExactBodyIfCurrent(project, clip) {
  if (!clip.exactImport?.body) return null;
  return clip.exactImport.audioSignature === getClipAudioSignature(project, clip)
    ? clip.exactImport.body
    : null;
}

function getExactLeadInIfAnchored(clip) {
  if (!clip.exactImport || !Number.isFinite(clip.exactImport.leadInMs)) return null;
  return Math.abs(clip.startBeat - (clip.exactImport.anchorStartBeat ?? clip.startBeat)) < 0.0001
    ? clip.exactImport.leadInMs
    : null;
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
    exactImport: normalizeExactImport(clip.exactImport),
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

function buildStandaloneImportBody(state, rawBody) {
  const prefixTokens = stateToDirectives(state, null);
  const bodyTokens = rawBody.trim().split(/\s+/u).filter(Boolean);
  let overlap = 0;
  while (overlap < prefixTokens.length && overlap < bodyTokens.length && prefixTokens[overlap] === bodyTokens[overlap]) {
    overlap += 1;
  }
  return [...prefixTokens, ...bodyTokens.slice(overlap)].join(' ').trim();
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
    const gapMs = getExactLeadInIfAnchored(clip) ?? Math.max(0, (clip.startBeat - cursorBeat) * beatMs);
    const clipBody = getExactBodyIfCurrent(project, clip) ?? buildClipProtocol(project, clip);
    const chunkParts = [];
    if (gapMs >= 15) {
      chunkParts.push(`p${Math.round(gapMs)}`);
    }
    chunkParts.push(clipBody);
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

function looksLikeReadableWord(text) {
  return /^[a-z][a-z'-]*$/iu.test(text) && !text.includes('-');
}

export function reconstructSentenceFromClips(clips) {
  const words = clips
    .map((clip) => clip.text?.trim())
    .filter((text) => text && looksLikeReadableWord(text));
  if (!words.length) return '';
  const sentence = words.join(' ').replace(/\s+/gu, ' ').trim();
  return sentence ? sentence[0].toUpperCase() + sentence.slice(1) : '';
}

const IMPORT_DIRECTIVE_MAP = {
  rate: 'rate',
  scale: 'scale',
  vibrato: 'vibratoDepth',
  vibratoRate: 'vibratoRate',
  tremolo: 'tremoloDepth',
  tremoloRate: 'tremoloRate',
  aspiration: 'aspiration',
  tilt: 'tilt',
  effort: 'effort',
};

function getImportInitialState(project) {
  return {
    bank: project.master.bank,
    baseF0Hz: project.master.baseF0,
    rate: project.master.rate,
    scale: project.master.scale,
    vibratoDepth: project.master.vibratoDepth,
    vibratoRate: project.master.vibratoRate,
    tremoloDepth: project.master.tremoloDepth,
    tremoloRate: project.master.tremoloRate,
    aspiration: project.master.aspiration,
    tilt: project.master.tilt,
    effort: project.master.effort,
  };
}

function cloneImportState(state) {
  return { ...state };
}

function applyDirectiveToImportState(state, token, initialState) {
  if (token.type === 'bank_switch') {
    state.bank = token.name;
    return;
  }
  if (token.type === 'bank_reset') {
    state.bank = initialState.bank;
    return;
  }
  if (token.type !== 'directive') return;

  if (token.key === 'base' || token.key === 'pitch') {
    if (token.reset) state.baseF0Hz = initialState.baseF0Hz;
    else if (token.relative) state.baseF0Hz += token.value;
    else state.baseF0Hz = token.value;
    return;
  }

  const mappedKey = IMPORT_DIRECTIVE_MAP[token.key];
  if (!mappedKey) return;
  if (token.reset) state[mappedKey] = initialState[mappedKey];
  else if (token.relative) state[mappedKey] += token.value;
  else state[mappedKey] = token.value;
}

function importTokensToEvents(source, tokens, startingState, initialState) {
  const events = [];
  let prefix = [];
  let pendingState = cloneImportState(startingState);
  let inGroup = false;
  let group = [];
  let groupState = null;

  const flushSingle = (text, token) => {
    const rawText = [...prefix, text].join(' ').trim();
    if (!rawText) return;
    events.push({
      text: rawText,
      state: cloneImportState(pendingState),
      ratioWeight: token.stressed ? 1.5 : 1,
    });
    prefix = [];
  };

  const flushGroup = () => {
    if (!group.length || !groupState) return;
    const rawText = [...prefix, '(', ...group, ')'].join(' ').trim();
    if (rawText) {
      events.push({
        text: rawText,
        state: cloneImportState(groupState),
        ratioWeight: 1,
      });
    }
    prefix = [];
    group = [];
    groupState = null;
    inGroup = false;
  };

  for (const token of tokens) {
    const rawToken = source.slice(token.srcStart, token.srcEnd);
    if (token.type === 'syllable_open') {
      inGroup = true;
      group = [];
      groupState = cloneImportState(pendingState);
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
        flushSingle(rawToken, token);
      }
      continue;
    }
    if (token.type === 'directive' || token.type === 'bank_switch' || token.type === 'bank_reset') {
      applyDirectiveToImportState(pendingState, token, initialState);
      prefix.push(rawToken);
      continue;
    }
    prefix.push(rawToken);
  }

  if (group.length) flushGroup();
  return events;
}

function buildImportedAutomation(project, events, clipState) {
  const totalWeight = events.reduce((sum, event) => sum + event.ratioWeight, 0) || 1;
  let traversed = 0;
  const ratios = events.map((event) => {
    const ratio = totalWeight <= 1 ? 0 : traversed / Math.max(1, totalWeight - event.ratioWeight);
    traversed += event.ratioWeight;
    return ratio;
  });
  const automation = {};

  const stateReaders = {
    pitchOffset: (event) => 12 * Math.log2(Math.max(1e-6, event.state.baseF0Hz) / Math.max(1e-6, project.master.baseF0)),
    rate: (event) => event.state.rate,
    scale: (event) => event.state.scale,
    vibratoDepth: (event) => event.state.vibratoDepth,
    vibratoRate: (event) => event.state.vibratoRate,
    tremoloDepth: (event) => event.state.tremoloDepth,
    tremoloRate: (event) => event.state.tremoloRate,
    aspiration: (event) => event.state.aspiration,
    tilt: (event) => event.state.tilt,
    effort: (event) => event.state.effort,
  };

  for (const key of AUTOMATION_PARAM_KEYS) {
    const values = events.map((event) => stateReaders[key](event));
    const baseValue = key === 'pitchOffset'
      ? clipState.pitchOffset
      : key === 'rate'
        ? clipState.rateMs
        : (clipState.effects[key] ?? project.master[key]);

    const changed = values.some((value) => Math.abs(value - baseValue) > 0.0001);
    if (!changed) continue;

    const points = [];
    for (let index = 0; index < values.length; index += 1) {
      const value = key === 'pitchOffset'
        ? clamp(values[index], MIN_PITCH_OFFSET, MAX_PITCH_OFFSET)
        : clamp(values[index], EFFECT_PARAMS[key].min, EFFECT_PARAMS[key].max);
      const time = clamp(Number(ratios[index].toFixed(4)), 0, 1);
      const previous = points[points.length - 1];
      if (previous && Math.abs(previous.value - value) < 0.0001) {
        continue;
      }
      points.push({
        id: makeId('kf'),
        time,
        value: Number(value.toFixed(4)),
      });
    }
    if (!points.length) continue;
    if (points[0].time !== 0) {
      points.unshift({
        id: makeId('kf'),
        time: 0,
        value: Number(baseValue.toFixed(4)),
      });
    }
    automation[key] = points;
  }

  return automation;
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
  const clips = [];
  const beatMs = getBeatMs(project);
  const initialState = getImportInitialState(project);
  let runningState = cloneImportState(initialState);
  let cursorBeat = 0;
  let pendingLeadInMs = 0;

  const flush = (source, currentTokens, currentClipStartState, currentStartBeat, currentLeadInMs) => {
    if (!currentTokens.length) return false;
    const phonemeTokens = currentTokens.filter((token) =>
      token.type === 'phoneme' || token.type === 'syllable_open' || token.type === 'syllable_close'
    );
    const rawBody = currentTokens
      .map((token) => source.slice(token.srcStart, token.srcEnd))
      .join(' ')
      .trim();
    const phonemes = phonemeTokens
      .map((token) => source.slice(token.srcStart, token.srcEnd))
      .join(' ')
      .trim();
    if (!phonemes) {
      return false;
    }
    const events = importTokensToEvents(source, currentTokens, currentClipStartState, initialState);
    const firstEventState = events[0]?.state ?? cloneImportState(currentClipStartState);
    const pitchOffset = clamp(
      12 * Math.log2(Math.max(1e-6, firstEventState.baseF0Hz) / Math.max(1e-6, project.master.baseF0)),
      MIN_PITCH_OFFSET,
      MAX_PITCH_OFFSET,
    );
    const clipSeed = {
      id: makeId(),
      text: protocolToWordLabel(phonemes),
      phonemes,
      startBeat: currentStartBeat,
      rateMs: clamp(firstEventState.rate, EFFECT_PARAMS.rate.min, EFFECT_PARAMS.rate.max),
      pitchOffset,
      color: CLIP_COLORS[clips.length % CLIP_COLORS.length],
      bank: banks.get(firstEventState.bank) ? firstEventState.bank : project.master.bank,
      effects: {
        scale: clamp(firstEventState.scale, EFFECT_PARAMS.scale.min, EFFECT_PARAMS.scale.max),
        vibratoDepth: clamp(firstEventState.vibratoDepth, EFFECT_PARAMS.vibratoDepth.min, EFFECT_PARAMS.vibratoDepth.max),
        vibratoRate: clamp(firstEventState.vibratoRate, EFFECT_PARAMS.vibratoRate.min, EFFECT_PARAMS.vibratoRate.max),
        tremoloDepth: clamp(firstEventState.tremoloDepth, EFFECT_PARAMS.tremoloDepth.min, EFFECT_PARAMS.tremoloDepth.max),
        tremoloRate: clamp(firstEventState.tremoloRate, EFFECT_PARAMS.tremoloRate.min, EFFECT_PARAMS.tremoloRate.max),
        aspiration: clamp(firstEventState.aspiration, EFFECT_PARAMS.aspiration.min, EFFECT_PARAMS.aspiration.max),
        tilt: clamp(firstEventState.tilt, EFFECT_PARAMS.tilt.min, EFFECT_PARAMS.tilt.max),
        effort: clamp(firstEventState.effort, EFFECT_PARAMS.effort.min, EFFECT_PARAMS.effort.max),
      },
      automation: {},
    };
    const clip = normalizeClip(project, clipSeed, clips.length);
    clip.text = protocolToWordLabel(clip.phonemes);
    clip.automation = buildImportedAutomation(project, events, clip);
    clip.exactImport = {
      body: buildStandaloneImportBody(currentClipStartState, rawBody),
      leadInMs: currentLeadInMs,
      anchorStartBeat: clip.startBeat,
      audioSignature: '',
    };
    clip.exactImport.audioSignature = getClipAudioSignature(project, clip);
    clips.push(clip);
    cursorBeat = clip.startBeat + clip.lengthBeats;
    pendingLeadInMs = 0;
    return true;
  };

  for (const rawLine of rawCode.split(/\r?\n/u)) {
    const parsedLine = tokenize(rawLine);
    if (!parsedLine.tokens.length) continue;
    let currentTokens = [];
    let currentClipStartState = cloneImportState(runningState);
    let currentStartBeat = cursorBeat;
    let currentLeadInMs = pendingLeadInMs;

    for (const token of parsedLine.tokens) {
      if (token.type === 'pause') {
        flush(parsedLine.source, currentTokens, currentClipStartState, currentStartBeat, currentLeadInMs);
        currentTokens = [];
        pendingLeadInMs += token.ms;
        cursorBeat += snapBeat(token.ms / beatMs);
        currentStartBeat = cursorBeat;
        currentClipStartState = cloneImportState(runningState);
        currentLeadInMs = pendingLeadInMs;
        continue;
      }
      if (token.type === 'directive' && token.key === 'pause') {
        flush(parsedLine.source, currentTokens, currentClipStartState, currentStartBeat, currentLeadInMs);
        currentTokens = [];
        pendingLeadInMs += Math.abs(token.value);
        cursorBeat += snapBeat(Math.abs(token.value) / beatMs);
        currentStartBeat = cursorBeat;
        currentClipStartState = cloneImportState(runningState);
        currentLeadInMs = pendingLeadInMs;
        continue;
      }
      if (!currentTokens.length) {
        currentStartBeat = cursorBeat;
        currentClipStartState = cloneImportState(runningState);
        currentLeadInMs = pendingLeadInMs;
      }
      currentTokens.push(token);
      if (token.type === 'directive' || token.type === 'bank_switch' || token.type === 'bank_reset') {
        applyDirectiveToImportState(runningState, token, initialState);
      }
    }
    flush(parsedLine.source, currentTokens, currentClipStartState, currentStartBeat, currentLeadInMs);
  }

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
