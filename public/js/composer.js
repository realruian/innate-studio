// 创作面板：模式、参考素材、提示词、参数，以及把表单拼成 Seedance 请求。

import { h, icon, toast, clear, segmented, toggle } from './dom.js';
import { api, state, on, KINDS, findAsset, assetReadiness, refreshAsset, startHistoryLoop } from './store.js';
import { openAssetPicker, thumbEl } from './assets.js';
import { openSettings } from './settings.js';
import { buildRequest as buildPayload, refsInUse, RES_RANK } from './request.js';

const FORM_KEY = 'seedance-studio.form.v1';

const RESOLUTIONS = ['480p', '720p', '1080p'];
const RATIOS = [
  { value: '16:9', label: '16:9' },
  { value: '4:3', label: '4:3' },
  { value: '1:1', label: '1:1' },
  { value: '3:4', label: '3:4' },
  { value: '9:16', label: '9:16' },
  { value: '21:9', label: '21:9' },
  { value: 'adaptive', label: '比例自适应' },
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
  { value: 'text', label: '文生视频', hint: '只用文字描述画面。' },
  { value: 'frames', label: '首尾帧', hint: '指定视频的第一帧，尾帧可选；模型在两帧之间生成过渡。' },
  { value: 'reference', label: '参考生成', hint: '用图片、视频、音频作参考：图片最多 9 张，视频和音频各最多 3 段。' },
];
const MODEL_NOTES = { 'seedance-2.0': '专业模型', 'seedance-2.0-fast': '快速模型' };

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
let submitting = false;
let submitError = '';
let saveTimer = null;
let previewOpen = false;
let advancedOpen = false;

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

// ---------- 渲染 ----------

let els = null;

export function setForm(next) {
  form = mergeForm(JSON.parse(JSON.stringify(next)));
  if (!state.models.includes(form.model) && state.models.length) form.model = state.models[0];
  if (!resolutionsFor(form.model).includes(form.resolution)) form.resolution = '720p';
  submitError = '';
  persist();
  if (els) drawAll();
}

function update(patch, redraw = drawAll) {
  Object.assign(form, patch);
  submitError = '';
  persist();
  redraw();
}

function field(label, control, aside) {
  return h('div', { class: 'field' }, h('div', { class: 'field-head' }, h('span', { class: 'field-label' }, label), aside), control);
}

function refTile(ref, label, onRemove) {
  const s = refStatus(ref);
  return h(
    'div',
    { class: `ref-tile tone-${s.tone}`, title: ref.name },
    thumbEl(ref.thumb, ref.kind),
    label && h('span', { class: 'ref-index' }, label),
    !s.ready && h('span', { class: `ref-state ${s.tone === 'error' ? 'is-error' : 'cursor-text'}` }, s.label),
    h('button', { class: 'ref-remove', type: 'button', title: '移除', onClick: onRemove }, '×'),
  );
}

function addTile(onClick) {
  return h('button', { class: 'ref-tile ref-add', type: 'button', 'aria-label': '添加素材', onClick }, '+');
}

function drawMedia() {
  const root = clear(els.media);
  root.hidden = form.mode === 'text';
  if (form.mode === 'frames') {
    const slot = (key, label) => {
      const ref = form.frames[key];
      const setRef = (value) => update({ frames: { ...form.frames, [key]: value } }, drawDynamic);
      return h(
        'div',
        { class: 'frame-slot' },
        ref
          ? refTile(ref, null, () => setRef(null))
          : addTile(() => openAssetPicker({ kind: 'image', remaining: 1, usedIds: usedAssetIds(), onPick: setRef })),
        h('span', { class: 'small muted' }, label),
      );
    };
    root.append(
      field(
        '首尾帧图片',
        h('div', { class: 'frames-row' }, slot('first', '首帧'), h('span', { class: 'frames-arrow' }, '→'), slot('last', '尾帧（可选）')),
      ),
    );
    return;
  }
  if (form.mode === 'reference') {
    const prefix = { image: '图', video: '视频', audio: '音频' };
    for (const [kind, meta] of Object.entries(KINDS)) {
      const list = form.refs[kind];
      const setList = (next) => update({ refs: { ...form.refs, [kind]: next } }, drawDynamic);
      root.append(
        field(
          `参考${meta.label}`,
          h(
            'div',
            { class: 'ref-row' },
            list.map((ref, i) => refTile(ref, `${prefix[kind]}${i + 1}`, () => setList(form.refs[kind].filter((r) => r.uid !== ref.uid)))),
            list.length < meta.max &&
              addTile(() =>
                openAssetPicker({
                  kind,
                  remaining: meta.max - form.refs[kind].length,
                  usedIds: usedAssetIds(),
                  onPick: (ref) => setList([...form.refs[kind], ref].slice(0, meta.max)),
                }),
              ),
          ),
          h('span', { class: 'small muted' }, `${list.length} / ${meta.max}`),
        ),
      );
    }
  }
}

