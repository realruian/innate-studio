// 画布的规则：哪种节点能连哪种、连进来的素材怎么排进视频请求。

import test from 'node:test';
import assert from 'node:assert/strict';
import { canLink, targetsOf, sourcesOf, linkLabel, joinPrompt, videoFormFrom, stripNodeData } from '../web/src/canvas/model.ts';
import { buildRequest } from '../web/src/request.ts';

const base = {
  mode: 'text', prompt: '', model: 'seedance-2.0', resolution: '720p', ratio: '16:9', duration: 5, durationAuto: true, generateAudio: true, watermark: false, seed: '', webSearch: false, inputType: 'auto',
  sr: { enabled: false, by: 'resolution', resolution: '1080p', limit: 1440, scene: '', tool: 'standard', fps: '' },
  frames: { first: null, last: null },
  refs: { image: [], video: [], audio: [] },
};
const node = { prompt: '', model: 'seedance-2.0-fast', resolution: '480p', ratio: '9:16', duration: 8 };
const ref = (kind, n) => ({ uid: `${kind}${n}`, kind, source: 'asset', assetId: `a${n}`, url: `asset://a${n}`, name: `${kind}${n}`, thumb: null });
const input = (kind, role, n) => ({ kind, role, ref: ref(kind, n) });

test('连线：文本可以给任何会生成的节点，图片还能给图片当参考图，视频和音频只能给视频', () => {
  assert.deepEqual(targetsOf('text'), ['text', 'image', 'video', 'audio']);
  assert.deepEqual(sourcesOf('video'), ['text', 'image', 'video', 'audio']);
  assert.deepEqual(sourcesOf('image'), ['text', 'image']);
  for (const kind of ['image', 'video', 'audio']) {
    assert.ok(canLink(kind, 'video'));
    assert.equal(canLink(kind, 'image'), kind === 'image');
    assert.ok(!canLink(kind, 'text'));
  }
});

test('连线上的字：图片按用途标，文本不标', () => {
  assert.equal(linkLabel({ kind: 'text' }), '');
  assert.equal(linkLabel({ kind: 'image' }), '参考图');
  assert.equal(linkLabel({ kind: 'image', role: 'first' }), '首帧');
  assert.equal(linkLabel({ kind: 'video' }), '参考视频');
});

test('提示词：上游文本在前，自己写的在后，空的不算', () => {
  assert.equal(joinPrompt([' 一只猫 ', ''], '慢镜头'), '一只猫\n慢镜头');
  assert.equal(joinPrompt([], '  '), '');
});

test('没有素材连进来是文生视频，参数用节点自己的', () => {
  const { form, problems } = videoFormFrom(base, node, '一只猫', []);
  assert.deepEqual(problems, []);
  assert.equal(form.mode, 'text');
  assert.deepEqual([form.model, form.resolution, form.ratio, form.duration, form.durationAuto], ['seedance-2.0-fast', '480p', '9:16', 8, false]);
  assert.deepEqual(buildRequest(form).problems, []);
});

test('素材都是参考用途时是参考生成，按种类分开', () => {
  const { form, problems } = videoFormFrom(base, node, '', [input('image', 'reference', 1), input('video', 'reference', 2), input('image', 'reference', 3)]);
  assert.deepEqual(problems, []);
  assert.equal(form.mode, 'reference');
  assert.deepEqual(form.refs.image.map((r) => r.uid), ['image1', 'image3']);
  assert.deepEqual(form.refs.video.map((r) => r.uid), ['video2']);
  const roles = buildRequest(form).payload.content.map((c) => c.role);
  assert.deepEqual(roles, ['reference_image', 'reference_image', 'reference_video']);
});

test('有连线标了首帧或尾帧就按首尾帧生成', () => {
  const { form, problems } = videoFormFrom(base, node, '', [input('image', 'last', 1), input('image', 'first', 2)]);
  assert.deepEqual(problems, []);
  assert.equal(form.mode, 'frames');
  assert.equal(form.frames.first.uid, 'image2');
  assert.equal(form.frames.last.uid, 'image1');
});

test('首尾帧摆不通的情况会说明原因', () => {
  assert.match(videoFormFrom(base, node, '', [input('image', 'last', 1)]).problems[0], /还需要一张首帧/);
  assert.match(videoFormFrom(base, node, '', [input('image', 'first', 1), input('image', 'first', 2)]).problems[0], /首帧只能有一张/);
  assert.match(videoFormFrom(base, node, '', [input('image', 'first', 1), input('image', 'reference', 2)]).problems[0], /不能一起用/);
});

test('存画布之前去掉只在页面上有意义的状态', () => {
  assert.deepEqual(stripNodeData({ prompt: 'a', recordId: 'r1', busy: '准备中', error: '失败了' }), { prompt: 'a', recordId: 'r1' });
});
