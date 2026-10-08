// 表单 → 请求体。对照 Flatkey 文档里 POST /v1/videos 的参数。

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, refsInUse, buildImageRequest, buildSpeechRequest, buildSfxRequest, buildMusicRequest } from '../web/src/request.ts';

const baseForm = (patch = {}) => ({
  mode: 'text',
  prompt: '清晨的厨房',
  model: 'seedance-2.0',
  resolution: '720p',
  ratio: '16:9',
  duration: 5,
  durationAuto: false,
  generateAudio: true,
  watermark: false,
  seed: '',
  webSearch: false,
  inputType: 'auto',
  sr: { enabled: false, by: 'resolution', resolution: '1080p', limit: 1440, scene: '', tool: 'standard', fps: '' },
  frames: { first: null, last: null },
  refs: { image: [], video: [], audio: [] },
  ...patch,
});

const ref = (kind, url) => ({ uid: url, kind, source: 'url', url });

test('文生视频：只有文本和基础参数', () => {
  const { payload, problems } = buildRequest(baseForm());
  assert.deepEqual(problems, []);
  assert.deepEqual(payload, {
    model: 'seedance-2.0',
    content: [{ type: 'text', text: '清晨的厨房' }],
    resolution: '720p',
    ratio: '16:9',
    duration: 5,
    generate_audio: true,
    watermark: false,
  });
});

test('文生视频：没有提示词不能提交', () => {
  assert.deepEqual(buildRequest(baseForm({ prompt: '   ' })).problems, ['请填写提示词']);
});

test('首尾帧：角色是 first_frame / last_frame，首帧必填', () => {
  const frames = { first: ref('image', 'https://a/first.jpg'), last: ref('image', 'https://a/last.jpg') };
  const { payload, problems } = buildRequest(baseForm({ mode: 'frames', frames }));
  assert.deepEqual(problems, []);
  assert.deepEqual(payload.content.slice(1), [
    { type: 'image_url', image_url: { url: 'https://a/first.jpg' }, role: 'first_frame' },
    { type: 'image_url', image_url: { url: 'https://a/last.jpg' }, role: 'last_frame' },
  ]);

  const missing = buildRequest(baseForm({ mode: 'frames', frames: { first: null, last: frames.last } }));
  assert.deepEqual(missing.problems, ['请添加首帧图片']);
});

test('参考生成：图片、视频、音频各用自己的字段和角色', () => {
  const refs = {
    image: [ref('image', 'asset://ast_1'), ref('image', 'https://a/2.png')],
    video: [ref('video', 'asset://ast_3')],
    audio: [ref('audio', 'asset://ast_4')],
  };
  const { payload, problems } = buildRequest(baseForm({ mode: 'reference', refs }));
  assert.deepEqual(problems, []);
  assert.deepEqual(payload.content, [
    { type: 'text', text: '清晨的厨房' },
    { type: 'image_url', image_url: { url: 'asset://ast_1' }, role: 'reference_image' },
    { type: 'image_url', image_url: { url: 'https://a/2.png' }, role: 'reference_image' },
    { type: 'video_url', video_url: { url: 'asset://ast_3' }, role: 'reference_video' },
    { type: 'audio_url', audio_url: { url: 'asset://ast_4' }, role: 'reference_audio' },
  ]);
});

test('参考生成：只有音频不够', () => {
  const refs = { image: [], video: [], audio: [ref('audio', 'asset://ast_4')] };
  const { problems } = buildRequest(baseForm({ mode: 'reference', prompt: '', refs }));
  assert.deepEqual(problems, ['只有音频不够，还需要提示词、图片或视频']);
});

test('切回文生视频时，之前选的参考素材不会被带上', () => {
  const refs = { image: [ref('image', 'asset://ast_1')], video: [], audio: [] };
  const form = baseForm({ mode: 'text', refs });
  assert.deepEqual(refsInUse(form), []);
  assert.equal(buildRequest(form).payload.content.length, 1);
});

test('素材没就绪或不可用时不能提交', () => {
  const refs = { image: [ref('image', 'asset://ast_1')], video: [], audio: [] };
  const form = baseForm({ mode: 'reference', refs });
  assert.match(buildRequest(form, () => ({ ready: false, tone: 'pending' })).problems[0], /还在处理中/);
  assert.match(buildRequest(form, () => ({ ready: false, tone: 'error' })).problems[0], /不可用/);
});

test('时长自动传 -1', () => {
  assert.equal(buildRequest(baseForm({ durationAuto: true })).payload.duration, -1);
});

test('可选参数只在设置时出现', () => {
  const plain = buildRequest(baseForm()).payload;
  for (const key of ['seed', 'web_search', 'input_type', 'super_resolution_config']) assert.equal(key in plain, false, key);

  const { payload, problems } = buildRequest(baseForm({ seed: '42', webSearch: true, inputType: 'reference' }));
  assert.deepEqual(problems, []);
  assert.equal(payload.seed, 42);
  assert.equal(payload.web_search, true);
  assert.equal(payload.input_type, 'reference');
});

test('随机种子必须是整数', () => {
  assert.deepEqual(buildRequest(baseForm({ seed: '1.5' })).problems, ['随机种子需要是整数']);
});

