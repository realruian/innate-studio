// 创作输入框的状态和动作：正在编辑的表单、润色、音色试听、提交。界面在 Composer.tsx，把表单拼成请求的逻辑在 request.ts。
// 这里改完状态都要调 changed()，输入框才会重画。

import { api, state, on, emit, findAsset, assetReadiness, refreshAsset, startHistoryLoop, loadVoices, polishModel, goTo } from '../store.ts';
import { exclusive } from '../playback.ts';
import { refFromAsset, refFromRecord, assetFromRecord, readVideo } from '../media.ts';
import { toast } from '../ui/layers.tsx';
import { buildRequest as buildVideoRequest, buildImageRequest, buildSpeechRequest, buildSfxRequest, buildMusicRequest, refsInUse, videoFamily, RES_RANK } from '../request.ts';
import { ALL_RESOLUTIONS, VIDEO_TASKS, videoCapabilities, videoFamilyOf, type VideoTask } from '../../../shared/models.ts';
import type { Asset, BuiltRequest, CreateType, HistoryItem, Ref, RefStatus, Studio, VideoForm, Voice } from '../types.ts';

// 视频的表单单独存一份（生成记录里存的也是它）；当前选的类型和其余几种的表单存在另一份里。
const FORM_KEY = 'seedance-studio.form.v1';
const STUDIO_KEY = 'seedance-studio.studio.v1';

// 能生成的五种内容。polish 表示这种内容的提示词可以让模型帮忙补充（要朗读的文字不能改写，配乐没有提示词）。
export const TYPES: { value: CreateType; label: string; title: string; action: string; polish?: boolean; placeholder?: string }[] = [
  { value: 'video', label: '视频', title: '想生成什么视频？', action: '生成视频', polish: true, placeholder: '描述你想生成的视频：主体、动作、场景、镜头运动、光线和风格' },
  { value: 'image', label: '图片', title: '想生成什么图片？', action: '生成图片', polish: true, placeholder: '描述你想生成的图片：主体、环境、构图、光线和风格' },
  { value: 'speech', label: '语音', title: '想让它读什么？', action: '生成语音', placeholder: '输入要朗读的文字' },
  { value: 'sfx', label: '音效', title: '想要什么声音？', action: '生成音效', polish: true, placeholder: '描述想要的声音：来源、材质、动作，是一次声响还是持续的环境声' },
  { value: 'music', label: '配乐', title: '给哪段视频配乐？', action: '生成配乐' },
];

export const RESOLUTIONS = ALL_RESOLUTIONS;
export const RATIOS = [
  { value: '16:9', label: '16:9' },
  { value: '4:3', label: '4:3' },
  { value: '1:1', label: '1:1' },
  { value: '3:4', label: '3:4' },
  { value: '9:16', label: '9:16' },
  { value: '21:9', label: '21:9' },
  { value: 'adaptive', label: '自适应' },
];
export const SR_RESOLUTIONS = ['720p', '1080p', '2k', '4k'];

