// 第三个平台火山方舟：页面发来的请求换成方舟自己的格式、任务回方舟查询、Seedream 生图、豆包润色。
// 和 openrouter.test.js 一样把真实的 server.js 跑起来，平台换成模拟接口。

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock as startFlatkey } from './mock-flatkey.js';
import { startMock as startArk, MOCK_ARK_KEY } from './mock-ark.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let flatkey;
let ark;
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

const waitItem = (id, done, what) =>
  waitFor(async () => {
    const { data } = await call('POST', `/api/history/${id}/refresh`);
    return done(data) ? data : null;
  }, what);

const VIDEO = 'doubao-seedance-2-0-260128';
const IMAGE = 'doubao-seedream-5-0-pro-260628';
const videoPayload = (prompt, extra = {}) => ({ model: VIDEO, prompt, duration: 5, resolution: '720p', aspect_ratio: '16:9', ...extra });
const sent = (pathname) => ark.log.filter((entry) => entry.method === 'POST' && entry.pathname === pathname).map((entry) => JSON.parse(entry.body));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const upload = async () => (await (await fetch(`${base}/api/uploads`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: PNG })).json()).url;

before(async () => {
  flatkey = await startFlatkey({ taskSeconds: 0.5, assetSeconds: 0.5 });
  ark = await startArk({ taskSeconds: 0.8 });
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seedance-test-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, ['server.js'], {
    cwd: root,
    stdio: 'ignore',
    // Key 的环境变量都置空：即使本机设置了真实 Key，测试也绝不会用到它。
    env: { ...process.env, PORT: String(port), FLATKEY_BASE_URL: flatkey.url, ARK_BASE_URL: ark.url, SEEDANCE_DATA_DIR: dataDir, FLATKEY_API_KEY: '', OPENROUTER_API_KEY: '', ARK_API_KEY: '' },
  });
  await waitFor(async () => (await fetch(`${base}/api/state`)).ok, '服务启动');
});

