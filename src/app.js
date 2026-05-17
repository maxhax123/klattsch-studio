import { StudioAudio } from './audio.js';
import {
  AUTOMATION_PARAM_KEYS,
  CLIP_EFFECT_KEYS,
  EFFECT_PARAMS,
  IMPORT_TEMPLATES,
  MAX_PITCH_OFFSET,
  MIN_PITCH_OFFSET,
  PIXELS_PER_BEAT,
  ROW_HEIGHT,
  SONG_EXTENSION,
  SONG_MIME,
  SNAP_BEAT,
} from './constants.js';
import { sentenceToClips } from './g2p.js';
import { banks } from './engine/banks/index.js';
import {
  buildProtocol,
  clamp,
  copyProject,
  createBlankClip,
  createProject,
  duplicateClip,
  exportSong,
  getBeatMs,
  getClipById,
  getPlaybackSegments,
  getProjectEndBeat,
  getSortedClips,
  importProtocol,
  importSong,
  loadProject,
  normalizeClip,
  sampleAutomation,
  saveProject,
  snapBeat,
  splitClip,
  syncClipTiming,
  estimateClipUnits,
} from './project.js';
import { makeId } from './id.js';

const root = document.getElementById('app');
const bankNames = banks.list();

const state = {
  project: loadProject() ?? createProject(),
  selectedClipId: null,
  automationParam: 'pitchOffset',
  activeClipId: null,
  playbackSegments: [],
  currentMs: 0,
  totalMs: 0,
  isPlaying: false,
  statusText: 'Ready.',
  statusKind: 'info',
  drag: null,
  automationDrag: null,
  modal: {
    mode: null,
    value: '',
    replace: true,
  },
  collapsedSections: {
    playlist: false,
    keyframes: false,
    masterVoice: false,
    clipInspector: false,
    protocol: false,
    status: false,
  },
  contextMenu: {
    visible: false,
    x: 0,
    y: 0,
    clipId: null,
  },
  clipboardClip: null,
  shellReady: false,
};

const audio = new StudioAudio({
  onStatus(text, kind) {
    setStatus(text, kind);
  },
  onPlayback(payload) {
    state.isPlaying = payload.isPlaying;
    state.currentMs = payload.currentMs;
    state.totalMs = payload.totalMs;
    state.activeClipId = payload.activeClipId;
    renderTimeline();
    renderProtocolPanel();
    renderFooter();
  },
});

function ensureSelection() {
  if (!state.selectedClipId && state.project.clips.length) {
    state.selectedClipId = state.project.clips[0].id;
  }
  if (state.selectedClipId && !getClipById(state.project, state.selectedClipId)) {
    state.selectedClipId = state.project.clips[0]?.id ?? null;
  }
}

function setStatus(text, kind = 'info') {
  state.statusText = text;
  state.statusKind = kind;
  renderHeader();
  renderFooter();
}

function getErrorMessage(error, fallback = 'Unknown error') {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return fallback;
}

function reportError(label, error) {
  console.error(`[Klattsch Studio] ${label}`, error);
  setStatus(`${label}: ${getErrorMessage(error)}`, 'warn');
}

function persist() {
  saveProject(state.project);
}

function sectionClass(sectionKey) {
  return state.collapsedSections[sectionKey] ? 'collapsed' : '';
}

function sectionToggleLabel(sectionKey) {
  return state.collapsedSections[sectionKey] ? 'Expand' : 'Collapse';
}

function hideContextMenu() {
  state.contextMenu.visible = false;
  state.contextMenu.clipId = null;
}

function isEditableTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable
  );
}

function cloneClipForClipboard(clip) {
  return structuredClone(clip);
}

function deleteSelectedClip() {
  const clip = getSelectedClip();
  if (!clip) return false;
  state.project.clips = state.project.clips.filter((item) => item.id !== clip.id);
  state.selectedClipId = state.project.clips[0]?.id ?? null;
  hideContextMenu();
  persist();
  renderAll();
  setStatus('Clip deleted.', 'success');
  return true;
}

function duplicateSelectedClip() {
  const clip = getSelectedClip();
  if (!clip) return false;
  const clone = duplicateClip(state.project, clip);
  state.selectedClipId = clone.id;
  hideContextMenu();
  persist();
  renderAll();
  setStatus(`Duplicated ${clip.text}.`, 'success');
  return true;
}

function copySelectedClip() {
  const clip = getSelectedClip();
  if (!clip) return false;
  state.clipboardClip = cloneClipForClipboard(clip);
  setStatus(`Copied ${clip.text}.`, 'success');
  return true;
}

function pasteClipboardClip() {
  if (!state.clipboardClip) return false;
  const base = state.clipboardClip;
  const pasted = normalizeClip(state.project, {
    ...structuredClone(base),
    id: makeId(),
    text: `${base.text} copy`,
    startBeat: base.startBeat + base.lengthBeats,
  }, state.project.clips.length);
  state.project.clips.push(pasted);
  state.selectedClipId = pasted.id;
  persist();
  renderAll();
  setStatus(`Pasted ${pasted.text}.`, 'success');
  return true;
}

function nudgeSelectedClip({ beatDelta = 0, pitchDelta = 0 }) {
  const clip = getSelectedClip();
  if (!clip) return false;
  if (beatDelta !== 0) {
    clip.startBeat = Math.max(0, snapBeat(clip.startBeat + beatDelta));
  }
  if (pitchDelta !== 0) {
    clip.pitchOffset = clamp(
      clip.pitchOffset + pitchDelta,
      MIN_PITCH_OFFSET,
      MAX_PITCH_OFFSET,
    );
  }
  persist();
  renderAll();
  return true;
}

function slugifyTitle(title) {
  return (title || 'klattsch-studio')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48) || 'klattsch-studio';
}

function getSelectedClip() {
  return getClipById(state.project, state.selectedClipId);
}

function syncClipRateFromLength(clip) {
  const beatMs = getBeatMs(state.project);
  const units = estimateClipUnits(clip.phonemes);
  clip.rateMs = clamp((clip.lengthBeats * beatMs) / units, EFFECT_PARAMS.rate.min, EFFECT_PARAMS.rate.max);
}

