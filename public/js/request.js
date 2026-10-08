// 把创作表单转成 POST /v1/videos 的请求体。纯函数，不碰页面和网络，可以单独测试。

export const RES_RANK = { '480p': 0, '720p': 1, '1080p': 2, '2k': 3, '4k': 4 };

const MEDIA_FIELD = { image: 'image_url', video: 'video_url', audio: 'audio_url' };

// 当前模式下实际会用到的参考素材。
export function refsInUse(form) {
  if (form.mode === 'frames') return [form.frames.first, form.frames.last].filter(Boolean);
  if (form.mode === 'reference') return [...form.refs.image, ...form.refs.video, ...form.refs.audio];
  return [];
}

// 返回 { payload, problems }。problems 非空时不能提交。
// refStatus(ref) 由调用方提供，返回 { ready, tone }，表示素材能否用于当前模型。
export function buildRequest(form, refStatus = () => ({ ready: true, tone: 'ok' })) {
  const problems = [];
  const content = [];
  const text = form.prompt.trim();
  const media = (ref, role) => ({ type: MEDIA_FIELD[ref.kind], [MEDIA_FIELD[ref.kind]]: { url: ref.url }, role });

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
  if (statuses.some((s) => s.tone === 'error')) problems.push('有素材不可用，请移除后再生成');
  else if (statuses.some((s) => !s.ready)) problems.push(`有素材还在处理中，可用于 ${form.model} 后才能生成`);

  const payload = {
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
    const sr = {};
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
