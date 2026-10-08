// 创作输入框：上面选要生成什么（视频、图片、语音、音效、配乐），框里是素材、提示词和一排工具栏，右下角提交。
// 把表单拼成请求的逻辑在 request.js。

import { h, icon, add, toast, clear, segmented, toggle, dropdown, formRow, openPopover, openMenu } from './dom.js';
import { api, state, on, KINDS, findAsset, assetReadiness, refreshAsset, startHistoryLoop, loadVoices, polishModel, goTo } from './store.js';
import { openAssetPicker, thumbEl, refFromAsset, refFromRecord, assetFromRecord } from './assets.js';
import { openSettings } from './settings.js';
import { buildRequest as buildVideoRequest, buildImageRequest, buildSpeechRequest, buildSfxRequest, buildMusicRequest, refsInUse, videoFamily, RES_RANK } from './request.js';

// 视频的表单单独存一份（生成记录里存的也是它）；当前选的类型和其余几种的表单存在另一份里。
const FORM_KEY = 'seedance-studio.form.v1';
const STUDIO_KEY = 'seedance-studio.studio.v1';

// 能生成的五种内容。polish 表示这种内容的提示词可以让模型帮忙补充（要朗读的文字不能改写，配乐没有提示词）。
const TYPES = [
  { value: 'video', label: '视频', title: '想生成什么视频？', action: '生成视频', polish: true, placeholder: '描述你想生成的视频：主体、动作、场景、镜头运动、光线和风格' },
  { value: 'image', label: '图片', title: '想生成什么图片？', action: '生成图片', polish: true, placeholder: '描述你想生成的图片：主体、环境、构图、光线和风格' },
  { value: 'speech', label: '语音', title: '想让它读什么？', action: '生成语音', placeholder: '输入要朗读的文字' },
  { value: 'sfx', label: '音效', title: '想要什么声音？', action: '生成音效', polish: true, placeholder: '描述想要的声音：来源、材质、动作，是一次声响还是持续的环境声' },
  { value: 'music', label: '配乐', title: '给哪段视频配乐？', action: '生成配乐' },
];

const RESOLUTIONS = ['480p', '720p', '1080p'];
const RATIOS = [
  { value: '16:9', label: '16:9' },
  { value: '4:3', label: '4:3' },
  { value: '1:1', label: '1:1' },
  { value: '3:4', label: '3:4' },
  { value: '9:16', label: '9:16' },
  { value: '21:9', label: '21:9' },
  { value: 'adaptive', label: '自适应' },
];
const DURATIONS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const SR_RESOLUTIONS = ['720p', '1080p', '2k', '4k'];
const SR_SCENES = [
  { value: '', label: '不指定' },
  { value: 'aigc', label: 'AIGC 内容' },
  { value: 'short_series', label: '短剧' },
  { value: 'ugc', label: 'UGC' },
  { value: 'old_film', label: '老片' },
];
const MODES = [
  { value: 'text', label: '文生视频', icon: 'type', note: '只用文字' },
  { value: 'frames', label: '首尾帧', icon: 'frames', note: '指定首帧，尾帧可选' },
  { value: 'reference', label: '参考生成', icon: 'layers', note: '图片、视频、音频作参考' },
];
// Grok 只有文生视频和图生视频，时长 1 到 15 秒，没有 1080p，也没有 Seedance「更多」里的那些设置。
const GROK_MODES = [MODES[0], { value: 'frames', label: '图生视频', icon: 'frames', note: '给一张首帧' }];
const GROK_DURATIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const GROK_RATIOS = ['16:9', '4:3', '1:1', '3:4', '9:16'];
const MODEL_NOTES = { 'seedance-2.0': '专业模型', 'seedance-2.0-fast': '快速模型' };
const INPUT_TYPES = [
  { value: 'auto', label: '自动判断', note: '推荐' },
  { value: 'reference', label: 'reference', note: '参考' },
  { value: 'first_last_frame', label: 'first_last_frame', note: '首尾帧' },
];
const REF_PREFIX = { image: '图', video: '视频', audio: '音频' };

const IMAGE_RATIOS = ['16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16'].map((value) => ({ value, label: value }));
const IMAGE_COUNTS = [1, 2, 3, 4];
const SFX_DURATIONS = [1, 2, 3, 5, 8, 10, 15, 20];
const SFX_INFLUENCES = [
  { value: '0.3', label: '自由发挥', note: '默认' },
  { value: '0.6', label: '贴近描述' },
  { value: '0.9', label: '严格按描述' },
];
const VOICE_GENDERS = { male: '男声', female: '女声', neutral: '中性' };
const VOICE_LANGUAGES = { zh: '中文', en: '英语' };

