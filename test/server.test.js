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

// 等服务自己把某条记录推进到满足条件（不手动刷新）。
const waitItem = (id, done, what) =>
  waitFor(async () => {
    const item = (await call('GET', '/api/history')).data.items.find((i) => i.id === id);
    return item && done(item) ? item : null;
  }, what);

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function upload(bytes, type) {
  const res = await fetch(`${base}/api/uploads`, { method: 'POST', headers: { 'Content-Type': type }, body: bytes });
  return { status: res.status, data: await res.json() };
}

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
    env: { ...process.env, PORT: String(port), FLATKEY_BASE_URL: mock.url, SEEDANCE_DATA_DIR: dataDir, FLATKEY_API_KEY: '', SEEDANCE_PENDING_LIMIT_MS: '1500' },
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

test('模型列表：按用途分好，只留接得上的模型', async () => {
  const { data } = await call('GET', '/api/models');
  assert.equal(data.source, 'remote');
  // 视频只留 Seedance 和 Grok 两类，Seedance 排在前面。
  assert.deepEqual(data.models, ['seedance-2.0', 'seedance-2.0-fast', 'grok-imagine-video']);
  // 图片模型只留能走生图接口的那个。
  assert.deepEqual(data.imageModels, ['grok-imagine-image-2.0']);
  assert.deepEqual(data.polishModels, ['claude-haiku-5-5', 'claude-sonnet-5-5']);
  assert.deepEqual(data.audio, { speech: true, sfx: true, music: true });
});

