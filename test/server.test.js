// 把真实的 server.js 跑起来，上游换成模拟接口，走一遍主要流程。

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock, MOCK_KEY } from './mock-flatkey.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let mock;
let app;
let base;
let dataDir;

const freePort = () =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

async function waitFor(check, what, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await check();
      if (last) return last;
    } catch {
      /* 还没准备好，继续等 */
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`等待超时：${what}`);
}

async function call(method, url, body, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(base + url, init);
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

const textPayload = (text, extra = {}) => ({ model: 'seedance-2.0', content: [{ type: 'text', text }], resolution: '480p', ratio: '16:9', duration: 4, ...extra });

// 反复让服务去查上游，直到这条记录满足条件。
const refreshUntil = (id, done, what) =>
  waitFor(async () => {
    const { data } = await call('POST', `/api/history/${id}/refresh`);
    return done(data) ? data : null;
  }, what);

before(async () => {
  mock = await startMock({ taskSeconds: 0.5, assetSeconds: 0.5 });
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seedance-test-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, ['server.js'], {
    cwd: root,
    stdio: 'ignore',
    // FLATKEY_API_KEY 置空：即使本机设置了真实 Key，测试也绝不会用到它。
    env: { ...process.env, PORT: String(port), FLATKEY_BASE_URL: mock.url, SEEDANCE_DATA_DIR: dataDir, FLATKEY_API_KEY: '' },
  });
  await waitFor(async () => (await fetch(`${base}/api/state`)).ok, '服务启动');
});

after(async () => {
  app?.kill();
  await mock?.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('没有 Key：状态为未设置，创建任务被拒绝', async () => {
  const state = await call('GET', '/api/state');
  assert.equal(state.data.hasKey, false);
  assert.equal(state.data.baseUrl, mock.url);

  const created = await call('POST', '/api/videos', { payload: textPayload('一只猫') });
  assert.equal(created.status, 401);
  assert.equal(created.data.error.code, 'no_api_key');
});

test('保存 Key：拒绝不是 Key 的内容，接受正常的 Key，且不回显完整内容', async () => {
  for (const bad of ['行，帮我编译安装吧', 'sk-fk abc', '']) {
    const res = await call('PUT', '/api/key', { apiKey: bad });
    assert.equal(res.status, 400, `应该拒绝：${bad}`);
    assert.equal(res.data.error.code, 'invalid_key');
  }
  const saved = await call('PUT', '/api/key', { apiKey: MOCK_KEY });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.hasKey, true);
  assert.equal(JSON.stringify(saved.data).includes(MOCK_KEY), false);
});

test('模型列表只保留 Seedance 模型', async () => {
  const { data } = await call('GET', '/api/models');
  assert.equal(data.source, 'remote');
  assert.deepEqual(data.models, ['seedance-2.0', 'seedance-2.0-fast']);
});

test('页面能打开，目录穿越和跨站请求被拦截', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.equal((await fetch(`${base}/%2e%2e/server.js`)).status, 404);

  const crossSite = await call('POST', '/api/videos', { payload: textPayload('x') }, { Origin: 'https://evil.example' });
  assert.equal(crossSite.status, 403);

  const notJson = await fetch(`${base}/api/videos`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(notJson.status, 415);
});

test('文生视频：创建 → 轮询 → 完成 → 视频存到本机', async () => {
  const payload = textPayload('清晨的厨房，镜头缓慢推进', { generate_audio: true, watermark: false });
  const created = await call('POST', '/api/videos', { payload, form: { mode: 'text' } });
  assert.equal(created.status, 200);
  assert.equal(created.data.status, 'queued');
  assert.match(created.data.id, /^task_/);

  // 上游收到的请求体和 Key 与我们发的一致。
  assert.deepEqual(mock.tasks.get(created.data.id).payload, payload);
  assert.equal(mock.log.find((l) => l.method === 'POST' && l.path === '/v1/videos').auth, `Bearer ${MOCK_KEY}`);

  const done = await refreshUntil(created.data.id, (item) => item.status === 'completed' && item.savedLocally, '任务完成并保存到本机');
  assert.equal(done.progress, 100);
  assert.equal(done.usage.total_tokens, 120);
  assert.match(done.videoUrl, /^\/media\/videos\/task_[\w]+\.mp4$/);
  assert.ok(fs.existsSync(path.join(dataDir, 'videos', done.localFile)));

  const ranged = await fetch(base + done.videoUrl, { headers: { Range: 'bytes=0-3' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-type'), 'video/mp4');
  assert.equal((await ranged.arrayBuffer()).byteLength, 4);

  const history = await call('GET', '/api/history');
  assert.equal(history.data.items[0].id, created.data.id);
  assert.deepEqual(history.data.items[0].form, { mode: 'text' });
  assert.ok(JSON.parse(fs.readFileSync(path.join(dataDir, 'history.json'), 'utf8')).some((i) => i.id === created.data.id));
});

test('上游拒绝请求：把原因带回来，不留记录', async () => {
  const before = (await call('GET', '/api/history')).data.items.length;
  const res = await call('POST', '/api/videos', { payload: textPayload('REJECT 这条会被拒绝') });
  assert.equal(res.status, 400);
  assert.match(res.data.error.message, /unsupported resolution/);
  assert.equal((await call('GET', '/api/history')).data.items.length, before);
});

test('任务中途失败：记录失败原因', async () => {
  const created = await call('POST', '/api/videos', { payload: textPayload('FAIL 这条会失败') });
  const failed = await refreshUntil(created.data.id, (item) => item.status === 'failed', '任务变成失败');
  assert.equal(failed.error.code, 'video_generation_failed');
  assert.ok(failed.error.message);
  assert.equal(failed.videoUrl, null);
});

test('删除记录：同时删掉本机的视频文件', async () => {
  const created = await call('POST', '/api/videos', { payload: textPayload('用来删除的一条') });
  const done = await refreshUntil(created.data.id, (item) => item.savedLocally, '视频保存到本机');
  const file = path.join(dataDir, 'videos', done.localFile);
  assert.ok(fs.existsSync(file));

  assert.equal((await call('DELETE', `/api/history/${created.data.id}`)).status, 204);
  assert.equal(fs.existsSync(file), false);
  assert.equal((await call('GET', '/api/history')).data.items.some((i) => i.id === created.data.id), false);
});

test('素材：用链接创建，轮询到可用', async () => {
  assert.equal((await call('POST', '/api/assets', { url: 'http://not-https/a.png', asset_type: 'Image' })).status, 400);

  const created = await call('POST', '/api/assets', { url: 'https://cdn.example.com/a.mp4', asset_type: 'Video', name: '背景视频' });
  assert.equal(created.status, 200);
  assert.equal(created.data.status, 'Processing');
  assert.equal(created.data.asset_url, `asset://${created.data.id}`);
  assert.equal(created.data.name, '背景视频');

  const active = await waitFor(async () => {
    const { data } = await call('GET', `/api/assets/${created.data.id}`);
    return data.status === 'Active' ? data : null;
  }, '素材变成 Active');
  assert.deepEqual(active.available_models, ['seedance-2.0', 'seedance-2.0-fast']);
  assert.equal(active.name, '背景视频');
});

test('素材：超过大小上限的上传返回 413 和说明，而不是断开连接', async () => {
  const before = mock.log.length;
  const form = new FormData();
  form.append('file', new Blob([Buffer.alloc(65 * 1024 * 1024)], { type: 'video/mp4' }), '太大.mp4');
  form.append('asset_type', 'Video');
  const res = await call('POST', '/api/assets/upload', form, { 'X-Asset-Name': encodeURIComponent('太大.mp4'), 'X-Asset-Type': 'Video' });
  assert.equal(res.status, 413);
  assert.match(res.data.error.message, /文件太大/);
  assert.equal(mock.log.slice(before).some((l) => l.path === '/v1/assets/upload'), false);
});

test('素材：上传文件、补缩略图、只从列表移除、从上游删除', async () => {
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('fake png')], { type: 'image/png' }), '参考图.png');
  form.append('asset_type', 'Image');
  const uploaded = await call('POST', '/api/assets/upload', form, { 'X-Asset-Name': encodeURIComponent('参考图.png'), 'X-Asset-Type': 'Image' });
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.data.name, '参考图.png');
  assert.equal(uploaded.data.asset_type, 'Image');
  assert.match(mock.log.find((l) => l.path === '/v1/assets/upload').contentType, /^multipart\/form-data; boundary=/);

  const patched = await call('PATCH', `/api/assets/${uploaded.data.id}`, { thumb: 'data:image/jpeg;base64,AAAA' });
  assert.equal(patched.data.thumb, 'data:image/jpeg;base64,AAAA');

  const listed = () => call('GET', '/api/assets').then((r) => r.data.items.map((a) => a.id));
  assert.ok((await listed()).includes(uploaded.data.id));

  // 只从列表移除：上游的素材还在。
  assert.equal((await call('DELETE', `/api/assets/${uploaded.data.id}?scope=local`)).status, 204);
  assert.equal((await listed()).includes(uploaded.data.id), false);
  assert.ok(mock.assets.has(uploaded.data.id));

  // 按 ID 加回来，再从上游删除。
  assert.equal((await call('POST', '/api/assets/import', { id: `asset://${uploaded.data.id}` })).status, 200);
  assert.equal((await call('DELETE', `/api/assets/${uploaded.data.id}`)).status, 204);
  assert.equal(mock.assets.has(uploaded.data.id), false);
});