const defaults = () => ({
  mode: 'text',
  prompt: '',
  model: 'seedance-2.0',
  resolution: '720p',
  ratio: '16:9',
  duration: 5,
  durationAuto: false,
  generateAudio: true,
  watermark: false,
  seed: '',
  webSearch: false,
  inputType: 'auto',
  sr: { enabled: false, by: 'resolution', resolution: '1080p', limit: 1440, scene: '', tool: 'standard', fps: '' },
  frames: { first: null, last: null },
  refs: { image: [], video: [], audio: [] },
});

const studioDefaults = () => ({
  type: 'video',
  image: { prompt: '', model: 'grok-imagine-image-2.0', ratio: '16:9', count: 1 },
  speech: { prompt: '', voiceId: '', voiceName: '' },
  sfx: { prompt: '', duration: 'auto', influence: '0.3' },
  music: { video: null },
});

function mergeForm(saved) {
  const base = defaults();
  if (!saved || typeof saved !== 'object') return base;
  return {
    ...base,
    ...saved,
    sr: { ...base.sr, ...(saved.sr || {}) },
    frames: { ...base.frames, ...(saved.frames || {}) },
    refs: { ...base.refs, ...(saved.refs || {}) },
  };
}

function mergeStudio(saved) {
  const base = studioDefaults();
  if (!saved || typeof saved !== 'object') return base;
  const merged = { type: TYPES.some((t) => t.value === saved.type) ? saved.type : base.type };
  for (const key of ['image', 'speech', 'sfx', 'music']) merged[key] = { ...base[key], ...(saved[key] || {}) };
  return merged;
}

function load(key, merge) {
  try {
    return merge(JSON.parse(localStorage.getItem(key)));
  } catch {
    return merge(null);
  }
}

let form = load(FORM_KEY, mergeForm);
let studio = load(STUDIO_KEY, mergeStudio);
let els = null;
let submitting = false;
let submitError = '';
let saveTimer = null;
let refSignature = '';
// 润色之前的原文。留着它，「润色」就变成「撤销润色」；用户再动一下文字就丢掉。
let beforePolish = null;
let polishing = false;
let voicesError = '';
let voiceFilter = 'all';
const popovers = { frame: null, more: null, voice: null };
const preview = new Audio();
let previewing = '';

const typeOf = (value = studio.type) => TYPES.find((t) => t.value === value) || TYPES[0];
// 当前类型正在编辑的那份表单。
const draft = () => (studio.type === 'video' ? form : studio[studio.type]);

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(FORM_KEY, JSON.stringify(form));
      localStorage.setItem(STUDIO_KEY, JSON.stringify(studio));
    } catch {
      /* 存不下就不存，不影响使用 */
    }
  }, 300);
}

const isGrok = (model = form.model) => videoFamily(model) === 'grok';
// seedance-2.5 文档写明只支持 480p / 720p；Grok 也没有 1080p。
const resolutionsFor = (model) => (isGrok(model) || /^seedance-2\.5/.test(model) ? ['480p', '720p'] : RESOLUTIONS);
const ratiosFor = (model) => (isGrok(model) ? GROK_RATIOS : RATIOS.map((r) => r.value));

const allRefs = (f = form) => refsInUse(f);
const usedAssetIds = () => allRefs().map((r) => r.assetId).filter(Boolean);

function refStatus(ref) {
  if (ref.source === 'url') return { ready: true, tone: 'ok', label: '链接' };
  if (ref.source === 'local') return { ready: true, tone: 'ok', label: '本机' };
  return assetReadiness(findAsset(ref.assetId), form.model);
}

// 视频表单对应的请求体，以及不能提交的原因。
export function buildRequest(f = form) {
  return buildVideoRequest(f, refStatus);
}

// 当前类型的请求和不能提交的原因。
function currentRequest() {
  if (studio.type === 'image') return buildImageRequest(studio.image);
  if (studio.type === 'speech') return buildSpeechRequest(studio.speech);
  if (studio.type === 'sfx') return buildSfxRequest(studio.sfx);
  if (studio.type === 'music') return buildMusicRequest(studio.music);
  return buildRequest();
}

// 超分的目标必须高于原始分辨率；不满足时自动换到更高的最近一档，免得用户被一条看不见的校验卡住。
function fitSrTarget() {
  if (!form.sr.enabled || form.sr.by !== 'resolution') return;
  if (RES_RANK[form.sr.resolution] > RES_RANK[form.resolution]) return;
  const next = SR_RESOLUTIONS.find((r) => RES_RANK[r] > RES_RANK[form.resolution]);
  if (next) form.sr = { ...form.sr, resolution: next };
}

// 换模型后，把当前模型不支持的取值换成它支持的，免得带着一个提交不了的设置。
function fitModel() {
  if (!resolutionsFor(form.model).includes(form.resolution)) form.resolution = '720p';
  if (!ratiosFor(form.model).includes(form.ratio)) form.ratio = '16:9';
  if (isGrok()) {
    if (form.mode === 'reference') form.mode = 'text';
    form.durationAuto = false;
  } else if (form.duration < DURATIONS[0]) {
    form.duration = 5;
  }
}

