// 画布的规则：哪种节点能连哪种、连进来的素材怎么排进视频请求。

import test from 'node:test';
import assert from 'node:assert/strict';
import { canLink, targetsOf, sourcesOf, linkLabel, joinPrompt, videoFormFrom, stripNodeData, nodeWidth, clipOf, pasteClip, snapTo, tidy, placeResults, groupFrame, runOrder, resolveMentions } from '../web/src/canvas/model.ts';
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

test('节点的宽度：空着时形状固定，不跟着所选的比例变；有了内容按它实际的宽高比，收在范围里', () => {
  assert.equal(nodeWidth('text'), 240);
  assert.equal(nodeWidth('audio'), 320);
  assert.equal(nodeWidth('image', { ratio: '9:16' }), 240);
  assert.equal(nodeWidth('video', { ratio: '9:16' }), 427);
  assert.equal(nodeWidth('video', { ratio: '9:16', aspect: 9 / 16 }), 150);
  assert.equal(nodeWidth('image', { aspect: 1.5 }), 360);
  assert.equal(nodeWidth('video', { aspect: 3 }), 560);
});

test('拖动对齐：靠近别的框的边线或中线就吸过去，参考线画在两个框之间；离得远不吸', () => {
  const other = { x: 0, y: 0, width: 240, height: 240 };
  // 在右边隔开 100，顶边差 4：吸到顶边，上、中、下三条线都对上（一样高）。
  const near = snapTo({ x: 340, y: 4, width: 427, height: 240 }, [other], 6);
  assert.deepEqual([near.dx, near.dy], [0, -4]);
  assert.deepEqual(near.guides, [
    { x1: 240, y1: 0, x2: 340, y2: 0 },
    { x1: 240, y1: 120, x2: 340, y2: 120 },
    { x1: 240, y1: 240, x2: 340, y2: 240 },
  ]);
  // 在下面，左边差 5：吸到左边线，竖着的参考线画在上下两个框之间。
  const below = snapTo({ x: 5, y: 400, width: 150, height: 240 }, [other], 6);
  assert.deepEqual([below.dx, below.dy], [-5, 0]);
  assert.deepEqual(below.guides, [{ x1: 0, y1: 240, x2: 0, y2: 400 }]);
  // 差得比 reach 多：不动，也没有参考线。
  const far = snapTo({ x: 300, y: 30, width: 100, height: 240 }, [other], 6);
  assert.deepEqual(far, { dx: 0, dy: 0, guides: [] });
});

test('一键整理：按连线从左到右分列，同一列上下排开；零散的节点排在最下面一行；左上角不动', () => {
  const at = (x, y) => ({ x, y });
  const nodes = [
    { id: 'video', position: at(900, 700), width: 427 },
    { id: 'text', position: at(130, 90), width: 240 },
    { id: 'imgB', position: at(500, 600), width: 240 },
    { id: 'imgA', position: at(480, 100), width: 360 },
    { id: 'lonely', position: at(100, 900), width: 320 },
    { id: 'lonely2', position: at(700, 950), width: 240 },
  ];
  const edges = [
    { source: 'text', target: 'imgA' },
    { source: 'text', target: 'imgB' },
    { source: 'imgA', target: 'video' },
    { source: 'imgB', target: 'video' },
    { source: 'text', target: 'video' },
  ];
  const placed = tidy(nodes, edges);
  assert.deepEqual(placed.get('text'), at(100, 90));
  // 第二列在文本右边隔 120；两张图上下排，行距是节点的高度加 56。
  assert.deepEqual(placed.get('imgA'), at(460, 90));
  assert.deepEqual(placed.get('imgB'), at(460, 410));
  // 视频直接连着文本，也连着图片：排在图片后面那一列，列的位置按这一列最宽的节点让开。
  assert.deepEqual(placed.get('video'), at(940, 90));
  // 零散的在这一组下面排成一行。
  assert.deepEqual(placed.get('lonely'), at(100, 730));
  assert.deepEqual(placed.get('lonely2'), at(500, 730));
  assert.equal(tidy([], []).size, 0);
});

