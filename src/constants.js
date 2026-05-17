export const PROJECT_STORAGE_KEY = 'klattsch-studio.project.v1';
export const SONG_MIME = 'application/vnd.klattsch.song+json';
export const SONG_EXTENSION = '.klattschsong.json';
export const DEFAULT_VIDEO_MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm',
];

export const SNAP_BEAT = 0.25;
export const PIXELS_PER_BEAT = 68;
export const ROW_HEIGHT = 28;
export const LANE_COUNT = 25;
export const MAX_PITCH_OFFSET = 12;
export const MIN_PITCH_OFFSET = -12;
export const AUDIO_SAMPLE_RATE = 48000;

export const PITCH_LANES = Array.from(
  { length: LANE_COUNT },
  (_, index) => MAX_PITCH_OFFSET - index,
);

export const CLIP_COLORS = [
  'sunset',
  'acid',
  'teal',
  'violet',
  'amber',
  'crimson',
];

export const EFFECT_PARAMS = {
  pitchOffset: {
    label: 'Pitch Offset',
    shortLabel: 'Pitch',
    min: -12,
    max: 12,
    step: 0.25,
    defaultValue: 0,
    format: (value) => `${Number(value).toFixed(2)} st`,
  },
  rate: {
    label: 'Rate',
    shortLabel: 'Rate',
    directive: 'r',
    min: 40,
    max: 240,
    step: 1,
    defaultValue: 110,
    format: (value) => `${Math.round(value)} ms`,
  },
  scale: {
    label: 'Formant Scale',
    shortLabel: 'Scale',
    directive: 's',
    min: 0.7,
    max: 1.5,
    step: 0.01,
    defaultValue: 1,
    format: (value) => Number(value).toFixed(2),
  },
  vibratoDepth: {
    label: 'Vibrato Depth',
    shortLabel: 'Vib Amt',
    directive: 'v',
    min: 0,
    max: 18,
    step: 0.1,
    defaultValue: 0,
    format: (value) => `${Number(value).toFixed(1)} Hz`,
  },
  vibratoRate: {
    label: 'Vibrato Rate',
    shortLabel: 'Vib Rate',
    directive: 'w',
    min: 1,
    max: 12,
    step: 0.1,
    defaultValue: 5,
    format: (value) => `${Number(value).toFixed(1)} Hz`,
  },
  tremoloDepth: {
    label: 'Tremolo Depth',
    shortLabel: 'Trem Amt',
    directive: 'm',
    min: 0,
    max: 1,
    step: 0.01,
    defaultValue: 0,
    format: (value) => Number(value).toFixed(2),
  },
  tremoloRate: {
    label: 'Tremolo Rate',
    shortLabel: 'Trem Rate',
    directive: 'n',
    min: 0.5,
    max: 15,
    step: 0.1,
    defaultValue: 5,
    format: (value) => `${Number(value).toFixed(1)} Hz`,
  },
  aspiration: {
    label: 'Aspiration',
    shortLabel: 'Air',
    directive: 'h',
    min: 0,
    max: 1,
    step: 0.01,
    defaultValue: 0,
    format: (value) => Number(value).toFixed(2),
  },
  tilt: {
    label: 'Spectral Tilt',
    shortLabel: 'Tilt',
    directive: 't',
    min: -0.9,
    max: 0.9,
    step: 0.01,
    defaultValue: 0,
    format: (value) => Number(value).toFixed(2),
  },
  effort: {
    label: 'Vocal Effort',
    shortLabel: 'Effort',
    directive: 'g',
    min: 0,
    max: 1,
    step: 0.01,
    defaultValue: 0.5,
    format: (value) => Number(value).toFixed(2),
  },
};

export const AUTOMATION_PARAM_KEYS = [
  'pitchOffset',
  'rate',
  'scale',
  'vibratoDepth',
  'vibratoRate',
  'tremoloDepth',
  'tremoloRate',
  'aspiration',
  'tilt',
  'effort',
];

export const CLIP_EFFECT_KEYS = [
  'scale',
  'vibratoDepth',
  'vibratoRate',
  'tremoloDepth',
  'tremoloRate',
  'aspiration',
  'tilt',
  'effort',
];

export const DEFAULT_MASTER = Object.freeze({
  title: 'Klattsch Studio Session',
  bank: 'klatt1980-en',
  tempo: 128,
  baseF0: 140,
  rate: EFFECT_PARAMS.rate.defaultValue,
  scale: EFFECT_PARAMS.scale.defaultValue,
  vibratoDepth: EFFECT_PARAMS.vibratoDepth.defaultValue,
  vibratoRate: EFFECT_PARAMS.vibratoRate.defaultValue,
  tremoloDepth: EFFECT_PARAMS.tremoloDepth.defaultValue,
  tremoloRate: EFFECT_PARAMS.tremoloRate.defaultValue,
  aspiration: EFFECT_PARAMS.aspiration.defaultValue,
  tilt: EFFECT_PARAMS.tilt.defaultValue,
  effort: EFFECT_PARAMS.effort.defaultValue,
  outputVolume: 1,
});

export const IMPORT_TEMPLATES = {
  sentence: 'Type a sentence here. The studio will turn it into valid klattsch protocol.',
  protocol: 'Paste raw klattsch code here. The studio will break it into editable clips.',
};