test('余额：读取剩余和已用', async () => {
  const { data } = await call('GET', '/api/credits');
  assert.deepEqual(data, { remaining: 34.18, used: 185.13 });
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

test('任务一直没结果：超过时限后停止自动查询，手动再查能接上', async () => {
  const created = await call('POST', '/api/videos', { payload: textPayload('STUCK 这条会一直卡住') });
  const { id } = created.data;
  const pollCount = () => mock.log.filter((l) => l.method === 'GET' && l.path === `/v1/videos/${id}`).length;

  // 不去手动刷新，只靠服务自己的轮询走到超时。
  const timedOut = await waitFor(async () => {
    const item = (await call('GET', '/api/history')).data.items.find((i) => i.id === id);
    return item.status === 'failed' ? item : null;
  }, '任务被标为查询超时');
  assert.equal(timedOut.error.code, 'poll_timeout');

  // 超时之后服务不再自己去查。
  const before = pollCount();
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(pollCount(), before);

  // 手动再查：上游仍没结果就保持超时；上游完成了就照常完成并保存。
  const again = await call('POST', `/api/history/${id}/refresh`);
  assert.equal(pollCount(), before + 1);
  assert.equal(again.data.error.code, 'poll_timeout');

  mock.tasks.get(id).stuck = false;
  const done = await refreshUntil(id, (item) => item.savedLocally, '超时的任务再查后完成');
  assert.equal(done.status, 'completed');
  assert.equal(done.error, null);
});

test('Grok 视频：用 prompt 格式；本机的首帧发给上游时换成 data URL，记录里仍是短地址', async () => {
  const frame = await upload(PNG, 'image/png');
  assert.equal(frame.status, 200);
  assert.match(frame.data.url, /^\/media\/uploads\/up_[0-9a-f]+\.png$/);

  const payload = { model: 'grok-imagine-video', prompt: '纸船缓缓漂远', duration: 3, aspect_ratio: '9:16', resolution: '720p', image: { url: frame.data.url } };
  const created = await call('POST', '/api/videos', { payload, form: { mode: 'frames' } });
  assert.equal(created.status, 200);
  assert.equal(created.data.kind, 'video');
  assert.equal(created.data.prompt, '纸船缓缓漂远');

  const sent = mock.tasks.get(created.data.id).payload;
  assert.equal(sent.prompt, '纸船缓缓漂远');
  assert.equal(sent.content, undefined);
  assert.equal(sent.image.url, `data:image/png;base64,${PNG.toString('base64')}`);
  assert.equal(created.data.payload.image.url, frame.data.url);

  const done = await refreshUntil(created.data.id, (item) => item.savedLocally, 'Grok 视频完成并保存');
  assert.match(done.videoUrl, /^\/media\/videos\/task_\w+\.mp4$/);

  // 指向不存在的本机文件：直接说明，不发给上游。
  const missing = await call('POST', '/api/videos', { payload: { ...payload, image: { url: '/media/uploads/up_none.png' } } });
  assert.equal(missing.status, 400);
  assert.equal(missing.data.error.code, 'file_not_found');
});

test('生图：一次出两张，各自一条记录，文件存到本机', async () => {
  const before = mock.log.filter((l) => l.path === '/v1/images/generations').length;
  const created = await call('POST', '/api/images', { payload: { model: 'grok-imagine-image-2.0', prompt: '静水上的红色纸船', n: 2, aspect_ratio: '9:16' }, form: { prompt: '静水上的红色纸船' } });
  assert.equal(created.status, 200);
  assert.equal(created.data.items.length, 2);
  // 请求一发出就有记录，状态是生成中。
  for (const item of created.data.items) {
    assert.equal(item.kind, 'image');
    assert.equal(item.status, 'in_progress');
    assert.match(item.id, /^img_/);
  }

  const [first, second] = await Promise.all(created.data.items.map((i) => waitItem(i.id, (item) => item.status === 'completed', '图片生成完成')));
  // 两张图只发了一次请求。
  assert.equal(mock.log.filter((l) => l.path === '/v1/images/generations').length, before + 1);
  assert.match(first.mediaUrl, /^\/media\/images\/img_[0-9a-f]+\.png$/);
  assert.equal(first.videoUrl, null);
  assert.notEqual(first.mediaUrl, second.mediaUrl);
  assert.equal(first.usage.cost_usd, 0.04);
  assert.equal(first.payload.aspect_ratio, '9:16');

  const file = await fetch(base + first.mediaUrl);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG);

  // 删除记录时图片文件一起删掉。
  assert.equal((await call('DELETE', `/api/history/${second.id}`)).status, 204);
  assert.equal(fs.existsSync(path.join(dataDir, 'images', second.localFile)), false);
});

test('生图失败：记录留下来并写明原因', async () => {
  const created = await call('POST', '/api/images', { payload: { model: 'grok-imagine-image-2.0', prompt: 'FAIL 这张会失败' } });
  const failed = await waitItem(created.data.items[0].id, (item) => item.status === 'failed', '图片记录变成失败');
  assert.match(failed.error.message, /image generation failed/);
  assert.equal(failed.mediaUrl, null);

  assert.equal((await call('POST', '/api/images', { payload: { model: 'grok-imagine-image-2.0', prompt: '  ' } })).status, 400);
});

test('语音和音效：选音色、生成、存成 MP3', async () => {
  const voices = await call('GET', '/api/voices');
  assert.deepEqual(voices.data.items.map((v) => [v.id, v.language, v.gender]), [['voiceEnRoger01', 'en', 'male'], ['voiceZhAnson02', 'zh', 'male']]);
  assert.ok(voices.data.items[0].previewUrl);

  const speech = await call('POST', '/api/audio/speech', { text: '你好，这是一次测试。', voiceId: 'voiceZhAnson02', voiceName: 'Anson' });
  assert.equal(speech.status, 200);
  assert.equal(speech.data.tool, 'speech');
  const spoken = await waitItem(speech.data.id, (item) => item.status === 'completed', '语音生成完成');
  assert.match(spoken.mediaUrl, /^\/media\/audio\/aud_[0-9a-f]+\.mp3$/);
  assert.equal((await fetch(base + spoken.mediaUrl)).headers.get('content-type'), 'audio/mpeg');
  assert.equal(mock.log.some((l) => l.path === '/v1/text-to-speech/voiceZhAnson02'), true);
  assert.equal((await call('POST', '/api/audio/speech', { text: '没选音色' })).status, 400);

  const sfx = await call('POST', '/api/audio/sfx', { text: '厚重的关门声', duration: 2, influence: 0.5 });
  assert.deepEqual(sfx.data.payload, { text: '厚重的关门声', duration_seconds: 2, prompt_influence: 0.5 });
  await waitItem(sfx.data.id, (item) => item.status === 'completed', '音效生成完成');
  // 不带时长就不传这个字段，交给模型决定。
  assert.deepEqual((await call('POST', '/api/audio/sfx', { text: '雨声' })).data.payload, { text: '雨声' });
  assert.equal((await call('POST', '/api/audio/sfx', { text: '太长', duration: 60 })).status, 400);
});

test('配乐：把本机视频传上去，轮询到完成，音乐存到本机', async () => {
  const video = await upload(Buffer.from('fake mp4 bytes'), 'video/mp4');
  assert.match(video.data.url, /^\/media\/uploads\/up_[0-9a-f]+\.mp4$/);

  const created = await call('POST', '/api/audio/music', { video: video.data.url, duration: 5.04, form: { video: { url: video.data.url } } });
  assert.equal(created.status, 200);
  assert.equal(created.data.tool, 'music');
  assert.match(created.data.id, /^task_/);
  assert.equal(created.data.status, 'in_progress');
  assert.equal(mock.log.find((l) => l.path === '/v1/video-to-music').contentType.startsWith('multipart/form-data'), true);

  const done = await refreshUntil(created.data.id, (item) => item.savedLocally, '配乐完成并保存');
  assert.equal(done.status, 'completed');
  assert.match(done.mediaUrl, /^\/media\/audio\/task_\w+\.mp3$/);
  assert.equal(fs.readFileSync(path.join(dataDir, 'audio', done.localFile), 'utf8'), `mock music for ${created.data.id}`);

  // 没有时长、不是视频、文件不存在，都在本地拦下。
  assert.equal((await call('POST', '/api/audio/music', { video: video.data.url })).status, 400);
  assert.equal((await call('POST', '/api/audio/music', { video: (await upload(PNG, 'image/png')).data.url, duration: 5 })).status, 400);
  assert.equal((await call('POST', '/api/audio/music', { video: '/media/videos/../config.json', duration: 5 })).status, 400);
});

test('本机上传：只收图片、视频和 MP3、WAV 音频；/media 只给出这几个目录里的文件', async () => {
  assert.equal((await upload(Buffer.from('x'), 'application/zip')).status, 415);
  assert.equal((await upload(Buffer.from('x'), 'audio/ogg')).status, 415);
  const sound = await upload(Buffer.from('ID3 fake'), 'audio/mpeg');
  assert.equal(sound.status, 200);
  assert.match(sound.data.url, /^\/media\/uploads\/[\w-]+\.mp3$/);
  assert.equal((await upload(Buffer.alloc(0), 'image/png')).status, 400);
  assert.equal((await fetch(`${base}/media/config.json`)).status, 404);
  assert.equal((await fetch(`${base}/media/uploads/..%2Fconfig.json`)).status, 404);
});

test('提示词润色：按内容类型改写，只接受列出的模型', async () => {
  const res = await call('POST', '/api/polish', { text: '清晨的厨房', kind: 'video', model: 'claude-haiku-5-5' });
  assert.equal(res.status, 200);
  assert.equal(res.data.text, '清晨的厨房，镜头缓慢推进，柔和的晨光');
  assert.equal(res.data.model, 'claude-haiku-5-5');

  // 选中的模型被限流：自动换下一个，并说明这次用的是谁。
  const chats = () => mock.log.filter((l) => l.path === '/v1/chat/completions').length;
  const before = chats();
  const limited = await call('POST', '/api/polish', { text: 'LIMITED 清晨的厨房', kind: 'video', model: 'claude-haiku-5-5' });
  assert.equal(limited.status, 200);
  assert.equal(limited.data.model, 'claude-sonnet-5-5');
  assert.equal(chats(), before + 2);
  // 刚失败过的模型先不再试，直接用能用的那个。
  const again = await call('POST', '/api/polish', { text: 'LIMITED 再来一次', kind: 'video', model: 'claude-haiku-5-5' });
  assert.equal(again.data.model, 'claude-sonnet-5-5');
  assert.equal(chats(), before + 3);
  assert.equal((await call('POST', '/api/polish', { text: '清晨的厨房', kind: 'video', model: 'gpt-4o' })).status, 400);
  assert.equal((await call('POST', '/api/polish', { text: '要朗读的话', kind: 'speech', model: 'claude-haiku-5-5' })).status, 400);
  assert.equal((await call('POST', '/api/polish', { text: ' ', kind: 'video', model: 'claude-haiku-5-5' })).status, 400);
});

test('提示词润色：按要用的生成模型选规则', async () => {
  // 发给文本模型的系统提示词。
  const guideFor = async (kind, target) => {
    const res = await call('POST', '/api/polish', { text: '清晨的厨房', kind, model: 'claude-sonnet-5-5', target });
    assert.equal(res.status, 200);
    return mock.log.findLast((l) => l.path === '/v1/chat/completions').system;
  };
  const seedance = await guideFor('video', { model: 'seedance-2.0', mode: 'text' });
  assert.match(seedance, /Seedance/);
  assert.match(seedance, /镜头1/);
  assert.doesNotMatch(seedance, /首尾帧生成|参考生成/);
  // 不说是哪个模型时，按 Seedance 来。
  assert.equal(await guideFor('video'), seedance);
  assert.match(await guideFor('video', { model: 'seedance-2.0-pro', mode: 'frames' }), /首尾帧生成/);
  // 参考生成：告诉它带了几份素材、该怎么称呼。
  const reference = await guideFor('video', { model: 'seedance-2.0', mode: 'reference', refs: { image: 2, video: 0, audio: 1 } });
  assert.match(reference, /图片 2 张、音频 1 段/);
  assert.doesNotMatch(reference, /视频 \d+ 段/);
  // 延长和编辑视频也是参考生成，句式不能被改写成普通的参考。
  assert.match(reference, /不要改成"参考视频1"/);

  const grok = await guideFor('video', { model: 'grok-imagine-video-1.5', mode: 'text' });
  assert.match(grok, /Grok Imagine 视频/);
  assert.doesNotMatch(grok, /镜头1/);
  assert.match(await guideFor('video', { model: 'grok-imagine-video', mode: 'frames' }), /图生视频/);

  assert.match(await guideFor('image', { model: 'grok-imagine-image-2.0' }), /Grok Imagine 图片/);
  assert.doesNotMatch(await guideFor('image', { model: 'some-other-image-model' }), /Grok/);
  assert.match(await guideFor('sfx'), /ElevenLabs/);
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

test('素材：用链接创建，轮询到目标模型可用', async () => {
  assert.equal((await call('POST', '/api/assets', { url: 'http://not-https/a.png', asset_type: 'Image' })).status, 400);

  const created = await call('POST', '/api/assets', { url: 'https://cdn.example.com/a.mp4', asset_type: 'Video', name: '背景视频' });
  assert.equal(created.status, 200);
  assert.equal(created.data.status, 'Processing');
  assert.equal(created.data.asset_url, `asset://${created.data.id}`);
  assert.equal(created.data.name, '背景视频');

  // 能不能用看的是目标模型在不在 available_models 里。视频素材的汇总状态会停在 Failed，但列出来的模型照样能用。
  const usable = await waitFor(async () => {
    const { data } = await call('GET', `/api/assets/${created.data.id}`);
    return data.available_models?.includes('seedance-2.0') ? data : null;
  }, '素材可以用于 seedance-2.0');
  assert.deepEqual(usable.available_models, ['seedance-2.0', 'seedance-2.0-fast']);
  assert.equal(usable.status, 'Failed');
  assert.equal(usable.name, '背景视频');
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

test('画布：新建、保存、读回、改名、删除', async () => {
  const created = await call('POST', '/api/canvases', {});
  assert.equal(created.status, 200);
  assert.match(created.data.id, /^cv_/);
  assert.equal(created.data.name, '未命名画布');
  const { id } = created.data;

  const nodes = [{ id: 'n1', type: 'text', position: { x: 10, y: 20 }, data: { text: '一只猫' } }, { id: 'n2', type: 'video', position: { x: 400, y: 20 }, data: { prompt: '', model: 'seedance-2.0' } }];
  const edges = [{ id: 'e1', source: 'n1', target: 'n2', type: 'link', data: { kind: 'text' } }];
  const saved = await call('PUT', `/api/canvases/${id}`, { name: '  分镜一  ', nodes, edges, viewport: { x: 1, y: 2, zoom: 0.5 }, cover: { url: '/media/images/a.png', kind: 'image', extra: 1 } });
  assert.deepEqual(saved.data.cover, { url: '/media/images/a.png', kind: 'image' });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.name, '分镜一');

  const read = await call('GET', `/api/canvases/${id}`);
  assert.deepEqual(read.data.nodes, nodes);
  assert.deepEqual(read.data.edges, edges);
  assert.deepEqual(read.data.viewport, { x: 1, y: 2, zoom: 0.5 });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'canvases.json'), 'utf8')).find((c) => c.id === id).nodes, nodes);

  // 只改名字不动内容；节点不是数组的请求不收。
  await call('PUT', `/api/canvases/${id}`, { name: '' });
  assert.equal((await call('GET', `/api/canvases/${id}`)).data.nodes.length, 2);
  assert.equal((await call('PUT', `/api/canvases/${id}`, { nodes: 'x' })).status, 400);

  const list = await call('GET', '/api/canvases');
  assert.deepEqual(list.data.items.find((c) => c.id === id).name, '未命名画布');
  assert.equal(list.data.items.find((c) => c.id === id).nodes, undefined);
  assert.deepEqual(list.data.items.find((c) => c.id === id).cover, { url: '/media/images/a.png', kind: 'image' });
  assert.equal((await call('PUT', `/api/canvases/${id}`, { cover: null })).data.cover, null);

  assert.equal((await call('DELETE', `/api/canvases/${id}`)).status, 204);
  assert.equal((await call('GET', `/api/canvases/${id}`)).status, 404);
});

