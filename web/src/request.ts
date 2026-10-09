// 把创作表单转成发给本地服务的请求。纯函数，不碰页面和网络，可以单独测试。
// Flatkey 上视频有两种请求格式：Seedance 用 content 数组，Grok 用 prompt 字符串。火山方舟上是另一种，由本地服务换成方舟自己的格式。图片、语音、音效、配乐各有一个小函数。

import { videoFamilyOf, type VideoSpec } from '../../shared/models.ts';
import type { VideoForm, ImageForm, SpeechForm, SfxForm, MusicForm, Ref, RefStatus, BuiltRequest } from './types.ts';

export const RES_RANK: Record<string, number> = { '480p': 0, '720p': 1, '1080p': 2, '2k': 3, '4k': 4 };

const MEDIA_FIELD: Record<string, string> = { image: 'image_url', video: 'video_url', audio: 'audio_url' };

// 认不出来的型号按 Seedance 的格式发。
export const videoFamily = (model?: string) => videoFamilyOf(model) ?? 'seedance';

// 当前模式下实际会用到的参考素材。
export function refsInUse(form: VideoForm): Ref[] {
  if (form.mode === 'frames') return [form.frames.first, form.frames.last].filter((r): r is Ref => Boolean(r));
  if (form.mode === 'reference') return [...form.refs.image, ...form.refs.video, ...form.refs.audio];
  return [];
}

// 换生成方式时把已经添加的图片带过去，不用重新添加。返回换完之后的首尾帧和参考素材。
// 换成首尾帧：首帧空着的话，第一张参考图当首帧。换成参考生成：首帧、尾帧排到参考图的最前面，放不下的留在原处。
// 图是挪过去的，不在原处留一份，免得在一边移除了、换回来又出现。
export function carryRefs(form: VideoForm, mode: VideoForm['mode'], maxImages: number): Pick<VideoForm, 'frames' | 'refs'> {
  const frames = { ...form.frames };
  let images = [...form.refs.image];
  if (mode === 'frames' && !frames.first && images.length) {
    frames.first = images[0];
    images = images.slice(1);
  } else if (mode === 'reference') {
    const same = (a: Ref, b: Ref) => (a.assetId ? a.assetId === b.assetId : a.url === b.url);
    const moved: Ref[] = [];
    for (const key of ['first', 'last'] as const) {
      const ref = frames[key];
      if (!ref) continue;
      const known = [...moved, ...images].some((r) => same(r, ref));
      if (!known && moved.length + images.length >= maxImages) continue;
      if (!known) moved.push(ref);
      frames[key] = null;
    }
    images = [...moved, ...images];
  }
  return { frames, refs: { ...form.refs, image: images } };
}