function pillSelect(label, value, options, onChange) {
  return h(
    'label',
    { class: 'pill-select', title: label },
    h(
      'select',
      { 'aria-label': label, onChange: (e) => onChange(e.target.value) },
      options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(value), disabled: o.disabled }, o.label)),
    ),
  );
}

function toggleChip(label, pressed, onChange) {
  return h(
    'button',
    { type: 'button', class: `chip-toggle ${pressed ? 'on' : ''}`, 'aria-pressed': String(pressed), onClick: () => onChange(!pressed) },
    h('span', { class: 'chip-dot' }),
    label,
  );
}

function drawParams() {
  const root = clear(els.params);
  const models = state.models.includes(form.model) ? state.models : [form.model, ...state.models];
  const allowed = resolutionsFor(form.model);

  root.append(
    pillSelect('模型', form.model, models.map((m) => ({ value: m, label: MODEL_NOTES[m] ? `${m} · ${MODEL_NOTES[m]}` : m })), (model) => {
      const patch = { model };
      if (!resolutionsFor(model).includes(form.resolution)) patch.resolution = '720p';
      update(patch, drawAll);
    }),
    pillSelect(
      '分辨率',
      form.resolution,
      RESOLUTIONS.map((r) => ({ value: r, label: r, disabled: !allowed.includes(r) })),
      (resolution) => update({ resolution }, drawAll),
    ),
    pillSelect('画面比例', form.ratio, RATIOS, (ratio) => update({ ratio }, drawParams)),
    pillSelect(
      '时长',
      form.durationAuto ? 'auto' : String(form.duration),
      [...DURATIONS.map((d) => ({ value: String(d), label: `${d} 秒` })), { value: 'auto', label: '时长自动' }],
      (value) => update(value === 'auto' ? { durationAuto: true } : { durationAuto: false, duration: Number(value) }, drawParams),
    ),
    toggleChip('音频', form.generateAudio, (value) => update({ generateAudio: value }, drawParams)),
    toggleChip('水印', form.watermark, (value) => update({ watermark: value }, drawParams)),
  );
  drawPreview();
}

function numberInput(value, onInput, attrs = {}) {
  return h('input', { class: 'input', type: 'number', inputmode: 'numeric', value: String(value ?? ''), onInput: (e) => onInput(e.target.value), ...attrs });
}