function update(patch, redraw = drawAll) {
  Object.assign(form, patch);
  fitModel();
  fitSrTarget();
  submitError = '';
  persist();
  redraw();
}

function updateStudio(type, patch, redraw = drawAll) {
  Object.assign(studio[type], patch);
  submitError = '';
  persist();
  redraw();
}

function setType(type) {
  studio.type = type;
  beforePolish = null;
  submitError = '';
  stopPreview();
  persist();
  if (els) drawAll();
  if (type === 'speech') ensureVoices();
}

// 把一份视频表单填回输入框（复用记录时用）。
export function setForm(next) {
  form = mergeForm(JSON.parse(JSON.stringify(next)));
  if (!state.models.includes(form.model) && state.models.length) form.model = state.models[0];
  fitModel();
  setType('video');
}

// 把图片、语音、音效、配乐的表单填回输入框。
export function setStudio(type, next) {
  const { type: _ignored, ...fields } = JSON.parse(JSON.stringify(next || {}));
  studio[type] = { ...studioDefaults()[type], ...fields };
  setType(type);
}

// 用一张生成的图片当首帧去生成视频。Grok 直接用本机的文件；Seedance 只认素材库，所以先传上去。
export async function useImageAsFirstFrame(item) {
  let first;
  if (isGrok()) {
    first = await refFromRecord(item);
  } else {
    toast('正在把图片传到素材库…', 'info');
    first = refFromAsset(await assetFromRecord(item), 'image');
  }
  Object.assign(form, { mode: 'frames', frames: { first, last: null } });
  setType('video');
  goTo('create');
}

// 给一条已经存到本机的视频配乐：把它放进配乐的输入框，等用户点提交。
export async function useVideoForMusic(item) {
  studio.music = { video: await refFromRecord(item) };
  setType('music');
  goTo('create');
}

// ---------- 参考素材 ----------

function refTile(ref, label, onRemove) {
  const s = refStatus(ref);
  return h(
    'div',
    { class: `ref-tile tone-${s.tone}`, title: ref.name },
    thumbEl(ref.thumb, ref.kind),
    label && h('span', { class: 'ref-index' }, label),
    !s.ready && h('span', { class: `ref-state ${s.tone === 'error' ? 'is-error' : ''}` }, s.label),
    h('button', { class: 'ref-remove', type: 'button', 'aria-label': '移除', onClick: onRemove }, '×'),
  );
}

// 一个只放一份素材的格子：有就显示缩略图，没有就是一个「+」。
function slot(ref, label, onAdd, onRemove) {
  const empty = h('button', { class: 'ref-tile ref-add', type: 'button', 'aria-label': `添加${label}`, onClick: onAdd }, '+');
  return h('div', { class: 'frame-slot' }, ref ? refTile(ref, null, onRemove) : empty, h('span', { class: 'small muted' }, label));
}

function drawMedia() {
  const root = clear(els.media);
  const type = studio.type;
  root.hidden = !(type === 'music' || (type === 'video' && form.mode !== 'text'));
  if (root.hidden) return;

  if (type === 'music') {
    const video = studio.music.video;
    const setVideo = (next) => updateStudio('music', { video: next }, drawDynamic);
    const label = video?.duration ? `要配乐的视频 · ${Math.round(video.duration)} 秒` : '要配乐的视频';
    // 配乐要把视频文件传给模型，所以只能选本机有的：生成记录里的，或者从电脑里选一个。
    root.append(h('div', { class: 'frames-row' }, slot(video, label, () => openAssetPicker({ kind: 'video', local: true, sources: ['records', 'upload'], onPick: setVideo }), () => setVideo(null))));
    return;
  }

  if (form.mode === 'frames') {
    const frame = (key, label) => {
      const setRef = (value) => update({ frames: { ...form.frames, [key]: value } }, drawDynamic);
      return slot(form.frames[key], label, () => openAssetPicker({ kind: 'image', remaining: 1, usedIds: usedAssetIds(), local: isGrok(), onPick: setRef }), () => setRef(null));
    };
    // Grok 只有首帧。
    root.append(h('div', { class: 'frames-row' }, frame('first', '首帧'), !isGrok() && [h('span', { class: 'frames-arrow' }, '→'), frame('last', '尾帧（可选）')]));
    return;
  }

  const setList = (kind, next) => update({ refs: { ...form.refs, [kind]: next } }, drawDynamic);
  const tiles = [];
  for (const kind of Object.keys(KINDS)) {
    form.refs[kind].forEach((ref, i) => {
      tiles.push(refTile(ref, `${REF_PREFIX[kind]}${i + 1}`, () => setList(kind, form.refs[kind].filter((r) => r.uid !== ref.uid))));
    });
  }
  // 三种素材共用一个「+」：先选类型，再选来源。
  const kinds = Object.entries(KINDS);
  const full = kinds.every(([kind, meta]) => form.refs[kind].length >= meta.max);
  const addButton = h(
    'button',
    {
      class: 'ref-tile ref-add',
      type: 'button',
      'aria-label': '添加参考素材',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      onClick: () =>
        openMenu(addButton, {
          label: '添加参考素材',
          items: kinds.map(([kind, meta]) => ({ value: kind, label: meta.label, note: `${form.refs[kind].length} / ${meta.max}`, disabled: form.refs[kind].length >= meta.max })),
          onSelect: (kind) =>
            openAssetPicker({
              kind,
              remaining: KINDS[kind].max - form.refs[kind].length,
              usedIds: usedAssetIds(),
              onPick: (ref) => setList(kind, [...form.refs[kind], ref].slice(0, KINDS[kind].max)),
            }),
        }),
    },
    '+',
  );
  root.append(h('div', { class: 'ref-row' }, tiles, !full && addButton));
}