function syncAllClipsFromTempo() {
  for (const clip of state.project.clips) {
    syncClipTiming(state.project, clip);
  }
}

function shiftImportedClips(clips, offsetBeat) {
  return clips.map((clip, index) =>
    normalizeClip(
      state.project,
      {
        ...clip,
        id: `${clip.id}-shift-${index}`,
        startBeat: clip.startBeat + offsetBeat,
      },
      state.project.clips.length + index,
    ),
  );
}

function formatRangeValue(key, value) {
  return EFFECT_PARAMS[key].format(value);
}

function escapeHtml(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeAttr(text) {
  return escapeHtml(text).replaceAll('"', '&quot;');
}

function buildProtocolMarkup() {
  const compiled = buildProtocol(state.project);
  const selectedId = state.selectedClipId;
  const activeId = state.activeClipId;
  const ranges = [...compiled.ranges].sort((a, b) => a.start - b.start);
  let cursor = 0;
  let markup = '';

  for (const range of ranges) {
    markup += escapeHtml(compiled.text.slice(cursor, range.start));
    const clipText = escapeHtml(compiled.text.slice(range.start, range.end));
    const classes = ['protocol-segment'];
    if (range.clipId === selectedId) classes.push('selected');
    if (range.clipId === activeId) classes.push('active');
    markup += `<span class="${classes.join(' ')}">${clipText}</span>`;
    cursor = range.end;
  }
  markup += escapeHtml(compiled.text.slice(cursor));
  return { markup, protocolText: compiled.text };
}

function getTimelineBeatFromMs(currentMs) {
  const segments = state.playbackSegments;
  const projectEndBeat = Math.max(1, getProjectEndBeat(state.project));
  if (!segments.length || state.totalMs <= 0) {
    return state.totalMs ? (currentMs / state.totalMs) * projectEndBeat : 0;
  }

  const first = segments[0];
  if (currentMs <= first.tStartMs) {
    const span = Math.max(first.tStartMs, 1);
    return (currentMs / span) * first.beatStart;
  }

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (currentMs >= segment.tStartMs && currentMs <= segment.tEndMs) {
      const ratio = (currentMs - segment.tStartMs) / Math.max(segment.tEndMs - segment.tStartMs, 1);
      return segment.beatStart + ratio * (segment.beatEnd - segment.beatStart);
    }

    const next = segments[index + 1];
    if (next && currentMs > segment.tEndMs && currentMs < next.tStartMs) {
      const ratio = (currentMs - segment.tEndMs) / Math.max(next.tStartMs - segment.tEndMs, 1);
      return segment.beatEnd + ratio * (next.beatStart - segment.beatEnd);
    }
  }

  const last = segments[segments.length - 1];
  const remainingMs = Math.max(state.totalMs - last.tEndMs, 1);
  const ratio = clamp((currentMs - last.tEndMs) / remainingMs, 0, 1);
  return last.beatEnd + ratio * (projectEndBeat - last.beatEnd);
}

function renderShell() {
  root.innerHTML = `
    <div class="studio-shell">
      <header class="hero card">
        <div class="hero-copy">
          <p class="eyebrow">Web klattsch sequencer</p>
          <h1>Klattsch Studio</h1>
          <p class="hero-text">
            Playlist words, draw automation, and render like a proper vocal sketchpad.
          </p>
        </div>
        <div class="hero-actions" id="header-actions"></div>
      </header>

      <main class="workspace">
        <section class="card playlist-card ${sectionClass('playlist')}">
          <div class="panel-heading">
            <div>
              <p class="panel-kicker">Playlist</p>
              <h2>Word Timeline</h2>
            </div>
            <div class="playlist-tools">
              <button type="button" class="ghost-btn" data-action="toggle-section" data-section="playlist">${sectionToggleLabel('playlist')}</button>
              <button type="button" class="ghost-btn" data-action="import-sentence">Import Sentence</button>
              <button type="button" class="ghost-btn" data-action="import-protocol">Import Klattsch Code</button>
              <button type="button" class="ghost-btn" data-action="new-project">New Demo</button>
            </div>
          </div>
          <div class="collapsible-body ${sectionClass('playlist')}">
            <div class="playlist-layout">
              <div class="lane-labels" id="lane-labels"></div>
              <div class="timeline-wrap">
                <div class="timeline-ruler" id="timeline-ruler"></div>
                <div class="timeline-scroll" id="timeline-scroll">
                  <div class="timeline-grid" id="timeline-grid"></div>
                </div>
              </div>
            </div>
            <div class="automation-section ${sectionClass('keyframes')}">
              <div class="automation-toolbar">
                <div>
                  <p class="panel-kicker">Automation</p>
                  <h3>Keyframes</h3>
                </div>
                <div class="automation-controls">
                  <button type="button" class="ghost-btn" data-action="toggle-section" data-section="keyframes">${sectionToggleLabel('keyframes')}</button>
                  <label class="mini-label">
                    Parameter
                    <select id="automation-param"></select>
                  </label>
                  <button type="button" class="ghost-btn" data-action="clear-automation">Clear Lane</button>
                </div>
              </div>
              <div class="collapsible-body ${sectionClass('keyframes')}">
                <canvas id="automation-canvas" width="1200" height="240"></canvas>
              </div>
            </div>
          </div>
        </section>

        <aside class="card inspector-card">
          <div class="panel-heading">
            <div>
              <p class="panel-kicker">Mixer + Inspector</p>
              <h2>Session Controls</h2>
            </div>
            <button type="button" class="ghost-btn" data-action="import-song">Import Song</button>
          </div>
          <div id="inspector-content" class="inspector-content"></div>
        </aside>
      </main>

      <section class="bottom-panels">
        <article class="card protocol-card ${sectionClass('protocol')}">
          <div class="panel-heading">
            <div>
              <p class="panel-kicker">Protocol</p>
              <h2>Generated Klattsch Code</h2>
            </div>
            <div class="playlist-tools">
              <button type="button" class="ghost-btn" data-action="toggle-section" data-section="protocol">${sectionToggleLabel('protocol')}</button>
              <button type="button" class="ghost-btn" data-action="export-protocol">Download Code</button>
            </div>
          </div>
          <div class="collapsible-body ${sectionClass('protocol')}">
            <pre id="protocol-preview" class="protocol-preview"></pre>
          </div>
        </article>
        <article class="card footer-card ${sectionClass('status')}">
          <div class="panel-heading">
            <div>
              <p class="panel-kicker">Status</p>
              <h2>Session Notes</h2>
            </div>
            <button type="button" class="ghost-btn" data-action="toggle-section" data-section="status">${sectionToggleLabel('status')}</button>
          </div>
          <div class="collapsible-body ${sectionClass('status')}">
            <div id="footer-content" class="footer-content"></div>
          </div>
        </article>
      </section>

      <div
        id="clip-context-menu"
        class="context-menu ${state.contextMenu.visible ? '' : 'hidden'}"
        style="left:${state.contextMenu.x}px;top:${state.contextMenu.y}px"
      >
        <button type="button" class="context-item" data-action="duplicate-clip">Duplicate Clip</button>
        <button type="button" class="context-item danger" data-action="delete-clip">Delete Clip</button>
      </div>

      <div class="modal-backdrop hidden" id="modal-backdrop">
        <div class="modal-card">
          <div class="modal-head">
            <div>
              <p class="panel-kicker" id="modal-kicker">Import</p>
              <h2 id="modal-title">Import</h2>
            </div>
            <button type="button" class="ghost-btn" data-action="close-modal">Close</button>
          </div>
          <textarea id="modal-textarea" class="modal-textarea" spellcheck="false"></textarea>
          <label class="checkbox-row">
            <input id="modal-replace" type="checkbox" checked />
            Replace current arrangement instead of appending after the last clip.
          </label>
          <div class="modal-actions">
            <button type="button" class="ghost-btn" data-action="close-modal">Cancel</button>
            <button type="button" class="primary-btn" data-action="apply-modal">Apply Import</button>
          </div>
        </div>
      </div>

      <input id="song-file-input" type="file" accept="${SONG_EXTENSION},application/json" hidden />
    </div>
  `;

  const labels = document.getElementById('lane-labels');
  labels.innerHTML = Array.from({ length: MAX_PITCH_OFFSET - MIN_PITCH_OFFSET + 1 }, (_, index) => {
    const pitch = MAX_PITCH_OFFSET - index;
    return `<div class="lane-label"><span>${pitch > 0 ? '+' : ''}${pitch}</span><small>st</small></div>`;
  }).join('');

  const paramSelect = document.getElementById('automation-param');
  paramSelect.innerHTML = AUTOMATION_PARAM_KEYS
    .map((key) => `<option value="${key}" ${key === state.automationParam ? 'selected' : ''}>${EFFECT_PARAMS[key].label}</option>`)
    .join('');

  wireShellEvents();
  state.shellReady = true;
}