after(async () => {
  app?.kill();
  await flatkey?.close();
  await ark?.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('切到火山方舟：Key 单独存，没有固定开头也能存；能做的只有视频和图片', async () => {
  const saved = (await call('PUT', '/api/key', { apiKey: MOCK_ARK_KEY, provider: 'ark' })).data;
  assert.equal(saved.provider, 'flatkey');
  assert.deepEqual(saved.providers.map((p) => [p.id, p.hasKey]), [['flatkey', false], ['openrouter', false], ['ark', true]]);
  assert.equal(JSON.stringify(saved).includes(MOCK_ARK_KEY), false);

  const switched = (await call('PUT', '/api/provider', { provider: 'ark' })).data;
  assert.equal(switched.provider, 'ark');
  assert.equal(switched.baseUrl, ark.url);
  assert.deepEqual(switched.features, { image: true, speech: false, sfx: false, music: false, library: false, persons: false });

  const bad = await call('PUT', '/api/key', { apiKey: '中文 key', provider: 'ark' });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error.message, /火山方舟 的控制台复制那一串/);
});

test('模型列表：型号和各自支持什么是登记好的，连一次接口只为确认 Key 能用', async () => {
  const { data } = await call('GET', '/api/models');
  assert.equal(data.source, 'remote');
  assert.deepEqual(data.models, ['doubao-seedance-2-5-260628', 'doubao-seedance-2-0-260128', 'doubao-seedance-2-0-fast-260128', 'doubao-seedance-2-0-mini-260615']);
  assert.deepEqual(data.videoSpecs[VIDEO].resolutions, ['480p', '720p', '1080p', '4k']);
  assert.equal(data.videoSpecs['doubao-seedance-2-5-260628'].durations.at(-1), 30);
  assert.deepEqual(data.videoSpecs['doubao-seedance-2-0-mini-260615'].frames, ['first_frame', 'last_frame']);
  assert.deepEqual(data.imageModels, ['doubao-seedream-5-0-pro-260628', 'doubao-seedream-5-0-flash-260915', 'doubao-seedream-5-0-260128']);
  assert.equal(data.imageRefs[IMAGE], 10);
  assert.equal(data.imageRatios[IMAGE].includes('16:9'), true);
  assert.deepEqual(data.polishModels, ['doubao-seed-2-1-lite-260915', 'doubao-seed-2-1-turbo-260628', 'doubao-seed-2-1-pro-260915']);
  assert.deepEqual(data.audio, { speech: false, sfx: false, music: false });
  assert.equal(ark.log.some((entry) => entry.method === 'GET' && entry.pathname === '/contents/generations/tasks' && entry.authed), true);
});

test('余额：方舟没有查余额的接口，告诉页面读不到', async () => {
  assert.deepEqual((await call('GET', '/api/credits')).data, { unavailable: true });
});

test('提交视频：换成 content 数组，本机的首帧内嵌进去；完成后把结果存到本机，用量是 token', async () => {
  const url = await upload();
  const payload = videoPayload('猫转头', { aspect_ratio: undefined, generate_audio: false, seed: 7, frame_images: [{ type: 'image_url', image_url: { url }, frame_type: 'first_frame' }] });
  const created = await call('POST', '/api/videos', { payload });
  assert.equal(created.status, 200);
  assert.equal(created.data.provider, 'ark');
  assert.equal(created.data.status, 'queued');
  assert.equal(created.data.prompt, '猫转头');
  // 记录里存的还是页面发来的样子。
  assert.equal(created.data.payload.frame_images[0].image_url.url, url);

  const request = sent('/contents/generations/tasks').at(-1);
  assert.deepEqual(Object.keys(request).sort(), ['content', 'duration', 'generate_audio', 'model', 'ratio', 'resolution', 'seed', 'watermark']);
  assert.deepEqual({ ...request, content: null }, { model: VIDEO, content: null, resolution: '720p', ratio: 'adaptive', duration: 5, watermark: false, generate_audio: false, seed: 7 });
  assert.deepEqual(request.content[0], { type: 'text', text: '猫转头' });
  assert.equal(request.content[1].role, 'first_frame');
  assert.match(request.content[1].image_url.url, /^data:image\/png;base64,/);

  const done = await waitItem(created.data.id, (i) => i.savedLocally, '结果存到本机');
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.usage, { completion_tokens: 108900, total_tokens: 108900 });
  assert.match(done.videoUrl, /^\/media\/videos\//);
  // 结果是从 content.video_url 给的地址下载的。
  assert.equal(ark.log.some((entry) => entry.pathname === `/tos/${created.data.id}.mp4`), true);
});

test('参考生成：图片、视频、音频各有各的 role；参考视频只能是公网链接', async () => {
  const url = await upload();
  const refs = [
    { type: 'image_url', image_url: { url } },
    { type: 'video_url', video_url: { url: 'https://example.com/a.mp4' } },
    { type: 'audio_url', audio_url: { url: 'https://example.com/a.mp3' } },
  ];
  const created = await call('POST', '/api/videos', { payload: videoPayload('参考图片1里的人走进视频1的场景', { input_references: refs }) });
  assert.equal(created.status, 200);
  const { content, ratio } = sent('/contents/generations/tasks').at(-1);
  assert.equal(ratio, '16:9');
  assert.deepEqual(content.slice(1).map((c) => [c.type, c.role]), [['image_url', 'reference_image'], ['video_url', 'reference_video'], ['audio_url', 'reference_audio']]);
  assert.equal(content[2].video_url.url, 'https://example.com/a.mp4');

  const before = sent('/contents/generations/tasks').length;
  const local = await call('POST', '/api/videos', { payload: videoPayload('延长', { input_references: [{ type: 'video_url', video_url: { url: '/media/videos/a.mp4' } }] }) });
  assert.equal(local.status, 400);
  assert.equal(sent('/contents/generations/tasks').length, before);
});

test('不是方舟的型号不发出去；上游拒绝、模型没开通、任务失败，说的都是火山方舟', async () => {
  const before = sent('/contents/generations/tasks').length;
  const wrong = await call('POST', '/api/videos', { payload: videoPayload('猫', { model: 'bytedance/seedance-2.0' }) });
  assert.equal(wrong.status, 400);
  assert.match(wrong.data.error.message, /火山方舟上没有/);
  assert.equal(sent('/contents/generations/tasks').length, before);

  const rejected = await call('POST', '/api/videos', { payload: videoPayload('REJECT') });
  assert.equal(rejected.status, 400);
  assert.match(rejected.data.error.message, /火山方舟 返回（400）/);

  const notOpen = await call('POST', '/api/videos', { payload: videoPayload('NOTOPEN') });
  assert.equal(notOpen.status, 404);
  assert.match(notOpen.data.error.message, /还没有开通这个模型.*余额大于 200 元/);

  const created = await call('POST', '/api/videos', { payload: videoPayload('FAIL') });
  const failed = await waitItem(created.data.id, (i) => i.status === 'failed', '任务失败');
  assert.equal(failed.error.code, 'OutputVideoSensitiveContentDetected');
  assert.match(failed.error.message, /^生成的视频没有通过内容审核（/);
});

test('生图：要几张发几次，大小按画面比例换成像素值，不要水印；参考图放进 image 数组', async () => {
  const created = await call('POST', '/api/images', { payload: { model: IMAGE, prompt: '窗台上的猫', n: 2, aspect_ratio: '16:9' } });
  assert.equal(created.status, 200);
  assert.equal(created.data.items.length, 2);
  const done = await waitFor(async () => {
    const items = (await call('GET', '/api/history')).data.items.filter((i) => created.data.items.some((c) => c.id === i.id));
    return items.every((i) => i.status === 'completed') ? items : null;
  }, '两张图都生成完');
  assert.match(done[0].mediaUrl, /^\/media\/images\/img_\w+\.jpg$/);
  assert.equal(done[0].usage, null);
  assert.deepEqual(sent('/images/generations').slice(-2), Array(2).fill({ model: IMAGE, prompt: '窗台上的猫', size: '2048x1152', response_format: 'b64_json', watermark: false }));

  const url = await upload();
  const ref = { type: 'image_url', image_url: { url } };
  const edited = await call('POST', '/api/images', { payload: { model: 'doubao-seedream-5-0-260128', prompt: '改成水彩', n: 1, aspect_ratio: '1:1', input_references: [ref] } });
  assert.equal(edited.status, 200);
  await waitFor(() => sent('/images/generations').some((r) => r.prompt === '改成水彩'), '请求发出');
  const request = sent('/images/generations').at(-1);
  assert.equal(request.size, '2048x2048');
  assert.equal(request.image.length, 1);
  assert.match(request.image[0], /^data:image\/png;base64,/);

  const tooMany = await call('POST', '/api/images', { payload: { model: IMAGE, prompt: '改', n: 1, input_references: Array(11).fill(ref) } });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.data.error.message, /最多收 10 张/);

  const failed = await call('POST', '/api/images', { payload: { model: IMAGE, prompt: 'FAIL', n: 1 } });
  const item = await waitFor(async () => (await call('GET', '/api/history')).data.items.find((i) => i.id === failed.data.items[0].id && i.status === 'failed'), '生图失败');
  assert.match(item.error.message, /火山方舟 返回（500）/);
});