// ---------- 工具栏 ----------

// 比例的形状示意：按 "宽:高" 画一个小方框，写不成比例的（自适应）画虚线框。
function ratioShape(value) {
  const [w, hgt] = String(value).split(':').map(Number);
  if (!w || !hgt) return h('span', { class: 'ratio-shape ratio-auto' });
  const scale = 14 / Math.max(w, hgt);
  return h('span', { class: 'ratio-shape', style: { width: `${Math.max(6, Math.round(w * scale))}px`, height: `${Math.max(6, Math.round(hgt * scale))}px` } });
}

function drawToolbar() {
  if (studio.type === 'image') return drawImageToolbar();
  if (studio.type === 'speech') return drawSpeechToolbar();
  if (studio.type === 'sfx') return drawSfxToolbar();
  if (studio.type === 'music') return els.params.replaceChildren(h('span', { class: 'composer-hint' }, '会按画面生成一段和视频一样长的音乐'));

  const modes = isGrok() ? GROK_MODES : MODES;
  const mode = modes.find((m) => m.value === form.mode) || modes[0];
  const ratio = RATIOS.find((r) => r.value === form.ratio) || RATIOS[0];
  const models = state.models.includes(form.model) ? state.models : [form.model, ...state.models];
  const durations = isGrok() ? GROK_DURATIONS : DURATIONS;

  // 「画面」和「更多」打开的是面板，按钮本身要一直留着，所以只更新里面的内容。
  els.frameButton.replaceChildren(h('span', { class: 'ratio-box' }, ratioShape(form.ratio)), h('span', null, `${ratio.label} · ${form.resolution}`));
  els.frameButton.setAttribute('aria-label', `画面：${ratio.label}，${form.resolution}`);

  els.params.replaceChildren(
    dropdown({
      variant: 'tool',
      control: 'mode',
      icon: mode.icon,
      label: '生成方式',
      value: form.mode,
      options: modes.map((m) => ({ value: m.value, label: m.label, note: m.note })),
      onChange: (value) => update({ mode: value }),
    }),
    dropdown({
      variant: 'tool',
      control: 'model',
      icon: 'cube',
      label: '模型',
      value: form.model,
      options: models.map((m) => ({ value: m, label: m, note: MODEL_NOTES[m] })),
      onChange: (model) => update({ model }),
    }),
    els.frameButton,
    dropdown({
      variant: 'tool',
      control: 'duration',
      icon: 'clock',
      label: '时长',
      value: form.durationAuto ? 'auto' : String(form.duration),
      options: [...durations.map((d) => ({ value: String(d), label: `${d} 秒` })), ...(isGrok() ? [] : [{ value: 'auto', label: '由模型决定', display: '时长自动' }])],
      onChange: (value) => update(value === 'auto' ? { durationAuto: true } : { durationAuto: false, duration: Number(value) }),
    }),
    // 「更多」里全是 Seedance 的设置，Grok 一项也用不上。
    ...(isGrok() ? [] : [els.moreButton]),
  );
}