function drawAdvanced() {
  const root = clear(els.advanced);
  const live = () => {
    submitError = '';
    persist();
    drawFooter();
    drawPreview();
  };

  const seedInput = numberInput(form.seed, (v) => { form.seed = v; live(); }, { placeholder: '留空则每次随机', step: '1' });
  root.append(
    field(
      '随机种子',
      h(
        'div',
        { class: 'row' },
        seedInput,
        h('button', { class: 'btn', type: 'button', title: '随机生成一个种子', onClick: () => { form.seed = String(Math.floor(Math.random() * 2147483647)); seedInput.value = form.seed; live(); } }, '随机'),
      ),
    ),
    h(
      'div',
      { class: 'switch-list' },
      h('div', { class: 'switch-row' }, h('div', null, h('div', null, '联网搜索增强'), h('div', { class: 'small muted' }, '让任务先联网检索相关信息')), toggle(form.webSearch, (v) => update({ webSearch: v }, drawPreview), '联网搜索增强')),
    ),
    field(
      '输入模式',
      h(
        'select',
        { class: 'input', onChange: (e) => update({ inputType: e.target.value }, drawPreview) },
        [
          ['auto', '自动判断（推荐）'],
          ['reference', 'reference（参考）'],
          ['first_last_frame', 'first_last_frame（首尾帧）'],
        ].map(([value, label]) => h('option', { value, selected: form.inputType === value }, label)),
      ),
    ),
  );

  const sr = form.sr;
  const setSr = (patch, redraw = drawAdvanced) => {
    form.sr = { ...form.sr, ...patch };
    submitError = '';
    persist();
    redraw();
    drawFooter();
    drawPreview();
  };
  const srBody = h('div', { class: 'sub-panel', hidden: !sr.enabled });
  if (sr.enabled) {
    srBody.append(
      field('目标', segmented([{ value: 'resolution', label: '目标分辨率' }, { value: 'limit', label: '短边像素' }], sr.by, (by) => setSr({ by }))),
      sr.by === 'resolution'
        ? segmented(
            SR_RESOLUTIONS.map((r) => ({ value: r, label: r.toUpperCase().replace('P', 'p'), disabled: RES_RANK[r] <= RES_RANK[form.resolution], title: RES_RANK[r] <= RES_RANK[form.resolution] ? '必须高于原始分辨率' : '' })),
            sr.resolution,
            (resolution) => setSr({ resolution }),
          )
        : numberInput(sr.limit, (v) => setSr({ limit: v }, () => {}), { min: '64', max: '2160', step: '1', placeholder: '64 – 2160' }),
      field(
        '场景',
        h('select', { class: 'input', onChange: (e) => setSr({ scene: e.target.value }, () => {}) }, SR_SCENES.map((s) => h('option', { value: s.value, selected: sr.scene === s.value }, s.label))),
      ),
      field('超分模式', segmented([{ value: 'standard', label: '标准' }, { value: 'professional', label: '专业' }], sr.tool, (tool) => setSr({ tool }))),
      field('输出帧率', numberInput(sr.fps, (v) => setSr({ fps: v }, () => {}), { min: '1', max: '120', step: '1', placeholder: '留空则不改帧率（1 – 120）' })),
    );
  }
  root.append(
    h(
      'div',
      { class: 'switch-list' },
      h('div', { class: 'switch-row' }, h('div', null, h('div', null, '画质超分'), h('div', { class: 'small muted' }, '生成后再提升分辨率或帧率')), toggle(sr.enabled, (enabled) => setSr({ enabled }), '画质超分')),
    ),
    srBody,
    h(
      'details',
      { class: 'preview', open: previewOpen, onToggle: (e) => { previewOpen = e.target.open; } },
      h('summary', null, '查看将要发送的请求'),
      (els.preview = h('pre', { class: 'code' })),
    ),
  );
  drawPreview();
}

function drawPreview() {
  if (els.preview) els.preview.textContent = JSON.stringify(buildRequest().payload, null, 2);
}

function drawFooter() {
  const { problems } = buildRequest();
  const info = state.modelsInfo;
  let hint = '⌘ Enter 生成';
  let tone = '';
  if (!state.app.hasKey) {
    hint = '还没有设置 API Key';
    tone = 'warn';
  } else if (submitError) {
    hint = submitError;
    tone = 'error';
  } else if (problems.length) {
    hint = problems[0];
  } else if (info.source === 'default' && (info.error || info.note)) {
    hint = '未读到账号的模型列表，显示的是默认型号';
    tone = 'warn';
  }
  els.hint.className = `composer-hint ${tone}`;
  els.hint.textContent = hint;
  els.hint.title = hint;

  const root = clear(els.footer);
  if (!state.app.hasKey) {
    root.append(h('button', { class: 'btn btn-primary btn-sm', type: 'button', onClick: openSettings }, '设置 API Key'));
    return;
  }
  root.append(
    h(
      'button',
      { class: 'send-btn', type: 'button', title: '生成视频', 'aria-label': '生成视频', disabled: submitting || problems.length > 0, onClick: submit },
      submitting ? h('span', { class: 'spinner' }) : icon('arrowUp', 18),
    ),
  );
}

