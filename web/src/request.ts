// 把创作表单转成发给本地服务的请求。纯函数，不碰页面和网络，可以单独测试。
// 视频有两种请求格式：Seedance 用 content 数组，Grok 用 prompt 字符串。图片、语音、音效、配乐各有一个小函数。

import { videoFamilyOf } from '../../shared/models.ts';
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
    if (!text) problems.push('请填写提示词');
  } else if (form.mode === 'frames') {
    if (form.frames.first) content.push(media(form.frames.first, 'first_frame'));
    else problems.push('请添加首帧图片');
    if (form.frames.last) content.push(media(form.frames.last, 'last_frame'));
  } else {
    for (const ref of form.refs.image) content.push(media(ref, 'reference_image'));
    for (const ref of form.refs.video) content.push(media(ref, 'reference_video'));
    for (const ref of form.refs.audio) content.push(media(ref, 'reference_audio'));
    if (!text && !form.refs.image.length && !form.refs.video.length) {
      problems.push(form.refs.audio.length ? '只有音频不够，还需要提示词、图片或视频' : '请填写提示词，或添加参考图片、视频');
    }
  }

  const statuses = refsInUse(form).map(refStatus);
  // 只存在本机的文件（为 Grok 选的首帧）Seedance 读不到，它只认素材库里的素材和公网链接。
  if (refsInUse(form).some((r) => r.source === 'local')) problems.push('有素材只存在本机，Seedance 用不了，请移除后重新添加');
  else if (statuses.some((s) => s.tone === 'error')) problems.push('有素材不可用，请移除后再生成');
  else if (statuses.some((s) => !s.ready)) problems.push(`有素材还在处理中，可用于 ${form.model} 后才能生成`);

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
    else problems.push('随机种子需要是整数');
  }
  if (form.webSearch) payload.web_search = true;
  if (form.inputType !== 'auto') payload.input_type = form.inputType;

  if (form.sr.enabled) {
    const sr: Record<string, unknown> = {};
    if (form.sr.by === 'resolution') {
      sr.resolution = form.sr.resolution;
      if (RES_RANK[form.sr.resolution] <= RES_RANK[form.resolution]) problems.push('超分的目标分辨率必须高于原始分辨率');
    } else {
      const limit = Number(form.sr.limit);
      if (Number.isInteger(limit) && limit >= 64 && limit <= 2160) sr.resolution_limit = limit;
      else problems.push('超分的短边像素需要是 64 到 2160 之间的整数');
    }
    if (form.sr.scene) sr.scene = form.sr.scene;
    sr.tool_version = form.sr.tool;
    const fps = String(form.sr.fps).trim();
    if (fps !== '') {
      const n = Number(fps);
      if (Number.isInteger(n) && n >= 1 && n <= 120) sr.fps = n;
      else problems.push('超分的帧率需要是 1 到 120 之间的整数');
    }
    payload.super_resolution_config = sr;
  }

  return { payload, problems };
}

// Grok 视频：只有文生视频和图生视频（给一张首帧）。首帧可以是公网链接，也可以是本机文件，本机文件由本地服务换成内嵌数据再发出去。
function buildGrokRequest(form: VideoForm): BuiltRequest {
  const problems: string[] = [];
  const text = form.prompt.trim();
  const payload: Record<string, unknown> = { model: form.model, prompt: text, duration: Number(form.duration), resolution: form.resolution };
  if (!text) problems.push('请填写提示词');
  if (form.mode === 'reference') problems.push('这个模型不支持参考生成，请改用文生视频或图生视频');

  if (form.mode === 'frames') {
    const first = form.frames.first;
    if (!first) problems.push('请添加首帧图片');
    else if (first.source === 'asset') problems.push('这个模型用不了素材库里的素材，请移除后重新添加首帧');
    else payload.image = { url: first.url };
  } else {
    // 有首帧时画面比例跟着图片走，只有纯文字生成才需要指定。
    payload.aspect_ratio = form.ratio;
  }
  return { payload, problems };
}

export function buildImageRequest(form: ImageForm): BuiltRequest {
  const prompt = form.prompt.trim();
  return {
    payload: { model: form.model, prompt, n: Number(form.count) || 1, aspect_ratio: form.ratio },
    problems: prompt ? [] : ['请填写提示词'],
  };
}

export function buildSpeechRequest(form: SpeechForm): BuiltRequest {
  const text = form.prompt.trim();
  const problems: string[] = [];
  if (!text) problems.push('请填写要朗读的文字');
  else if (!form.voiceId) problems.push('请选择音色');
  return { body: { text, voiceId: form.voiceId, voiceName: form.voiceName }, problems };
}

export function buildSfxRequest(form: SfxForm): BuiltRequest {
  const text = form.prompt.trim();
  const body: Record<string, unknown> = { text, influence: Number(form.influence) };
  // 时长选"自动"时不传，由模型决定。
  if (form.duration !== 'auto') body.duration = Number(form.duration);
  return { body, problems: text ? [] : ['请描述想要的声音'] };
}

export function buildMusicRequest(form: MusicForm): BuiltRequest {
  const video = form.video;
  const problems: string[] = [];
  if (!video) problems.push('请选择要配乐的视频');
  else if (!((video.duration ?? 0) > 0)) problems.push('没有读到这段视频的时长，请重新选择');
  return { body: { video: video?.url, duration: video?.duration }, problems };
}