function drawImageToolbar() {
  const sub = studio.image;
  const models = state.catalog.image.includes(sub.model) || !state.catalog.image.length ? state.catalog.image : [sub.model, ...state.catalog.image];
  const ratio = IMAGE_RATIOS.find((r) => r.value === sub.ratio) || IMAGE_RATIOS[0];
  const ratioButton = h(
    'button',
    {
      class: 'dropdown dropdown-tool',
      type: 'button',
      'data-control': 'ratio',
      'aria-haspopup': 'listbox',
      'aria-expanded': 'false',
      'aria-label': `画面比例：${ratio.label}`,
      onClick: () => openMenu(ratioButton, { label: '画面比例', items: IMAGE_RATIOS.map((r) => ({ ...r, selected: r === ratio })), onSelect: (value) => updateStudio('image', { ratio: value }) }),
    },
    h('span', { class: 'ratio-box' }, ratioShape(ratio.value)),
    h('span', null, ratio.label),
  );
  els.params.replaceChildren(
    dropdown({
      variant: 'tool',
      control: 'model',
      icon: 'cube',
      label: '模型',
      value: sub.model,
      options: (models.length ? models : [sub.model]).map((m) => ({ value: m, label: m })),
      onChange: (model) => updateStudio('image', { model }),
    }),
    ratioButton,
    dropdown({
      variant: 'tool',
      control: 'count',
      icon: 'layers',
      label: '数量',
      value: String(sub.count),
      options: IMAGE_COUNTS.map((n) => ({ value: String(n), label: `${n} 张` })),
      onChange: (value) => updateStudio('image', { count: Number(value) }),
    }),
  );
}

function drawSpeechToolbar() {
  els.voiceButton.replaceChildren(icon('user'), h('span', null, studio.speech.voiceName || '选择音色'));
  els.voiceButton.setAttribute('aria-label', `音色：${studio.speech.voiceName || '未选择'}`);
  els.params.replaceChildren(els.voiceButton);
}

function drawSfxToolbar() {
  const sub = studio.sfx;
  els.params.replaceChildren(
    dropdown({
      variant: 'tool',
      control: 'duration',
      icon: 'clock',
      label: '时长',
      value: String(sub.duration),
      options: [{ value: 'auto', label: '由模型决定', display: '时长自动' }, ...SFX_DURATIONS.map((d) => ({ value: String(d), label: `${d} 秒` }))],
      onChange: (duration) => updateStudio('sfx', { duration }),
    }),
    dropdown({
      variant: 'tool',
      control: 'influence',
      icon: 'sliders',
      label: '和描述的贴合度',
      value: String(sub.influence),
      options: SFX_INFLUENCES,
      onChange: (influence) => updateStudio('sfx', { influence }),
    }),
  );
}

// 「画面」面板：比例和分辨率放在一起。
function drawFrame() {
  const allowed = resolutionsFor(form.model);
  const ratios = ratiosFor(form.model);
  add(
    clear(els.frame),
    h('div', { class: 'popover-title' }, '画面比例'),
    h(
      'div',
      { class: 'ratio-grid', role: 'radiogroup', 'aria-label': '画面比例' },
      RATIOS.map((r) =>
        h(
          'button',
          { type: 'button', class: `ratio-option ${form.ratio === r.value ? 'active' : ''}`, role: 'radio', 'aria-checked': String(form.ratio === r.value), disabled: !ratios.includes(r.value), onClick: () => update({ ratio: r.value }) },
          h('span', { class: 'ratio-box' }, ratioShape(r.value)),
          h('span', null, r.label),
        ),
      ),
    ),
    h('div', { class: 'popover-title' }, '分辨率'),
    segmented(
      RESOLUTIONS.map((r) => ({ value: r, label: r, disabled: !allowed.includes(r) })),
      form.resolution,
      (resolution) => update({ resolution }),
    ),
    allowed.length < RESOLUTIONS.length && h('div', { class: 'small muted' }, `${form.model} 不支持 1080p`),
    isGrok() && form.mode === 'frames' && h('div', { class: 'small muted' }, '图生视频时，画面比例跟着首帧走'),
  );
  popovers.frame?.place();
}

function numberInput(value, onInput, attrs = {}) {
  return h('input', { class: 'input', type: 'number', inputmode: 'numeric', value: String(value ?? ''), onInput: (e) => onInput(e.target.value), ...attrs });
}

