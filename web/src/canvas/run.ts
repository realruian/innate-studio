// 让一个节点生成：把连进来的文本和素材收齐，拼成和创作页一样的请求，交给本地服务。
// 结果是一条普通的生成记录，节点只记它的 id，进度跟着「创作记录」的轮询走。

import type { Edge, Node, ReactFlowInstance } from '@xyflow/react';
import { api, state, KINDS, startHistoryLoop, loadHistory, polishModel, canManage } from '../store.ts';
import { defaults, fitImageQuality, fitImageSize, hasLastFrame, imageRefLimit, specOf } from '../composer/state.ts';
import { buildVideoRequest, buildImageRequest, buildSpeechRequest, buildSfxRequest } from '../request.ts';
import { recordName } from '../media.ts';
import { toast } from '../ui/layers.tsx';
import type { HistoryItem, Kind, Ref } from '../types.ts';
import { NODE_LABELS, joinPrompt, nodeWidth, numbered, placeResults, resolveMentions, runOrder, stripNodeData, videoFormFrom, type AudioData, type ImageData, type LinkData, type MediaInput, type NodeKind, type TextData, type VideoData } from './model.ts';

type Flow = ReactFlowInstance<Node, Edge>;
type AnyData = Partial<ImageData & VideoData & AudioData & TextData>;

export const recordOf = (data: { recordId?: string }): HistoryItem | undefined => (data.recordId ? state.history.find((h) => h.id === data.recordId) : undefined);