test('复制粘贴：只带走两头都选中的连线，粘贴出来的换了新 id、相互位置不变，不带页面上的临时状态', () => {
  const nodes = [
    { id: 'a', type: 'text', position: { x: 100, y: 50 }, data: { text: '你好', busy: '正在写', error: '出错了' } },
    { id: 'b', type: 'image', position: { x: 400, y: 80 }, data: { prompt: '', model: 'm', ratio: '1:1', recordId: 'r1' } },
  ];
  const edges = [
    { id: 'e1', source: 'a', target: 'b', data: { kind: 'text' } },
    { id: 'e2', source: 'b', target: 'c', data: { kind: 'image', role: 'first' } },
  ];
  const clip = clipOf(nodes, edges);
  assert.deepEqual(clip.edges.map((e) => e.id), ['e1']);
  assert.deepEqual(clip.nodes[0].data, { text: '你好' });

  let n = 0;
  const pasted = pasteClip(clip, { at: { x: 0, y: 0 } }, () => `new${++n}`);
  assert.deepEqual(pasted.nodes.map((node) => [node.id, node.position]), [['new1', { x: 0, y: 0 }], ['new2', { x: 300, y: 30 }]]);
  assert.deepEqual(pasted.edges.map((e) => [e.source, e.target, e.data]), [['new1', 'new2', { kind: 'text' }]]);
  assert.equal(pasted.nodes[1].data.recordId, 'r1');
  assert.notEqual(pasted.nodes[1].data, clip.nodes[1].data);

  const copy = pasteClip(clip, { by: { x: 40, y: 40 } }, () => `dup${++n}`);
  assert.deepEqual(copy.nodes.map((node) => node.position), [{ x: 140, y: 90 }, { x: 440, y: 120 }]);
});

test('再次生成：空节点先装第一份，多出来的排在下面；已有内容的节点不动，结果全是新节点；下面有节点就跳过去', () => {
  const source = { id: 's', position: { x: 100, y: 100 }, width: 240 };
  // 空节点出 3 份：第一份进它自己，另外两份在下面，行距是节点的高度加 56（320）。
  assert.deepEqual(placeResults(source, false, 3, [source]), { here: 0, spots: [{ x: 100, y: 420 }, { x: 100, y: 740 }] });
  assert.deepEqual(placeResults(source, false, 1, [source]), { here: 0, spots: [] });
  // 已有内容出 2 份：都在下面。
  assert.deepEqual(placeResults(source, true, 2, [source]), { here: -1, spots: [{ x: 100, y: 420 }, { x: 100, y: 740 }] });
  // 正下方已经有一个节点：跳过那一行。旁边隔得远的不算。
  const below = { id: 'b', position: { x: 160, y: 430 }, width: 240 };
  const aside = { id: 'c', position: { x: 900, y: 420 }, width: 240 };
  assert.deepEqual(placeResults(source, true, 1, [source, below, aside]).spots, [{ x: 100, y: 740 }]);
});

test('分组：框按成员占的范围算，四周各留 24；执行顺序是上游在前，组外的线不算；复制出来的分组指向新的成员', () => {
  assert.equal(groupFrame([]), null);
  assert.deepEqual(groupFrame([{ x: 100, y: 100, width: 240, height: 264 }, { x: 460, y: 180, width: 427, height: 264 }]), { x: 76, y: 76, width: 835, height: 392 });

  const edges = [{ source: 'text', target: 'image' }, { source: 'image', target: 'video' }, { source: 'text', target: 'video' }, { source: 'outside', target: 'text' }];
  assert.deepEqual(runOrder(['video', 'image', 'text'], edges), ['text', 'image', 'video']);
  assert.deepEqual(runOrder(['video', 'image'], edges), ['image', 'video']);

  const clip = clipOf(
    [
      { id: 'g', type: 'group', position: { x: 0, y: 0 }, data: { name: '开场', members: ['a', 'b'] } },
      { id: 'a', type: 'text', position: { x: 100, y: 50 }, data: { text: '' } },
      { id: 'b', type: 'image', position: { x: 400, y: 80 }, data: { prompt: '', model: 'm', ratio: '1:1' } },
    ],
    [],
  );
  let n = 0;
  const pasted = pasteClip(clip, { at: { x: 1000, y: 1000 } }, () => `n${++n}`);
  assert.deepEqual(pasted.nodes[0].data.members, ['n2', 'n3']);
  assert.deepEqual(pasted.nodes[1].position, { x: 1000, y: 1000 });
});

test('@ 引用：图片、视频换成它在这次请求里排第几个；文本换成它的内容并记下来；没连进来的原样留着', () => {
  const inputs = [
    { name: '文本 2', kind: 'text', text: ' 赛博朋克风格 ' },
    { name: '图片 5', kind: 'image' },
    { name: '视频 1', kind: 'video' },
    { name: '图片 2', kind: 'image' },
  ];
  const out = resolveMentions('让@图片 2里的人走进@图片5的街道，动作参考@视频 1，整体是@文本 2。别管@图片 9', inputs);
  assert.equal(out.prompt, '让图2里的人走进图1的街道，动作参考视频1，整体是赛博朋克风格。别管@图片 9');
  assert.deepEqual([...out.inlined], ['文本 2']);
  assert.deepEqual(resolveMentions('没有引用', inputs), { prompt: '没有引用', inlined: new Set() });
});