// 「更多」面板：不常改的设置都收在这里。
function drawMore() {
  const refresh = () => drawSend();
  const live = () => {
    submitError = '';
    persist();
    refresh();
  };
  const sr = form.sr;
  const setSr = (patch, redraw = drawMore) => {
    form.sr = { ...form.sr, ...patch };
    fitSrTarget();
    submitError = '';
    persist();
    redraw();
    refresh();
  };

  const seedInput = numberInput(form.seed, (v) => { form.seed = v; live(); }, { placeholder: '留空则每次随机', step: '1', 'aria-label': '随机种子' });
  const randomSeed = () => {
    form.seed = String(Math.floor(Math.random() * 2147483647));
    seedInput.value = form.seed;
    live();
  };

  add(
    clear(els.more),
    h('div', { class: 'popover-title' }, '输出'),
    formRow('同步音频', toggle(form.generateAudio, (v) => update({ generateAudio: v }, refresh), '同步音频'), '同时生成与画面同步的声音'),
    formRow('水印', toggle(form.watermark, (v) => update({ watermark: v }, refresh), '水印')),
    h('div', { class: 'popover-title' }, '高级'),
    formRow('随机种子', h('div', { class: 'row' }, seedInput, h('button', { class: 'btn', type: 'button', onClick: randomSeed }, '随机'))),
    formRow('联网搜索增强', toggle(form.webSearch, (v) => update({ webSearch: v }, refresh), '联网搜索增强'), '让任务先联网检索相关信息'),
    formRow(
      '输入模式',
      dropdown({ label: '输入模式', value: form.inputType, options: INPUT_TYPES, onChange: (inputType) => update({ inputType }, () => { drawMore(); refresh(); }) }),
    ),
    formRow('画质超分', toggle(sr.enabled, (enabled) => setSr({ enabled }), '画质超分'), '生成后再提升分辨率或帧率'),
    sr.enabled &&
      h(
        'div',
        { class: 'sub-panel' },
        formRow('目标', segmented([{ value: 'resolution', label: '目标分辨率' }, { value: 'limit', label: '短边像素' }], sr.by, (by) => setSr({ by }))),
        sr.by === 'resolution'
          ? formRow(
              '目标分辨率',
              segmented(
                SR_RESOLUTIONS.map((r) => ({ value: r, label: r.toUpperCase().replace('P', 'p'), disabled: RES_RANK[r] <= RES_RANK[form.resolution] })),
                sr.resolution,
                (resolution) => setSr({ resolution }),
              ),
              '必须高于原始分辨率',
            )
          : formRow('短边像素', numberInput(sr.limit, (v) => setSr({ limit: v }, () => {}), { min: '64', max: '2160', step: '1', placeholder: '64 – 2160', 'aria-label': '短边像素' })),
        formRow('场景', dropdown({ label: '场景', value: sr.scene, options: SR_SCENES, onChange: (scene) => setSr({ scene }) })),
        formRow('超分模式', segmented([{ value: 'standard', label: '标准' }, { value: 'professional', label: '专业' }], sr.tool, (tool) => setSr({ tool }))),
        formRow('输出帧率', numberInput(sr.fps, (v) => setSr({ fps: v }, () => {}), { min: '1', max: '120', step: '1', placeholder: '不改（1 – 120）', 'aria-label': '输出帧率' })),
      ),
  );
  popovers.more?.place();
}

// ---------- 音色 ----------

async function ensureVoices() {
  if (state.voices || !state.app.hasKey) return;
  voicesError = '';
  try {
    await loadVoices();
  } catch (err) {
    voicesError = err.message;
  }
  // 还没选过音色：有中文音色就先用第一个中文的，朗读中文最自然。
  if (state.voices?.length && !state.voices.some((v) => v.id === studio.speech.voiceId)) {
    const first = state.voices.find((v) => v.language === 'zh') || state.voices[0];
    Object.assign(studio.speech, { voiceId: first.id, voiceName: voiceName(first) });
    persist();
  }
  if (els && studio.type === 'speech') drawAll();
}

// 音色的名字是「名字 - 一句描述」，前半截当名字，后半截当附注。
const voiceName = (voice) => voice.name.split(/\s[-–]\s/)[0];
const voiceNote = (voice) => [VOICE_GENDERS[voice.gender], VOICE_LANGUAGES[voice.language] || voice.language.toUpperCase(), voice.name.split(/\s[-–]\s/)[1]].filter(Boolean).join(' · ');

function stopPreview() {
  preview.pause();
  previewing = '';
}
preview.addEventListener('ended', () => {
  previewing = '';
  if (popovers.voice) drawVoices();
});

function togglePreview(voice) {
  if (previewing === voice.id) {
    stopPreview();
  } else {
    preview.src = voice.previewUrl;
    preview.play().catch(() => toast('这个音色的试听播放不了', 'error'));
    previewing = voice.id;
  }
  drawVoices();
}

