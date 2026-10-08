// 表单 → 请求体。对照 Flatkey 文档里 POST /v1/videos 的参数。

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, refsInUse } from '../public/js/request.js';

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