test('文本节点：让文本模型写一段文字，参考内容和要求一起发过去', async () => {
  const before = mock.log.length;
  const res = await call('POST', '/api/text', { prompt: '写成三句分镜', context: '一只猫在窗台上', model: 'claude-haiku-5-5' });
  assert.equal(res.status, 200);
  assert.ok(res.data.text.length > 0);
  const sent = mock.log.slice(before).find((l) => l.path === '/v1/chat/completions');
  assert.ok(sent, '应当调了对话接口');
  assert.equal((await call('POST', '/api/text', { prompt: '', model: 'claude-haiku-5-5' })).status, 400);
  assert.equal((await call('POST', '/api/text', { prompt: '写点什么', model: 'not-a-model' })).status, 400);
});

test('角色：新建、从生成记录选的图会复制一份、改、删', async () => {
  const shot = await upload(PNG, 'image/png');
  // 生成一张图，拿它当角色的参考图。
  const made = await call('POST', '/api/images', { payload: { model: 'grok-imagine-image-2.0', prompt: '穿风衣的女人，正面全身', n: 1 } });
  const image = await waitItem(made.data.items[0].id, (item) => item.status === 'completed', '图片生成完成');

  const created = await call('POST', '/api/characters', { name: '  林晚  ', description: '二十多岁，黑色长发，米色风衣', images: [shot.data.url, image.mediaUrl] });
  assert.equal(created.status, 200);
  assert.match(created.data.id, /^ch_/);
  assert.equal(created.data.name, '林晚');
  // 上传来的图原样用；生成记录里的图复制到 uploads，记录删了角色的图还在。
  assert.equal(created.data.images[0], shot.data.url);
  assert.match(created.data.images[1], /^\/media\/uploads\/up_[0-9a-f]+\.\w+$/);
  await call('DELETE', `/api/history/${image.id}`);
  assert.equal((await fetch(base + image.mediaUrl)).status, 404);
  assert.equal((await fetch(base + created.data.images[1])).status, 200);

  const { id } = created.data;
  const renamed = await call('PUT', `/api/characters/${id}`, { name: '', images: [created.data.images[1]] });
  assert.equal(renamed.data.name, '未命名角色');
  assert.deepEqual(renamed.data.images, [created.data.images[1]]);
  assert.equal(renamed.data.description, '二十多岁，黑色长发，米色风衣');

  // 不在本机的图、不是图片的文件、太多张都不收。
  assert.equal((await call('PUT', `/api/characters/${id}`, { images: ['/media/uploads/up_none.png'] })).status, 400);
  assert.equal((await call('PUT', `/api/characters/${id}`, { images: ['https://example.com/a.png'] })).status, 400);
  const clip = await upload(Buffer.from('not really a video'), 'video/mp4');
  assert.equal((await call('PUT', `/api/characters/${id}`, { images: [clip.data.url] })).status, 400);
  assert.equal((await call('PUT', `/api/characters/${id}`, { images: Array(7).fill(shot.data.url) })).status, 400);

  assert.equal((await call('GET', '/api/characters')).data.items.find((c) => c.id === id).images.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'characters.json'), 'utf8')).length, 1);
  assert.equal((await call('DELETE', `/api/characters/${id}`)).status, 204);
  assert.equal((await call('DELETE', `/api/characters/${id}`)).status, 404);
});

