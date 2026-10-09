// 模拟 OpenRouter 的视频、图片、语音接口，形状按它的文档和 2026-10-09 的实测结果写。只用于测试，不会访问外网。
// 地址里没有 /api 前缀：真实的接口地址是 https://openrouter.ai/api，这里的 url 对应的就是带着 /api 的那一段。
//
// 约定：
// - 提示词里带 REJECT：创建时直接返回 400
// - 提示词里带 FAIL：任务变成 failed
// - 其余任务按时间走 pending → in_progress → completed
// - 参考视频、音频不是 https 链接：返回 400（和真实接口一样）
// - 生图的提示词里带 FAIL：返回 500

import http from 'node:http';
import crypto from 'node:crypto';

export const MOCK_OR_KEY = 'sk-or-v1-mocktestkey0001';

const VIDEO_MODELS = [
  { id: 'google/veo-3.1-lite', supported_resolutions: ['720p', '1080p'], supported_aspect_ratios: ['16:9', '9:16'], supported_durations: [8, 4, 6], supported_frame_images: ['first_frame', 'last_frame'], generate_audio: true, seed: true },
  { id: 'bytedance/seedance-2.0', supported_resolutions: ['480p', '720p', '1080p', '4K'], supported_aspect_ratios: ['16:9', '9:16', '1:1'], supported_durations: [4, 5, 6], supported_frame_images: ['first_frame', 'last_frame'], generate_audio: true, seed: true },
  { id: 'bytedance/seedance-2.5', supported_resolutions: ['480p', '720p'], supported_aspect_ratios: ['16:9', '9:16', '1:1', '21:9'], supported_durations: [4, 5, 6, 10, 30], supported_frame_images: ['first_frame', 'last_frame'], generate_audio: true, seed: true },
  { id: 'x-ai/grok-imagine-video', supported_resolutions: ['480p', '720p'], supported_aspect_ratios: ['16:9', '9:16'], supported_durations: [1, 5, 15], supported_frame_images: ['first_frame'], generate_audio: null, seed: null },
  // 视频放大工具：没有分辨率和时长，不该出现在生成模型里。
  { id: 'black-forest-labs/flux-video-upscale', supported_resolutions: null, supported_aspect_ratios: null, supported_durations: null, supported_frame_images: null },
];
const TEXT_MODELS = ['anthropic/claude-haiku-5.5', 'x-ai/grok-4.7', 'openai/gpt-6-sol'];
const ratios = (...values) => ({ aspect_ratio: { type: 'enum', values } });
const IMAGE_MODELS = [
  { id: 'google/gemini-3-pro-image', name: 'Google: Nano Banana Pro (Gemini 3 Pro Image)', supported_parameters: { ...ratios('1:1', '16:9', '9:16'), n: { type: 'range', min: 1, max: 1 }, input_references: { type: 'range', min: 0, max: 14 } } },
  { id: 'x-ai/grok-imagine-image-2.0', supported_parameters: { ...ratios('1:1', '16:9', '3:2'), n: { type: 'range', min: 1, max: 1 }, input_references: { type: 'range', min: 0, max: 3 } } },
  // 不收画面比例的模型。
  { id: 'recraft/recraft-v4', supported_parameters: {} },
];
const SPEECH_MODELS = [
  { id: 'elevenlabs/eleven-multilingual-v2', supported_voices: ['george', 'sarah'] },
  { id: 'google/gemini-3.8-flash-tts', supported_voices: ['Kore'] },
];
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

