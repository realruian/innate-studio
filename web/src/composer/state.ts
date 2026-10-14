// 创作输入框的状态和动作：正在编辑的表单、润色、音色试听、提交。界面在 Composer.tsx，把表单拼成请求的逻辑在 request.ts。
// 这里改完状态都要调 changed()，输入框才会重画。

import { api, state, on, emit, KINDS, startHistoryLoop, loadVoices, polishModel, goTo, type ApiError } from '../store.ts';
import { exclusive } from '../playback.ts';
import { refFromRecord, kindOfFile, uploadLocalFile } from '../media.ts';
import { toast } from '../ui/layers.tsx';
import { buildVideoRequest, buildImageRequest, buildSpeechRequest, buildSfxRequest, buildMusicRequest, refsInUse, carryRefs } from '../request.ts';
import { quoteCost, toCredits, type VideoSpec } from '../../../shared/models.ts';
import type { BuiltRequest, Character, CreateType, HistoryItem, Kind, Ref, SkillRef, Studio, VideoForm, Voice } from '../types.ts';

// 视频的表单单独存一份（生成记录里存的也是它）；当前选的类型和其余几种的表单存在另一份里。
const FORM_KEY = 'innate-studio.form.v1';
const STUDIO_KEY = 'innate-studio.studio.v1';

// 能生成的五种内容。polish 表示这种内容的文字可以让模型帮忙润色：提示词是补得更具体，要朗读的文稿是改得更适合朗读。
export const TYPES: { value: CreateType; label: string; title: string; action: string; polish?: boolean; placeholder?: string }[] = [
  { value: 'video', label: '视频', title: '想生成什么视频？', action: '生成视频', polish: true, placeholder: '描述主体、动作、场景、运镜、光线与风格' },
  { value: 'image', label: '图片', title: '想生成什么图片？', action: '生成图片', polish: true, placeholder: '描述主体、环境、构图、光线与风格' },
  { value: 'speech', label: '语音', title: '想让它读什么？', action: '生成语音', polish: true, placeholder: '输入朗读文本' },
  { value: 'sfx', label: '音效', title: '想要什么声音？', action: '生成音效', polish: true, placeholder: '描述声音的来源、材质与动作' },
  { value: 'music', label: '配乐', title: '想要什么配乐？', action: '生成配乐', polish: true, placeholder: '描述风格、情绪、节奏与乐器' },
];

export const RATIOS = [
  { value: '16:9', label: '16:9' },
  { value: '4:3', label: '4:3' },
  { value: '1:1', label: '1:1' },
  { value: '3:4', label: '3:4' },
  { value: '9:16', label: '9:16' },
  { value: '21:9', label: '21:9' },
];

export const defaults = (): VideoForm => ({
  mode: 'reference',
  prompt: '',
  model: 'doubao-seedance-2-0-260128',
  resolution: '720p',
  ratio: '16:9',
  duration: 5,
  durationAuto: false,
  generateAudio: true,
  seed: '',
  frames: { first: null, last: null },
  refs: { image: [], video: [], audio: [] },
  skill: null,
});

const studioDefaults = (): Studio => ({
  type: 'video',
  image: { prompt: '', model: 'doubao-seedream-5-0-pro-260628', ratio: '16:9', count: 1, refs: [], skill: null },
  speech: { prompt: '', voiceId: '', voiceName: '' },
  sfx: { prompt: '', duration: 'auto' },
  music: { prompt: '', video: null, duration: 30 },
});

// 以前存下的表单、别的平台留下的记录里，可能带着现在用不了的素材。只留本机的文件和公网链接。
const usable = (ref: Ref | null | undefined): ref is Ref => Boolean(ref) && (ref!.source === 'local' || ref!.source === 'url');

