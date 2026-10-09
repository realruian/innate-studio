// 让一个节点生成：把连进来的文本和素材收齐，拼成和创作页一样的请求，交给本地服务。
// 结果是一条普通的生成记录，节点只记它的 id，进度跟着「创作记录」的轮询走。

import type { Edge, Node, ReactFlowInstance } from '@xyflow/react';
import { api, state, KINDS, findAsset, refreshAsset, assetReadiness, startHistoryLoop, loadHistory } from '../store.ts';
import { capabilities, defaults, imageRefLimit, isOpenRouter, specOf, traits } from '../composer/state.ts';
import { buildRequest as buildVideoRequest, buildOpenRouterRequest, buildImageRequest, buildSpeechRequest, buildSfxRequest } from '../request.ts';
import { recordName, refFromAsset, uploadVirtualAsset } from '../media.ts';
import { toast } from '../ui/layers.tsx';
import type { HistoryItem, Kind, Ref } from '../types.ts';
import { NODE_LABELS, joinPrompt, videoFormFrom, type AudioData, type ImageData, type LinkData, type MediaInput, type NodeKind, type TextData, type VideoData } from './model.ts';

type Flow = ReactFlowInstance<Node, Edge>;
type AnyData = Partial<ImageData & VideoData & AudioData & TextData>;

export const recordOf = (data: { recordId?: string }): HistoryItem | undefined => (data.recordId ? state.history.find((h) => h.id === data.recordId) : undefined);