test('真人档案：创建、认证链接、添加素材都带幂等键', async () => {
  const person = await call('POST', '/api/real-persons', { name: '测试档案' });
  assert.equal(person.status, 200);
  assert.match(person.data.id, /^rph_/);
  assert.match(person.data.verification_url, /^https:\/\//);

  const list = await call('GET', '/api/real-persons');
  assert.ok(list.data.items.some((p) => p.id === person.data.id && p.name === '测试档案'));

  const session = await call('POST', `/api/real-persons/${person.data.id}/verification-sessions`);
  assert.match(session.data.verification_url, /^https:\/\//);

  const asset = await call('POST', `/api/real-persons/${person.data.id}/assets`, { url: 'https://cdn.example.com/p.png', asset_type: 'Image', name: '正面' }, { 'Idempotency-Key': 'fixed-key-123' });
  assert.equal(asset.status, 200);
  assert.equal(asset.data.personId, person.data.id);
  assert.equal(asset.data.name, '正面');

  const writes = mock.log.filter((l) => l.method === 'POST' && l.path.startsWith('/v1/real-persons'));
  assert.equal(writes.length, 3);
  assert.ok(writes.every((l) => l.idempotencyKey));
  assert.equal(writes.at(-1).idempotencyKey, 'fixed-key-123');

  const assets = await waitFor(async () => {
    const { data } = await call('GET', `/api/real-persons/${person.data.id}/assets`);
    return data.items[0]?.status === 'Active' ? data.items : null;
  }, '真人素材变成 Active');
  assert.equal(assets[0].id, asset.data.id);
});