const defaults = (): VideoForm => ({
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

const studioDefaults = (): Studio => ({
  type: 'video',
  image: { prompt: '', model: 'grok-imagine-image-2.0', ratio: '16:9', count: 1 },
  speech: { prompt: '', voiceId: '', voiceName: '' },
  sfx: { prompt: '', duration: 'auto', influence: '0.3' },
  music: { video: null },
});

function mergeForm(saved: Partial<VideoForm> | null): VideoForm {
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

function mergeStudio(saved: Partial<Studio> | null): Studio {
  const base = studioDefaults();
  if (!saved || typeof saved !== 'object') return base;
  return {
    type: TYPES.some((t) => t.value === saved.type) ? saved.type! : base.type,
    image: { ...base.image, ...(saved.image || {}) },
    speech: { ...base.speech, ...(saved.speech || {}) },
    sfx: { ...base.sfx, ...(saved.sfx || {}) },
    music: { ...base.music, ...(saved.music || {}) },
  };
}

function load<T>(key: string, merge: (saved: any) => T): T {
  try {
    return merge(JSON.parse(localStorage.getItem(key)!));
  } catch {
    return merge(null);
  }
}

// 输入框当前的全部状态。form 是视频的表单，studio 是当前类型和其余几种的表单。
export const composer = {
  form: load(FORM_KEY, mergeForm),
  studio: load(STUDIO_KEY, mergeStudio),
  submitting: false,
  submitError: '',
  // 润色之前的原文。留着它，「润色」就变成「撤销润色」；用户再动一下文字就丢掉。
  beforePolish: null as string | null,
  polishing: false,
  voicesError: '',
  voiceFilter: 'all' as 'all' | 'zh' | 'en' | 'other',
  // 正在试听的音色。
  previewing: '',
};
state.createType = composer.studio.type;

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let refSignature = '';

export const typeOf = (value: CreateType = composer.studio.type) => TYPES.find((t) => t.value === value) || TYPES[0];
// 当前类型正在编辑的那份表单里的文字。配乐没有提示词。
export const draftPrompt = () => (composer.studio.type === 'video' ? composer.form.prompt : composer.studio.type === 'music' ? '' : composer.studio[composer.studio.type].prompt) || '';
function writePrompt(text: string) {
  const { type } = composer.studio;
  if (type === 'video') composer.form.prompt = text;
  else if (type !== 'music') composer.studio[type].prompt = text;
}

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(FORM_KEY, JSON.stringify(composer.form));
      localStorage.setItem(STUDIO_KEY, JSON.stringify(composer.studio));
    } catch {
      /* 存不下就不存，不影响使用 */
    }
  }, 300);
}

// Grok 只有文生视频和图生视频，也没有 Seedance「更多」里的那些设置。
export const isGrok = (model = composer.form.model) => videoFamily(model) === 'grok';
// 当前模型能选的分辨率、比例、时长。各模型的范围登记在 shared/models.ts。
export const capabilities = (model = composer.form.model) => videoCapabilities(model);

const allRefs = () => refsInUse(composer.form);
export const usedAssetIds = () => allRefs().map((r) => r.assetId).filter((id): id is string => Boolean(id));

export function refStatus(ref: Ref): RefStatus & { label: string } {
  if (ref.source === 'url') return { ready: true, tone: 'ok', label: '链接' };
  if (ref.source === 'local') return { ready: true, tone: 'ok', label: '本机' };
  return assetReadiness(findAsset(ref.assetId), composer.form.model);
}

// 当前类型的请求和不能提交的原因。
export function currentRequest(): BuiltRequest {
  const { studio } = composer;
  if (studio.type === 'image') return buildImageRequest(studio.image);
  if (studio.type === 'speech') return buildSpeechRequest(studio.speech);
  if (studio.type === 'sfx') return buildSfxRequest(studio.sfx);
  if (studio.type === 'music') return buildMusicRequest(studio.music);
  return buildVideoRequest(composer.form, refStatus);
}

// 超分的目标必须高于原始分辨率；不满足时自动换到更高的最近一档，免得用户被一条看不见的校验卡住。
function fitSrTarget() {
  const { form } = composer;
  if (!form.sr.enabled || form.sr.by !== 'resolution') return;
  if (RES_RANK[form.sr.resolution] > RES_RANK[form.resolution]) return;
  const next = SR_RESOLUTIONS.find((r) => RES_RANK[r] > RES_RANK[form.resolution]);
  if (next) form.sr = { ...form.sr, resolution: next };
}

// 换模型后，把当前模型不支持的取值换成它支持的，免得带着一个提交不了的设置。
function fitModel() {
  const { form } = composer;
  const able = capabilities();
  if (!able.resolutions.includes(form.resolution)) form.resolution = '720p';
  if (!able.ratios.includes(form.ratio)) form.ratio = '16:9';
  if (!able.autoDuration) form.durationAuto = false;
  if (!able.durations.includes(Number(form.duration))) form.duration = 5;
  if (isGrok() && form.mode === 'reference') form.mode = 'text';
}