function renderShellState() {
  const sectionMappings = [
    ['playlist', '.playlist-card', '.playlist-card > .collapsible-body', '.playlist-tools [data-section="playlist"]'],
    ['keyframes', '.automation-section', '.automation-section > .collapsible-body', '.automation-controls [data-section="keyframes"]'],
    ['protocol', '.protocol-card', '.protocol-card > .collapsible-body', '.protocol-card [data-section="protocol"]'],
    ['status', '.footer-card', '.footer-card > .collapsible-body', '.footer-card [data-section="status"]'],
  ];

  for (const [sectionKey, containerSelector, bodySelector, buttonSelector] of sectionMappings) {
    const container = document.querySelector(containerSelector);
    const body = document.querySelector(bodySelector);
    const button = document.querySelector(buttonSelector);
    const collapsed = state.collapsedSections[sectionKey];
    container?.classList.toggle('collapsed', collapsed);
    body?.classList.toggle('collapsed', collapsed);
    if (button) button.textContent = sectionToggleLabel(sectionKey);
  }

  const paramSelect = document.getElementById('automation-param');
  if (paramSelect) {
    paramSelect.value = state.automationParam;
  }

  const contextMenu = document.getElementById('clip-context-menu');
  if (contextMenu) {
    contextMenu.classList.toggle('hidden', !state.contextMenu.visible);
    contextMenu.style.left = `${state.contextMenu.x}px`;
    contextMenu.style.top = `${state.contextMenu.y}px`;
  }
}

function renderHeader() {
  const selected = getSelectedClip();
  const actions = document.getElementById('header-actions');
  actions.innerHTML = `
    <div class="transport-stack">
      <div class="transport-row">
        <button type="button" class="primary-btn" data-action="play">${state.isPlaying ? 'Playing...' : 'Play Arrangement'}</button>
        <button type="button" class="ghost-btn" data-action="stop">Stop</button>
      </div>
      <div class="transport-row">
        <button type="button" class="ghost-btn" data-action="export-mp3">Export MP3</button>
        <button type="button" class="ghost-btn" data-action="export-video">Export Video</button>
        <button type="button" class="ghost-btn" data-action="export-song">Save Song</button>
      </div>
      <div class="transport-meta ${state.statusKind}">
        <span>${escapeHtml(state.statusText)}</span>
        <small>${selected ? `Selected: ${escapeHtml(selected.text)} (${selected.pitchOffset > 0 ? '+' : ''}${selected.pitchOffset} st)` : 'No clip selected'}</small>
      </div>
    </div>
  `;
}

