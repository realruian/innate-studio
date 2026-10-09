// 模型登记表：型号的附注、各模型的参数范围。

import test from 'node:test';
import assert from 'node:assert/strict';
import { modelLabel, modelNote, videoFamilyOf, referenceModeLabel, videoCapabilities, polishGuide, isProvider, estimateCost } from '../shared/models.ts';

test('型号附注：同一档的型号附注相同，没有分档的不加', () => {
  assert.equal(modelNote('seedance-2.0-fast'), '快速版');
  assert.equal(modelNote('seedance-2.0-mini'), '轻量版');
  // 官方只有 Fast 和 Mini 两档有名字，不带后缀的和带 -pro 的不标。
  for (const id of ['seedance-2.0', 'seedance-2.0-pro', 'seedance-2.5-pro', 'seedance-2.5', 'grok-imagine-video', 'grok-imagine-video-1.5', 'grok-imagine-image-2.0']) assert.equal(modelNote(id), '', id);
});

test('带参考素材的生成方式：Seedance 叫全能参考，别的模型叫参考生成', () => {
  for (const id of ['seedance-2.0', 'seedance-2.5', 'bytedance/seedance-2.0-fast']) assert.equal(referenceModeLabel(id), '全能参考', id);
  for (const id of ['google/veo-3.1', 'kwaivgi/kling-v2.5', 'x-ai/grok-imagine-video', undefined]) assert.equal(referenceModeLabel(id), '参考生成', String(id));
});

test('视频模型分两族，认不出来的不算视频模型', () => {
  assert.equal(videoFamilyOf('seedance-2.0-fast'), 'seedance');
  assert.equal(videoFamilyOf('grok-imagine-video-1.5'), 'grok');
  assert.equal(videoFamilyOf('MiniMax-H3'), null);
  assert.equal(videoFamilyOf(undefined), null);
  // 火山方舟的型号前面带 doubao-、后面带日期，一样认得出，附注也照常标。
  assert.equal(videoFamilyOf('doubao-seedance-2-5-260628'), 'seedance');
  assert.equal(modelNote('doubao-seedance-2-0-fast-260128'), '快速版');
  assert.equal(modelNote('doubao-seedance-2-0-mini-260615'), '轻量版');
  assert.equal(modelNote('doubao-seedance-2-0-260128'), '');
});

test('平台只有 Flatkey 和火山方舟；润色规则按型号选，认不出来的按 Seedance 处理', () => {
  assert.equal(isProvider('flatkey'), true);
  assert.equal(isProvider('ark'), true);
  assert.equal(isProvider('openrouter'), false);
  assert.match(polishGuide({ kind: 'video', model: 'doubao-seedance-2-0-260128', mode: 'text' }), /Seedance 视频模型/);
  assert.match(polishGuide({ kind: 'video', model: 'grok-imagine-video', mode: 'text' }), /Grok Imagine 视频模型/);
  assert.match(polishGuide({ kind: 'video', model: 'some-new-model', mode: 'text' }), /Seedance 视频模型/);
  // 2.5 有自己的写法：知道时长就用时间戳分段，不知道就用镜头序号
  const v25 = 'doubao-seedance-2-5-260628';
  assert.match(polishGuide({ kind: 'video', model: v25, mode: 'text', duration: 12 }), /Seedance 2\.5 视频模型[\s\S]*一共 12 秒[\s\S]*3-12秒/);
  assert.match(polishGuide({ kind: 'video', model: v25, mode: 'text' }), /镜头1：/);
  assert.doesNotMatch(polishGuide({ kind: 'video', model: v25, mode: 'text' }), /0-3秒/);
  assert.match(polishGuide({ kind: 'video', model: v25, mode: 'frames', duration: 5 }), /首尾帧生成/);
  // Seedream 有自己的写法，带了参考图再加一段图生图的
  const img = 'doubao-seedream-5-0-pro-260628';
  assert.match(polishGuide({ kind: 'image', model: img }), /Seedream 图片模型/);
  assert.doesNotMatch(polishGuide({ kind: 'image', model: img, refs: { image: 0 } }), /图生图/);
  assert.match(polishGuide({ kind: 'image', model: img, refs: { image: 2 } }), /带了 2 张参考图/);
  assert.match(polishGuide({ kind: 'image', model: 'some-image-model' }), /AI 图片生成模型/);
});