// 用到的素材里有真人素材就盯着那份档案，素材库里查不到的就去问一次。
function syncWatches() {
  state.watchedPersons.clear();
  for (const ref of allRefs()) {
    if (ref.source !== 'asset') continue;
    if (ref.personId) state.watchedPersons.add(ref.personId);
    else if (!findAsset(ref.assetId)) refreshAsset(ref.assetId!).catch(() => {});
  }
  refSignature = currentRefSignature();
}
const currentRefSignature = () => allRefs().map((r) => `${r.uid}:${refStatus(r).label}`).join('|');

// 状态改完了：让输入框重画。
function changed() {
  syncWatches();
  emit('composer');
}

export function update(patch: Partial<VideoForm>) {
  Object.assign(composer.form, patch);
  fitModel();
  fitSrTarget();
  composer.submitError = '';
  persist();
  changed();
}

export function updateSr(patch: Partial<VideoForm['sr']>) {
  composer.form.sr = { ...composer.form.sr, ...patch };
  fitSrTarget();
  composer.submitError = '';
  persist();
  changed();
}

export function updateStudio<T extends 'image' | 'speech' | 'sfx' | 'music'>(type: T, patch: Partial<Studio[T]>) {
  Object.assign(composer.studio[type], patch);
  composer.submitError = '';
  persist();
  changed();
}

export function setType(type: CreateType) {
  composer.studio.type = type;
  state.createType = type;
  emit('createType');
  composer.beforePolish = null;
  composer.submitError = '';
  stopPreview();
  persist();
  changed();
  if (type === 'speech') ensureVoices();
}

// 把一份视频表单填回输入框（复用记录时用）。
export function setForm(next: Partial<VideoForm>) {
  composer.form = mergeForm(JSON.parse(JSON.stringify(next)));
  if (!state.models.includes(composer.form.model) && state.models.length) composer.form.model = state.models[0];
  fitModel();
  setType('video');
}

// 把图片、语音、音效、配乐的表单填回输入框。
export function setStudio(type: 'image' | 'speech' | 'sfx' | 'music', next: Record<string, unknown> | undefined) {
  const { type: _ignored, ...fields } = JSON.parse(JSON.stringify(next || {}));
  (composer.studio[type] as object) = { ...studioDefaults()[type], ...fields };
  setType(type);
}

// 拿一张生成的图片去生成视频。
// Seedance：当作参考图（参考生成）。模型照着图里的人和物另拍一段，不要求视频从这张图原样开始；
// 想让视频严格从这张图开始，再手动改成首尾帧。Seedance 只认素材库，所以先把图传上去。
// Grok：它只有「图生视频」一种用法，就是把图当首帧，直接用本机的文件。
export async function useImageForVideo(item: HistoryItem) {
  if (isGrok()) {
    Object.assign(composer.form, { mode: 'frames', frames: { first: await refFromRecord(item), last: null } });
  } else {
    toast('正在把图片传到素材库…', 'info');
    const ref = refFromAsset(await assetFromRecord(item), 'image');
    Object.assign(composer.form, { mode: 'reference', refs: { image: [ref], video: [], audio: [] } });
  }
  setType('video');
  goTo('create');
}

// 延长或修改一条已经存到本机的视频。Seedance 把这两件事都当成参考生成来做：视频作为参考素材，提示词用固定的句式开头。
// 这里把视频传进素材库、切到参考生成、填好开头和结尾的约束，用户只要在中间写上内容。
const sourceAssets = new Map<string, Asset>();
export async function useVideoAsSource(item: HistoryItem, task: VideoTask) {
  // 只有 Seedance 能做。当前选的不是，就换成账号里的第一个 Seedance 型号。
  const model = [composer.form.model, item.model, ...state.models].find((id) => videoFamilyOf(id) === 'seedance' && state.models.includes(id));
  if (!model) throw new Error('账号里没有 Seedance 模型，延长和修改用不了');
  // 同一条视频这次打开页面期间传过，就接着用那份素材，不重复上传。
  let asset = sourceAssets.get(item.id);
  if (!asset || !findAsset(asset.id)) {
    toast('正在把视频传到素材库…', 'info');
    asset = await assetFromRecord(item);
    sourceAssets.set(item.id, asset);
  }
  const { lead, keep } = VIDEO_TASKS[task];
  const p = item.payload || {};
  const able = videoCapabilities(model);
  const ratio = p.ratio || p.aspect_ratio;
  const next: Partial<VideoForm> = { model, mode: 'reference', prompt: `${lead}\n${keep}`, refs: { image: [], video: [refFromAsset(asset, 'video')], audio: [] } };
  // 画面比例和分辨率跟原视频一致，接起来或者对比着看才不会变样。
  if (able.ratios.includes(ratio)) next.ratio = ratio;
  if (able.resolutions.includes(p.resolution)) next.resolution = p.resolution;
  // 修改出来的视频和原视频一样长。
  if (task === 'edit') {
    const seconds = Math.round(p.duration > 0 ? p.duration : (await readVideo(item.mediaUrl!).catch(() => ({ duration: 0 }))).duration);
    if (able.durations.includes(seconds)) Object.assign(next, { duration: seconds, durationAuto: false });
  }
  Object.assign(composer.form, next);
  fitModel();
  // 光标放在开头那句的后面，用户直接接着写。
  caretAfterFocus = lead.length;
  setType('video');
  goTo('create');
}