function renderTimeline() {
  const ruler = document.getElementById('timeline-ruler');
  const grid = document.getElementById('timeline-grid');
  const endBeat = getProjectEndBeat(state.project);

  ruler.style.width = `${endBeat * PIXELS_PER_BEAT}px`;
  ruler.innerHTML = Array.from({ length: endBeat + 1 }, (_, beat) => `
    <div class="ruler-mark" style="left:${beat * PIXELS_PER_BEAT}px">
      <span>${beat + 1}</span>
    </div>
  `).join('');

  grid.style.width = `${endBeat * PIXELS_PER_BEAT}px`;
  grid.style.height = `${(MAX_PITCH_OFFSET - MIN_PITCH_OFFSET + 1) * ROW_HEIGHT}px`;
  grid.innerHTML = `
    ${getSortedClips(state.project).map((clip) => {
      const laneIndex = MAX_PITCH_OFFSET - clip.pitchOffset;
      const selected = clip.id === state.selectedClipId;
      const active = clip.id === state.activeClipId;
      const top = laneIndex * ROW_HEIGHT + 4;
      const left = clip.startBeat * PIXELS_PER_BEAT + 4;
      const width = Math.max(68, clip.lengthBeats * PIXELS_PER_BEAT - 8);
      return `
        <article
          class="clip-shell ${selected ? 'selected' : ''} ${active ? 'active' : ''}"
          data-clip-id="${clip.id}"
          data-color="${clip.color}"
          style="top:${top}px;left:${left}px;width:${width}px"
        >
          <button type="button" class="resize-handle left" data-resize="left" aria-label="Resize left"></button>
          <div class="clip-body">
            <strong>${escapeHtml(clip.text)}</strong>
          </div>
          <button type="button" class="resize-handle right" data-resize="right" aria-label="Resize right"></button>
        </article>
      `;
    }).join('')}
  `;
}

function renderMasterSection() {
  const master = state.project.master;
  const bankOptions = bankNames
    .map((name) => `<option value="${name}" ${name === master.bank ? 'selected' : ''}>${escapeHtml(name)}</option>`)
    .join('');

  return `
    <section class="stack-block">
      <div class="section-head section-head-toggle">
        <div>
          <h3>Master Voice</h3>
          <p>These defaults feed every clip unless the clip overrides them.</p>
        </div>
        <button type="button" class="ghost-btn" data-action="toggle-section" data-section="masterVoice">${sectionToggleLabel('masterVoice')}</button>
      </div>
      <div class="collapsible-body ${sectionClass('masterVoice')}">
        <label class="field">
          <span>Song Title</span>
          <input id="master-title" type="text" value="${escapeAttr(master.title)}" />
        </label>
        <div class="compact-grid">
          <label class="field">
            <span>Tempo</span>
            <input id="master-tempo" type="number" min="60" max="220" step="1" value="${master.tempo}" />
          </label>
          <label class="field">
            <span>Base F0</span>
            <input id="master-basef0" type="number" min="70" max="320" step="1" value="${master.baseF0}" />
          </label>
          <label class="field">
            <span>Phoneme Bank</span>
            <select id="master-bank">${bankOptions}</select>
          </label>
          <label class="field">
            <span>Output Volume</span>
            <input id="master-volume" type="range" min="0" max="1.5" step="0.01" value="${master.outputVolume}" />
            <small>${master.outputVolume.toFixed(2)}</small>
          </label>
        </div>
        <div class="slider-grid">
          ${CLIP_EFFECT_KEYS.map((key) => `
            <label class="field slider-field">
              <span>${EFFECT_PARAMS[key].label}</span>
              <input
                data-master-param="${key}"
                type="range"
                min="${EFFECT_PARAMS[key].min}"
                max="${EFFECT_PARAMS[key].max}"
                step="${EFFECT_PARAMS[key].step}"
                value="${master[key]}"
              />
              <small>${formatRangeValue(key, master[key])}</small>
            </label>
          `).join('')}
        </div>
      </div>
    </section>
  `;
}

function renderClipSection() {
  const clip = getSelectedClip();
  if (!clip) {
    return `
      <section class="stack-block">
        <div class="section-head">
          <h3>No Clip Selected</h3>
          <p>Double-click the playlist to create a new word clip, or import a sentence to seed the arrangement.</p>
        </div>
      </section>
    `;
  }

  const bankOptions = bankNames
    .map((name) => `<option value="${name}" ${name === clip.bank ? 'selected' : ''}>${escapeHtml(name)}</option>`)
    .join('');
  const splitMax = Math.max(2, clip.phonemes.split(/\s+/u).filter(Boolean).length);

  return `
    <section class="stack-block">
      <div class="section-head section-head-toggle">
        <div>
          <h3>Selected Clip</h3>
          <p>Drag the clip in the playlist to change time and pitch. Edits here update the generated protocol below.</p>
        </div>
        <button type="button" class="ghost-btn" data-action="toggle-section" data-section="clipInspector">${sectionToggleLabel('clipInspector')}</button>
      </div>
      <div class="collapsible-body ${sectionClass('clipInspector')}">
        <label class="field">
          <span>Display Word</span>
          <input id="clip-text" type="text" value="${escapeAttr(clip.text)}" />
        </label>
        <label class="field">
          <span>Phoneme String</span>
          <textarea id="clip-phonemes" rows="5" spellcheck="false">${escapeHtml(clip.phonemes)}</textarea>
        </label>
        <div class="compact-grid">
          <label class="field">
            <span>Start Beat</span>
            <input id="clip-start" type="number" min="0" step="${SNAP_BEAT}" value="${clip.startBeat}" />
          </label>
          <label class="field">
            <span>Length</span>
            <input id="clip-length" type="number" min="0.5" step="${SNAP_BEAT}" value="${clip.lengthBeats}" />
          </label>
          <label class="field">
            <span>Rate</span>
            <input id="clip-rate" type="number" min="${EFFECT_PARAMS.rate.min}" max="${EFFECT_PARAMS.rate.max}" step="1" value="${Math.round(clip.rateMs)}" />
          </label>
          <label class="field">
            <span>Bank</span>
            <select id="clip-bank">${bankOptions}</select>
          </label>
          <label class="field">
            <span>Pitch Offset</span>
            <input id="clip-pitch" type="number" min="${MIN_PITCH_OFFSET}" max="${MAX_PITCH_OFFSET}" step="0.25" value="${clip.pitchOffset}" />
          </label>
        </div>
        <div class="slider-grid">
          ${CLIP_EFFECT_KEYS.map((key) => {
            const value = clip.effects[key] ?? state.project.master[key];
            return `
              <label class="field slider-field">
                <span>${EFFECT_PARAMS[key].label}</span>
                <input
                  data-clip-param="${key}"
                  type="range"
                  min="${EFFECT_PARAMS[key].min}"
                  max="${EFFECT_PARAMS[key].max}"
                  step="${EFFECT_PARAMS[key].step}"
                  value="${value}"
                />
                <small>${formatRangeValue(key, value)}</small>
              </label>
            `;
          }).join('')}
        </div>
        <div class="mini-toolbar">
          <label class="mini-label">
            Split after token
            <input id="clip-split-index" type="number" min="1" max="${splitMax - 1}" step="1" value="${Math.max(1, Math.floor(splitMax / 2))}" />
          </label>
          <button type="button" class="ghost-btn" data-action="split-clip">Split Word</button>
          <button type="button" class="ghost-btn" data-action="duplicate-clip">Duplicate</button>
          <button type="button" class="ghost-btn danger" data-action="delete-clip">Delete</button>
        </div>
      </div>
    </section>
  `;
}

