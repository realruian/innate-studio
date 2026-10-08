// 模拟 Flatkey 的 Seedance 接口，形状按官方文档写。只用于测试和本地调界面，不会访问外网。
//
// 约定：
// - 提示词里带 REJECT：创建时直接返回 400
// - 提示词里带 FAIL：任务中途变成 failed
// - 提示词里带 STUCK：任务一直停在 in_progress（把 tasks 里这条的 stuck 改成 false 才会继续）
// - 其余任务按时间走 queued → in_progress → completed
// - 生图的提示词里带 FAIL：返回 500
// - 润色的草稿里带 LIMITED：claude-haiku-5-5 返回 429，其他模型正常
// 除了视频，还模拟了生图、语音、音效、配乐、对话（润色用）和余额这几个接口。

import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const MOCK_KEY = 'sk-fk-mocktestkey0001';

const hex = (n) => crypto.randomBytes(n).toString('hex');

// sampleFile、imageFile、audioFile：生成结果用这几个真实文件代替占位内容，调界面时才看得到画面、听得到声音。
export function startMock({ port = 0, taskSeconds = 14, assetSeconds = 9, sampleFile = '', imageFile = '', audioFile = '' } = {}) {
  const tasks = new Map();
  const assets = new Map();
  const persons = new Map();
  const music = new Map();
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
  const ageOf = (item) => (Date.now() - item.start) / 1000;
  const sample = (file, fallback) => (file && fs.existsSync(file) ? fs.readFileSync(file) : Buffer.from(fallback));
  const sendAudio = (res, fallback) => {
    const bytes = sample(audioFile, fallback);
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': bytes.length });
    res.end(bytes);
  };

  function taskView(t, base) {
    const age = ageOf(t);
    const view = { id: t.id, object: 'video', model: t.model, created_at: Math.floor(t.start / 1000) };
    if (age < taskSeconds * 0.1) return { ...view, status: 'queued', progress: 0 };
    if (t.stuck) return { ...view, status: 'in_progress', progress: 50 };
    if (t.fail && age >= taskSeconds * 0.4) {
      return { ...view, status: 'failed', error: { message: '视频生成任务失败。', code: 'video_generation_failed' } };
    }
    if (age < taskSeconds) return { ...view, status: 'in_progress', progress: Math.min(99, Math.round((age / taskSeconds) * 100)) };
    return {
      ...view,
      status: 'completed',
      progress: 100,
      usage: { completion_tokens: 120, total_tokens: 120 },
      metadata: { url: `${base}/v1/videos/${t.id}/content` },
      completed_at: Math.floor((t.start + taskSeconds * 1000) / 1000),
    };
  }

  function assetView(a) {
    const age = ageOf(a);
    const view = { id: a.id, object: 'asset', asset_type: a.asset_type, asset_url: `asset://${a.id}`, created_at: Math.floor(a.start / 1000) };
    if (a.person) return { ...view, name: a.name, asset_uri: view.asset_url, status: age < assetSeconds * 0.6 ? 'Processing' : 'Active' };
    if (age < assetSeconds * 0.4) return { ...view, status: 'Processing', available_models: [] };
    // 和真实接口一样：视频素材的汇总状态会是 Failed（有的模型没准备好），但列在 available_models 里的模型照样能用。
    if (a.asset_type === 'Video' || /汇总失败/.test(a.name || '')) return { ...view, status: 'Failed', available_models: ['seedance-2.0', 'seedance-2.0-fast'] };
    if (age < assetSeconds) return { ...view, status: 'Processing', available_models: ['seedance-2.0-fast'] };
    return { ...view, status: 'Active', available_models: ['seedance-2.0', 'seedance-2.0-fast'] };
  }

  const personView = (p) => ({
    id: p.id,
    object: 'real_person',
    name: p.name,
    status: ageOf(p) < assetSeconds ? 'pending_verification' : 'active',
    created_at: Math.floor(p.start / 1000),
  });

  const multipartField = (body, name) => (new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`).exec(body.toString('latin1')) || [])[1] || '';

  const server = http.createServer(async (req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const { pathname } = new URL(req.url, base);
    const body = await readBody(req);
    const auth = req.headers.authorization || '';
    log.push({ method: req.method, path: pathname, auth, idempotencyKey: req.headers['idempotency-key'] || '', contentType: req.headers['content-type'] || '', size: body.length });

    let m;
    // 视频内容地址不需要鉴权，和真实接口一致。
    if (req.method === 'GET' && (m = /^\/v1\/videos\/([\w-]+)\/content$/.exec(pathname))) {
      if (sampleFile && fs.existsSync(sampleFile)) {
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': fs.statSync(sampleFile).size });
        return fs.createReadStream(sampleFile).pipe(res);
      }
      const bytes = Buffer.from(`mock mp4 for ${m[1]}`);
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bytes.length });
      return res.end(bytes);
    }

    if (auth !== `Bearer ${MOCK_KEY}`) {
      return json(res, 401, { error: { message: 'Invalid API key provided.', type: 'authentication_error', code: 'invalid_api_key' } });
    }

    if (req.method === 'GET' && pathname === '/v1/models') {
      return json(res, 200, {
        object: 'list',
        data: [
          { id: 'gpt-4o', object: 'model', type: 'text' },
          { id: 'claude-haiku-5-5', object: 'model', type: 'text' },
          { id: 'claude-sonnet-5-5', object: 'model', type: 'text' },
          { id: 'seedance-2.0', object: 'model', type: 'video', supported_endpoint_types: ['openai-video'] },
          { id: 'seedance-2.0-fast', object: 'model', type: 'video', supported_endpoint_types: ['openai-video'] },
          // 和真实接口一样：这个型号接在另一个接口上，POST /v1/videos 用不了。
          { id: 'seedance2.0-pro', object: 'model', type: 'video', supported_endpoint_types: ['video'] },
          { id: 'grok-imagine-video', object: 'model', type: 'video', supported_endpoint_types: ['openai-video'] },
          { id: 'MiniMax-H3', object: 'model', type: 'video', supported_endpoint_types: ['openai-video'] },
          // 和真实接口一样：列表里有两个图片模型，但只有标了 image-generation 的那个能生图。
          { id: 'grok-imagine-image', object: 'model', type: 'image', supported_endpoint_types: ['openai'] },
          { id: 'grok-imagine-image-2.0', object: 'model', type: 'image', supported_endpoint_types: ['image-generation', 'openai'] },
          { id: 'eleven_multilingual_v2', object: 'model', type: 'audio' },
          { id: 'eleven_sound_v1', object: 'model', type: 'audio' },
          { id: 'sonilo-video-to-music', object: 'model', type: 'audio' },
        ],
      });
    }

    if (req.method === 'GET' && pathname === '/v1/credits') return json(res, 200, { remaining: 34.18, used: 185.13 });

    if (req.method === 'POST' && pathname === '/v1/images/generations') {
      const payload = JSON.parse(body.toString() || '{}');
      if (/FAIL/.test(payload.prompt || '')) return json(res, 500, { error: { message: 'image generation failed', code: 'server_error' } });
      const count = payload.n || 1;
      // 没给示例图时用一张 1×1 的 PNG。
      const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
      const real = imageFile && fs.existsSync(imageFile);
      const image = { b64_json: real ? fs.readFileSync(imageFile).toString('base64') : pixel, mime_type: real && /\.jpe?g$/i.test(imageFile) ? 'image/jpeg' : 'image/png' };
      return json(res, 200, { data: Array.from({ length: count }, () => image), usage: { cost_in_usd_ticks: 400000000 * count } });
    }

    if (req.method === 'GET' && pathname === '/v1/voices') {
      return json(res, 200, {
        voices: [
          { voice_id: 'voiceEnRoger01', name: 'Roger - Laid-Back, Casual', labels: { gender: 'male', language: 'en', accent: 'american' }, preview_url: `${base}/preview/roger.mp3` },
          { voice_id: 'voiceZhAnson02', name: 'Anson - Clear Young Baritone', labels: { gender: 'male', language: 'zh', accent: 'beijing mandarin' }, preview_url: `${base}/preview/anson.mp3` },
        ],
      });
    }
    if (req.method === 'POST' && (/^\/v1\/text-to-speech\/[\w-]+$/.test(pathname) || pathname === '/v1/sound-generation')) {
      const payload = JSON.parse(body.toString() || '{}');
      if (!payload.text) return json(res, 422, { error: { message: 'text is required', code: 'invalid_request' } });
      return sendAudio(res, `mock mp3: ${payload.text}`);
    }

    if (req.method === 'POST' && pathname === '/v1/video-to-music') {
      if (!/^multipart\/form-data/.test(req.headers['content-type'] || '')) return json(res, 400, { code: 'invalid_content_type', message: 'content type must be multipart/form-data' });
      const seconds = Number(multipartField(body, 'duration_seconds'));
      if (!(seconds > 0)) return json(res, 400, { code: 'invalid_duration_seconds', message: 'duration_seconds must be a positive number' });
      if (!/name="video"; filename=/.test(body.toString('latin1'))) return json(res, 400, { code: 'invalid_video_source', message: 'exactly one of video or video_url is required' });
      const id = `task_${hex(16)}`;
      music.set(id, { id, start: Date.now(), seconds });
      return json(res, 200, { id, task_id: id, status: 'processing', model: 'sonilo-video-to-music', created_at: Math.floor(Date.now() / 1000) });
    }
    if (req.method === 'GET' && (m = /^\/v1\/video-to-music\/([\w-]+)(\/content)?$/.exec(pathname))) {
      const task = music.get(m[1]);
      if (!task) return json(res, 400, { code: 'task_not_exist', message: 'task_not_exist' });
      if (m[2]) return sendAudio(res, `mock music for ${task.id}`);
      const view = { id: task.id, task_id: task.id, model: 'sonilo-video-to-music', created_at: Math.floor(task.start / 1000) };
      if (ageOf(task) < taskSeconds) return json(res, 200, { ...view, status: 'processing' });
      return json(res, 200, { ...view, status: 'succeeded', duration_seconds: task.seconds, audio: [{ url: `${base}/v1/video-to-music/${task.id}/content?variant=0`, content_type: 'audio/mpeg' }] });
    }

    if (req.method === 'POST' && pathname === '/v1/chat/completions') {
      const payload = JSON.parse(body.toString() || '{}');
      const draft = payload.messages?.at(-1)?.content || '';
      log.at(-1).system = payload.messages?.[0]?.content || '';
      // 草稿里带 LIMITED 时，haiku 这个模型被限流，其他模型正常。
      if (/LIMITED/.test(draft) && payload.model === 'claude-haiku-5-5') return json(res, 429, { error: { message: 'Upstream rate limit exceeded, please retry later', type: 'rate_limit_error' } });
      return json(res, 200, { model: payload.model, choices: [{ index: 0, message: { role: 'assistant', content: `${draft}，镜头缓慢推进，柔和的晨光` }, finish_reason: 'stop' }] });
    }

    if (req.method === 'POST' && pathname === '/v1/videos') {
      const payload = JSON.parse(body.toString() || '{}');
      // 两种请求格式，各模型只认一种：Grok 用 prompt 字符串，其余用 content 数组。
      const grok = /^grok-imagine-video/.test(payload.model || '');
      if (grok && !payload.prompt) return json(res, 400, { code: 'invalid_request', message: 'prompt is required' });
      if (grok && !(payload.duration >= 1 && payload.duration <= 15)) return json(res, 400, { code: 'invalid_request', message: 'duration must be between 1 and 15' });
      if (!grok && (!Array.isArray(payload.content) || !payload.content.length)) {
        return json(res, 400, { error: { message: 'content is required', type: 'invalid_request_error', code: 'invalid_request' } });
      }
      const text = grok ? payload.prompt : payload.content.filter((c) => c.type === 'text').map((c) => c.text).join(' ');
      if (/REJECT/.test(text)) return json(res, 400, { code: 'invalid_request', message: 'unsupported resolution' });
      const id = `task_${hex(16)}`;
      tasks.set(id, { id, model: payload.model, start: Date.now(), fail: /FAIL/.test(text), stuck: /STUCK/.test(text), payload });
      return json(res, 200, { id, task_id: id, object: 'video', model: payload.model, status: 'queued', progress: 0, created_at: Math.floor(Date.now() / 1000) });
    }
    if (req.method === 'GET' && (m = /^\/v1\/videos\/([\w-]+)$/.exec(pathname))) {
      const task = tasks.get(m[1]);
      if (!task) return json(res, 404, { error: { message: 'task not found', code: 'task_not_found' } });
      return json(res, 200, taskView(task, base));
    }

    if (req.method === 'POST' && (pathname === '/v1/assets' || pathname === '/v1/assets/upload')) {
      const type = pathname === '/v1/assets' ? JSON.parse(body.toString()).asset_type || 'Image' : multipartField(body, 'asset_type') || 'Image';
      const id = `ast_${hex(16)}`;
      assets.set(id, { id, asset_type: type, start: Date.now() });
      return json(res, 200, assetView(assets.get(id)));
    }
    if ((m = /^\/v1\/assets\/([\w-]+)$/.exec(pathname))) {
      const asset = assets.get(m[1]);
      if (!asset) return json(res, 404, { error: { message: 'asset not found', code: 'asset_not_found' } });
      if (req.method === 'DELETE') {
        assets.delete(m[1]);
        res.writeHead(204);
        return res.end();
      }
      return json(res, 200, assetView(asset));
    }

    const needsKey = () => json(res, 400, { error: { message: 'Idempotency-Key is required', code: 'missing_idempotency_key' } });

    if (pathname === '/v1/real-persons' && req.method === 'GET') {
      return json(res, 200, { object: 'list', data: [...persons.values()].map(personView) });
    }
    if (pathname === '/v1/real-persons' && req.method === 'POST') {
      if (!req.headers['idempotency-key']) return needsKey();
      const id = `rph_${hex(8)}`;
      persons.set(id, { id, name: JSON.parse(body.toString()).name, start: Date.now() });
      return json(res, 200, { ...personView(persons.get(id)), verification_url: `https://verify.example.com/s/${hex(6)}` });
    }
    if ((m = /^\/v1\/real-persons\/([\w-]+)$/.exec(pathname)) && req.method === 'GET') {
      const person = persons.get(m[1]);
      if (!person) return json(res, 404, { error: { message: 'not found', code: 'real_person_not_found' } });
      return json(res, 200, personView(person));
    }
    if ((m = /^\/v1\/real-persons\/([\w-]+)\/verification-sessions$/.exec(pathname)) && req.method === 'POST') {
      if (!req.headers['idempotency-key']) return needsKey();
      return json(res, 200, { verification_url: `https://verify.example.com/s/${hex(6)}` });
    }
    if ((m = /^\/v1\/real-persons\/([\w-]+)\/assets$/.exec(pathname))) {
      if (req.method === 'GET') {
        return json(res, 200, { object: 'list', data: [...assets.values()].filter((a) => a.person === m[1]).map(assetView) });
      }
      if (!req.headers['idempotency-key']) return needsKey();
      let type;
      let name;
      if (/json/.test(req.headers['content-type'] || '')) {
        ({ asset_type: type, name } = JSON.parse(body.toString()));
      } else {
        type = multipartField(body, 'asset_type');
        name = Buffer.from(multipartField(body, 'name'), 'latin1').toString('utf8');
      }
      const id = `ast_${hex(16)}`;
      assets.set(id, { id, asset_type: type || 'Image', name: name || '', person: m[1], start: Date.now() });
      return json(res, 200, assetView(assets.get(id)));
    }

    json(res, 404, { error: { message: `no route ${req.method} ${pathname}`, code: 'not_found' } });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        url: `http://127.0.0.1:${server.address().port}`,
        log,
        tasks,
        assets,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

// 直接运行：node test/mock-flatkey.js
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mock = await startMock({ port: Number(process.env.MOCK_PORT) || 5999, sampleFile: process.env.MOCK_SAMPLE || '', imageFile: process.env.MOCK_IMAGE || '', audioFile: process.env.MOCK_AUDIO || '' });
  console.log(`模拟 Flatkey 已启动：${mock.url}（Key：${MOCK_KEY}）`);
}
