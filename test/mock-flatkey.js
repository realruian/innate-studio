// 模拟 Flatkey 的 Seedance 接口，形状按官方文档写。只用于测试和本地调界面，不会访问外网。
//
// 约定：
// - 提示词里带 REJECT：创建时直接返回 400
// - 提示词里带 FAIL：任务中途变成 failed
// - 其余任务按时间走 queued → in_progress → completed

import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const MOCK_KEY = 'sk-fk-mocktestkey0001';

const hex = (n) => crypto.randomBytes(n).toString('hex');

export function startMock({ port = 0, taskSeconds = 14, assetSeconds = 9, sampleFile = '' } = {}) {
  const tasks = new Map();
  const assets = new Map();
  const persons = new Map();
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

  function taskView(t, base) {
    const age = ageOf(t);
    const view = { id: t.id, object: 'video', model: t.model, created_at: Math.floor(t.start / 1000) };
    if (age < taskSeconds * 0.1) return { ...view, status: 'queued', progress: 0 };
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
          { id: 'seedance-2.0', object: 'model', type: 'video' },
          { id: 'seedance-2.0-fast', object: 'model', type: 'video' },
          { id: 'MiniMax-H3', object: 'model', type: 'video' },
        ],
      });
    }

    if (req.method === 'POST' && pathname === '/v1/videos') {
      const payload = JSON.parse(body.toString() || '{}');
      if (!Array.isArray(payload.content) || !payload.content.length) {
        return json(res, 400, { error: { message: 'content is required', type: 'invalid_request_error', code: 'invalid_request' } });
      }
      const text = payload.content.filter((c) => c.type === 'text').map((c) => c.text).join(' ');
      if (/REJECT/.test(text)) return json(res, 400, { code: 'invalid_request', message: 'unsupported resolution' });
      const id = `task_${hex(16)}`;
      tasks.set(id, { id, model: payload.model, start: Date.now(), fail: /FAIL/.test(text), payload });
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
  const mock = await startMock({ port: Number(process.env.MOCK_PORT) || 5999, sampleFile: process.env.MOCK_SAMPLE || '' });
  console.log(`模拟 Flatkey 已启动：${mock.url}（Key：${MOCK_KEY}）`);
}