function renderInspector() {
  const target = document.getElementById('inspector-content');
  target.innerHTML = `${renderMasterSection()}${renderClipSection()}`;
}

function renderProtocolPanel() {
  const preview = document.getElementById('protocol-preview');
  const { markup } = buildProtocolMarkup();
  preview.innerHTML = markup;
}

function renderFooter() {
  const footer = document.getElementById('footer-content');
  const clipCount = state.project.clips.length;
  const selected = getSelectedClip();
  const protocol = buildProtocol(state.project);
  const playbackSegments = getPlaybackSegments(state.project, state.totalMs || null);
  footer.innerHTML = `
    <div class="footer-metric-row">
      <div class="footer-metric"><strong>${clipCount}</strong><span>clips</span></div>
      <div class="footer-metric"><strong>${getProjectEndBeat(state.project).toFixed(0)}</strong><span>beats</span></div>
      <div class="footer-metric"><strong>${protocol.text.length}</strong><span>code chars</span></div>
      <div class="footer-metric"><strong>${playbackSegments.length}</strong><span>playback spans</span></div>
    </div>
    <div class="footer-note">
      <p class="status-pill ${state.statusKind}">${escapeHtml(state.statusText)}</p>
      <p>${selected ? `Selected clip: ${escapeHtml(selected.text)} using ${escapeHtml(selected.bank)}.` : 'Select a clip to inspect its voice settings and automation.'}</p>
      <ul class="tips-list">
        <li>Double-click the playlist to create a new clip at that beat and pitch lane.</li>
        <li>Drag clips vertically to transpose them. That movement rewrites pitch via generated <code>b</code> directives.</li>
        <li>Use the automation lane to add keyframes for pitch, rate, vibrato, tremolo, aspiration, tilt, and effort.</li>
      </ul>
    </div>
  `;
}

function renderModal() {
  const backdrop = document.getElementById('modal-backdrop');
  const title = document.getElementById('modal-title');
  const kicker = document.getElementById('modal-kicker');
  const textarea = document.getElementById('modal-textarea');
  const replace = document.getElementById('modal-replace');
  if (!state.modal.mode) {
    backdrop.classList.add('hidden');
    return;
  }
  backdrop.classList.remove('hidden');
  const isSentence = state.modal.mode === 'sentence';
  title.textContent = isSentence ? 'Import Sentence' : 'Import Klattsch Code';
  kicker.textContent = isSentence ? 'Text to Protocol' : 'Protocol to Timeline';
  textarea.placeholder = IMPORT_TEMPLATES[state.modal.mode];
  textarea.value = state.modal.value;
  replace.checked = state.modal.replace;
}

function renderAll() {
  if (!state.shellReady) renderShell();
  ensureSelection();
  renderShellState();
  renderHeader();
  renderTimeline();
  renderInspector();
  renderProtocolPanel();
  renderFooter();
  renderModal();
  drawAutomationCanvas();
}

function updateProject(mutator) {
  mutator(state.project);
  ensureSelection();
  persist();
  renderAll();
}

