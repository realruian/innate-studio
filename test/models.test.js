// 模型登记表：型号的附注、各模型的参数范围。

import test from 'node:test';
import assert from 'node:assert/strict';
import { modelNote, videoFamilyOf, videoCapabilities } from '../shared/models.ts';

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