// 给一条已经存到本机的视频配乐：把它放进配乐的输入框，等用户点提交。
export async function useVideoForMusic(item: HistoryItem) {
  composer.studio.music = { video: await refFromRecord(item) };
  setType('music');
  goTo('create');
}

// ---------- 音色 ----------

export async function ensureVoices() {
  if (state.voices || !state.app.hasKey) return;
  composer.voicesError = '';
  try {
    await loadVoices();
  } catch (err) {
    composer.voicesError = (err as Error).message;
  }
  // 还没选过音色：有中文音色就先用第一个中文的，朗读中文最自然。
  const { speech } = composer.studio;
  const voices = (state.voices || []) as Voice[];
  if (voices.length && !voices.some((v) => v.id === speech.voiceId)) {
    const first = voices.find((v) => v.language === 'zh') || voices[0];
    Object.assign(speech, { voiceId: first.id, voiceName: voiceName(first) });
    persist();
  }
  changed();
}

const VOICE_GENDERS: Record<string, string> = { male: '男声', female: '女声', neutral: '中性' };
const VOICE_LANGUAGES: Record<string, string> = { zh: '中文', en: '英语' };
// 音色的名字是「名字 - 一句描述」，前半截当名字，后半截当附注。
export const voiceName = (voice: Voice) => voice.name.split(/\s[-–]\s/)[0];
export const voiceNote = (voice: Voice) => [VOICE_GENDERS[voice.gender], VOICE_LANGUAGES[voice.language] || voice.language.toUpperCase(), voice.name.split(/\s[-–]\s/)[1]].filter(Boolean).join(' · ');

const preview = new Audio();

export function stopPreview() {
  preview.pause();
  composer.previewing = '';
}
// 试听放完、或者被别处的播放顶掉时，按钮变回「试听」。换一个音色试听时地址会换，那一下不算停。
exclusive(preview);
const previewStopped = () => {
  if (!preview.paused && !preview.ended) return;
  composer.previewing = '';
  emit('composer');
};
preview.addEventListener('ended', previewStopped);
preview.addEventListener('pause', previewStopped);

export function togglePreview(voice: Voice) {
  if (composer.previewing === voice.id) {
    stopPreview();
  } else {
    preview.src = voice.previewUrl!;
    preview.play().catch(() => toast('这个音色的试听播放不了', 'error'));
    composer.previewing = voice.id;
  }
  emit('composer');
}

export function setVoiceFilter(filter: typeof composer.voiceFilter) {
  composer.voiceFilter = filter;
  emit('composer');
}

export function pickVoice(voice: Voice) {
  stopPreview();
  updateStudio('speech', { voiceId: voice.id, voiceName: voiceName(voice) });
}

// ---------- 润色、提交 ----------

// 用户自己在输入框里打字。动了文字，润色前的原文就不再留着，「撤销润色」变回「润色」。
export function typePrompt(text: string) {
  writePrompt(text);
  composer.beforePolish = null;
  composer.submitError = '';
  persist();
  emit('composer');
}