function downloadText(text, name, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function openModal(mode) {
  state.modal.mode = mode;
  state.modal.value = '';
  state.modal.replace = true;
  renderModal();
}

function closeModal() {
  state.modal.mode = null;
  renderModal();
}

function applyModalImport() {
  const textarea = document.getElementById('modal-textarea');
  const replace = document.getElementById('modal-replace');
  state.modal.value = textarea.value;
  state.modal.replace = replace.checked;

  if (!state.modal.value.trim()) {
    setStatus('Nothing to import yet.', 'warn');
    return;
  }

  if (state.modal.mode === 'sentence') {
    const imported = sentenceToClips(state.modal.value, state.project.master)
      .map((clip, index) => normalizeClip(state.project, clip, index));
    updateProject((project) => {
      if (state.modal.replace) {
        project.clips = imported;
      } else {
        project.clips.push(...shiftImportedClips(imported, getProjectEndBeat(project)));
      }
      state.selectedClipId = project.clips[0]?.id ?? null;
    });
    setStatus('Sentence imported and converted into valid klattsch protocol.', 'success');
  } else if (state.modal.mode === 'protocol') {
    updateProject((project) => {
      if (state.modal.replace) {
        importProtocol(project, state.modal.value);
      } else {
        const temp = copyProject(project);
        importProtocol(temp, state.modal.value);
        project.clips.push(...shiftImportedClips(temp.clips, getProjectEndBeat(project)));
      }
      state.selectedClipId = project.clips[0]?.id ?? null;
    });
    setStatus('Klattsch code imported into editable clips.', 'success');
  }

  closeModal();
}

function getAutomationCanvas() {
  return document.getElementById('automation-canvas');
}

function canvasMetrics() {
  const canvas = getAutomationCanvas();
  const bounds = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(320, Math.floor(bounds.width * dpr));
  canvas.height = Math.max(180, Math.floor(bounds.height * dpr));
  return { canvas, bounds, dpr };
}

function automationValueToY(paramKey, value, height, padding) {
  const def = EFFECT_PARAMS[paramKey];
  const t = (value - def.min) / (def.max - def.min || 1);
  return padding + (1 - t) * (height - padding * 2);
}

function automationXToTime(x, width, padding) {
  return clamp((x - padding) / Math.max(1, width - padding * 2), 0, 1);
}

function automationYToValue(paramKey, y, height, padding) {
  const def = EFFECT_PARAMS[paramKey];
  const t = clamp(1 - (y - padding) / Math.max(1, height - padding * 2), 0, 1);
  const raw = def.min + t * (def.max - def.min);
  return Number((Math.round(raw / def.step) * def.step).toFixed(4));
}

function getAutomationPoints(clip) {
  return clip?.automation[state.automationParam] ?? [];
}

function drawAutomationCanvas() {
  const clip = getSelectedClip();
  const { canvas, dpr } = canvasMetrics();
  const context = canvas.getContext('2d');
  const width = canvas.width / dpr;
  const height = canvas.height / dpr;
  const padding = 28;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);

  context.fillStyle = '#0a1016';
  context.fillRect(0, 0, width, height);
  context.strokeStyle = 'rgba(255,255,255,0.08)';
  for (let index = 0; index <= 4; index += 1) {
    const y = padding + ((height - padding * 2) / 4) * index;
    context.beginPath();
    context.moveTo(padding, y);
    context.lineTo(width - padding, y);
    context.stroke();
  }
  for (let index = 0; index <= 8; index += 1) {
    const x = padding + ((width - padding * 2) / 8) * index;
    context.beginPath();
    context.moveTo(x, padding);
    context.lineTo(x, height - padding);
    context.stroke();
  }

  context.fillStyle = '#94a3b8';
  context.font = '12px "IBM Plex Mono", monospace';
  context.fillText(EFFECT_PARAMS[state.automationParam].label, padding, 18);

  if (!clip) {
    context.fillStyle = '#64748b';
    context.fillText('Select a clip to draw keyframes.', padding, height / 2);
    return;
  }

  const points = getAutomationPoints(clip);
  const baseValue = state.automationParam === 'pitchOffset'
    ? clip.pitchOffset
    : state.automationParam === 'rate'
      ? clip.rateMs
      : (clip.effects[state.automationParam] ?? state.project.master[state.automationParam]);

  const renderPoints = points.length
    ? points
    : [
        { id: 'base-a', time: 0, value: baseValue },
        { id: 'base-b', time: 1, value: baseValue },
      ];

  context.strokeStyle = '#ff8c42';
  context.lineWidth = 2;
  context.beginPath();
  renderPoints.forEach((point, index) => {
    const x = padding + point.time * (width - padding * 2);
    const y = automationValueToY(state.automationParam, point.value, height, padding);
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.stroke();

  renderPoints.forEach((point) => {
    const x = padding + point.time * (width - padding * 2);
    const y = automationValueToY(state.automationParam, point.value, height, padding);
    const liveValue = sampleAutomation(clip, state.automationParam, point.time, baseValue);
    context.fillStyle = '#0f172a';
    context.strokeStyle = '#f8fafc';
    context.beginPath();
    context.arc(x, y, 6, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.fillStyle = '#f97316';
    context.fillRect(x - 1, y - 1, 2, 2);
    context.fillStyle = '#9ca3af';
    context.fillText(formatRangeValue(state.automationParam, liveValue), Math.min(width - 88, x + 10), Math.max(18, y - 10));
  });
}

function locateAutomationPoint(event) {
  const clip = getSelectedClip();
  if (!clip) return null;
  const canvas = getAutomationCanvas();
  const rect = canvas.getBoundingClientRect();
  const padding = 28;
  const width = rect.width;
  const height = rect.height;
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const points = getAutomationPoints(clip);

  for (const point of points) {
    const pointX = padding + point.time * (width - padding * 2);
    const pointY = automationValueToY(state.automationParam, point.value, height, padding);
    if (Math.hypot(pointX - x, pointY - y) <= 10) {
      return { point, x, y, width, height, padding };
    }
  }
  return { point: null, x, y, width, height, padding };
}

function handleAutomationPointerDown(event) {
  const clip = getSelectedClip();
  if (!clip) return;
  const hit = locateAutomationPoint(event);
  const points = clip.automation[state.automationParam] ?? [];

  if (event.altKey && hit.point) {
    clip.automation[state.automationParam] = points.filter((point) => point.id !== hit.point.id);
    persist();
    renderAll();
    return;
  }

  if (hit.point) {
    state.automationDrag = { pointId: hit.point.id };
  } else {
    const nextPoint = {
      id: makeId('kf'),
      time: Number(automationXToTime(hit.x, hit.width, hit.padding).toFixed(4)),
      value: automationYToValue(state.automationParam, hit.y, hit.height, hit.padding),
    };
    clip.automation[state.automationParam] = [...points, nextPoint].sort((left, right) => left.time - right.time);
    state.automationDrag = { pointId: nextPoint.id };
    persist();
    renderAll();
  }

  const canvas = getAutomationCanvas();
  canvas.setPointerCapture(event.pointerId);
}

function handleAutomationPointerMove(event) {
  if (!state.automationDrag) return;
  const clip = getSelectedClip();
  if (!clip) return;
  const canvas = getAutomationCanvas();
  const rect = canvas.getBoundingClientRect();
  const padding = 28;
  const points = clip.automation[state.automationParam] ?? [];
  const point = points.find((item) => item.id === state.automationDrag.pointId);
  if (!point) return;

  point.time = Number(automationXToTime(event.clientX - rect.left, rect.width, padding).toFixed(4));
  point.value = automationYToValue(state.automationParam, event.clientY - rect.top, rect.height, padding);
  clip.automation[state.automationParam] = points.sort((left, right) => left.time - right.time);
  drawAutomationCanvas();
}

function handleAutomationPointerUp(event) {
  if (!state.automationDrag) return;
  state.automationDrag = null;
  const canvas = getAutomationCanvas();
  canvas.releasePointerCapture(event.pointerId);
  persist();
  renderAll();
}

function openSongFilePicker() {
  document.getElementById('song-file-input').click();
}

function handleSongFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  file.text().then((text) => {
    state.project = importSong(text);
    state.selectedClipId = state.project.clips[0]?.id ?? null;
    persist();
    renderAll();
    setStatus('Song imported.', 'success');
  }).catch((error) => {
    reportError('Song import failed', error);
  }).finally(() => {
    event.target.value = '';
  });
}

function wireShellEvents() {
  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    const clip = getSelectedClip();

    if (action === 'play') {
      try {
        const playback = await audio.play(state.project);
        state.playbackSegments = playback.playbackSegments;
        state.totalMs = playback.result.totalMs;
        renderTimeline();
      } catch (error) {
        reportError('Playback failed', error);
      }
      return;
    }
    if (action === 'toggle-section') {
      const sectionKey = button.dataset.section;
      if (sectionKey && sectionKey in state.collapsedSections) {
        state.collapsedSections[sectionKey] = !state.collapsedSections[sectionKey];
        renderAll();
      }
      return;
    }
    if (action === 'stop') {
      audio.stop();
      hideContextMenu();
      setStatus('Playback stopped.', 'info');
      return;
    }
    if (action === 'export-mp3') {
      try {
        await audio.exportMp3(state.project, slugifyTitle(state.project.master.title));
      } catch (error) {
        reportError('MP3 export failed', error);
      }
      return;
    }
    if (action === 'export-video') {
      try {
        await audio.exportVideo(state.project, slugifyTitle(state.project.master.title));
      } catch (error) {
        reportError('Video export failed', error);
      }
      return;
    }
    if (action === 'export-song') {
      downloadText(exportSong(state.project), `${slugifyTitle(state.project.master.title)}${SONG_EXTENSION}`, SONG_MIME);
      setStatus('Song saved.', 'success');
      return;
    }
    if (action === 'export-protocol') {
      downloadText(buildProtocol(state.project).text, `${slugifyTitle(state.project.master.title)}.klattsch.txt`);
      setStatus('Protocol exported.', 'success');
      return;
    }
    if (action === 'import-sentence') {
      openModal('sentence');
      return;
    }
    if (action === 'import-protocol') {
      openModal('protocol');
      return;
    }
    if (action === 'new-project') {
      state.project = createProject();
      state.selectedClipId = state.project.clips[0]?.id ?? null;
      persist();
      renderAll();
      setStatus('Loaded a fresh demo arrangement.', 'success');
      return;
    }
    if (action === 'close-modal') {
      closeModal();
      return;
    }
    if (action === 'apply-modal') {
      applyModalImport();
      return;
    }
    if (action === 'import-song') {
      openSongFilePicker();
      return;
    }
    if (action === 'clear-automation' && clip) {
      delete clip.automation[state.automationParam];
      persist();
      renderAll();
      setStatus(`Cleared ${EFFECT_PARAMS[state.automationParam].label} automation.`, 'success');
      return;
    }
    if (action === 'duplicate-clip' && clip) {
      duplicateSelectedClip();
      return;
    }
    if (action === 'split-clip' && clip) {
      const splitInput = document.getElementById('clip-split-index');
      const splitIndex = Number(splitInput.value);
      const result = splitClip(state.project, clip, splitIndex);
      if (!result) {
        setStatus('This clip needs at least two phoneme tokens before it can split.', 'warn');
        return;
      }
      state.selectedClipId = result.id;
      persist();
      renderAll();
      setStatus('Clip split into two editable words.', 'success');
      return;
    }
    if (action === 'delete-clip' && clip) {
      deleteSelectedClip();
    }
  });

  root.addEventListener('change', (event) => {
    const target = event.target;
    const clip = getSelectedClip();

    if (target.id === 'automation-param') {
      state.automationParam = target.value;
      drawAutomationCanvas();
      return;
    }

    if (target.id === 'modal-replace') {
      state.modal.replace = target.checked;
      return;
    }

    if (target.id === 'master-bank') {
      updateProject((project) => {
        project.master.bank = target.value;
      });
      return;
    }

    if (target.id === 'clip-bank' && clip) {
      updateProject(() => {
        clip.bank = target.value;
      });
      return;
    }
  });

  root.addEventListener('input', (event) => {
    const target = event.target;
    const clip = getSelectedClip();

    if (target.id === 'modal-textarea') {
      state.modal.value = target.value;
      return;
    }

    if (target.id === 'master-title') {
      updateProject((project) => {
        project.master.title = target.value;
      });
      return;
    }
    if (target.id === 'master-tempo') {
      updateProject((project) => {
        project.master.tempo = clamp(Number(target.value), 60, 220);
        syncAllClipsFromTempo();
      });
      return;
    }
    if (target.id === 'master-basef0') {
      updateProject((project) => {
        project.master.baseF0 = clamp(Number(target.value), 70, 320);
      });
      return;
    }
    if (target.id === 'master-volume') {
      updateProject((project) => {
        project.master.outputVolume = Number(target.value);
      });
      return;
    }
    if (target.dataset.masterParam) {
      updateProject((project) => {
        project.master[target.dataset.masterParam] = Number(target.value);
      });
      return;
    }

    if (!clip) return;

    if (target.id === 'clip-text') {
      updateProject(() => {
        clip.text = target.value;
      });
      return;
    }
    if (target.id === 'clip-phonemes') {
      updateProject(() => {
        clip.phonemes = target.value.trim() || 'HH AH L OW';
        syncClipTiming(state.project, clip);
      });
      return;
    }
    if (target.id === 'clip-start') {
      updateProject(() => {
        clip.startBeat = Math.max(0, snapBeat(Number(target.value)));
      });
      return;
    }
    if (target.id === 'clip-length') {
      updateProject(() => {
        clip.lengthBeats = Math.max(0.5, snapBeat(Number(target.value)));
        syncClipRateFromLength(clip);
      });
      return;
    }
    if (target.id === 'clip-rate') {
      updateProject(() => {
        clip.rateMs = clamp(Number(target.value), EFFECT_PARAMS.rate.min, EFFECT_PARAMS.rate.max);
        syncClipTiming(state.project, clip);
      });
      return;
    }
    if (target.id === 'clip-pitch') {
      updateProject(() => {
        clip.pitchOffset = clamp(Number(target.value), MIN_PITCH_OFFSET, MAX_PITCH_OFFSET);
      });
      return;
    }
    if (target.dataset.clipParam) {
      updateProject(() => {
        clip.effects[target.dataset.clipParam] = Number(target.value);
      });
      return;
    }
  });

  const timeline = document.getElementById('timeline-grid');
  timeline.addEventListener('click', (event) => {
    hideContextMenu();
    const clipEl = event.target.closest('.clip-shell');
    if (!clipEl) return;
    state.selectedClipId = clipEl.dataset.clipId;
    renderAll();
  });

  timeline.addEventListener('dblclick', (event) => {
    if (event.target.closest('.clip-shell')) return;
    const rect = timeline.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const beat = Math.max(0, snapBeat(x / PIXELS_PER_BEAT));
    const lane = Math.round(y / ROW_HEIGHT);
    const pitchOffset = clamp(MAX_PITCH_OFFSET - lane, MIN_PITCH_OFFSET, MAX_PITCH_OFFSET);
    const clip = createBlankClip(state.project, beat, pitchOffset);
    state.selectedClipId = clip.id;
    persist();
    renderAll();
    setStatus('New clip added to the playlist.', 'success');
  });

  timeline.addEventListener('pointerdown', (event) => {
    hideContextMenu();
    const clipEl = event.target.closest('.clip-shell');
    if (!clipEl) return;
    const clip = getClipById(state.project, clipEl.dataset.clipId);
    if (!clip) return;
    const mode = event.target.dataset.resize ? `resize-${event.target.dataset.resize}` : 'move';
    state.selectedClipId = clip.id;
    state.drag = {
      clipId: clip.id,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      originalStartBeat: clip.startBeat,
      originalLength: clip.lengthBeats,
      originalPitch: clip.pitchOffset,
    };
    window.addEventListener('pointermove', handleTimelinePointerMove);
    window.addEventListener('pointerup', handleTimelinePointerUp, { once: true });
    renderAll();
  });

  timeline.addEventListener('contextmenu', (event) => {
    const clipEl = event.target.closest('.clip-shell');
    if (!clipEl) return;
    event.preventDefault();
    state.selectedClipId = clipEl.dataset.clipId;
    state.contextMenu.visible = true;
    state.contextMenu.x = event.clientX;
    state.contextMenu.y = event.clientY;
    state.contextMenu.clipId = clipEl.dataset.clipId;
    renderAll();
  });

  const canvas = getAutomationCanvas();
  canvas.addEventListener('pointerdown', handleAutomationPointerDown);
  canvas.addEventListener('pointermove', handleAutomationPointerMove);
  canvas.addEventListener('pointerup', handleAutomationPointerUp);
  canvas.addEventListener('pointercancel', handleAutomationPointerUp);

  document.getElementById('song-file-input').addEventListener('change', handleSongFile);
  document.removeEventListener('click', handleGlobalDocumentClick);
  document.addEventListener('click', handleGlobalDocumentClick);
  document.removeEventListener('keydown', handleGlobalKeyDown);
  document.addEventListener('keydown', handleGlobalKeyDown);
}