test('超分：按目标分辨率，且必须高于原始分辨率', () => {
  const sr = { enabled: true, by: 'resolution', resolution: '4k', limit: 1440, scene: 'aigc', tool: 'professional', fps: '60' };
  const ok = buildRequest(baseForm({ resolution: '1080p', sr }));
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.payload.super_resolution_config, { resolution: '4k', scene: 'aigc', tool_version: 'professional', fps: 60 });

  const same = buildRequest(baseForm({ resolution: '1080p', sr: { ...sr, resolution: '1080p' } }));
  assert.deepEqual(same.problems, ['超分的目标分辨率必须高于原始分辨率']);
});

test('超分：按短边像素时不带 resolution，范围 64–2160', () => {
  const sr = { enabled: true, by: 'limit', resolution: '1080p', limit: '1440', scene: '', tool: 'standard', fps: '' };
  const ok = buildRequest(baseForm({ sr }));
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.payload.super_resolution_config, { resolution_limit: 1440, tool_version: 'standard' });

  assert.equal(buildRequest(baseForm({ sr: { ...sr, limit: '4000' } })).problems.length, 1);
  assert.equal(buildRequest(baseForm({ sr: { ...sr, fps: '0' } })).problems.length, 1);
});

// ---------- Grok 视频 ----------

const local = (url) => ({ uid: url, kind: 'image', source: 'local', url });

test('Grok 文生视频：用 prompt 字符串，带比例、分辨率、时长，不带 Seedance 的参数', () => {
  const { payload, problems } = buildRequest(baseForm({ model: 'grok-imagine-video', ratio: '9:16', duration: 3, seed: '7', webSearch: true }));
  assert.deepEqual(problems, []);
  assert.deepEqual(payload, { model: 'grok-imagine-video', prompt: '清晨的厨房', duration: 3, resolution: '720p', aspect_ratio: '9:16' });
});

test('Grok 图生视频：首帧放在 image 里，比例跟着图片走；素材库里的素材用不了', () => {
  const withFrame = buildRequest(baseForm({ model: 'grok-imagine-video-1.5', mode: 'frames', frames: { first: local('/media/images/img_1.jpg'), last: null } }));
  assert.deepEqual(withFrame.problems, []);
  assert.deepEqual(withFrame.payload.image, { url: '/media/images/img_1.jpg' });
  assert.equal('aspect_ratio' in withFrame.payload, false);

  const fromLibrary = { uid: 'a', kind: 'image', source: 'asset', assetId: 'ast_1', url: 'asset://ast_1' };
  assert.deepEqual(buildRequest(baseForm({ model: 'grok-imagine-video', mode: 'frames', frames: { first: fromLibrary, last: null } })).problems, ['这个模型用不了素材库里的素材，请移除后重新添加首帧']);
  assert.deepEqual(buildRequest(baseForm({ model: 'grok-imagine-video', mode: 'frames' })).problems, ['请添加首帧图片']);
  assert.deepEqual(buildRequest(baseForm({ model: 'grok-imagine-video', mode: 'reference' })).problems, ['这个模型不支持参考生成，请改用文生视频或图生视频']);
});

test('Seedance 用不了只存在本机的首帧', () => {
  const { problems } = buildRequest(baseForm({ mode: 'frames', frames: { first: local('/media/uploads/up_1.png'), last: null } }));
  assert.deepEqual(problems, ['有素材只存在本机，Seedance 用不了，请移除后重新添加']);
});

// ---------- 图片、语音、音效、配乐 ----------

test('生图：模型、提示词、张数、比例', () => {
  assert.deepEqual(buildImageRequest({ prompt: ' 红色纸船 ', model: 'grok-imagine-image-2.0', ratio: '16:9', count: 2 }), {
    payload: { model: 'grok-imagine-image-2.0', prompt: '红色纸船', n: 2, aspect_ratio: '16:9' },
    problems: [],
  });
  assert.deepEqual(buildImageRequest({ prompt: '', model: 'm', ratio: '1:1', count: 1 }).problems, ['请填写提示词']);
});

test('语音：要有文字和音色', () => {
  assert.deepEqual(buildSpeechRequest({ prompt: '你好', voiceId: 'v1', voiceName: 'Anson' }), { body: { text: '你好', voiceId: 'v1', voiceName: 'Anson' }, problems: [] });
  assert.deepEqual(buildSpeechRequest({ prompt: '', voiceId: 'v1' }).problems, ['请填写要朗读的文字']);
  assert.deepEqual(buildSpeechRequest({ prompt: '你好', voiceId: '' }).problems, ['请选择音色']);
});

test('音效：时长选自动时不传', () => {
  assert.deepEqual(buildSfxRequest({ prompt: '关门声', duration: 'auto', influence: '0.3' }).body, { text: '关门声', influence: 0.3 });
  assert.deepEqual(buildSfxRequest({ prompt: '关门声', duration: '5', influence: '0.6' }).body, { text: '关门声', influence: 0.6, duration: 5 });
  assert.deepEqual(buildSfxRequest({ prompt: ' ', duration: 'auto', influence: '0.3' }).problems, ['请描述想要的声音']);
});

test('配乐：要有视频，并且读到了时长', () => {
  assert.deepEqual(buildMusicRequest({ video: { url: '/media/videos/a.mp4', duration: 5.04 } }), { body: { video: '/media/videos/a.mp4', duration: 5.04 }, problems: [] });
  assert.deepEqual(buildMusicRequest({ video: null }).problems, ['请选择要配乐的视频']);
  assert.deepEqual(buildMusicRequest({ video: { url: '/media/videos/a.mp4', duration: 0 } }).problems, ['没有读到这段视频的时长，请重新选择']);
});