function setPrompt(text: string) {
  writePrompt(text);
  composer.submitError = '';
  persist();
  emit('composer');
}

// 让文本模型把提示词补充得更具体。结果直接替换输入框里的文字，可以撤销。
export async function polish() {
  const { type } = composer.studio;
  const original = draftPrompt();
  if (!original.trim()) return toast('先写几个字，再让它补充', 'info');
  composer.polishing = true;
  emit('composer');
  try {
    const wanted = polishModel();
    // 各个生成模型的提示词写法不一样，所以把这次要用的模型、生成方式和带了几份参考素材一起告诉它。
    const { form, studio } = composer;
    const target =
      type === 'video'
        ? { model: form.model, mode: form.mode, refs: { image: form.refs.image.length, video: form.refs.video.length, audio: form.refs.audio.length } }
        : type === 'image'
          ? { model: studio.image.model }
          : {};
    const { text, model } = await api('POST', '/api/polish', { text: original, kind: type, model: wanted, target });
    // 等结果的时候用户换了类型或者又改了文字，就不去覆盖。
    if (composer.studio.type === type && draftPrompt() === original) {
      composer.beforePolish = original;
      setPrompt(text);
      if (model !== wanted) toast(`${wanted} 暂时用不了，这次是 ${model} 润色的`, 'info', 5000);
    }
  } catch (err) {
    toast((err as Error).message, 'error', 6000);
  } finally {
    composer.polishing = false;
    emit('composer');
  }
}

export function undoPolish() {
  const original = composer.beforePolish;
  composer.beforePolish = null;
  setPrompt(original || '');
}

export async function submit() {
  const { studio, form } = composer;
  const { type } = studio;
  const request = currentRequest();
  if (request.problems.length) return toast(request.problems[0], 'info');
  composer.submitting = true;
  composer.submitError = '';
  emit('composer');
  try {
    if (type === 'video') await api('POST', '/api/videos', { payload: request.payload, form });
    else if (type === 'image') await api('POST', '/api/images', { payload: request.payload, form: { type, ...studio.image } });
    else await api('POST', `/api/audio/${type}`, { ...request.body, form: { type, ...studio[type] } });
    toast('已提交，正在生成', 'success');
    startHistoryLoop();
  } catch (err) {
    composer.submitError = (err as Error).message;
    toast((err as Error).message, 'error', 6000);
  } finally {
    composer.submitting = false;
    emit('composer');
  }
}

// 输入框的文本框。点「新建创作」时要把光标放回去。
let promptEl: HTMLTextAreaElement | null = null;
export const registerPrompt = (el: HTMLTextAreaElement | null) => {
  promptEl = el;
};
// 下一次把光标放回文本框时，放在第几个字后面。用完就清掉。
let caretAfterFocus: number | null = null;
export function focusComposer() {
  if (!promptEl || promptEl.hidden) return;
  promptEl.focus();
  if (caretAfterFocus !== null) promptEl.setSelectionRange(caretAfterFocus, caretAfterFocus);
  caretAfterFocus = null;
}

// 读到 Key 的状态之后调一次，然后才画输入框。
export function initComposer() {
  const { form, studio } = composer;
  if (!state.models.includes(form.model) && state.modelsInfo.source === 'remote') form.model = state.models[0];
  fitModel();
  syncWatches();
  if (studio.type === 'speech') ensureVoices();

  on('app', () => {
    if (composer.studio.type === 'speech') ensureVoices();
  });
  on('models', () => {
    const info = state.modelsInfo;
    if (info.source === 'remote' && !state.models.includes(composer.form.model)) {
      composer.form.model = state.models[0];
      fitModel();
      persist();
    }
    if (state.catalog.image.length && !state.catalog.image.includes(composer.studio.image.model)) {
      composer.studio.image.model = state.catalog.image[0];
      persist();
    }
    if (state.app.hasKey && info.source === 'default' && info.error) toast(`没能读到账号的模型列表，暂时显示默认型号。${info.error}`, 'error', 6000);
    changed();
  });
  // 素材状态变了（比如处理完成），用到它的地方才需要重画。
  on('assets', () => {
    if (currentRefSignature() !== refSignature) changed();
  });
}