// 返回 { payload, problems }。problems 非空时不能提交。
// refStatus(ref) 由调用方提供，返回 { ready, tone }，表示素材能否用于当前模型。
export function buildRequest(form: VideoForm, refStatus: (ref: Ref) => RefStatus = () => ({ ready: true, tone: 'ok' })): BuiltRequest {
  if (videoFamily(form.model) === 'grok') return buildGrokRequest(form);
  const problems: string[] = [];
  const content: Record<string, unknown>[] = [];
  const text = form.prompt.trim();
  const media = (ref: Ref, role: string) => ({ type: MEDIA_FIELD[ref.kind], [MEDIA_FIELD[ref.kind]]: { url: ref.url }, role });

  if (text) content.push({ type: 'text', text });

  if (form.mode === 'text') {
    if (!text) problems.push('请输入提示词');
  } else if (form.mode === 'frames') {
    if (form.frames.first) content.push(media(form.frames.first, 'first_frame'));
    else problems.push('请添加首帧图片');
    if (form.frames.last) content.push(media(form.frames.last, 'last_frame'));
  } else {
    for (const ref of form.refs.image) content.push(media(ref, 'reference_image'));
    for (const ref of form.refs.video) content.push(media(ref, 'reference_video'));
    for (const ref of form.refs.audio) content.push(media(ref, 'reference_audio'));
    if (!text && !form.refs.image.length && !form.refs.video.length) {
      problems.push(form.refs.audio.length ? '仅有音频无法生成，请添加提示词、图片或视频' : '请输入提示词，或添加参考图片、视频');
    }
  }

  const statuses = refsInUse(form).map(refStatus);
  // 只存在本机的文件（为 Grok 选的首帧）Seedance 读不到，它只认素材库里的素材和公网链接。
  if (refsInUse(form).some((r) => r.source === 'local')) problems.push('Seedance 不支持本地素材，请移除后重新添加');
  else if (statuses.some((s) => s.tone === 'error')) problems.push('部分素材不可用，请移除后重试');
  else if (statuses.some((s) => !s.ready)) problems.push('部分素材处理中，请稍后重试');

  const payload: Record<string, unknown> = {
    model: form.model,
    content,
    resolution: form.resolution,
    ratio: form.ratio,
    duration: form.durationAuto ? -1 : Number(form.duration),
    generate_audio: Boolean(form.generateAudio),
    watermark: Boolean(form.watermark),
  };

  const seed = String(form.seed).trim();
  if (seed !== '') {
    if (/^-?\d+$/.test(seed)) payload.seed = Number(seed);
    else problems.push('随机种子须为整数');
  }
  if (form.webSearch) payload.web_search = true;
  if (form.inputType !== 'auto') payload.input_type = form.inputType;

  if (form.sr.enabled) {
    const sr: Record<string, unknown> = {};
    if (form.sr.by === 'resolution') {
      sr.resolution = form.sr.resolution;
      if (RES_RANK[form.sr.resolution] <= RES_RANK[form.resolution]) problems.push('超分目标分辨率须高于原始分辨率');
    } else {
      const limit = Number(form.sr.limit);
      if (Number.isInteger(limit) && limit >= 64 && limit <= 2160) sr.resolution_limit = limit;
      else problems.push('超分短边像素须为 64–2160 的整数');
    }
    if (form.sr.scene) sr.scene = form.sr.scene;
    sr.tool_version = form.sr.tool;
    const fps = String(form.sr.fps).trim();
    if (fps !== '') {
      const n = Number(fps);
      if (Number.isInteger(n) && n >= 1 && n <= 120) sr.fps = n;
      else problems.push('超分帧率须为 1–120 的整数');
    }
    payload.super_resolution_config = sr;
  }

  return { payload, problems };
}

// 火山方舟的视频：提示词是 prompt 字符串，首尾帧在 frame_images，参考素材在 input_references，本地服务把它换成方舟自己的 content 数组再发出去。spec 是这个模型支持什么。
// 图片可以用本机的文件（本地服务会把它内嵌进请求）；参考视频和音频只能用公网链接；Flatkey 素材库里的素材这边读不到。
// 2026-10-09 用真实接口跑过：文生视频、首帧、首尾帧、参考图、图加视频加音频的参考生成都能用。platform 是平台的名字，只用在提示里。
export function buildSpecRequest(form: VideoForm, spec: VideoSpec, platform = '火山方舟'): BuiltRequest {
  const problems: string[] = [];
  const text = form.prompt.trim();
  const payload: Record<string, unknown> = { model: form.model, duration: Number(form.duration), resolution: form.resolution };
  if (text) payload.prompt = text;
  const media = (ref: Ref) => ({ type: MEDIA_FIELD[ref.kind], [MEDIA_FIELD[ref.kind]]: { url: ref.url } });

  if (form.mode === 'text') {
    if (!text) problems.push('请输入提示词');
  } else if (form.mode === 'frames') {
    const frames: Record<string, unknown>[] = [];
    if (form.frames.first) frames.push({ ...media(form.frames.first), frame_type: 'first_frame' });
    else problems.push('请添加首帧图片');
    if (form.frames.last && spec.frames.includes('last_frame')) frames.push({ ...media(form.frames.last), frame_type: 'last_frame' });
    payload.frame_images = frames;
  } else {
    const refs = [...form.refs.image, ...form.refs.video, ...form.refs.audio];
    payload.input_references = refs.map(media);
    if (!text && !form.refs.image.length && !form.refs.video.length) {
      problems.push(form.refs.audio.length ? '仅有音频无法生成，请添加提示词、图片或视频' : '请输入提示词，或添加参考图片、视频');
    }
  }
  // 有首帧时画面比例跟着图片走，其余情况才需要指定。
  if (form.mode !== 'frames') payload.aspect_ratio = form.ratio;

  const used = refsInUse(form);
  if (used.some((r) => r.source === 'asset')) problems.push(`${platform} 不支持 Flatkey 素材库的素材，请移除后重新添加`);
  else if (used.some((r) => r.kind === 'video' && r.source === 'local')) problems.push('参考视频仅支持公网链接');

  if (spec.audio) payload.generate_audio = Boolean(form.generateAudio);
  const seed = String(form.seed).trim();
  if (spec.seed && seed !== '') {
    if (/^-?\d+$/.test(seed)) payload.seed = Number(seed);
    else problems.push('随机种子须为整数');
  }
  return { payload, problems };
}