function handleGlobalDocumentClick(event) {
  if (!state.contextMenu.visible) return;
  if (event.target.closest('#clip-context-menu')) return;
  hideContextMenu();
  renderAll();
}

function handleGlobalKeyDown(event) {
  if (isEditableTarget(event.target)) return;

  const modKey = event.ctrlKey || event.metaKey;
  if (modKey && event.key.toLowerCase() === 'c') {
    if (copySelectedClip()) event.preventDefault();
    return;
  }
  if (modKey && event.key.toLowerCase() === 'v') {
    if (pasteClipboardClip()) event.preventDefault();
    return;
  }

  if (event.key === 'Delete' || event.key === 'Backspace') {
    if (deleteSelectedClip()) event.preventDefault();
    return;
  }

  if (event.key === 'ArrowLeft') {
    if (nudgeSelectedClip({ beatDelta: -SNAP_BEAT })) event.preventDefault();
    return;
  }
  if (event.key === 'ArrowRight') {
    if (nudgeSelectedClip({ beatDelta: SNAP_BEAT })) event.preventDefault();
    return;
  }
  if (event.key === 'ArrowUp') {
    if (nudgeSelectedClip({ pitchDelta: 1 })) event.preventDefault();
    return;
  }
  if (event.key === 'ArrowDown') {
    if (nudgeSelectedClip({ pitchDelta: -1 })) event.preventDefault();
  }
}