// 一个节点现在能交给下游的东西：本机的一个文件。还没生成完、或者文件不在本机，就是 null。
export function outputOf(node: Node): { url: string; kind: Kind; name: string } | null {
  const data = node.data as AnyData;
  if (data.upload) return { url: data.upload.url, kind: node.type as Kind, name: data.upload.name };
  const record = recordOf(data);
  if (!record || record.status !== 'completed' || !record.mediaUrl || !record.savedLocally) return null;
  return { url: record.mediaUrl, kind: record.kind, name: recordName(record) };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function submitVideo(node: Node, sources: { link: LinkData; node: Node }[], prompt: string, say: (text: string) => void) {
  const data = node.data as unknown as VideoData;
  const media = sources.filter((s) => s.link.kind !== 'text');
  const counts: Record<Kind, number> = { image: 0, video: 0, audio: 0 };
  const inputs: MediaInput[] = [];
  for (const { link, node: source } of media) {
    const kind = link.kind as Kind;
    const output = outputOf(source);
    if (!output) throw new Error(`上游${NODE_LABELS[kind]}节点尚未生成`);
    if (++counts[kind] > KINDS[kind].max) throw new Error(`参考${NODE_LABELS[kind]}最多 ${KINDS[kind].max} 个`);
    const role = kind === 'image' ? link.role || 'reference' : 'reference';
    if (role === 'last' && !hasLastFrame(data.model)) throw new Error(`${data.model} 不支持尾帧`);
    inputs.push({ kind, role, ref: { uid: crypto.randomUUID(), kind, source: 'local', url: output.url, name: output.name, thumb: null } });
  }
  const { form, problems } = videoFormFrom(defaults(), data, prompt, inputs);
  const request = buildVideoRequest(form, specOf(data.model));
  const problem = problems[0] || request.problems[0];
  if (problem) throw new Error(problem);
  say('正在提交');
  return (await api<HistoryItem>('POST', '/api/videos', { payload: request.payload, form: { ...form, ...FROM_CANVAS } })).id;
}

// 画布上提交的记录带着这个记号：创作页的「最近生成」不列它们，记录页里切到「画布」才看。
const FROM_CANVAS = { from: 'canvas' };

async function submitImage(node: Node, sources: { link: LinkData; node: Node }[], prompt: string, given?: { url: string; name: string }[]) {
  const data = node.data as unknown as ImageData;
  // 连进来的图片是参考图（图生图）。given 是这一次临时指定的参考图（扩图的底图），有它就不看连线。
  const refs: Ref[] = given
    ? given.map((item) => ({ uid: crypto.randomUUID(), kind: 'image' as const, source: 'local' as const, url: item.url, name: item.name, thumb: null }))
    : sources
    .filter((s) => s.link.kind === 'image')
    .map((s) => {
      const output = outputOf(s.node);
      if (!output) throw new Error('上游图片节点尚未生成');
      return { uid: crypto.randomUUID(), kind: 'image' as const, source: 'local' as const, url: output.url, name: output.name, thumb: null };
    });
  const form = { prompt, model: data.model, ratio: data.ratio, resolution: fitImageSize(data.model, data.resolution), quality: fitImageQuality(data.model, data.quality), count: data.count || 1, refs };
  const request = buildImageRequest(form, imageRefLimit(data.model));
  if (request.problems.length) throw new Error(request.problems[0]);
  return (await api<{ items: HistoryItem[] }>('POST', '/api/images', { payload: request.payload, form: { type: 'image', ...form, ...FROM_CANVAS } })).items.map((item) => item.id);
}

async function submitAudio(node: Node, prompt: string) {
  const data = node.data as unknown as AudioData;
  if (data.tool === 'sfx') {
    const form = { prompt, duration: 'auto' };
    const request = buildSfxRequest(form);
    if (request.problems.length) throw new Error(request.problems[0]);
    return (await api<HistoryItem>('POST', '/api/audio/sfx', { ...request.body, form: { type: 'sfx', ...form, ...FROM_CANVAS } })).id;
  }
  const form = { prompt, voiceId: data.voiceId, voiceName: data.voiceName };
  const request = buildSpeechRequest(form);
  if (request.problems.length) throw new Error(request.problems[0]);
  return (await api<HistoryItem>('POST', '/api/audio/speech', { ...request.body, form: { type: 'speech', ...form, ...FROM_CANVAS } })).id;
}

// 一个节点显示出来的名字：图片 1。提示词里 @ 的就是它。
export const nameOf = (node: Node) => `${NODE_LABELS[node.type as NodeKind]}${node.data.no ? ` ${node.data.no}` : ''}`;

// 最后发给模型的提示词：先把 @ 引用换掉，再把没被 @ 到的上游文本节点整段拼在前面。
function promptOf(sources: { link: LinkData; node: Node }[], own: string) {
  const { prompt, inlined } = resolveMentions(own, sources.map((s) => ({ name: nameOf(s.node), kind: s.link.kind, text: (s.node.data as AnyData).text })));
  const upstream = sources.filter((s) => s.link.kind === 'text' && !inlined.has(nameOf(s.node))).map((s) => (s.node.data as AnyData).text || '');
  return joinPrompt(upstream, prompt);
}

// 节点里是不是已经有内容了：上传的、生成出来的（生成失败的、记录已经删掉的不算）。
export function isFilled(data: AnyData) {
  const record = recordOf(data);
  return Boolean(data.upload || (record && record.status !== 'failed') || (data.text || '').trim());
}

// 把一批结果放上画布。节点还空着，第一份放进它自己；已经有内容，原来的留着不动。其余每份一个新节点：
// 参数和提示词照抄原节点，连进原节点的线也照样连进它，排在原节点下面。snap 是撤销用的那一下。
export function deliver(flow: Flow, id: string, results: Record<string, unknown>[], snap: () => void) {
  const node = flow.getNode(id);
  if (!node || !results.length) return;
  const width = (n: Node) => n.measured?.width || nodeWidth(n.type as NodeKind, n.data);
  const { here, spots } = placeResults({ id, position: node.position, width: width(node) }, isFilled(node.data as AnyData), results.length, flow.getNodes().filter((n) => n.type !== 'group' && !n.hidden).map((n) => ({ id: n.id, position: n.position, width: width(n) })));
  if (here >= 0) flow.updateNodeData(id, results[here]);
  const rest = results.filter((_, index) => index !== here);
  if (!rest.length) return;
  snap();
  // 新节点不带原节点的那份内容，也不带「一次几张」：再点它生成，默认只出一份。
  const base = { ...stripNodeData(node.data), recordId: undefined, upload: undefined, aspect: undefined, count: undefined, no: undefined };
  const fresh = numbered(rest.map((result, index) => ({ id: crypto.randomUUID(), type: node.type, position: spots[index], data: { ...base, ...result } }) as Node), flow.getNodes());
  const incoming = flow.getEdges().filter((edge) => edge.target === id);
  flow.addNodes(fresh);
  flow.addEdges(fresh.flatMap((made) => incoming.map((edge) => ({ ...edge, id: crypto.randomUUID(), target: made.id, selected: false }))));
  // 原节点在一个分组里，新节点也进这个组。
  for (const group of flow.getNodes()) {
    const members = (group.data as { members?: string[] }).members;
    if (group.type === 'group' && members?.includes(id)) flow.updateNodeData(group.id, { members: [...members, ...fresh.map((made) => made.id)] });
  }
}

// once：只管这一次的临时安排。prompt 是直接用这段提示词（斜杠预设、扩图），refs 是直接用这几张参考图。
export async function generate(flow: Flow, id: string, snap: () => void = () => {}, once: { prompt?: string; refs?: { url: string; name: string }[] } = {}) {
  const node = flow.getNode(id);
  if (!node || (node.data as AnyData).busy) return;
  if (node.type === 'text') return write(flow, id, snap);
  if (!state.app.hasKey) return toast(canManage() ? '请先在「管理」中配置 API Key' : '服务暂未开通', 'info');
  const say = (busy: string) => flow.updateNodeData(id, { busy });
  flow.updateNodeData(id, { busy: '准备中', error: '' });
  try {
    const sources = flow
      .getEdges()
      .filter((edge) => edge.target === id)
      .map((edge) => ({ link: edge.data as unknown as LinkData, node: flow.getNode(edge.source)! }))
      .filter((s) => s.node);
    const prompt = promptOf(sources, once.prompt ?? ((node.data as AnyData).prompt || ''));
    const kind = node.type as NodeKind;
    const count = Math.max(1, Number((node.data as AnyData).count) || 1);
    let ids: string[];
    if (kind === 'image') ids = await submitImage(node, sources, prompt, once.refs);
    else if (kind === 'video') {
      // 视频接口一次只出一段，要几段就提交几次。中途有一次没提交上，已经提交的照样放上画布。
      ids = [];
      for (let n = 0; n < count; n++) {
        try {
          ids.push(await submitVideo(node, sources, prompt, (text) => say(count > 1 ? `${text}（${n + 1}/${count}）` : text)));
        } catch (err) {
          if (!ids.length) throw err;
          toast(`第 ${n + 1} 段提交失败：${(err as Error).message}`, 'error', 6000);
          break;
        }
      }
    } else ids = [await submitAudio(node, prompt)];
    // 音频还是在原节点上换成新的；图片、视频已经有内容时不覆盖，新结果放进新节点。
    if (kind === 'audio') flow.updateNodeData(id, { recordId: ids[0], upload: undefined });
    else deliver(flow, id, ids.map((recordId) => ({ recordId, upload: undefined })), snap);
    await loadHistory().catch(() => {});
    startHistoryLoop();
  } catch (err) {
    flow.updateNodeData(id, { error: (err as Error).message });
    toast((err as Error).message, 'error', 6000);
  } finally {
    flow.updateNodeData(id, { busy: '' });
  }
}

// 文本节点让文本模型写：连进来的文本节点和框里已有的内容当参考，写出来的放进框里（框里已经有字就放进新节点）。
async function write(flow: Flow, id: string, snap: () => void) {
  const node = flow.getNode(id)!;
  const data = node.data as AnyData;
  const prompt = (data.prompt || '').trim();
  const model = state.catalog.polish.includes(data.model || '') ? data.model! : polishModel();
  if (!prompt) return toast('请输入写作要求', 'info');
  if (!model) return toast('暂无可用的文本模型', 'info');
  flow.updateNodeData(id, { busy: '生成中', error: '' });
  try {
    const sources = flow
      .getEdges()
      .filter((edge) => edge.target === id && (edge.data as unknown as LinkData)?.kind === 'text')
      .map((edge) => ({ link: edge.data as unknown as LinkData, node: flow.getNode(edge.source)! }))
      .filter((s) => s.node);
    // 要求里 @ 到的文本节点，内容直接写进要求；其余连进来的文本和框里已有的内容当参考。
    const { prompt: ask, inlined } = resolveMentions(prompt, sources.map((s) => ({ name: nameOf(s.node), kind: 'text' as const, text: (s.node.data as AnyData).text })));
    const upstream = sources.filter((s) => !inlined.has(nameOf(s.node))).map((s) => (s.node.data as AnyData).text || '');
    const result = await api<{ text: string }>('POST', '/api/text', { prompt: ask, context: joinPrompt(upstream, data.text || ''), model });
    deliver(flow, id, [{ text: result.text }], snap);
  } catch (err) {
    flow.updateNodeData(id, { error: (err as Error).message });
    toast((err as Error).message, 'error', 6000);
  } finally {
    flow.updateNodeData(id, { busy: '' });
  }
}

// ---------- 执行整组 ----------

const RUN_WAIT_MS = 20 * 60 * 1000;

// 把一批节点按上游到下游的顺序挨个生成。只动还没有内容的节点：已经有内容的当作现成的输入，不重新生成。
// 每个节点要等它出了结果才轮到下一个，因为下游要拿它的结果当输入。中途有一个失败就停下。
export async function runAll(flow: Flow, ids: string[], snap: () => void) {
  const todo = runOrder(ids, flow.getEdges()).filter((id) => {
    const node = flow.getNode(id);
    if (!node || isFilled(node.data as AnyData)) return false;
    // 没写要求的文本节点是留给人自己填的，跳过。
    return node.type !== 'text' || Boolean(((node.data as AnyData).prompt || '').trim());
  });
  if (!todo.length) return toast('该分组没有待生成的节点', 'info');
  toast(`开始执行，共 ${todo.length} 个节点`, 'info', 2400);
  for (const [index, id] of todo.entries()) {
    await generate(flow, id, snap);
    const deadline = Date.now() + RUN_WAIT_MS;
    for (;;) {
      const node = flow.getNode(id);
      if (!node) return;
      const data = node.data as AnyData;
      const record = recordOf(data);
      const failed = Boolean(data.error) || record?.status === 'failed' || (node.type !== 'text' && !data.recordId);
      if (failed || Date.now() > deadline) return toast(`第 ${index + 1} 个节点执行失败：${data.error || record?.error?.message || '未返回结果'}`, 'error', 6000);
      if (node.type === 'text' ? (data.text || '').trim() && !data.busy : outputOf(node)) break;
      await sleep(1000);
    }
  }
  toast('分组执行完成', 'success');
}

// ---------- 新节点的默认参数 ----------

// 视频节点的分辨率、比例、时长要落在所选模型支持的范围里；换模型之后不在范围里的换成它支持的第一个。
export function fitVideo(data: VideoData): VideoData {
  const able = specOf(data.model);
  const pick = <T,>(list: T[], value: T) => (list.includes(value) || !list.length ? value : list[0]);
  return { ...data, resolution: pick(able.resolutions, data.resolution), ratio: pick(able.ratios, data.ratio), duration: pick(able.durations, data.duration) };
}

// 新建节点时的参数跟创作页当前选的一致，选的模型不在了就用列表里的第一个。
export function newNodeData(kind: NodeKind, seed: { form: { model: string; resolution: string; ratio: string; duration: number }; image: { model: string; ratio: string; resolution?: string }; speech: { voiceId: string; voiceName: string } }): Record<string, unknown> {
  if (kind === 'text') return { text: '', prompt: '' };
  if (kind === 'image') {
    const models = state.catalog.image;
    const model = models.includes(seed.image.model) || !models.length ? seed.image.model : models[0];
    return { prompt: '', model, ratio: seed.image.ratio, resolution: fitImageSize(model, seed.image.resolution) };
  }
  if (kind === 'video') {
    const model = state.models.includes(seed.form.model) ? seed.form.model : state.models[0];
    return { ...fitVideo({ prompt: '', model, resolution: seed.form.resolution, ratio: seed.form.ratio, duration: seed.form.duration }) };
  }
  return { tool: 'speech', prompt: '', voiceId: seed.speech.voiceId, voiceName: seed.speech.voiceName };
}

// 画布的封面：里面最近生成的一张图或一段视频；没有生成过就用上传的。
export function coverOf(nodes: Node[]): { url: string; kind: 'image' | 'video' } | null {
  let best: { url: string; kind: 'image' | 'video'; at: number } | null = null;
  for (const node of nodes) {
    if (node.type !== 'image' && node.type !== 'video') continue;
    const kind: 'image' | 'video' = node.type;
    const data = node.data as AnyData;
    const record = recordOf(data);
    const found =
      record?.status === 'completed' && record.mediaUrl && record.savedLocally
        ? { url: record.mediaUrl, kind, at: record.completedAt || record.createdAt || 1 }
        : data.upload
          ? { url: data.upload.url, kind, at: 0 }
          : null;
    if (found && (!best || found.at > best.at)) best = found;
  }
  return best && { url: best.url, kind: best.kind };
}
