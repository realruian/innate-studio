// 创作输入框：参考素材、提示词、一排工具栏（生成方式、模型、画面、时长、更多），以及提交。
// 把表单拼成 Seedance 请求的逻辑在 request.js。

import { h, icon, add, toast, clear, segmented, toggle, dropdown, formRow, openPopover, openMenu } from './dom.js';
import { api, state, on, KINDS, findAsset, assetReadiness, refreshAsset, startHistoryLoop } from './store.js';
import { openAssetPicker, thumbEl } from './assets.js';
import { openSettings } from './settings.js';
import { buildRequest as buildPayload, refsInUse, RES_RANK } from './request.js';

const FORM_KEY = 'seedance-studio.form.v1';

const RESOLUTIONS = ['480p', '720p', '1080p'];
const RATIOS = [
  { value: '16:9', label: '16:9', w: 16, h: 9 },
  { value: '4:3', label: '4:3', w: 4, h: 3 },
  { value: '1:1', label: '1:1', w: 1, h: 1 },
  { value: '3:4', label: '3:4', w: 3, h: 4 },
  { value: '9:16', label: '9:16', w: 9, h: 16 },
  { value: '21:9', label: '21:9', w: 21, h: 9 },
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
const MODEL_NOTES = { 'seedance-2.0': '专业模型', 'seedance-2.0-fast': '快速模型' };
const INPUT_TYPES = [
  { value: 'auto', label: '自动判断', note: '推荐' },
  { value: 'reference', label: 'reference', note: '参考' },
  { value: 'first_last_frame', label: 'first_last_frame', note: '首尾帧' },
];
const REF_PREFIX = { image: '图', video: '视频', audio: '音频' };

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

function loadForm() {
  try {
    return mergeForm(JSON.parse(localStorage.getItem(FORM_KEY)));
  } catch {
    return defaults();
  }
}

let form = loadForm();
let els = null;
let submitting = false;
let submitError = '';
let saveTimer = null;
let refSignature = '';
const popovers = { frame: null, more: null };

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(FORM_KEY, JSON.stringify(form));
    } catch {
      /* 存不下就不存，不影响使用 */
    }
  }, 300);
}

// seedance-2.5 文档写明只支持 480p / 720p。
const resolutionsFor = (model) => (/^seedance-2\.5/.test(model) ? ['480p', '720p'] : RESOLUTIONS);

const allRefs = (f = form) => refsInUse(f);
const usedAssetIds = () => allRefs().map((r) => r.assetId).filter(Boolean);

function refStatus(ref) {
  if (ref.source === 'url') return { ready: true, tone: 'ok', label: '链接' };
  return assetReadiness(findAsset(ref.assetId), form.model);
}

// 当前表单对应的请求体，以及不能提交的原因。
export function buildRequest(f = form) {
  return buildPayload(f, refStatus);
}

// 「更多」里有没有偏离默认值的设置，用来在入口上给一个提示点。
const moreActive = () => !form.generateAudio || form.watermark || String(form.seed).trim() !== '' || form.webSearch || form.inputType !== 'auto' || form.sr.enabled;

// 超分的目标必须高于原始分辨率；不满足时自动换到更高的最近一档，免得用户被一条看不见的校验卡住。
function fitSrTarget() {
  if (!form.sr.enabled || form.sr.by !== 'resolution') return;
  if (RES_RANK[form.sr.resolution] > RES_RANK[form.resolution]) return;
  const next = SR_RESOLUTIONS.find((r) => RES_RANK[r] > RES_RANK[form.resolution]);
  if (next) form.sr = { ...form.sr, resolution: next };
}

function update(patch, redraw = drawAll) {
  Object.assign(form, patch);
  fitSrTarget();
  submitError = '';
  persist();
  redraw();
}

