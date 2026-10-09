// 第二个平台 OpenRouter：切换、各存各的 Key、请求格式、任务回自己的平台查询。
// 和 server.test.js 一样把真实的 server.js 跑起来，两个平台都换成模拟接口。

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock as startFlatkey, MOCK_KEY } from './mock-flatkey.js';
import { startMock as startOpenRouter, MOCK_OR_KEY } from './mock-openrouter.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let flatkey;
let openrouter;
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
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch {
      /* 还没准备好，继续等 */
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`等待超时：${what}`);
}

async function call(method, url, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(base + url, init);
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

// 反复让服务去查上游，直到这条记录满足条件。不等服务自己定时去查，免得测试跟着它的间隔慢下来。
const waitItem = (id, done, what) =>
  waitFor(async () => {
    const { data } = await call('POST', `/api/history/${id}/refresh`);
    return done(data) ? data : null;
  }, what);

const videoPayload = (prompt, extra = {}) => ({ model: 'bytedance/seedance-2.5', prompt, duration: 4, resolution: '480p', aspect_ratio: '16:9', ...extra });
const submitted = () => openrouter.log.filter((entry) => entry.method === 'POST' && entry.pathname === '/v1/videos').map((entry) => JSON.parse(entry.body));

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

before(async () => {
  flatkey = await startFlatkey({ taskSeconds: 0.5, assetSeconds: 0.5 });
  openrouter = await startOpenRouter({ taskSeconds: 0.8 });
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seedance-test-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, ['server.js'], {
    cwd: root,
    stdio: 'ignore',
    // 两个 Key 的环境变量都置空：即使本机设置了真实 Key，测试也绝不会用到它。
    env: { ...process.env, PORT: String(port), FLATKEY_BASE_URL: flatkey.url, OPENROUTER_BASE_URL: openrouter.url, SEEDANCE_DATA_DIR: dataDir, FLATKEY_API_KEY: '', OPENROUTER_API_KEY: '' },
  });
  await waitFor(async () => (await fetch(`${base}/api/state`)).ok, '服务启动');
});