// 「音色」面板：按语言筛一下，每个音色可以先试听再选。
function drawVoices() {
  const root = clear(els.voices);
  if (!state.voices) {
    root.append(h('div', { class: 'empty small-empty' }, voicesError ? `读取音色失败：${voicesError}` : '正在读取音色…'));
    popovers.voice?.place();
    return;
  }
  const match = { all: () => true, zh: (v) => v.language === 'zh', en: (v) => v.language === 'en', other: (v) => v.language !== 'zh' && v.language !== 'en' };
  add(
    root,
    segmented(
      [
        { value: 'all', label: '全部' },
        { value: 'zh', label: '中文' },
        { value: 'en', label: '英语' },
        { value: 'other', label: '其他' },
      ],
      voiceFilter,
      (next) => {
        voiceFilter = next;
        drawVoices();
      },
    ),
    h(
      'div',
      { class: 'voice-list', role: 'listbox', 'aria-label': '音色' },
      state.voices.filter(match[voiceFilter]).map((voice) => {
        const selected = voice.id === studio.speech.voiceId;
        return h(
          'div',
          { class: `voice-row ${selected ? 'selected' : ''}` },
          h(
            'button',
            {
              class: 'voice-pick',
              type: 'button',
              role: 'option',
              'aria-selected': String(selected),
              onClick: () => {
                stopPreview();
                updateStudio('speech', { voiceId: voice.id, voiceName: voiceName(voice) });
                popovers.voice?.close();
              },
            },
            h('span', { class: 'voice-name' }, voiceName(voice)),
            h('span', { class: 'voice-note ellipsis', clipTitle: voiceNote(voice) }, voiceNote(voice)),
          ),
          voice.previewUrl && h('button', { class: 'entry-action-btn', type: 'button', onClick: () => togglePreview(voice) }, previewing === voice.id ? '停止' : '试听'),
          h('span', { class: 'menu-item-check' }, selected && icon('check', 14)),
        );
      }),
    ),
  );
  popovers.voice?.place();
}

// ---------- 润色、提交 ----------

function setPrompt(text) {
  draft().prompt = text;
  els.prompt.value = text;
  submitError = '';
  autoGrow();
  persist();
  drawSend();
}

// 让文本模型把提示词补充得更具体。结果直接替换输入框里的文字，可以撤销。
async function polish() {
  const type = studio.type;
  const original = draft().prompt;
  if (!original.trim()) return toast('先写几个字，再让它补充', 'info');
  polishing = true;
  drawSend();
  try {
    const wanted = polishModel();
    const { text, model } = await api('POST', '/api/polish', { text: original, kind: type, model: wanted });
    // 等结果的时候用户换了类型或者又改了文字，就不去覆盖。
    if (studio.type === type && draft().prompt === original) {
      beforePolish = original;
      setPrompt(text);
      if (model !== wanted) toast(`${wanted} 暂时用不了，这次是 ${model} 润色的`, 'info', 5000);
    }
  } catch (err) {
    toast(err.message, 'error', 6000);
  } finally {
    polishing = false;
    drawSend();
  }
}

function undoPolish() {
  const original = beforePolish;
  beforePolish = null;
  setPrompt(original);
}

// 右下角：润色（有提示词的类型才有）和发送键。发送键不能提交时变淡，鼠标停上去或点一下都会说明原因。
function drawSend() {
  const root = clear(els.send);
  if (!state.app.hasKey) {
    root.append(h('button', { class: 'btn btn-primary btn-sm', type: 'button', onClick: openSettings }, '设置 API Key'));
    return;
  }
  const type = typeOf();
  const blocked = currentRequest().problems[0] || '';
  add(
    root,
    type.polish &&
      state.catalog.polish.length > 0 &&
      (beforePolish !== null
        ? h('button', { class: 'entry-action-btn', type: 'button', 'data-control': 'polish', onClick: undoPolish }, '撤销润色')
        : h('button', { class: 'entry-action-btn', type: 'button', 'data-control': 'polish', title: `让 ${polishModel()} 把提示词补充得更具体`, disabled: polishing, onClick: polish }, polishing && h('span', { class: 'spinner' }), '润色')),
    h(
      'button',
      {
        class: `send-btn ${blocked ? 'blocked' : ''}`,
        type: 'button',
        title: blocked || submitError || `${type.action}（⌘ Enter）`,
        'aria-label': type.action,
        'aria-disabled': blocked ? 'true' : null,
        disabled: submitting,
        onClick: submit,
      },
      submitting ? h('span', { class: 'spinner' }) : icon('arrowUp', 18),
    ),
  );
}

function autoGrow() {
  els.prompt.style.height = 'auto';
  els.prompt.style.height = `${Math.min(280, Math.max(72, els.prompt.scrollHeight))}px`;
}

// 上面的问句和类型切换。读到模型列表后，账号用不了的类型不能选。
function drawHead() {
  const { known, image, audio } = state.catalog;
  const missing = { image: known && !image.length, speech: known && !audio.speech, sfx: known && !audio.sfx, music: known && !audio.music };
  els.title.textContent = typeOf().title;
  clear(els.types).append(
    segmented(
      TYPES.map((t) => ({ value: t.value, label: t.label, disabled: missing[t.value] && t.value !== studio.type, title: missing[t.value] ? '这个账号没有对应的模型' : null })),
      studio.type,
      setType,
      'type-switch',
    ),
  );
}

// 素材状态变化时只重画会受影响的部分。
function drawDynamic() {
  drawMedia();
  drawSend();
  syncWatches();
}

