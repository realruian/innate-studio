// 画布的数据：节点、连线，以及「连线怎么变成一次生成请求」的规则。纯函数，不碰页面和网络，可以单独测试。

import type { Kind, Ref, VideoForm } from '../types.ts';

export type NodeKind = 'text' | 'image' | 'video' | 'audio';
// 图片连到视频节点时当什么用。
export type FrameRole = 'reference' | 'first' | 'last';

// 文本节点：text 是节点里的内容，可以自己写，也可以让文本模型写；prompt 是给模型的要求，model 是用哪个文本模型。
export interface TextData {
  text: string;
  prompt?: string;
  model?: string;
  busy?: string;
  error?: string;
}
// 节点里的内容有三种来历，只会有一种：recordId 是在这个节点上生成的那条生成记录；upload 是从本机上传的文件；asset 是从素材库里选的素材。
// assetId 是生成的结果或上传的文件传进素材库之后的素材，assetOf 记着传的是哪个文件。
// busy、error 只在页面打开期间有，不存进画布。
export interface Generated {
  recordId?: string;
  upload?: { url: string; name: string };
  asset?: Ref;
  assetId?: string;
  assetOf?: string;
  busy?: string;
  error?: string;
}
export interface ImageData extends Generated {
  prompt: string;
  model: string;
  ratio: string;
  // 节点里那张图实际的宽高比，图片读出来之后记下，节点的框按它定宽度。
  aspect?: number;
}
export interface VideoData extends Generated {
  prompt: string;
  model: string;
  resolution: string;
  ratio: string;
  duration: number;
}
export interface AudioData extends Generated {
  tool: 'speech' | 'sfx';
  prompt: string;
  voiceId: string;
  voiceName: string;
}
export type NodeData = TextData | ImageData | VideoData | AudioData;

export interface LinkData {
  // 连线起点是哪种节点。
  kind: NodeKind;
  role?: FrameRole;
}

export const NODE_LABELS: Record<NodeKind, string> = { text: '文本', image: '图片', video: '视频', audio: '音频' };
export const ROLE_LABELS: Record<FrameRole, string> = { reference: '参考图', first: '首帧', last: '尾帧' };

// 哪种节点能连到哪种节点。文本是提示词，可以给任何会生成的节点，连到另一个文本节点是给模型当参考内容；图片可以给视频和图片当参考图（图片连图片是图生图，要目标模型收参考图才行）；视频、音频只能给视频当参考素材。
const TARGETS: Record<NodeKind, NodeKind[]> = {
  text: ['text', 'image', 'video', 'audio'],
  image: ['image', 'video'],
  video: ['video'],
  audio: ['video'],
};
export const canLink = (source: NodeKind, target: NodeKind) => TARGETS[source].includes(target);
export const targetsOf = (source: NodeKind) => TARGETS[source];
// 哪些节点能连进它。
export const sourcesOf = (target: NodeKind) => (Object.keys(TARGETS) as NodeKind[]).filter((source) => TARGETS[source].includes(target));

// 连线上显示的字。文本连线不标。role 只有连到视频的图片才有；连到图片的都是参考图。
export function linkLabel(link: LinkData) {
  if (link.kind === 'image') return ROLE_LABELS[link.role || 'reference'];
  if (link.kind === 'video') return '参考视频';
  if (link.kind === 'audio') return '参考音频';
  return '';
}

// 上游文本节点的内容在前，节点自己写的在后，各占一段。
export const joinPrompt = (upstream: string[], own: string) => [...upstream, own].map((t) => t.trim()).filter(Boolean).join('\n');

export interface MediaInput {
  kind: Kind;
  role: FrameRole;
  ref: Ref;
}

// 把连进视频节点的素材排成视频表单里的首尾帧和参考素材。
// 有一条连线标了首帧或尾帧，就按首尾帧生成；否则有素材就是参考生成，没有就是文生视频。
export function videoFormFrom(base: VideoForm, data: VideoData, prompt: string, inputs: MediaInput[]): { form: VideoForm; problems: string[] } {
  const problems: string[] = [];
  const firsts = inputs.filter((i) => i.kind === 'image' && i.role === 'first');
  const lasts = inputs.filter((i) => i.kind === 'image' && i.role === 'last');
  const form: VideoForm = {
    ...base,
    prompt,
    model: data.model,
    resolution: data.resolution,
    ratio: data.ratio,
    duration: data.duration,
    durationAuto: false,
    mode: 'text',
    frames: { first: null, last: null },
    refs: { image: [], video: [], audio: [] },
  };
  if (firsts.length || lasts.length) {
    form.mode = 'frames';
    form.frames = { first: firsts[0]?.ref || null, last: lasts[0]?.ref || null };
    if (firsts.length > 1) problems.push('首帧只能有一张，请把多余的连线改成别的用途或删掉');
    if (lasts.length > 1) problems.push('尾帧只能有一张，请把多余的连线改成别的用途或删掉');
    if (!firsts.length) problems.push('只有尾帧不够，还需要一张首帧');
    if (inputs.length > firsts.length + lasts.length) problems.push('首尾帧和参考素材不能一起用：把连线都改成参考图，或者只留首帧、尾帧');
  } else if (inputs.length) {
    form.mode = 'reference';
    for (const input of inputs) form.refs[input.kind].push(input.ref);
  }
  return { form, problems };
}

// 存进画布之前去掉只在页面上有意义的东西。
export function stripNodeData<T extends object>(data: T): T {
  const { busy: _busy, error: _error, ...rest } = data as T & Generated;
  return rest as T;
}
