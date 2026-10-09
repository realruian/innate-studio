// 模型登记表：型号的附注、各模型的参数范围。

import test from 'node:test';
import assert from 'node:assert/strict';
import { modelNote, videoFamilyOf, videoCapabilities, videoSpecOf, polishGuide } from '../shared/models.ts';

test('型号附注：同一档的型号附注相同，没有分档的不加', () => {
  // seedance-2.0 就是专业版，和带 -pro 的是同一档，两个都要标。
  assert.equal(modelNote('seedance-2.0'), '专业版');
  assert.equal(modelNote('seedance-2.0-pro'), '专业版');
  assert.equal(modelNote('seedance-2.5-pro'), '专业版');
  assert.equal(modelNote('seedance-2.0-fast'), '快速版');
  assert.equal(modelNote('seedance-2.0-mini'), '轻量版');
  for (const id of ['seedance-2.5', 'grok-imagine-video', 'grok-imagine-video-1.5', 'grok-imagine-image-2.0']) assert.equal(modelNote(id), '', id);
});

test('视频模型分两族，认不出来的不算视频模型', () => {
  assert.equal(videoFamilyOf('seedance-2.0-fast'), 'seedance');
  assert.equal(videoFamilyOf('grok-imagine-video-1.5'), 'grok');
  assert.equal(videoFamilyOf('MiniMax-H3'), null);
  assert.equal(videoFamilyOf(undefined), null);
  // OpenRouter 的型号前面带厂商，一样认得出；它上面别的模型不属于这两族。
  assert.equal(videoFamilyOf('bytedance/seedance-2.5'), 'seedance');
  assert.equal(videoFamilyOf('x-ai/grok-imagine-video-1.5'), 'grok');
  assert.equal(videoFamilyOf('google/veo-3.1'), null);
});

test('OpenRouter 的模型：整理出支持什么，分辨率和时长从小到大；不是生成模型的不要', () => {
  const spec = videoSpecOf({ supported_resolutions: ['4K', '720p', '1080p'], supported_aspect_ratios: ['16:9'], supported_durations: [8, 4, 6], supported_frame_images: ['first_frame', 'last_frame'], generate_audio: true, seed: null });
  assert.deepEqual(spec, { resolutions: ['720p', '1080p', '4K'], ratios: ['16:9'], durations: [4, 6, 8], autoDuration: false, frames: ['first_frame', 'last_frame'], audio: true, seed: false });
  assert.equal(videoSpecOf({ supported_resolutions: null, supported_durations: null }), null);
});

test('润色规则：OpenRouter 上不是 Seedance 和 Grok 的视频模型用通用写法', () => {
  assert.match(polishGuide({ kind: 'video', model: 'google/veo-3.1', mode: 'text' }), /AI 视频生成模型/);
  assert.match(polishGuide({ kind: 'video', model: 'bytedance/seedance-2.5', mode: 'text' }), /Seedance 视频模型/);
  assert.match(polishGuide({ kind: 'video', model: 'x-ai/grok-imagine-video', mode: 'text' }), /Grok Imagine 视频模型/);
  // 不带厂商前缀又认不出来的，仍按 Seedance 处理。
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