export function startMock({ port = 0, taskSeconds = 14 } = {}) {
  const tasks = new Map();
  const log = [];

  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
    });

  function taskView(t, base) {
    const age = (Date.now() - t.start) / 1000;
    const view = { id: t.id, generation_id: t.id, polling_url: `${base}/v1/videos/${t.id}` };
    if (age < taskSeconds * 0.1) return { ...view, status: 'pending' };
    if (t.fail) return { ...view, status: 'failed', error: 'Content policy violation' };
    if (age < taskSeconds) return { ...view, status: 'in_progress' };
    return { ...view, status: 'completed', unsigned_urls: [`${base}/v1/videos/${t.id}/content?index=0`], usage: { cost: 0.415481, is_byok: false } };
  }

  const server = http.createServer(async (req, res) => {
    const { pathname, searchParams } = new URL(req.url, 'http://mock');
    const base = `http://127.0.0.1:${server.address().port}`;
    const body = await readBody(req);
    const authed = req.headers.authorization === `Bearer ${MOCK_OR_KEY}`;
    log.push({ method: req.method, pathname, authed, body: body.toString('utf8') });
    if (!authed) return json(res, 401, { error: { message: 'No auth credentials found', code: 401 } });

    if (req.method === 'GET' && pathname === '/v1/videos/models') return json(res, 200, { data: VIDEO_MODELS });
    if (req.method === 'GET' && pathname === '/v1/models') return json(res, 200, { data: searchParams.get('output_modalities') === 'speech' ? SPEECH_MODELS : TEXT_MODELS.map((id) => ({ id })) });
    if (req.method === 'GET' && pathname === '/v1/images/models') return json(res, 200, { data: IMAGE_MODELS });

    // 和真实接口一样：一次只出一张，图片是 base64，费用在 usage.cost 里。
    if (req.method === 'POST' && pathname === '/v1/images') {
      const payload = JSON.parse(body.toString('utf8'));
      if (/FAIL/.test(payload.prompt || '')) return json(res, 500, { error: { message: 'Image generation failed', code: 500 } });
      return json(res, 200, { created: Math.floor(Date.now() / 1000), data: [{ b64_json: PNG.toString('base64'), media_type: 'image/png' }], usage: { cost: 0.06 } });
    }

    // 语音直接返回音频内容，不是 JSON。
    if (req.method === 'POST' && pathname === '/v1/audio/speech') {
      const payload = JSON.parse(body.toString('utf8'));
      if (!payload.voice) return json(res, 400, { error: { message: 'voice is required', code: 400 } });
      const bytes = Buffer.from(`mock mp3 ${payload.voice}`);
      res.writeHead(200, { 'Content-Type': payload.response_format === 'mp3' ? 'audio/mpeg' : 'audio/pcm', 'Content-Length': bytes.length });
      return res.end(bytes);
    }
    if (req.method === 'GET' && pathname === '/v1/credits') return json(res, 200, { data: { total_credits: 30, total_usage: 4.5 } });

    if (req.method === 'POST' && pathname === '/v1/videos') {
      const payload = JSON.parse(body.toString('utf8'));
      if (/REJECT/.test(payload.prompt || '')) return json(res, 400, { error: { message: 'Invalid request', code: 400 } });
      for (const [index, ref] of (payload.input_references || []).entries()) {
        const url = (ref.video_url || ref.audio_url)?.url;
        if (url !== undefined && !/^https:\/\//.test(url)) return json(res, 400, { error: { message: `Invalid reference URL: input_references[${index}]: Only HTTPS URLs are allowed`, code: 400 } });
      }
      const id = `gen-vid-${Math.floor(Date.now() / 1000)}-${crypto.randomBytes(10).toString('hex')}`;
      tasks.set(id, { id, start: Date.now(), fail: /FAIL/.test(payload.prompt || ''), payload });
      return json(res, 202, taskView(tasks.get(id), base));
    }

    const content = /^\/v1\/videos\/([\w-]+)\/content$/.exec(pathname);
    if (req.method === 'GET' && content && tasks.has(content[1])) {
      const bytes = Buffer.from(`mock openrouter video ${content[1]}`);
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bytes.length });
      return res.end(bytes);
    }

    const task = /^\/v1\/videos\/([\w-]+)$/.exec(pathname);
    if (req.method === 'GET' && task) {
      if (!tasks.has(task[1])) return json(res, 404, { error: { message: 'Job not found', code: 404 } });
      return json(res, 200, taskView(tasks.get(task[1]), base));
    }

    if (req.method === 'POST' && pathname === '/v1/chat/completions') {
      const { model, messages } = JSON.parse(body.toString('utf8'));
      return json(res, 200, { model, choices: [{ message: { role: 'assistant', content: `润色后的：${messages.at(-1).content}` } }] });
    }

    json(res, 404, { error: { message: `no route ${req.method} ${pathname}`, code: 404 } });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({ port: server.address().port, url: `http://127.0.0.1:${server.address().port}`, log, tasks, close: () => new Promise((done) => server.close(done)) });
    });
  });
}