after(async () => {
  app?.kill();
  await flatkey?.close();
  await openrouter?.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('默认是 Flatkey；两个平台的 Key 各存各的，切换后说的是新平台', async () => {
  const start = (await call('GET', '/api/state')).data;
  assert.equal(start.provider, 'flatkey');
  assert.equal(start.features.music, true);
  assert.deepEqual(start.providers.map((p) => [p.id, p.hasKey]), [['flatkey', false], ['openrouter', false]]);

  await call('PUT', '/api/key', { apiKey: MOCK_KEY });
  // 不切换平台也能先把另一个平台的 Key 存好。
  const saved = (await call('PUT', '/api/key', { apiKey: MOCK_OR_KEY, provider: 'openrouter' })).data;
  assert.equal(saved.provider, 'flatkey');
  assert.deepEqual(saved.providers.map((p) => p.hasKey), [true, true]);
  assert.equal(JSON.stringify(saved).includes(MOCK_OR_KEY), false);

  assert.equal((await call('PUT', '/api/provider', { provider: 'nowhere' })).status, 400);
  const switched = (await call('PUT', '/api/provider', { provider: 'openrouter' })).data;
  assert.equal(switched.provider, 'openrouter');
  assert.equal(switched.baseUrl, openrouter.url);
  assert.equal(switched.keyHint.startsWith('sk-or-'), true);
  assert.deepEqual(switched.features, { image: true, speech: true, sfx: false, music: false, library: false, persons: false });
});

test('模型列表：带上每个模型支持什么，Seedance 在前且新型号在前，不是生成模型的不列', async () => {
  const { data } = await call('GET', '/api/models');
  assert.equal(data.source, 'remote');
  assert.deepEqual(data.models, ['bytedance/seedance-2.5', 'bytedance/seedance-2.0', 'google/veo-3.1-lite', 'x-ai/grok-imagine-video']);
  assert.deepEqual(data.videoSpecs['bytedance/seedance-2.0'].resolutions, ['480p', '720p', '1080p', '4K']);
  assert.deepEqual(data.videoSpecs['google/veo-3.1-lite'].durations, [4, 6, 8]);
  assert.deepEqual(data.videoSpecs['x-ai/grok-imagine-video'], { resolutions: ['480p', '720p'], ratios: ['16:9', '9:16'], durations: [1, 5, 15], autoDuration: false, frames: ['first_frame'], audio: false, seed: false });
  assert.deepEqual(data.polishModels, ['anthropic/claude-haiku-5.5', 'x-ai/grok-4.7']);
  // 图片模型里 Grok 排在前面；每个模型收哪些比例一起给。
  assert.deepEqual(data.imageModels, ['x-ai/grok-imagine-image-2.0', 'google/gemini-3-pro-image', 'recraft/recraft-v4']);
  assert.deepEqual(data.imageRatios['x-ai/grok-imagine-image-2.0'], ['1:1', '16:9', '3:2']);
  assert.deepEqual(data.imageRatios['recraft/recraft-v4'], []);
  assert.deepEqual(data.imageRefs, { 'google/gemini-3-pro-image': 14, 'x-ai/grok-imagine-image-2.0': 3, 'recraft/recraft-v4': 0 });
  assert.deepEqual(data.audio, { speech: true, sfx: false, music: false });
});

test('余额：充值总额减去已用，单位是美元', async () => {
  assert.deepEqual((await call('GET', '/api/credits')).data, { remaining: 25.5, used: 4.5, unit: 'usd' });
});

test('提交视频：本机的首帧内嵌进请求，记录里存短地址；完成后带着 Key 把结果存到本机', async () => {
  const up = await fetch(`${base}/api/uploads`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: PNG });
  const { url } = await up.json();
  const payload = videoPayload('猫转头', { frame_images: [{ type: 'image_url', image_url: { url }, frame_type: 'first_frame' }] });
  const created = await call('POST', '/api/videos', { payload });
  assert.equal(created.status, 200);
  assert.equal(created.data.provider, 'openrouter');
  assert.equal(created.data.status, 'queued');
  assert.equal(created.data.prompt, '猫转头');
  assert.equal(created.data.payload.frame_images[0].image_url.url, url);
  assert.match(submitted().at(-1).frame_images[0].image_url.url, /^data:image\/png;base64,/);

  const done = await waitItem(created.data.id, (i) => i.savedLocally, '结果存到本机');
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.usage, { cost_usd: 0.415481 });
  assert.match(done.videoUrl, /^\/media\/videos\//);
  // 结果地址要带 Key 才能下载。
  assert.equal(openrouter.log.some((entry) => /\/content$/.test(entry.pathname) && entry.authed), true);
});

test('参考视频只能是公网链接，本机的文件在发出去之前就拦下', async () => {
  const before = submitted().length;
  const local = await call('POST', '/api/videos', { payload: videoPayload('延长', { input_references: [{ type: 'video_url', video_url: { url: '/media/videos/a.mp4' } }] }) });
  assert.equal(local.status, 400);
  assert.match(local.data.error.message, /https 链接/);
  assert.equal(submitted().length, before);

  const remote = await call('POST', '/api/videos', { payload: videoPayload('参考', { input_references: [{ type: 'video_url', video_url: { url: 'https://example.com/a.mp4' } }] }) });
  assert.equal(remote.status, 200);
});

test('上游拒绝和任务失败：错误里说的是 OpenRouter', async () => {
  const rejected = await call('POST', '/api/videos', { payload: videoPayload('REJECT') });
  assert.equal(rejected.status, 400);
  assert.match(rejected.data.error.message, /OpenRouter 返回（400）/);

  const created = await call('POST', '/api/videos', { payload: videoPayload('FAIL') });
  const failed = await waitItem(created.data.id, (i) => i.status === 'failed', '任务失败');
  assert.equal(failed.error.message, 'Content policy violation');
});

test('润色：用 OpenRouter 的文本模型，不认 Flatkey 的型号', async () => {
  const ok = await call('POST', '/api/polish', { text: '一只猫', kind: 'video', model: 'anthropic/claude-haiku-5.5', target: { model: 'google/veo-3.1-lite', mode: 'text' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.model, 'anthropic/claude-haiku-5.5');
  const system = JSON.parse(openrouter.log.findLast((entry) => entry.pathname === '/v1/chat/completions').body).messages[0].content;
  assert.match(system, /AI 视频生成模型/);
  assert.equal((await call('POST', '/api/polish', { text: '一只猫', kind: 'video', model: 'claude-haiku-5-5' })).status, 400);
});

const imageRequests = () => openrouter.log.filter((entry) => entry.method === 'POST' && entry.pathname === '/v1/images').map((entry) => JSON.parse(entry.body));

test('图生图：本机的参考图内嵌进请求，记录里存短地址；张数超了、模型不收的不发', async () => {
  await call('GET', '/api/models');
  const up = await fetch(`${base}/api/uploads`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: PNG });
  const { url } = await up.json();
  const ref = { type: 'image_url', image_url: { url } };
  const created = await call('POST', '/api/images', { payload: { model: 'x-ai/grok-imagine-image-2.0', prompt: '改成水彩', n: 1, aspect_ratio: '16:9', input_references: [ref] } });
  assert.equal(created.status, 200);
  assert.equal(created.data.items[0].payload.input_references[0].image_url.url, url);
  await waitFor(() => imageRequests().some((r) => r.prompt === '改成水彩'), '请求发出');
  assert.match(imageRequests().at(-1).input_references[0].image_url.url, /^data:image\/png;base64,/);

  const tooMany = await call('POST', '/api/images', { payload: { model: 'x-ai/grok-imagine-image-2.0', prompt: '改', n: 1, input_references: [ref, ref, ref, ref] } });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.data.error.message, /最多收 3 张/);
  const refused = await call('POST', '/api/images', { payload: { model: 'recraft/recraft-v4', prompt: '改', n: 1, input_references: [ref] } });
  assert.equal(refused.status, 400);
  assert.match(refused.data.error.message, /不收参考图/);
});

test('生图：要几张就发几次，每张一条记录，费用各算各的；模型不收的比例不发', async () => {
  const created = await call('POST', '/api/images', { payload: { model: 'x-ai/grok-imagine-image-2.0', prompt: '窗台上的猫', n: 2, aspect_ratio: '16:9' } });
  assert.equal(created.status, 200);
  assert.equal(created.data.items.length, 2);
  const done = await waitFor(async () => {
    const items = (await call('GET', '/api/history')).data.items.filter((i) => created.data.items.some((c) => c.id === i.id));
    return items.every((i) => i.status === 'completed') ? items : null;
  }, '两张图都生成完');
  assert.match(done[0].mediaUrl, /^\/media\/images\/img_\w+\.png$/);
  assert.equal(done[0].usage.cost_usd, 0.06);
  assert.deepEqual(imageRequests().slice(-2), [
    { model: 'x-ai/grok-imagine-image-2.0', prompt: '窗台上的猫', aspect_ratio: '16:9' },
    { model: 'x-ai/grok-imagine-image-2.0', prompt: '窗台上的猫', aspect_ratio: '16:9' },
  ]);

  await call('POST', '/api/images', { payload: { model: 'recraft/recraft-v4', prompt: '一枚图标', n: 1, aspect_ratio: '16:9' } });
  await waitFor(() => imageRequests().some((r) => r.model === 'recraft/recraft-v4'), '请求发出');
  assert.equal('aspect_ratio' in imageRequests().at(-1), false);

  const failed = await call('POST', '/api/images', { payload: { model: 'x-ai/grok-imagine-image-2.0', prompt: 'FAIL', n: 1 } });
  const item = await waitFor(async () => (await call('GET', '/api/history')).data.items.find((i) => i.id === failed.data.items[0].id && i.status === 'failed'), '生图失败');
  assert.match(item.error.message, /OpenRouter 返回（500）/);
});

test('语音：音色来自模型列表，只有名字；生成时要 MP3', async () => {
  const voices = (await call('GET', '/api/voices')).data.items;
  assert.deepEqual(voices.map((v) => [v.id, v.name, v.previewUrl]), [['george', 'George', ''], ['sarah', 'Sarah', '']]);

  const created = await call('POST', '/api/audio/speech', { text: '你好', voiceId: 'sarah', voiceName: 'Sarah' });
  assert.equal(created.status, 200);
  assert.equal(created.data.model, 'elevenlabs/eleven-multilingual-v2');
  const done = await waitFor(async () => (await call('GET', '/api/history')).data.items.find((i) => i.id === created.data.id && i.status === 'completed'), '语音生成完');
  assert.match(done.mediaUrl, /^\/media\/audio\/aud_\w+\.mp3$/);
  const sent = JSON.parse(openrouter.log.findLast((entry) => entry.pathname === '/v1/audio/speech').body);
  assert.deepEqual(sent, { model: 'elevenlabs/eleven-multilingual-v2', input: '你好', voice: 'sarah', response_format: 'mp3' });
});

test('只有 Flatkey 有的功能在 OpenRouter 下被拒绝，读本机的素材列表不受影响', async () => {
  for (const [method, url, body] of [['POST', '/api/audio/sfx', { text: '雨声' }], ['POST', '/api/audio/music', { video: '/media/videos/a.mp4', duration: 5 }], ['GET', '/api/real-persons'], ['POST', '/api/assets', {}]]) {
    const res = await call(method, url, body);
    assert.equal(res.status, 400, url);
    assert.equal(res.data.error.code, 'not_on_provider', url);
  }
  assert.equal((await call('GET', '/api/assets')).status, 200);
});

test('切回 Flatkey 之后，OpenRouter 上没跑完的任务仍然回 OpenRouter 查', async () => {
  const created = await call('POST', '/api/videos', { payload: videoPayload('换平台之前提交的') });
  const back = (await call('PUT', '/api/provider', { provider: 'flatkey' })).data;
  assert.equal(back.provider, 'flatkey');
  assert.equal(back.features.library, true);

  const done = await waitItem(created.data.id, (i) => i.savedLocally, '换平台后任务照常完成');
  assert.equal(done.provider, 'openrouter');
  // 这条任务没有去问过 Flatkey。
  assert.equal(flatkey.log.some((entry) => entry.path.includes(created.data.id)), false);

  // 切回来之后，新提交的走 Flatkey。
  const next = await call('POST', '/api/videos', { payload: { model: 'seedance-2.0', content: [{ type: 'text', text: '回到 Flatkey' }], resolution: '480p', ratio: '16:9', duration: 4 } });
  assert.equal(next.status, 200);
  assert.equal(next.data.provider, 'flatkey');
  assert.equal((await call('POST', '/api/audio/sfx', { text: '雨声' })).status, 200);
});
