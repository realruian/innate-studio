// 模型登记表：型号的附注、各模型的参数范围。

import test from 'node:test';
import assert from 'node:assert/strict';
import { modelLabel, modelNote, polishGuide, estimateCost } from '../shared/models.ts';

test('型号附注：同一档的型号附注相同，没有分档的不加', () => {
  assert.equal(modelNote('doubao-seedance-2-0-fast-260128'), '快速版');
  assert.equal(modelNote('doubao-seedance-2-0-mini-260615'), '轻量版');
  // 官方只有 Fast 和 Mini 两档有名字，不带后缀的不标；不是 Seedance 的也不标。
  for (const id of ['doubao-seedance-2-0-260128', 'doubao-seedance-2-5-260628', 'doubao-seedream-5-0-pro-260628']) assert.equal(modelNote(id), '', id);
});

test('润色规则按型号选，认不出来的视频型号按 Seedance 2.0 处理', () => {
  assert.match(polishGuide({ kind: 'video', model: 'doubao-seedance-2-0-260128', mode: 'text' }), /Seedance 视频模型/);
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

test('型号在界面上的名字：写成官方叫法，认不出来的原样显示', () => {
  assert.equal(modelLabel('doubao-seedance-2-5-260628'), 'Seedance 2.5');
  assert.equal(modelLabel('doubao-seedance-2-0-260128'), 'Seedance 2.0');
  assert.equal(modelLabel('doubao-seedance-2-0-fast-260128'), 'Seedance 2.0 Fast');
  assert.equal(modelLabel('doubao-seedance-2-0-mini-260615'), 'Seedance 2.0 Mini');
  assert.equal(modelLabel('doubao-seedream-5-0-pro-260628'), 'Seedream 5.0 Pro');
  assert.equal(modelLabel('seed-tts-2.0'), 'Seed-TTS 2.0');
  assert.equal(modelLabel('seed-audio-1.0'), 'Seed-Audio 1.0');
  for (const id of ['seedance-2.0-fast', 'doubao-seed-2-0-pro-260215', '']) assert.equal(modelLabel(id), id);
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
  // 音效、配乐：按生成的秒数。
  near(estimateCost({ kind: 'audio', tool: 'sfx', model: 'seed-audio-1.0', usage: { audio_seconds: 30 } }), 0.5);
  // 语音：按计费字符数。
  near(estimateCost({ kind: 'audio', tool: 'speech', model: 'seed-tts-2.0', usage: { text_words: 200 } }), 0.06);
  // 别的平台、没有用量、价目表里没有的档位：不估。
  assert.equal(estimateCost({ kind: 'video', model: 'seedance-2.0', usage: { completion_tokens: 100 }, payload: { resolution: '720p' } }), null);
  assert.equal(estimateCost({ ...video, usage: null }), null);
  assert.equal(estimateCost({ ...video, payload: { resolution: '4k' } }), null);
});

test('MiniMax H3：名字、附注、润色规则和按秒算的费用', () => {
  assert.equal(modelLabel('MiniMax-H3'), 'MiniMax H3');
  assert.equal(modelLabel('MiniMax-H3-Max'), 'MiniMax H3 Max');
  assert.equal(modelNote('MiniMax-H3'), '');
  assert.equal(modelNote('MiniMax-H3-Max'), '快速版');
  // 没核对过官方写法，用通用的一份，不能把 Seedance 的规则套上去。
  const guide = polishGuide({ kind: 'video', model: 'MiniMax-H3', mode: 'frames' });
  assert.doesNotMatch(guide, /Seedance/);
  assert.match(guide, /首尾帧生成/);
  // 2K 0.80 元/秒；参考视频按输入秒数同价另收；参考图 5 张以内免费，之后每张 0.20。
  const cost = (model, resolution, usage) => estimateCost({ model, kind: 'video', payload: { resolution }, usage });
  assert.equal(cost('MiniMax-H3', '2K', { output_seconds: 5 }), 4);
  assert.equal(cost('MiniMax-H3', '768P', { output_seconds: 10, input_seconds: 4, input_image_count: 7 }).toFixed(2), '7.40');
  assert.equal(cost('MiniMax-H3-Max', '480P', { output_seconds: 10, input_image_count: 3 }).toFixed(2), '3.80');
  assert.equal(cost('MiniMax-H3', '1080p', { output_seconds: 5 }), null);
});

test('AiHubMix 的图片模型：名字；GPT Image 2.5 各档大小都在它收的范围里', async () => {
  const { AIHUBMIX_IMAGE_MODELS } = await import('../shared/models.ts');
  assert.equal(modelLabel('gpt-image-2.5-sunburst'), 'GPT Image 2.5 Sunburst');
  assert.equal(modelLabel('gpt-image-2.5-flare'), 'GPT Image 2.5 Flare');
  assert.equal(modelLabel('gemini-nano-banana-2.1'), 'Nano Banana 2.1');
  // 宽高都是 16 的倍数，长边不超过 3840，总像素 655,360 到 8,294,400，长宽比 1:3 到 3:1，并且和标着的比例对得上。
  for (const [tier, sizes] of Object.entries(AIHUBMIX_IMAGE_MODELS['gpt-image-2.5-flare'].sizes)) {
    for (const [ratio, size] of Object.entries(sizes)) {
      const [w, h] = size.split('x').map(Number);
      const [rw, rh] = ratio.split(':').map(Number);
      assert.equal(w % 16 === 0 && h % 16 === 0 && Math.max(w, h) <= 3840, true, `${tier} ${ratio} ${size}`);
      assert.equal(w * h >= 655360 && w * h <= 8294400, true, `${tier} ${ratio} ${size} 像素数`);
      assert.equal(Math.abs(w / h - rw / rh) < 0.02, true, `${tier} ${ratio} ${size} 比例`);
    }
  }
});