function drawAll() {
  const type = typeOf();
  const text = draft().prompt || '';
  drawHead();
  drawMedia();
  els.prompt.hidden = !type.placeholder;
  els.prompt.placeholder = type.placeholder || '';
  els.prompt.setAttribute('aria-label', type.value === 'speech' ? '要朗读的文字' : '提示词');
  if (els.prompt.value !== text) els.prompt.value = text;
  autoGrow();
  drawToolbar();
  if (type.value === 'video') {
    drawFrame();
    drawMore();
  }
  if (type.value === 'speech') drawVoices();
  drawSend();
  syncWatches();
}

function syncWatches() {
  state.watchedPersons.clear();
  for (const ref of allRefs()) {
    if (ref.source !== 'asset') continue;
    if (ref.personId) state.watchedPersons.add(ref.personId);
    else if (!findAsset(ref.assetId)) refreshAsset(ref.assetId).catch(() => {});
  }
  refSignature = allRefs().map((r) => `${r.uid}:${refStatus(r).label}`).join('|');
}

async function submit() {
  const type = studio.type;
  const request = currentRequest();
  if (request.problems.length) return toast(request.problems[0], 'info');
  submitting = true;
  submitError = '';
  drawSend();
  try {
    if (type === 'video') await api('POST', '/api/videos', { payload: request.payload, form });
    else if (type === 'image') await api('POST', '/api/images', { payload: request.payload, form: { type, ...studio.image } });
    else await api('POST', `/api/audio/${type}`, { ...request.body, form: { type, ...studio[type] } });
    toast('已提交，正在生成', 'success');
    startHistoryLoop();
  } catch (err) {
    submitError = err.message;
    toast(err.message, 'error', 6000);
  } finally {
    submitting = false;
    drawSend();
  }
}

export function focusComposer() {
  if (els && !els.prompt.hidden) els.prompt.focus();
}

function panelButton(name, label, content, className, children, onClose) {
  const button = h(
    'button',
    {
      class: 'dropdown dropdown-tool',
      type: 'button',
      'data-control': name,
      'aria-haspopup': 'dialog',
      'aria-expanded': 'false',
      'aria-label': label,
      onClick: () => {
        const layer = openPopover(button, content, {
          className,
          label,
          onClose: () => {
            popovers[name] = null;
            onClose?.();
          },
        });
        popovers[name] = layer;
      },
    },
    children,
  );
  return button;
}

export function renderComposer(root) {
  els = {
    title: h('h1', { class: 'composer-title' }),
    types: h('div', { class: 'composer-types' }),
    media: h('div', { class: 'media-block' }),
    params: h('div', { class: 'composer-params' }),
    send: h('div', { class: 'composer-send' }),
    frame: h('div', { class: 'popover-body' }),
    more: h('div', { class: 'popover-body' }),
    voices: h('div', { class: 'popover-body' }),
  };
  els.prompt = h('textarea', {
    class: 'prompt',
    rows: '3',
    value: draft().prompt || '',
    onInput: (e) => {
      draft().prompt = e.target.value;
      // 用户自己动了文字，润色前的原文就不再留着，「撤销润色」变回「润色」。
      beforePolish = null;
      submitError = '';
      autoGrow();
      persist();
      drawSend();
    },
    onKeydown: (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        if (state.app.hasKey && !submitting) submit();
      }
    },
  });
  els.frameButton = panelButton('frame', '画面', els.frame, 'frame-popover');
  els.moreButton = panelButton('more', '更多设置', els.more, 'more-popover', [icon('sliders'), h('span', null, '更多')]);
  els.voiceButton = panelButton('voice', '音色', els.voices, 'voice-popover', null, stopPreview);

  root.append(h('section', { class: 'composer' }, els.title, els.types, h('div', { class: 'composer-card' }, els.media, els.prompt, h('div', { class: 'composer-bar' }, els.params, els.send))));

  if (!state.models.includes(form.model) && state.modelsInfo.source === 'remote') form.model = state.models[0];
  fitModel();
  drawAll();
  if (studio.type === 'speech') ensureVoices();

  on('app', () => {
    drawSend();
    if (studio.type === 'speech') ensureVoices();
  });
  on('models', () => {
    const info = state.modelsInfo;
    if (info.source === 'remote' && !state.models.includes(form.model)) {
      form.model = state.models[0];
      fitModel();
      persist();
    }
    if (state.catalog.image.length && !state.catalog.image.includes(studio.image.model)) {
      studio.image.model = state.catalog.image[0];
      persist();
    }
    if (state.app.hasKey && info.source === 'default' && info.error) toast(`没能读到账号的模型列表，暂时显示默认型号。${info.error}`, 'error', 6000);
    drawAll();
  });
  on('assets', () => {
    const next = allRefs().map((r) => `${r.uid}:${refStatus(r).label}`).join('|');
    if (next !== refSignature) drawDynamic();
  });
}