test('润色：用豆包的文本模型，关掉深度思考；Seedance 的型号按 Seedance 的写法来', async () => {
  const ok = await call('POST', '/api/polish', { text: '一只猫', kind: 'video', model: 'doubao-seed-2-1-lite-260915', target: { model: VIDEO, mode: 'text' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.model, 'doubao-seed-2-1-lite-260915');
  const request = sent('/chat/completions').at(-1);
  assert.deepEqual(request.thinking, { type: 'disabled' });
  assert.match(request.messages[0].content, /Seedance 视频模型/);
  assert.equal((await call('POST', '/api/polish', { text: '一只猫', kind: 'video', model: 'claude-haiku-5-5' })).status, 400);
});

test('方舟上没有的功能被拒绝：语音、音效、配乐、素材库', async () => {
  assert.deepEqual((await call('GET', '/api/voices')).data, { items: [] });
  for (const [method, url, body] of [['POST', '/api/audio/speech', { text: '你好', voiceId: 'sarah' }], ['POST', '/api/audio/sfx', { text: '雨声' }], ['POST', '/api/audio/music', { video: '/media/videos/a.mp4', duration: 5 }], ['POST', '/api/assets', {}]]) {
    const res = await call(method, url, body);
    assert.equal(res.status, 400, url);
    assert.equal(res.data.error.code, 'not_on_provider', url);
  }
});

test('切回 Flatkey 之后，方舟上没跑完的任务仍然回方舟查', async () => {
  const created = await call('POST', '/api/videos', { payload: videoPayload('换平台之前提交的') });
  assert.equal((await call('PUT', '/api/provider', { provider: 'flatkey' })).data.provider, 'flatkey');
  const done = await waitItem(created.data.id, (i) => i.savedLocally, '换平台后任务照常完成');
  assert.equal(done.provider, 'ark');
  assert.equal(flatkey.log.some((entry) => entry.path.includes(created.data.id)), false);
});
