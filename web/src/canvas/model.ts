// 画布的数据：节点、连线，以及「连线怎么变成一次生成请求」的规则。纯函数，不碰页面和网络，可以单独测试。

import type { Kind, Ref, VideoForm } from '../types.ts';

export type NodeKind = 'text' | 'image' | 'video' | 'audio';
// 图片连到视频节点时当什么用。
export type FrameRole = 'reference' | 'first' | 'last';

// 文本节点：text 是节点里的内容，可以自己写，也可以让文本模型写；prompt 是给模型的要求，model 是用哪个文本模型。
export interface TextData {
  // 名字后面的编号。
  no?: number;
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
  // 名字后面的编号。
  no?: number;
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
  // 一次生成几张。不写就是一张。
  count?: number;
  // 节点里那张图实际的宽高比，图片读出来之后记下，节点的框按它定宽度。
  aspect?: number;
}
export interface VideoData extends Generated {
  prompt: string;
  model: string;
  resolution: string;
  ratio: string;
  duration: number;
  // 一次生成几段。不写就是一段。
  count?: number;
  // 节点里那段视频实际的宽高比，读到之后记下，节点的框按它定宽度。
  aspect?: number;
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

// ---------- 节点的大小 ----------

// 所有节点的框一样高。空着的时候形状是固定的：文本和图片是方的，视频是 16:9，音频宽 320，不跟着参数里选的比例变。
// 图片、视频有了内容（上传的、素材库里的、生成出来的），框才按它实际的宽高比定宽，太窄太宽的收在一个范围里。
export const BOX_HEIGHT = 240;
// 节点的名字那一行加上它和框之间的空隙，一共占多高。
export const TITLE_ROOM = 24;
export function nodeWidth(kind: NodeKind, data: { aspect?: number } = {}) {
  if (kind === 'text') return BOX_HEIGHT;
  if (kind === 'audio') return 320;
  const shape = data.aspect || (kind === 'video' ? 16 / 9 : 1);
  return Math.round(Math.min(560, Math.max(150, BOX_HEIGHT * shape)));
}

// ---------- 拖动时对齐 ----------

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
// 一条参考线：画布坐标里的一段横线或竖线。
export interface Guide {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

// 拖着的那个框靠近别的框时吸过去：左、中、右和上、中、下各三条线，离得最近的一条在 reach 以内就对上。
// 返回要挪多少，以及对上的那几条参考线。参考线画在两个框之间的空当里；两个框在那个方向上有重叠时，画满它们合起来的范围。
export function snapTo(moving: Rect, others: Rect[], reach: number): { dx: number; dy: number; guides: Guide[] } {
  const marks = (start: number, size: number) => [start, start + size / 2, start + size];
  const nearest = (axis: 'x' | 'y') => {
    const size = axis === 'x' ? 'width' : 'height';
    let best = 0;
    let gap = reach;
    let found = false;
    for (const other of others)
      for (const mine of marks(moving[axis], moving[size]))
        for (const theirs of marks(other[axis], other[size])) {
          const d = Math.abs(theirs - mine);
          if (d < gap || (d === gap && !found && d <= reach)) {
            gap = d;
            best = theirs - mine;
            found = true;
          }
        }
    return found ? best : null;
  };
  const dx = nearest('x');
  const dy = nearest('y');
  const moved = { ...moving, x: moving.x + (dx || 0), y: moving.y + (dy || 0) };
  const guides: Guide[] = [];
  const same = (a: number, b: number) => Math.abs(a - b) < 0.01;
  const span = (aStart: number, aSize: number, bStart: number, bSize: number) => {
    const inner = [Math.min(aStart + aSize, bStart + bSize), Math.max(aStart, bStart)];
    return inner[0] < inner[1] ? inner : [Math.min(aStart, bStart), Math.max(aStart + aSize, bStart + bSize)];
  };
  for (const other of others) {
    if (dx !== null)
      for (const x of marks(other.x, other.width))
        if (marks(moved.x, moved.width).some((mine) => same(mine, x))) {
          const [y1, y2] = span(moved.y, moved.height, other.y, other.height);
          guides.push({ x1: x, y1, x2: x, y2 });
        }
    if (dy !== null)
      for (const y of marks(other.y, other.height))
        if (marks(moved.y, moved.height).some((mine) => same(mine, y))) {
          const [x1, x2] = span(moved.x, moved.width, other.x, other.width);
          guides.push({ x1, y1: y, x2, y2: y });
        }
  }
  return { dx: dx || 0, dy: dy || 0, guides };
}

// ---------- 一键整理 ----------

const COLUMN_GAP = 120;
const ROW_GAP = 56;
const LOOSE_GAP = 80;
// 零散的节点一行最多排几个。
const LOOSE_PER_ROW = 6;

// 把节点按连线排整齐：上游在左、下游在右，一列一列对齐；同一列里按上游的次序排，线尽量不交叉。
// 连在一起的一串节点是一组，各组从上往下排；没有连线的零散节点在最下面排成一行。整理之后的左上角还在原来的左上角。
export function tidy(nodes: { id: string; position: { x: number; y: number }; width: number }[], edges: { source: string; target: string }[]): Map<string, { x: number; y: number }> {
  const placed = new Map<string, { x: number; y: number }>();
  if (!nodes.length) return placed;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const links = edges.filter((edge) => byId.has(edge.source) && byId.has(edge.target));
  const ins = new Map<string, string[]>(nodes.map((node) => [node.id, []]));
  const outs = new Map<string, string[]>(nodes.map((node) => [node.id, []]));
  for (const { source, target } of links) {
    ins.get(target)!.push(source);
    outs.get(source)!.push(target);
  }
  // 连在一起的分成一组。
  const groupOf = new Map<string, number>();
  let groups = 0;
  for (const node of nodes) {
    if (groupOf.has(node.id)) continue;
    const stack = [node.id];
    while (stack.length) {
      const id = stack.pop()!;
      if (groupOf.has(id)) continue;
      groupOf.set(id, groups);
      stack.push(...ins.get(id)!, ...outs.get(id)!);
    }
    groups++;
  }
  // 第几列：离最远的源头隔着几条线。连线不会成圈，所以算得完。
  const column = new Map<string, number>();
  const columnOf = (id: string): number => {
    if (!column.has(id)) {
      column.set(id, 0);
      column.set(id, Math.max(0, ...ins.get(id)!.map((from) => columnOf(from) + 1)));
    }
    return column.get(id)!;
  };
  nodes.forEach((node) => columnOf(node.id));

  const rowStep = TITLE_ROOM + BOX_HEIGHT + ROW_GAP;
  const left = Math.min(...nodes.map((node) => node.position.x));
  let top = Math.min(...nodes.map((node) => node.position.y));
  const byPlace = (a: string, b: string) => byId.get(a)!.position.y - byId.get(b)!.position.y || byId.get(a)!.position.x - byId.get(b)!.position.x;
  const members = Array.from({ length: groups }, () => [] as string[]);
  for (const node of nodes) members[groupOf.get(node.id)!].push(node.id);
  const linked = members.filter((ids) => ids.length > 1).sort((a, b) => Math.min(...a.map((id) => byId.get(id)!.position.y)) - Math.min(...b.map((id) => byId.get(id)!.position.y)));
  const loose = members.filter((ids) => ids.length === 1).map((ids) => ids[0]).sort((a, b) => byId.get(a)!.position.x - byId.get(b)!.position.x || byPlace(a, b));

  for (const ids of linked) {
    const columns: string[][] = [];
    for (const id of ids) (columns[column.get(id)!] ||= []).push(id);
    const row = new Map<string, number>();
    let x = left;
    columns.forEach((list, index) => {
      // 第一列按现在的上下次序；后面的每一列按上游节点排在第几行。
      const weight = (id: string) => {
        const from = ins.get(id)!.filter((source) => row.has(source));
        return from.length ? from.reduce((sum, source) => sum + row.get(source)!, 0) / from.length : Infinity;
      };
      list.sort((a, b) => (index ? weight(a) - weight(b) : 0) || byPlace(a, b));
      list.forEach((id, n) => {
        row.set(id, n);
        placed.set(id, { x, y: top + n * rowStep });
      });
      x += Math.max(...list.map((id) => byId.get(id)!.width)) + COLUMN_GAP;
    });
    top += Math.max(...columns.map((list) => list.length)) * rowStep;
  }
  let x = left;
  loose.forEach((id, index) => {
    if (index && index % LOOSE_PER_ROW === 0) {
      x = left;
      top += rowStep;
    }
    placed.set(id, { x, y: top });
    x += byId.get(id)!.width + LOOSE_GAP;
  });
  return placed;
}

// ---------- 节点的编号 ----------

// 节点的名字带编号（图片 1、图片 2），每种节点各排各的。编号定下来就不变，删掉前面的也不往前补。
// 这里给还没有编号的节点排上号，接在这一种已有的最大编号后面。
export function numbered<T extends { type?: string; data: Record<string, unknown> }>(nodes: T[], existing: { type?: string; data: Record<string, unknown> }[] = []): T[] {
  const last = new Map<string, number>();
  for (const node of [...existing, ...nodes]) last.set(node.type || '', Math.max(last.get(node.type || '') || 0, Number(node.data.no) || 0));
  return nodes.map((node) => {
    if (Number(node.data.no) > 0) return node;
    const no = (last.get(node.type || '') || 0) + 1;
    last.set(node.type || '', no);
    return { ...node, data: { ...node.data, no } };
  });
}

// ---------- 再次生成 ----------

// 一个节点生成出 results 份结果，各放在哪。
// 节点还空着：第一份放进它自己，多出来的每份一个新节点。节点里已经有内容：原来的留着不动，每份结果都是新节点。
// 新节点和原节点左边对齐，从它下面一行一行往下排，跳过已经有节点的位置。返回的 here 是放进原节点的那一份是第几个（没有就是 -1），spots 是新节点的位置。
const ROW_STEP = TITLE_ROOM + BOX_HEIGHT + 56;
export function placeResults(source: { id: string; position: { x: number; y: number }; width: number }, filled: boolean, results: number, others: { id: string; position: { x: number; y: number }; width: number }[]): { here: number; spots: { x: number; y: number }[] } {
  const spots: { x: number; y: number }[] = [];
  const taken = others.filter((node) => node.id !== source.id).map((node) => ({ ...node.position, width: node.width }));
  let y = source.position.y;
  for (let n = filled ? 0 : 1; n < results; n++) {
    do y += ROW_STEP;
    while (taken.some((node) => Math.abs(node.y - y) < ROW_STEP - 60 && node.x < source.position.x + source.width + 40 && node.x + node.width + 40 > source.position.x));
    spots.push({ x: source.position.x, y });
    taken.push({ x: source.position.x, y, width: source.width });
  }
  return { here: filled ? -1 : 0, spots };
}

// ---------- 复制、粘贴 ----------

interface Piece {
  id: string;
  type?: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}
interface Wire {
  id: string;
  source: string;
  target: string;
  data?: Record<string, unknown>;
}
export interface Clip {
  nodes: Piece[];
  edges: Wire[];
}

// 复制下来的是选中的节点，和两头都在其中的连线；只连着一头的线不带走。
export function clipOf(nodes: Piece[], edges: Wire[]): Clip {
  const ids = new Set(nodes.map((node) => node.id));
  return {
    nodes: nodes.map(({ id, type, position, data }) => ({ id, type, position: { ...position }, data: stripNodeData(data) })),
    edges: edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)).map(({ id, source, target, data }) => ({ id, source, target, data })),
  };
}

// 把复制下来的一份放回画布：节点和连线都换新 id，相互的位置不变。
// at 是这一份的左上角落在哪；没给就照原位置错开 by 这么多。
export function pasteClip(clip: Clip, place: { at?: { x: number; y: number }; by?: { x: number; y: number } }, newId: () => string): Clip {
  const left = Math.min(...clip.nodes.map((node) => node.position.x));
  const top = Math.min(...clip.nodes.map((node) => node.position.y));
  const dx = place.at ? place.at.x - left : place.by?.x || 0;
  const dy = place.at ? place.at.y - top : place.by?.y || 0;
  const ids = new Map(clip.nodes.map((node) => [node.id, newId()]));
  return {
    nodes: clip.nodes.map((node) => ({ ...node, id: ids.get(node.id)!, position: { x: node.position.x + dx, y: node.position.y + dy }, data: { ...node.data } })),
    edges: clip.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)).map((edge) => ({ ...edge, id: newId(), source: ids.get(edge.source)!, target: ids.get(edge.target)!, data: edge.data && { ...edge.data } })),
  };
}