test('参数范围：Grok 没有 1080p、21:9 和自动时长，seedance-2.5 没有 1080p', () => {
  const seedance = videoCapabilities('seedance-2.0');
  assert.deepEqual(seedance.resolutions, ['480p', '720p', '1080p']);
  assert.equal(seedance.durations[0], 4);
  assert.equal(seedance.autoDuration, true);
  assert.ok(seedance.ratios.includes('adaptive'));

  const grok = videoCapabilities('grok-imagine-video');
  assert.deepEqual(grok.resolutions, ['480p', '720p']);
  assert.deepEqual(grok.ratios, ['16:9', '4:3', '1:1', '3:4', '9:16']);
  assert.equal(grok.durations[0], 1);
  assert.equal(grok.durations.at(-1), 15);
  assert.equal(grok.autoDuration, false);

  assert.deepEqual(videoCapabilities('seedance-2.5').resolutions, ['480p', '720p']);
});

test('型号在界面上的名字：火山方舟的写成官方叫法，别的原样显示', () => {
  assert.equal(modelLabel('doubao-seedance-2-5-260628'), 'Seedance 2.5');
  assert.equal(modelLabel('doubao-seedance-2-0-260128'), 'Seedance 2.0');
  assert.equal(modelLabel('doubao-seedance-2-0-fast-260128'), 'Seedance 2.0 Fast');
  assert.equal(modelLabel('doubao-seedance-2-0-mini-260615'), 'Seedance 2.0 Mini');
  assert.equal(modelLabel('doubao-seedream-5-0-pro-260628'), 'Seedream 5.0 Pro');
  for (const id of ['seedance-2.0-fast', 'grok-imagine-video', 'doubao-seed-2-0-pro-260215', '']) assert.equal(modelLabel(id), id);
});

test('火山引擎的费用按用量和单价估算', () => {
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} 应该是 ${expected}`);
  // 视频：token × 单价，输入含视频时用便宜的那一档。
  const video = { kind: 'video', model: 'doubao-seedance-2-5-260628', usage: { completion_tokens: 108900 }, payload: { resolution: '720p' } };
  near(estimateCost(video), 7.623);
  near(estimateCost({ ...video, payload: { resolution: '1080p', input_references: [{ video_url: { url: 'x' } }] } }), 108900 * 46e-6);
  near(estimateCost({ ...video, model: 'doubao-seedance-2-0-fast-260128' }), 108900 * 37e-6);
  // 图片：5.0 pro 按像素分档，参考图第 2 张起收费；其余型号一口价。
  const image = { kind: 'image', model: 'doubao-seedream-5-0-pro-260628', usage: { size: '2048x1152' }, payload: {} };
  near(estimateCost(image), 0.3);
  near(estimateCost({ ...image, usage: { size: '2816x1584' }, payload: { input_references: [{}, {}, {}] } }), 0.64);
  near(estimateCost({ ...image, model: 'doubao-seedream-5-0-flash-260915' }), 0.12);
  near(estimateCost({ ...image, model: 'doubao-seedream-5-0-260128' }), 0.22);
  // 语音：按计费字符数。
  near(estimateCost({ kind: 'audio', tool: 'speech', model: 'seed-tts-2.0', usage: { text_words: 200 } }), 0.06);
  // 别的平台、没有用量、价目表里没有的档位：不估。
  assert.equal(estimateCost({ kind: 'video', model: 'seedance-2.0', usage: { completion_tokens: 100 }, payload: { resolution: '720p' } }), null);
  assert.equal(estimateCost({ ...video, usage: null }), null);
  assert.equal(estimateCost({ ...video, payload: { resolution: '4k' } }), null);
});