function handleTimelinePointerMove(event) {
  if (!state.drag) return;
  const clip = getClipById(state.project, state.drag.clipId);
  if (!clip) return;
  const deltaBeat = snapBeat((event.clientX - state.drag.startX) / PIXELS_PER_BEAT);
  const pitchDelta = Math.round((event.clientY - state.drag.startY) / ROW_HEIGHT);

  if (state.drag.mode === 'move') {
    clip.startBeat = Math.max(0, snapBeat(state.drag.originalStartBeat + deltaBeat));
    clip.pitchOffset = clamp(state.drag.originalPitch - pitchDelta, MIN_PITCH_OFFSET, MAX_PITCH_OFFSET);
  }

  if (state.drag.mode === 'resize-left') {
    const originalEnd = state.drag.originalStartBeat + state.drag.originalLength;
    clip.startBeat = Math.max(0, snapBeat(state.drag.originalStartBeat + deltaBeat));
    clip.startBeat = Math.min(clip.startBeat, originalEnd - 0.5);
    clip.lengthBeats = Math.max(0.5, snapBeat(originalEnd - clip.startBeat));
    syncClipRateFromLength(clip);
  }

  if (state.drag.mode === 'resize-right') {
    clip.lengthBeats = Math.max(0.5, snapBeat(state.drag.originalLength + deltaBeat));
    syncClipRateFromLength(clip);
  }

  renderTimeline();
  renderInspector();
  renderProtocolPanel();
}

function handleTimelinePointerUp() {
  window.removeEventListener('pointermove', handleTimelinePointerMove);
  state.drag = null;
  persist();
  renderAll();
}

window.addEventListener('error', (event) => {
  console.error('[Klattsch Studio] Unhandled error', event.error ?? event.message ?? event);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('[Klattsch Studio] Unhandled promise rejection', event.reason);
});

renderShell();
ensureSelection();
renderAll();
