// 模型登记表：型号的附注、各模型的参数范围。

import test from 'node:test';
import assert from 'node:assert/strict';
import { modelLabel, modelNote, videoFamilyOf, referenceModeLabel, videoCapabilities, polishGuide, isProvider } from '../shared/models.ts';

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