function mergeForm(saved: Partial<VideoForm> | null): VideoForm {
  const base = defaults();
  if (!saved || typeof saved !== 'object') return base;
  const frames = { ...base.frames, ...(saved.frames || {}) };
  const refs = { ...base.refs, ...(saved.refs || {}) };
  // 只取现在还有的那几项设置，以前的版本多存的不带进来。
  const fields = Object.fromEntries(Object.keys(base).filter((key) => key in saved).map((key) => [key, saved[key as keyof VideoForm]]));
  return {
    ...base,
    ...fields,
    frames: { first: usable(frames.first) ? frames.first : null, last: usable(frames.last) ? frames.last : null },
    refs: { image: (refs.image || []).filter(usable), video: (refs.video || []).filter(usable), audio: (refs.audio || []).filter(usable) },
  };
}

function mergeStudio(saved: Partial<Studio> | null): Studio {
  const base = studioDefaults();
  if (!saved || typeof saved !== 'object') return base;
  return {
    type: TYPES.some((t) => t.value === saved.type) ? saved.type! : base.type,
    image: { ...base.image, ...(saved.image || {}), refs: (saved.image?.refs || []).filter(usable) },
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
  // 提交时就被拒绝的原因（没开通模型、参数不对）。这时没有生成记录，所以写在输入框下面，改了输入或关掉才消失。
  submitError: '',
  submitDetail: '',
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

export const typeOf = (value: CreateType = composer.studio.type) => TYPES.find((t) => t.value === value) || TYPES[0];
// 当前类型正在编辑的那份表单里的文字。
export const draftPrompt = () => (composer.studio.type === 'video' ? composer.form.prompt : composer.studio[composer.studio.type].prompt) || '';
function writePrompt(text: string) {
  const { type } = composer.studio;
  if (type === 'video') composer.form.prompt = text;
  else composer.studio[type].prompt = text;
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

// 每个视频模型支持什么，由本地服务随模型列表一起给。列表还没读到时先按这一份保守的来。
const FALLBACK_SPEC: VideoSpec = { resolutions: ['480p', '720p'], ratios: ['16:9', '4:3', '1:1', '3:4', '9:16'], durations: [4, 5, 6, 7, 8], autoDuration: false, frames: ['first_frame'], audio: false, seed: false };
export const specOf = (model = composer.form.model) => state.videoSpecs[model] || FALLBACK_SPEC;

const allRefs = () => refsInUse(composer.form);

// 当前类型的请求和不能提交的原因。prompt 是技能扩写出来的提示词：给了就用它代替输入框里的那句话。
export function currentRequest(prompt?: string): BuiltRequest {
  const { studio } = composer;
  if (studio.type === 'image') return buildImageRequest(prompt === undefined ? studio.image : { ...studio.image, prompt }, imageRefLimit());
  if (studio.type === 'speech') return buildSpeechRequest(studio.speech);
  if (studio.type === 'sfx') return buildSfxRequest(studio.sfx);
  if (studio.type === 'music') return buildMusicRequest(studio.music);
  const form = prompt === undefined ? composer.form : { ...composer.form, prompt };
  return buildVideoRequest(form, specOf(form.model));
}

// 这次生成大约要多少积分，写在发送键旁边。和服务端预扣用的是同一个算法（shared/models.ts 的 quoteCost）。估不出来是 null。
export function currentCredits(): number | null {
  const { type } = composer.studio;
  const { payload, body } = currentRequest();
  if (type === 'video' || type === 'image') {
    const yuan = quoteCost({ kind: type, model: String(payload?.model || ''), payload });
    return yuan == null ? null : toCredits(yuan) * (type === 'image' ? Number(payload?.n) || 1 : 1);
  }
  const yuan = quoteCost({ tool: type, prompt: String(body?.text || ''), payload: { duration_seconds: body?.duration } });
  return yuan == null ? null : toCredits(yuan);
}

// ---------- 技能 ----------
// 技能只用在视频和图片上，两种各记各的。选了技能，输入框里写的就是一句简单的话，发送前按技能的规则扩写成提示词。

export function activeSkill(): SkillRef | null {
  const { type } = composer.studio;
  return (type === 'video' ? composer.form.skill : type === 'image' ? composer.studio.image.skill : null) || null;
}

export function setSkill(skill: SkillRef | null) {
  if (composer.studio.type === 'video') update({ skill });
  else if (composer.studio.type === 'image') updateStudio('image', { skill });
}

// 这次生成的设置，扩写时放在用户那句话前面：规则里有些写法要看它们（时长、要不要写声音、有没有参考图）。
function skillContext() {
  const { form, studio } = composer;
  if (studio.type === 'image') return `参考图：${studio.image.refs?.length || 0} 张\n画面比例：${studio.image.ratio}`;
  const images = refsInUse(form).filter((ref) => ref.kind === 'image').length;
  return [`时长：${form.durationAuto ? '由模型决定' : `${form.duration} 秒`}`, `生成声音：${specOf().audio && form.generateAudio ? '是' : '否'}`, `参考图：${images} 张`].join('\n');
}

// 换模型后，把当前模型不支持的取值换成它支持的，免得带着一个提交不了的设置。
function fitModel() {
  const { form } = composer;
  const able = specOf();
  // 常用的那一档这个模型有就用它，没有就用它支持的第一档。
  const pick = <T,>(list: T[], usual: T) => (list.includes(usual) ? usual : (list[0] ?? usual));
  if (!able.resolutions.includes(form.resolution)) form.resolution = pick(able.resolutions, '720p');
  if (!able.ratios.includes(form.ratio)) form.ratio = pick(able.ratios, '16:9');
  if (!able.autoDuration) form.durationAuto = false;
  if (!able.durations.includes(Number(form.duration))) form.duration = pick(able.durations, 5);
  if (form.mode === 'frames' && !able.frames.includes('first_frame')) form.mode = 'reference';
  // 没有单独的「文生视频」：不加素材的全能参考就是它。
  if (form.mode === 'text') form.mode = 'reference';
}

// 状态改完了：让输入框重画。
const changed = () => emit('composer');

export function update(patch: Partial<VideoForm>) {
  Object.assign(composer.form, patch);
  fitModel();
  composer.submitError = '';
  persist();
  changed();
}

// 换生成方式。
export function setMode(mode: VideoForm['mode']) {
  update({ mode, ...carryRefs(composer.form, mode, KINDS.image.max) });
}

// ---------- 添加素材 ----------
// 选素材的弹窗、拖进输入框、粘贴，三条路加进来的素材都走这里，规则只有一份。

const sameMedia = (a: Ref, b: Ref) => a.url === b.url;
// 视频的参考素材里，现在能加的是哪几类。没有视频：参考视频只收公网链接，本机的文件发不过去；图片和音频可以内嵌进请求。
export const addableKinds = (): Kind[] => ['image', 'audio'];
// 首尾帧里能不能给尾帧。
export const hasLastFrame = (model = composer.form.model) => specOf(model).frames.includes('last_frame');

// 当前类型和生成方式下，每种素材还能加几份。一种都不能加时是空的。
export function mediaRoom(): Partial<Record<Kind, number>> {
  const { form, studio } = composer;
  if (studio.type === 'image') return imageRefLimit() ? { image: imageRefLimit() - (studio.image.refs?.length || 0) } : {};
  if (studio.type === 'music') return { video: 1 };
  if (studio.type !== 'video' || form.mode === 'text') return {};
  if (form.mode === 'frames') return { image: [form.frames.first, hasLastFrame() ? form.frames.last : true].filter((slot) => !slot).length };
  return Object.fromEntries(addableKinds().map((kind) => [kind, KINDS[kind].max - form.refs[kind].length]));
}

// 已经用上的本机文件的地址：选素材时同一份不让加第二次。
export function usedMediaUrls() {
  const { studio } = composer;
  const refs = studio.type === 'image' ? studio.image.refs || [] : studio.type === 'music' ? [studio.music.video] : allRefs();
  return refs.filter((ref): ref is Ref => Boolean(ref)).map((ref) => ref.url);
}

// 把一份素材加进当前的输入框。slot 是首尾帧里指定放哪一格；没指定就放进第一个空着的。加不进去时返回原因。
export function addMedia(ref: Ref, slot?: 'first' | 'last'): string | null {
  const { form, studio } = composer;
  const label = KINDS[ref.kind].label;
  if (studio.type === 'music') {
    if (ref.kind !== 'video') return '请添加视频文件';
    updateStudio('music', { video: ref });
    return null;
  }
  const room = mediaRoom();
  if (!(ref.kind in room)) return `当前不支持添加${label}`;
  if (studio.type === 'image') {
    const refs = studio.image.refs || [];
    if (refs.some((r) => sameMedia(r, ref))) return null;
    if (refs.length >= imageRefLimit()) return `${label}数量已达上限`;
    updateStudio('image', { refs: [...refs, ref] });
    return null;
  }
  if (form.mode === 'frames') {
    const key = slot || (!form.frames.first ? 'first' : hasLastFrame() && !form.frames.last ? 'last' : null);
    if (!key) return '首帧和尾帧均已添加';
    update({ frames: { ...form.frames, [key]: ref } });
    return null;
  }
  const list = form.refs[ref.kind];
  if (list.some((r) => sameMedia(r, ref))) return null;
  if (list.length >= KINDS[ref.kind].max) return `${label}数量已达上限`;
  update({ refs: { ...form.refs, [ref.kind]: [...list, ref] } });
  return null;
}

// 拖进来或粘贴进来的文件：先传上去，再按 addMedia 的规则加进输入框。
export async function addFiles(files: File[]) {
  if (!files.length) return;
  if (!Object.keys(mediaRoom()).length) return toast('当前类型不支持添加素材', 'info');
  let uploading = false;
  for (const file of files) {
    const kind = kindOfFile(file);
    const room = mediaRoom();
    const problem = !kind ? `不支持的文件类型：${file.name}` : !(kind in room) ? `当前不支持添加${KINDS[kind].label}` : room[kind]! <= 0 ? `${KINDS[kind].label}数量已达上限` : null;
    if (problem) {
      toast(problem, 'info');
      continue;
    }
    if (!uploading) toast('正在上传…', 'info', 1800);
    uploading = true;
    try {
      const ref = await uploadLocalFile(file, kind!);
      const refused = addMedia(ref);
      if (refused) toast(refused, 'info');
    } catch (err) {
      toast((err as Error).message, 'error', 6000);
    }
  }
}

// 首帧和尾帧对调。
export function swapFrames() {
  const { first, last } = composer.form.frames;
  update({ frames: { first: last, last: first } });
}

// 图片能选的画面比例：各模型收的比例登记好了，只留这个模型收的。模型列表还没读到时先全列着。
export const IMAGE_RATIOS = ['16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16'];
export function imageRatios(model = composer.studio.image.model) {
  const accepted = state.catalog.imageRatios[model];
  return accepted ? IMAGE_RATIOS.filter((r) => accepted.includes(r)) : IMAGE_RATIOS;
}
// 图片能选的分辨率档位。模型列表还没读到时是空的，这时不显示分辨率。
export const imageSizes = (model = composer.studio.image.model) => state.catalog.imageSizes[model]?.options || [];
// 选着的档位这个模型没有（或者还没选过）时，用它默认的那一档；模型不分档时不带档位。
export function fitImageSize(model: string, resolution?: string) {
  const sizes = state.catalog.imageSizes[model];
  if (!sizes) return undefined;
  return resolution && sizes.options.includes(resolution) ? resolution : sizes.default;
}
// 图片能选的画质档位。只有分画质的模型（GPT Image 2.5）才有，其余是空的，这时不显示画质。
export const imageQualities = (model = composer.studio.image.model) => state.catalog.imageQualities[model]?.options || [];
// 选着的画质这个模型没有（或者还没选过）时，用它默认的那一档；模型不分画质时不带。
export function fitImageQuality(model: string, quality?: string) {
  const qualities = state.catalog.imageQualities[model];
  if (!qualities) return undefined;
  return quality && qualities.options.includes(quality) ? quality : qualities.default;
}
// 这个图片模型最多收几张参考图（图生图）。0 是不能带参考图。
export const imageRefLimit = (model = composer.studio.image.model) => state.catalog.imageRefs[model] || 0;
// 换了图片模型后，选着的比例它不收就换成它收的第一个；分辨率、画质它没有那一档就换成它默认的；参考图超出它收的张数，多的去掉。
function fitImage() {
  const { image } = composer.studio;
  const ratios = imageRatios();
  if (state.catalog.known && (image.refs?.length || 0) > imageRefLimit()) image.refs = (image.refs || []).slice(0, imageRefLimit());
  if (ratios.length && !ratios.includes(image.ratio)) image.ratio = ratios[0];
  // 模型列表还没读到时先不动，免得把存着的选择冲掉。
  if (state.catalog.known) image.resolution = fitImageSize(image.model, image.resolution);
  if (state.catalog.known) image.quality = fitImageQuality(image.model, image.quality);
}

export function updateStudio<T extends 'image' | 'speech' | 'sfx' | 'music'>(type: T, patch: Partial<Studio[T]>) {
  Object.assign(composer.studio[type], patch);
  if (type === 'image') fitImage();
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

// 拿一张生成的图片去生成视频：当作参考图（全能参考）。模型照着图里的人和物另拍一段，不要求视频从这张图原样开始；
// 想让视频严格从这张图开始，再手动改成首尾帧。
export async function useImageForVideo(item: HistoryItem) {
  Object.assign(composer.form, { mode: 'reference', refs: { image: [await refFromRecord(item)], video: [], audio: [] } });
  setType('video');
  goTo('create');
}

// 把角色的参考图变成一组本机的参考素材。
export const refsFromCharacter = (character: Character): Ref[] => character.images.map((url) => ({ uid: crypto.randomUUID(), kind: 'image', source: 'local', url, name: character.name, thumb: url }));

// 拿一个角色去生成图片或视频：把它的参考图加进输入框，已经加好的素材留着；提示词空着的话，先填上角色的描述。
// 图片：当参考图（图生图），当前模型不收参考图就换成第一个收的。视频：当参考图。
export function useCharacter(character: Character, type: 'image' | 'video') {
  const refs = refsFromCharacter(character);
  if (!refs.length) throw new Error('该角色暂无参考图，请先添加');
  const { form, studio } = composer;
  // 角色的图排在已有参考图的后面，同一张不重复加。
  const merged = (current: Ref[]) => [...current, ...refs.filter((ref) => !current.some((r) => r.url === ref.url))];
  if (type === 'image') {
    const model = [studio.image.model, ...state.catalog.image].find((id) => imageRefLimit(id) > 0);
    if (!model) throw new Error('暂无支持参考图的图片模型');
    Object.assign(studio.image, { model, refs: merged(studio.image.refs || []).slice(0, imageRefLimit(model)) });
    if (!studio.image.prompt.trim()) studio.image.prompt = character.description;
    fitImage();
  } else {
    Object.assign(form, { mode: 'reference', refs: { ...form.refs, image: merged(form.refs.image).slice(0, KINDS.image.max) } });
    if (!form.prompt.trim()) form.prompt = character.description;
    fitModel();
  }
  setType(type);
  goTo('create');
}

// 给一条已经存到本机的视频配乐：把它放进配乐的输入框，等用户写上要什么样的音乐再提交。
export async function useVideoForMusic(item: HistoryItem) {
  composer.studio.music = { ...composer.studio.music, video: await refFromRecord(item) };
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
const VOICE_LANGUAGES: Record<string, string> = { zh: '中文', en: '英语', ja: '日语', ko: '韩语', es: '西班牙语', pt: '葡萄牙语', fr: '法语', de: '德语', it: '意大利语', ru: '俄语', ar: '阿拉伯语', id: '印尼语', th: '泰语', vi: '越南语', ms: '马来语', fil: '菲律宾语' };
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
    preview.play().catch(() => toast('试听播放失败', 'error'));
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
  if (!original.trim()) return toast(type === 'speech' ? '请先输入朗读文本' : '请先输入提示词', 'info');
  composer.polishing = true;
  emit('composer');
  try {
    const wanted = polishModel();
    // 各个生成模型的提示词写法不一样，所以把这次要用的模型、生成方式和带了几份参考素材一起告诉它。
    const { form, studio } = composer;
    const target =
      type === 'video'
        ? { model: form.model, mode: form.mode, refs: { image: form.refs.image.length, video: form.refs.video.length, audio: form.refs.audio.length }, duration: form.durationAuto ? undefined : Number(form.duration) }
        : type === 'image'
          ? { model: studio.image.model, refs: { image: studio.image.refs?.length || 0 } }
          : {};
    const { text, model } = await api('POST', '/api/polish', { text: original, kind: type, model: wanted, target });
    // 等结果的时候用户换了类型或者又改了文字，就不去覆盖。
    if (composer.studio.type === type && draftPrompt() === original) {
      composer.beforePolish = original;
      setPrompt(text);
      if (model !== wanted) toast('润色模型不可用，已自动切换', 'info', 5000);
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
  let request = currentRequest();
  if (request.problems.length) return toast(request.problems[0], 'info');
  const skill = activeSkill();
  if (skill && !polishModel()) return toast('暂无可用的文本模型，请取消技能后重试', 'info');
  composer.submitting = true;
  composer.submitError = '';
  emit('composer');
  try {
    // 选了技能：先让文本模型按规则把这句话扩写成提示词，再拿扩写的结果去生成。输入框里留着的还是用户写的那句话。
    if (skill) {
      const { text } = await api('POST', '/api/skills/expand', { id: skill.id, text: draftPrompt(), context: skillContext(), model: polishModel() });
      request = currentRequest(text);
      if (request.problems.length) throw new Error(request.problems[0]);
    }
    if (type === 'video') await api('POST', '/api/videos', { payload: request.payload, form });
    else if (type === 'image') await api('POST', '/api/images', { payload: request.payload, form: { type, ...studio.image } });
    else await api('POST', `/api/audio/${type}`, { ...request.body, form: { type, ...studio[type] } });
    toast('已提交，正在生成', 'success');
    startHistoryLoop();
  } catch (err) {
    composer.submitError = (err as Error).message;
    composer.submitDetail = (err as ApiError).detail || '';
  } finally {
    composer.submitting = false;
    emit('composer');
  }
}

// 输入框的文本框。点侧栏的「创作」时要把光标放回去。
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
  const { studio } = composer;
  fitModel();
  if (studio.type === 'speech') ensureVoices();

  on('app', () => {
    if (composer.studio.type === 'speech') ensureVoices();
  });
  on('models', () => {
    const info = state.modelsInfo;
    // 选着的型号不在列表里（以前别的平台的型号、已经下线的型号）就换成第一个。
    if (!state.models.includes(composer.form.model) && state.models.length) composer.form.model = state.models[0];
    fitModel();
    if (state.catalog.image.length && !state.catalog.image.includes(composer.studio.image.model)) composer.studio.image.model = state.catalog.image[0];
    fitImage();
    persist();
    if (state.app.hasKey && info.source === 'default' && info.error) toast(`模型列表加载失败，已显示默认模型。${info.error}`, 'error', 6000);
    changed();
  });
}

export function dismissSubmitError() {
  composer.submitError = '';
  emit('composer');
}