// 一个节点现在能交给下游的东西：本机的一个文件，或者素材库里的一份素材（这时带着 asset）。还没生成完、或者文件不在本机，就是 null。
export function outputOf(node: Node): { url: string; kind: Kind; name: string; asset?: Ref } | null {
  const data = node.data as AnyData;
  if (data.asset) return { url: data.asset.url, kind: data.asset.kind, name: data.asset.name, asset: data.asset };
  if (data.upload) return { url: data.upload.url, kind: node.type as Kind, name: data.upload.name };
  const record = recordOf(data);
  if (!record || record.status !== 'completed' || !record.mediaUrl || !record.savedLocally) return null;
  return { url: record.mediaUrl, kind: record.kind, name: recordName(record) };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// 素材传进素材库之后要等平台处理完才能用。等这么久还没好就不等了。
const ASSET_WAIT_MS = 5 * 60 * 1000;

// Seedance 只认素材库里的素材：把上游节点的文件传进去，等它能用于这个模型。传过一次的记在上游节点上，下次直接用。
async function libraryRef(flow: Flow, source: Node, output: NonNullable<ReturnType<typeof outputOf>>, model: string, say: (text: string) => void): Promise<Ref> {
  const data = source.data as AnyData;
  let asset = data.assetOf === output.url ? findAsset(data.assetId) : null;
  if (!asset && data.assetOf === output.url && data.assetId) asset = await refreshAsset(data.assetId).catch(() => null);
  if (!asset) {
    say('正在把素材传到素材库');
    const res = await fetch(output.url);
    if (!res.ok) throw new Error('上游节点的文件已经不在本机了');
    const blob = await res.blob();
    asset = await uploadVirtualAsset(new File([blob], `${output.name}.${output.url.split('.').pop()}`, { type: blob.type }), output.kind);
    flow.updateNodeData(source.id, { assetId: asset.id, assetOf: output.url });
  }
  const deadline = Date.now() + ASSET_WAIT_MS;
  for (;;) {
    const status = assetReadiness(asset, model);
    if (status.ready) return refFromAsset(asset, output.kind);
    if (status.tone === 'error') throw new Error(`素材${status.label}，用不了`);
    if (Date.now() > deadline) throw new Error('素材还在处理中，等一会儿再点生成');
    say('素材处理中');
    await sleep(3000);
    asset = await refreshAsset(asset.id);
  }
}

async function submitVideo(flow: Flow, node: Node, sources: { link: LinkData; node: Node }[], prompt: string, say: (text: string) => void) {
  const data = node.data as unknown as VideoData;
  const able = traits(data.model);
  const media = sources.filter((s) => s.link.kind !== 'text');
  const counts: Record<Kind, number> = { image: 0, video: 0, audio: 0 };
  const inputs: MediaInput[] = [];
  for (const { link, node: source } of media) {
    const kind = link.kind as Kind;
    const output = outputOf(source);
    if (!output) throw new Error(`连进来的${NODE_LABELS[kind]}节点还没有结果，先让它生成完`);
    if (!able.refKinds.includes(kind) || (kind !== 'image' && !able.reference)) throw new Error(`${data.model} 用不了参考${NODE_LABELS[kind]}`);
    if (++counts[kind] > KINDS[kind].max) throw new Error(`参考${NODE_LABELS[kind]}最多 ${KINDS[kind].max} 个`);
    const role = kind === 'image' ? link.role || 'reference' : 'reference';
    if (role === 'last' && !able.lastFrame) throw new Error(`${data.model} 不支持尾帧`);
    // 素材库里的素材直接用；本机的文件看模型：能直接收的就直接给，Seedance 要先传进素材库。
    if (output.asset && able.localFiles) throw new Error(`${data.model} 用不了素材库里的素材，请换成上传的文件或生成的结果`);
    const ref: Ref = output.asset
      ? { ...output.asset, uid: crypto.randomUUID() }
      : able.localFiles
        ? { uid: crypto.randomUUID(), kind, source: 'local', url: output.url, name: output.name, thumb: null }
        : await libraryRef(flow, source, output, data.model, say);
    inputs.push({ kind, role, ref });
  }
  const { form, problems } = videoFormFrom(defaults(), data, prompt, inputs);
  const request = isOpenRouter()
    ? buildOpenRouterRequest(form, specOf(data.model))
    : buildVideoRequest(form, (ref) => (ref.source === 'asset' ? assetReadiness(findAsset(ref.assetId), data.model) : { ready: true, tone: 'ok' }));
  const problem = problems[0] || request.problems[0];
  if (problem) throw new Error(problem);
  say('正在提交');
  return (await api<HistoryItem>('POST', '/api/videos', { payload: request.payload, form })).id;
}

async function submitImage(node: Node, sources: { link: LinkData; node: Node }[], prompt: string) {
  const data = node.data as unknown as ImageData;
  // 连进来的图片是参考图（图生图）。
  const refs: Ref[] = sources
    .filter((s) => s.link.kind === 'image')
    .map((s) => {
      const output = outputOf(s.node);
      if (!output) throw new Error('连进来的图片节点还没有结果，先让它生成完');
      return output.asset ? { ...output.asset, uid: crypto.randomUUID() } : { uid: crypto.randomUUID(), kind: 'image' as const, source: 'local' as const, url: output.url, name: output.name, thumb: null };
    });
  const form = { prompt, model: data.model, ratio: data.ratio, count: 1, refs };
  const request = buildImageRequest(form, imageRefLimit(data.model));
  if (request.problems.length) throw new Error(request.problems[0]);
  return (await api<{ items: HistoryItem[] }>('POST', '/api/images', { payload: request.payload, form: { type: 'image', ...form } })).items[0].id;
}

async function submitAudio(node: Node, prompt: string) {
  const data = node.data as unknown as AudioData;
  if (data.tool === 'sfx') {
    const form = { prompt, duration: 'auto', influence: '0.3' };
    const request = buildSfxRequest(form);
    if (request.problems.length) throw new Error(request.problems[0]);
    return (await api<HistoryItem>('POST', '/api/audio/sfx', { ...request.body, form: { type: 'sfx', ...form } })).id;
  }
  const form = { prompt, voiceId: data.voiceId, voiceName: data.voiceName };
  const request = buildSpeechRequest(form);
  if (request.problems.length) throw new Error(request.problems[0]);
  return (await api<HistoryItem>('POST', '/api/audio/speech', { ...request.body, form: { type: 'speech', ...form } })).id;
}

export async function generate(flow: Flow, id: string) {
  const node = flow.getNode(id);
  if (!node || (node.data as AnyData).busy) return;
  if (!state.app.hasKey) return toast('还没有设置 API Key，请先到「设置」里填写', 'info');
  const say = (busy: string) => flow.updateNodeData(id, { busy });
  flow.updateNodeData(id, { busy: '准备中', error: '' });
  try {
    const sources = flow
      .getEdges()
      .filter((edge) => edge.target === id)
      .map((edge) => ({ link: edge.data as unknown as LinkData, node: flow.getNode(edge.source)! }))
      .filter((s) => s.node);
    const upstream = sources.filter((s) => s.link.kind === 'text').map((s) => (s.node.data as AnyData).text || '');
    const prompt = joinPrompt(upstream, (node.data as AnyData).prompt || '');
    const kind = node.type as NodeKind;
    const recordId = kind === 'video' ? await submitVideo(flow, node, sources, prompt, say) : kind === 'image' ? await submitImage(node, sources, prompt) : await submitAudio(node, prompt);
    // 换了新结果，之前上传的、从素材库选的、传进素材库的那份都不再是它的输出。
    // 宽高比也清掉：生成完之前框回到按所选比例留的大小，出了结果再按实际的来。
    flow.updateNodeData(id, { recordId, upload: undefined, asset: undefined, assetId: undefined, assetOf: undefined, aspect: undefined });
    await loadHistory().catch(() => {});
    startHistoryLoop();
  } catch (err) {
    flow.updateNodeData(id, { error: (err as Error).message });
    toast((err as Error).message, 'error', 6000);
  } finally {
    flow.updateNodeData(id, { busy: '' });
  }
}

// ---------- 新节点的默认参数 ----------

// 视频节点的分辨率、比例、时长要落在所选模型支持的范围里；换模型之后不在范围里的换成它支持的第一个。
export function fitVideo(data: VideoData): VideoData {
  const able = capabilities(data.model);
  const pick = <T,>(list: T[], value: T) => (list.includes(value) || !list.length ? value : list[0]);
  return { ...data, resolution: pick(able.resolutions, data.resolution), ratio: pick(able.ratios, data.ratio), duration: pick(able.durations, data.duration) };
}

// 新建节点时的参数跟创作页当前选的一致，换平台之后选的模型不在了就用列表里的第一个。
export function newNodeData(kind: NodeKind, seed: { form: { model: string; resolution: string; ratio: string; duration: number }; image: { model: string; ratio: string }; speech: { voiceId: string; voiceName: string } }): Record<string, unknown> {
  if (kind === 'text') return { text: '', prompt: '' };
  if (kind === 'image') {
    const models = state.catalog.image;
    return { prompt: '', model: models.includes(seed.image.model) || !models.length ? seed.image.model : models[0], ratio: seed.image.ratio };
  }
  if (kind === 'video') {
    const model = state.models.includes(seed.form.model) ? seed.form.model : state.models[0];
    return { ...fitVideo({ prompt: '', model, resolution: seed.form.resolution, ratio: seed.form.ratio, duration: seed.form.duration }) };
  }
  return { tool: 'speech', prompt: '', voiceId: seed.speech.voiceId, voiceName: seed.speech.voiceName };
}

// 画布的封面：里面最近生成的一张图或一段视频；没有生成过就用上传的、素材库里选的。
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
          : data.asset?.thumb
            ? { url: data.asset.thumb, kind: 'image' as const, at: 0 }
            : null;
    if (found && (!best || found.at > best.at)) best = found;
  }
  return best && { url: best.url, kind: best.kind };
}
