// 素材能不能用：看的是目标模型在不在可用列表里，不是汇总状态。

import test from 'node:test';
import assert from 'node:assert/strict';
import { assetReadiness } from '../web/src/store.ts';

const asset = (status, available_models = []) => ({ id: 'ast_1', status, available_models });

test('汇总状态是失败，但目标模型在可用列表里：能用', () => {
  // 真实接口对视频素材就是这样返回的。
  const video = asset('Failed', ['seedance-2.0', 'seedance-2.0-pro']);
  assert.deepEqual(assetReadiness(video, 'seedance-2.0'), { ready: true, tone: 'ok', label: '可用' });
  // 要用的模型不在列表里，才是失败。
  assert.equal(assetReadiness(video, 'seedance-2.5').ready, false);
  assert.equal(assetReadiness(video, 'seedance-2.5').label, '处理失败');
  // 素材库页面不针对某个模型：有模型能用就不算失败。
  assert.deepEqual(assetReadiness(video), { ready: true, tone: 'ok', label: '部分模型可用' });
  assert.equal(assetReadiness(asset('Failed')).label, '处理失败');
});

test('还在处理：目标模型已经可用就不用再等；过期和已删除的不能用', () => {
  assert.equal(assetReadiness(asset('Processing', ['seedance-2.0-fast']), 'seedance-2.0-fast').ready, true);
  assert.equal(assetReadiness(asset('Processing', ['seedance-2.0-fast']), 'seedance-2.0').label, '处理中');
  assert.equal(assetReadiness(asset('Active'), 'seedance-2.0').ready, true);
  assert.equal(assetReadiness(asset('Expired', ['seedance-2.0']), 'seedance-2.0').ready, false);
  assert.equal(assetReadiness(asset('Deleted', ['seedance-2.0']), 'seedance-2.0').ready, false);
  assert.equal(assetReadiness(null, 'seedance-2.0').label, '查询中');
});