// Grok 视频：只有文生视频和图生视频（给一张首帧）。首帧可以是公网链接，也可以是本机文件，本机文件由本地服务换成内嵌数据再发出去。
function buildGrokRequest(form: VideoForm): BuiltRequest {
  const problems: string[] = [];
  const text = form.prompt.trim();
  const payload: Record<string, unknown> = { model: form.model, prompt: text, duration: Number(form.duration), resolution: form.resolution };
  if (!text) problems.push('请输入提示词');
  if (form.mode === 'reference') problems.push('当前模型不支持参考生成，请改用文生视频或图生视频');

  if (form.mode === 'frames') {
    const first = form.frames.first;
    if (!first) problems.push('请添加首帧图片');
    else if (first.source === 'asset') problems.push('当前模型不支持素材库素材，请移除后重新添加首帧');
    else payload.image = { url: first.url };
  } else {
    // 有首帧时画面比例跟着图片走，只有纯文字生成才需要指定。
    payload.aspect_ratio = form.ratio;
  }
  return { payload, problems };
}

// refLimit 是这个模型最多收几张参考图，0 是不收。参考图只能是本机的图片或公网链接，本地服务会把本机的内嵌进请求。
export function buildImageRequest(form: ImageForm, refLimit = 0): BuiltRequest {
  const prompt = form.prompt.trim();
  const refs = form.refs || [];
  const problems: string[] = [];
  const payload: Record<string, unknown> = { model: form.model, prompt, n: Number(form.count) || 1, aspect_ratio: form.ratio };
  if (form.resolution) payload.resolution = form.resolution;
  if (!prompt) problems.push(refs.length ? '请输入修改要求' : '请输入提示词');
  if (refs.length) {
    if (!refLimit) problems.push(`${form.model} 不支持参考图，请移除参考图或更换模型`);
    else if (refs.length > refLimit) problems.push(`${form.model} 最多支持 ${refLimit} 张参考图`);
    if (refs.some((r) => r.source === 'asset')) problems.push('不支持 Flatkey 素材库的参考图，请移除后重新添加');
    payload.input_references = refs.map((ref) => ({ type: 'image_url', image_url: { url: ref.url } }));
  }
  return { payload, problems };
}

export function buildSpeechRequest(form: SpeechForm): BuiltRequest {
  const text = form.prompt.trim();
  const problems: string[] = [];
  if (!text) problems.push('请输入朗读文本');
  else if (!form.voiceId) problems.push('请选择音色');
  return { body: { text, voiceId: form.voiceId, voiceName: form.voiceName }, problems };
}

export function buildSfxRequest(form: SfxForm): BuiltRequest {
  const text = form.prompt.trim();
  const body: Record<string, unknown> = { text, influence: Number(form.influence) };
  // 时长选"自动"时不传，由模型决定。
  if (form.duration !== 'auto') body.duration = Number(form.duration);
  return { body, problems: text ? [] : ['请输入音效描述'] };
}

export function buildMusicRequest(form: MusicForm): BuiltRequest {
  const video = form.video;
  const problems: string[] = [];
  if (!video) problems.push('请选择视频');
  else if (!((video.duration ?? 0) > 0)) problems.push('无法获取视频时长，请重新选择');
  return { body: { video: video?.url, duration: video?.duration }, problems };
}