function drawModes() {
  const mode = MODES.find((m) => m.value === form.mode);
  clear(els.modes).append(
    segmented(MODES.map((m) => ({ value: m.value, label: m.label })), form.mode, (value) => update({ mode: value }, drawAll), 'mode-tabs'),
    h('span', { class: 'mode-hint' }, mode.hint),
  );
}

function autoGrow() {
  els.prompt.style.height = 'auto';
  els.prompt.style.height = `${Math.min(280, Math.max(72, els.prompt.scrollHeight))}px`;
}

// 素材状态变化时只重画会受影响的部分。
function drawDynamic() {
  drawMedia();
  drawFooter();
  drawPreview();
  syncWatches();
}

function drawAll() {
  drawModes();
  drawMedia();
  if (els.prompt.value !== form.prompt) els.prompt.value = form.prompt;
  autoGrow();
  els.count.textContent = `${form.prompt.length} 字`;
  drawParams();
  drawAdvanced();
  drawFooter();
  syncWatches();
}

let refSignature = '';

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
  if (problems.length) return toast(problems[0], 'error');
  submitting = true;
  submitError = '';
  drawFooter();
  try {
    await api('POST', '/api/videos', { payload, form });
    toast('已提交，正在生成', 'success');
    startHistoryLoop();
  } catch (err) {
    submitError = err.message;
    toast(err.message, 'error', 6000);
  } finally {
    submitting = false;
    drawFooter();
  }
}

export function focusComposer() {
  els?.prompt.focus();
}

export function renderComposer(root) {
  els = {
    modes: h('div', { class: 'composer-modes' }),
    media: h('div', { class: 'media-block' }),
    params: h('div', { class: 'composer-params' }),
    advanced: h('div', { class: 'advanced-body' }),
    footer: h('div', { class: 'composer-send' }),
    hint: h('span', { class: 'composer-hint' }),
    count: h('span', { class: 'composer-count' }),
    preview: null,
  };
  els.prompt = h('textarea', {
    class: 'prompt',
    rows: '3',
    'aria-label': '提示词',
    placeholder: '描述你想生成的视频：主体、动作、场景、镜头运动、光线和风格',
    value: form.prompt,
    onInput: (e) => {
      form.prompt = e.target.value;
      els.count.textContent = `${form.prompt.length} 字`;
      submitError = '';
      autoGrow();
      persist();
      drawFooter();
      drawPreview();
    },
    onKeydown: (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        if (state.app.hasKey && !submitting) submit();
      }
    },
  });

  const advancedPanel = h('div', { class: 'advanced-panel', hidden: !advancedOpen }, els.advanced);
  const advancedToggle = h(
    'button',
    {
      class: 'tray-btn',
      type: 'button',
      'aria-expanded': String(advancedOpen),
      onClick: () => {
        advancedOpen = !advancedOpen;
        advancedPanel.hidden = !advancedOpen;
        advancedToggle.setAttribute('aria-expanded', String(advancedOpen));
        advancedToggle.classList.toggle('on', advancedOpen);
      },
    },
    icon('sliders', 14),
    '高级设置',
  );

  root.append(
    h(
      'section',
      { class: 'composer' },
      h('h1', { class: 'composer-title' }, '想生成什么视频？'),
      els.modes,
      h(
        'div',
        { class: 'composer-card' },
        els.media,
        els.prompt,
        h('div', { class: 'composer-bar' }, els.params, els.footer),
        h('div', { class: 'composer-tray' }, advancedToggle, els.hint, els.count),
      ),
      advancedPanel,
    ),
  );

  if (!state.models.includes(form.model) && state.modelsInfo.source === 'remote') form.model = state.models[0];
  drawAll();

  on('app', drawFooter);
  on('models', () => {
    if (state.modelsInfo.source === 'remote' && !state.models.includes(form.model)) {
      form.model = state.models[0];
      if (!resolutionsFor(form.model).includes(form.resolution)) form.resolution = '720p';
      persist();
    }
    drawAll();
  });
  on('assets', () => {
    const next = allRefs().map((r) => `${r.uid}:${refStatus(r).label}`).join('|');
    if (next !== refSignature) drawDynamic();
  });
}