test('模板：存下一份表单、改名、删；不认识的类型和过大的封面不收', async () => {
  const cover = `data:image/jpeg;base64,${PNG.toString('base64')}`;
  const form = { prompt: '雨夜街头，霓虹倒影', model: 'seedance-2.0', resolution: '720p', ratio: '16:9', duration: 5 };
  const created = await call('POST', '/api/templates', { name: '', type: 'video', form, cover });
  assert.equal(created.status, 200);
  assert.match(created.data.id, /^tp_/);
  assert.equal(created.data.name, '未命名模板');
  assert.deepEqual(created.data.form, form);
  assert.equal(created.data.cover, cover);

  assert.equal((await call('POST', '/api/templates', { name: 'x', type: 'music', form })).status, 400);
  assert.equal((await call('POST', '/api/templates', { name: 'x', type: 'image', form: 'x' })).status, 400);
  // 封面不是图片或者太大，就当没有封面。
  const plain = await call('POST', '/api/templates', { name: '无封面', type: 'image', form: { prompt: '一只猫' }, cover: `data:image/jpeg;base64,${'A'.repeat(400 * 1024)}` });
  assert.equal(plain.data.cover, null);

  const { id } = created.data;
  assert.equal((await call('PUT', `/api/templates/${id}`, { name: ' 雨夜 ' })).data.name, '雨夜');
  const list = await call('GET', '/api/templates');
  assert.deepEqual(list.data.items.map((t) => t.name).sort(), ['无封面', '雨夜']);
  assert.equal((await call('DELETE', `/api/templates/${id}`)).status, 204);
  assert.equal((await call('GET', '/api/templates')).data.items.length, 1);
  assert.equal((await call('PUT', `/api/templates/${id}`, { name: 'x' })).status, 404);
});