export function setForm(next) {
  form = mergeForm(JSON.parse(JSON.stringify(next)));
  if (!state.models.includes(form.model) && state.models.length) form.model = state.models[0];
  if (!resolutionsFor(form.model).includes(form.resolution)) form.resolution = '720p';
  submitError = '';
  persist();
  if (els) drawAll();
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

function drawMedia() {
  const root = clear(els.media);
  root.hidden = form.mode === 'text';

  if (form.mode === 'frames') {
    const slot = (key, label) => {
      const ref = form.frames[key];
      const setRef = (value) => update({ frames: { ...form.frames, [key]: value } }, drawDynamic);
      const empty = h(
        'button',
        { class: 'ref-tile ref-add', type: 'button', 'aria-label': `添加${label}`, onClick: () => openAssetPicker({ kind: 'image', remaining: 1, usedIds: usedAssetIds(), onPick: setRef }) },
        '+',
      );
      return h('div', { class: 'frame-slot' }, ref ? refTile(ref, null, () => setRef(null)) : empty, h('span', { class: 'small muted' }, label));
    };
    root.append(h('div', { class: 'frames-row' }, slot('first', '首帧'), h('span', { class: 'frames-arrow' }, '→'), slot('last', '尾帧（可选）')));
    return;
  }

  if (form.mode === 'reference') {
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
}

// ---------- 工具栏 ----------

function ratioShape(value) {
  const ratio = RATIOS.find((r) => r.value === value);
  if (!ratio?.w) return h('span', { class: 'ratio-shape ratio-auto' });
  const scale = 14 / Math.max(ratio.w, ratio.h);
  return h('span', { class: 'ratio-shape', style: { width: `${Math.max(6, Math.round(ratio.w * scale))}px`, height: `${Math.max(6, Math.round(ratio.h * scale))}px` } });
}

function drawToolbar() {
  const mode = MODES.find((m) => m.value === form.mode) || MODES[0];
  const ratio = RATIOS.find((r) => r.value === form.ratio) || RATIOS[0];
  const models = state.models.includes(form.model) ? state.models : [form.model, ...state.models];

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
      options: MODES.map((m) => ({ value: m.value, label: m.label, note: m.note })),
      onChange: (value) => update({ mode: value }),
    }),
    dropdown({
      variant: 'tool',
      control: 'model',
      icon: 'cube',
      label: '模型',
      value: form.model,
      options: models.map((m) => ({ value: m, label: m, note: MODEL_NOTES[m] })),
      onChange: (model) => {
        const patch = { model };
        if (!resolutionsFor(model).includes(form.resolution)) patch.resolution = '720p';
        update(patch);
      },
    }),
    els.frameButton,
    dropdown({
      variant: 'tool',
      control: 'duration',
      icon: 'clock',
      label: '时长',
      value: form.durationAuto ? 'auto' : String(form.duration),
      options: [...DURATIONS.map((d) => ({ value: String(d), label: `${d} 秒` })), { value: 'auto', label: '由模型决定', display: '时长自动' }],
      onChange: (value) => update(value === 'auto' ? { durationAuto: true } : { durationAuto: false, duration: Number(value) }),
    }),
    els.moreButton,
  );
}

// 「画面」面板：比例和分辨率放在一起。
function drawFrame() {
  const allowed = resolutionsFor(form.model);
  add(
    clear(els.frame),
    h('div', { class: 'popover-title' }, '画面比例'),
    h(
      'div',
      { class: 'ratio-grid', role: 'radiogroup', 'aria-label': '画面比例' },
      RATIOS.map((r) =>
        h(
          'button',
          { type: 'button', class: `ratio-option ${form.ratio === r.value ? 'active' : ''}`, role: 'radio', 'aria-checked': String(form.ratio === r.value), onClick: () => update({ ratio: r.value }) },
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

// 发送键：不能提交时变淡，鼠标停上去或点一下都会说明原因。
function drawSend() {
  els.moreDot.hidden = !moreActive();
  const root = clear(els.send);
  if (!state.app.hasKey) {
    root.append(h('button', { class: 'btn btn-primary btn-sm', type: 'button', onClick: openSettings }, '设置 API Key'));
    return;
  }
  const blocked = buildRequest().problems[0] || '';
  root.append(
    h(
      'button',
      {
        class: `send-btn ${blocked ? 'blocked' : ''}`,
        type: 'button',
        title: blocked || submitError || '生成视频（⌘ Enter）',
        'aria-label': '生成视频',
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

// 素材状态变化时只重画会受影响的部分。
function drawDynamic() {
  drawMedia();
  drawSend();
  syncWatches();
}

function drawAll() {
  drawMedia();
  if (els.prompt.value !== form.prompt) els.prompt.value = form.prompt;
  autoGrow();
  drawToolbar();
  drawFrame();
  drawMore();
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
  const { payload, problems } = buildRequest();
  if (problems.length) return toast(problems[0], 'info');
  submitting = true;
  submitError = '';
  drawSend();
  try {
    await api('POST', '/api/videos', { payload, form });
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
  els?.prompt.focus();
}

function panelButton(name, label, content, className, children) {
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
        const layer = openPopover(button, content, { className, label, onClose: () => { popovers[name] = null; } });
        popovers[name] = layer;
      },
    },
    children,
  );
  return button;
}

export function renderComposer(root) {
  els = {
    media: h('div', { class: 'media-block' }),
    params: h('div', { class: 'composer-params' }),
    send: h('div', { class: 'composer-send' }),
    frame: h('div', { class: 'popover-body' }),
    more: h('div', { class: 'popover-body' }),
    moreDot: h('span', { class: 'more-dot', hidden: true }),
  };
  els.prompt = h('textarea', {
    class: 'prompt',
    rows: '3',
    'aria-label': '提示词',
    placeholder: '描述你想生成的视频：主体、动作、场景、镜头运动、光线和风格',
    value: form.prompt,
    onInput: (e) => {
      form.prompt = e.target.value;
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
  els.moreButton = panelButton('more', '更多设置', els.more, 'more-popover', [icon('sliders'), h('span', null, '更多'), els.moreDot]);

  root.append(
    h(
      'section',
      { class: 'composer' },
      h('h1', { class: 'composer-title' }, '想生成什么视频？'),
      h('div', { class: 'composer-card' }, els.media, els.prompt, h('div', { class: 'composer-bar' }, els.params, els.send)),
    ),
  );

  if (!state.models.includes(form.model) && state.modelsInfo.source === 'remote') form.model = state.models[0];
  drawAll();

  on('app', drawSend);
  on('models', () => {
    const info = state.modelsInfo;
    if (info.source === 'remote' && !state.models.includes(form.model)) {
      form.model = state.models[0];
      if (!resolutionsFor(form.model).includes(form.resolution)) form.resolution = '720p';
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
