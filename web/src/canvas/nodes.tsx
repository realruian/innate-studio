// 画布上的四种节点和连线。
// 节点本身只是一块内容：上面一行名字，下面一个框放结果。选中它之后，下方才出现输入面板：参考素材、提示词、模型和参数、生成键。
// 左右两个加号是连接点：拖出去连到别的节点，点一下是在那一侧接一个新节点。
// 跟着画布缩放的只有框和里面的内容；名字、加号、操作条、输入面板在屏幕上的大小不变，缩得再小也看得清、点得到。

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { BaseEdge, Handle, NodeToolbar, Position, getBezierPath, useConnection, useEdges, useInternalNode, useReactFlow, useStore as useFlowStore, useUpdateNodeInternals, type EdgeProps, type Node, type NodeProps } from '@xyflow/react';
import { api, state, useStore, loadVoices, isPendingTask, polishModel, KINDS as MEDIA } from '../store.ts';
import { RATIOS, capabilities, imageRatios, imageRefLimit, traits, voiceName } from '../composer/state.ts';
import { modelNote } from '../../../shared/models.ts';
import { kindOfFile, uploadLocalFile } from '../media.ts';
import { openAssetPicker } from '../assets.tsx';
import { Icon, type IconName } from '../ui/Icon.tsx';
import { Dropdown, tip } from '../ui/controls.tsx';
import { openMenu, toast } from '../ui/layers.tsx';
import { VideoPlayer, AudioPlayer } from '../player.tsx';
import { openDetail } from '../history.tsx';
import type { Kind } from '../types.ts';
import { NODE_LABELS, ROLE_LABELS, canLink, joinPrompt, linkLabel, type AudioData, type FrameRole, type ImageData, type LinkData, type NodeKind, type TextData, type VideoData } from './model.ts';
import { fitVideo, generate, outputOf, recordOf } from './run.ts';

// 画布页交给节点用的几件事。snap：会改动画布结构的操作，动手之前调一下，撤销时回到这一刻。
// addInput：在某个节点左边加一个节点并连进它，extra 是新节点一出来就带着的内容（上传的文件、素材库里的素材）。
export const CanvasActions = createContext<{ snap: () => void; addInput: (targetId: string, kind: NodeKind, extra?: Record<string, unknown>) => void }>({ snap() {}, addInput() {} });

export const NODE_ICONS: Record<NodeKind, IconName> = { text: 'type', image: 'image', video: 'video', audio: 'music' };

// React Flow 认这几个类名：nodrag 是在它上面按住拖动不会挪节点，nowheel 是在它上面滚动不会移动画布。
const INERT = 'nodrag nowheel';

type MediaData = Partial<ImageData & VideoData & AudioData>;

// 只选中了这一个节点时才显示它的工具条和输入面板；框选了一片时都不显示，免得叠成一堆。
function useAlone(selected?: boolean) {
  const count = useFlowStore((s) => {
    let n = 0;
    for (const node of s.nodeLookup.values()) if (node.selected) n++;
    return n;
  });
  return Boolean(selected) && count === 1;
}

// 所有节点的框一样高，宽度跟着内容的比例走：1:1 是方的，16:9 就宽一些。太窄太宽的比例收在一个范围里。
const BOX_HEIGHT = 240;
function boxWidth(ratio?: string, aspect?: number) {
  const parts = /^(\d+):(\d+)$/.exec(ratio || '');
  const shape = aspect || (parts ? Number(parts[1]) / Number(parts[2]) : 16 / 9);
  return Math.round(Math.min(560, Math.max(150, BOX_HEIGHT * shape)));
}

function Frame({ id, kind, selected, width, tools, panel, children }: { id: string; kind: NodeKind; selected?: boolean; width: number; tools?: ReactNode; panel: ReactNode; children: ReactNode }) {
  const flow = useReactFlow();
  const alone = useAlone(selected);
  // 正从别的节点拉一条线过来：这个节点接得住，就把整个框变成落点，不用对准小加号；接不住就暗下去。
  // 从右边的加号拉出来的线要找下游，从左边的加号拉出来的要找上游。
  const link = useConnection();
  const other = link.inProgress && link.fromNode.id !== id ? (link.fromNode.type as NodeKind) : null;
  const wants = other && link.fromHandle?.type === 'source' ? 'target' : 'source';
  const fits = Boolean(other) && (wants === 'target' ? canLink(other!, kind) : canLink(kind, other!));
  // 落点是拉线时才加进来的，要让 React Flow 重新量一遍这个节点，它才认得这个落点（线拖上来时才会把它标成可以连）。
  const remeasure = useUpdateNodeInternals();
  useEffect(() => remeasure(id), [fits, wants]);
  return (
    <div className={`cnode cnode-${kind} ${selected ? 'selected' : ''} ${other && !fits ? 'is-dimmed' : ''}`} style={{ width }}>
      {/* 操作条和输入面板画在画布的缩放之外，所以大小不变；位置仍然贴着节点。 */}
      <NodeToolbar isVisible={alone} position={Position.Top} offset={8}>
        <div className="cnode-tools">
          {tools}
          <button className="cnode-btn" type="button" {...tip('删除节点')} aria-label="删除节点" onClick={() => flow.deleteElements({ nodes: [{ id }] })}>
            <Icon name="trash" />
          </button>
        </div>
      </NodeToolbar>
      <div className="cnode-title">
        <Icon name={NODE_ICONS[kind]} size={14} />
        <span>{NODE_LABELS[kind]}</span>
      </div>
      <div className="cnode-box">{children}</div>
      <Handle type="target" position={Position.Left} className="cnode-port">
        <Icon name="plus" size={12} />
      </Handle>
      <Handle type="source" position={Position.Right} className="cnode-port">
        <Icon name="plus" size={12} />
      </Handle>
      {fits && <Handle id="body" type={wants} position={wants === 'target' ? Position.Left : Position.Right} className="cnode-drop" isConnectableStart={false} />}
      <NodeToolbar isVisible={alone} position={Position.Bottom} offset={12}>
        <div className="cnode-panel nowheel">{panel}</div>
      </NodeToolbar>
    </div>
  );
}

// 连进这个节点的线，连同线那头的节点。
function useInputs(id: string) {
  const flow = useReactFlow();
  const found: { edgeId: string; link: LinkData; node: Node }[] = [];
  for (const edge of useEdges()) {
    const node = edge.target === id ? flow.getNode(edge.source) : undefined;
    if (node) found.push({ edgeId: edge.id, link: edge.data as unknown as LinkData, node });
  }
  return found;
}

function Prompt({ id, value, placeholder }: { id: string; value: string; placeholder: string }) {
  const flow = useReactFlow();
  return <textarea className="cnode-prompt" value={value} placeholder={placeholder} onChange={(e) => flow.updateNodeData(id, { prompt: e.target.value })} />;
}

// 输入面板最下面一行：左边是模型和参数，右边是生成键。
function Bar({ working, action, onSend, children }: { working: boolean; action: string; onSend: () => void; children: ReactNode }) {
  return (
    <div className="cnode-bar">
      <div className="cnode-params">{children}</div>
      <button className="send-btn" type="button" {...tip(working ? '正在生成' : action)} aria-label={action} disabled={working} onClick={onSend}>
        {working ? <span className="spinner" /> : <Icon name="arrowUp" size={18} />}
      </button>
    </div>
  );
}

// 图片、视频、音频节点的框里放什么：正在做什么、生成到哪了、结果或失败原因；什么都没有时是一个淡淡的图标。
// onShape：图片、视频读出来之后报告它实际的宽高比，节点的框跟着它定宽度。
function Result({ kind, data, onShape }: { kind: NodeKind; data: MediaData; onShape?: (aspect: number) => void }) {
  useStore('history');
  const record = recordOf(data);
  const measure = (e: { currentTarget: HTMLImageElement }) => e.currentTarget.naturalHeight > 0 && onShape?.(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight);
  const blank = (content: ReactNode, failed = false) => <div className={`cnode-state ${failed ? 'is-failed' : ''}`}>{content}</div>;
  const waiting = (text: string) =>
    blank(
      <>
        <span className="spinner" />
        {text}
      </>,
    );
  if (data.busy) return waiting(data.busy);
  if (data.asset) {
    return data.asset.thumb ? (
      <div className="cnode-library">
        <img className="cnode-pic" src={data.asset.thumb} alt={data.asset.name} draggable={false} onLoad={measure} />
        <span className="cnode-badge">素材库</span>
      </div>
    ) : (
      blank(`素材库 · ${data.asset.name}`)
    );
  }
  if (data.upload && kind === 'image') return <img className="cnode-pic" src={data.upload.url} alt={data.upload.name} draggable={false} onLoad={measure} />;
  if (data.upload) return <Clip src={data.upload.url} label={data.upload.name} onShape={onShape} />;
  if (!record) return blank(data.recordId && state.historyLoaded ? '这条生成记录已经删除' : <Icon name={NODE_ICONS[kind]} size={28} stroke={1.2} />);
  if (isPendingTask(record)) return waiting(record.status === 'queued' ? '排队中' : record.progress ? `生成中 ${Math.round(record.progress)}%` : '生成中');
  if (record.status === 'failed') {
    return blank(
      <>
        <Icon name="alert" />
        <span>{record.error?.message || '生成失败'}</span>
      </>,
      true,
    );
  }
  if (!record.mediaUrl) return waiting('已生成，正在存到本机');
  if (kind === 'image') return <img className="cnode-pic" src={record.mediaUrl} alt={record.prompt || '生成的图片'} draggable={false} onLoad={measure} />;
  if (kind === 'video') return <Clip src={record.mediaUrl} label={record.prompt || '生成的视频'} onShape={onShape} />;
  return (
    <div className={`cnode-sound ${INERT}`}>
      <AudioPlayer src={record.mediaUrl} kind={record.tool === 'sfx' ? '音效' : `语音 · ${record.payload?.voice_name || ''}`} text={record.prompt} />
    </div>
  );
}

// 视频读到尺寸之后报告它实际的宽高比。播放器是现成的组件，这里从它外面去听那个视频元素。
function Clip({ src, label, onShape }: { src: string; label: string; onShape?: (aspect: number) => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const video = box.current?.querySelector('video');
    if (!video) return;
    const measure = () => video.videoHeight > 0 && onShape?.(video.videoWidth / video.videoHeight);
    measure();
    video.addEventListener('loadedmetadata', measure);
    return () => video.removeEventListener('loadedmetadata', measure);
  }, [src]);
  return (
    <div ref={box} className={`cnode-clip ${INERT}`}>
      <VideoPlayer src={src} label={label} />
    </div>
  );
}

// 生成的结果可以点开看详情。
function DetailTool({ data }: { data: MediaData }) {
  useStore('history');
  const record = recordOf(data);
  if (record?.status !== 'completed') return null;
  return (
    <button className="cnode-btn" type="button" {...tip('查看详情')} aria-label="查看详情" onClick={() => openDetail(record.id)}>
      <Icon name="expand" />
    </button>
  );
}

function useWorking(data: MediaData) {
  useStore('history', 'app');
  const record = recordOf(data);
  return Boolean(data.busy) || Boolean(record && isPendingTask(record));
}

const promptHint = (linked: boolean, own: string) => (linked ? '已连上文本节点，这里可以再补充' : own);

// ---------- 文本 ----------

// 框里是内容，双击进去改。下面的面板是给文本模型提要求：写好的内容会放进框里，连进来的文本节点和框里已有的内容当参考。
export function TextNode({ id, data: raw, selected }: NodeProps) {
  const data = raw as unknown as TextData;
  const flow = useReactFlow();
  const inputs = useInputs(id);
  const [editing, setEditing] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  useStore('models', 'app');
  const models = state.catalog.polish;
  const model = models.includes(data.model || '') ? data.model! : polishModel();

  useEffect(() => {
    if (editing) area.current?.focus();
  }, [editing]);
  // 不再选中就退出编辑。
  useEffect(() => {
    if (!selected) setEditing(false);
  }, [selected]);

  async function write() {
    const prompt = (data.prompt || '').trim();
    if (!prompt) return toast('先写下想让模型写什么', 'info');
    if (!model) return toast('当前账号里没有可用的文本模型', 'info');
    flow.updateNodeData(id, { busy: '正在写', error: '' });
    try {
      const upstream = inputs.filter((i) => i.link.kind === 'text').map((i) => (i.node.data as unknown as TextData).text || '');
      const result = await api<{ text: string }>('POST', '/api/text', { prompt, context: joinPrompt(upstream, data.text || ''), model });
      flow.updateNodeData(id, { text: result.text });
    } catch (err) {
      flow.updateNodeData(id, { error: (err as Error).message });
      toast((err as Error).message, 'error', 6000);
    } finally {
      flow.updateNodeData(id, { busy: '' });
    }
  }

  return (
    <Frame
      id={id}
      kind="text"
      selected={selected}
      width={BOX_HEIGHT}
      panel={
        <>
          <Prompt id={id} value={data.prompt || ''} placeholder={data.text ? '想怎么改？例如：改成三个分镜，每个一句话' : '想让模型写什么？例如：写一段 15 秒短视频的分镜'} />
          {data.error && !data.busy && <p className="cnode-error">{data.error}</p>}
          <Bar working={Boolean(data.busy)} action="让模型写" onSend={write}>
            {models.length > 0 ? (
              <Dropdown variant="tool" icon="sparkle" label="文本模型" value={model} options={models.map((m) => ({ value: m, label: m }))} onChange={(next) => flow.updateNodeData(id, { model: next })} />
            ) : (
              <span className="cnode-note">还没读到可用的文本模型</span>
            )}
          </Bar>
        </>
      }
    >
      {data.busy ? (
        <div className="cnode-state">
          <span className="spinner" />
          {data.busy}
        </div>
      ) : editing ? (
        <textarea ref={area} className={`cnode-text-edit ${INERT}`} value={data.text} onChange={(e) => flow.updateNodeData(id, { text: e.target.value })} onBlur={() => setEditing(false)} />
      ) : (
        <div className={`cnode-text-view nowheel ${data.text ? '' : 'is-empty'}`} onDoubleClick={() => setEditing(true)}>
          {data.text || '双击开始编辑，或者选中后让模型写'}
        </div>
      )}
    </Frame>
  );
}

// ---------- 图片 ----------

export function ImageNode({ id, data: raw, selected }: NodeProps) {
  const data = raw as unknown as ImageData;
  const flow = useReactFlow();
  const file = useRef<HTMLInputElement>(null);
  const inputs = useInputs(id);
  const linked = inputs.some((i) => i.link.kind === 'text');
  const working = useWorking(data);
  useStore('models', 'app');
  const models = state.catalog.image.length ? state.catalog.image : [data.model];
  const ratios = imageRatios(data.model);
  // 这个模型收几张参考图。不收的模型不显示参考图那一排；已经连进来的仍然显示，方便看出问题在哪。
  const refLimit = imageRefLimit(data.model);
  const hasRefs = inputs.some((i) => i.link.kind === 'image');

  async function upload(picked?: File) {
    if (!picked) return;
    flow.updateNodeData(id, { busy: '正在上传', error: '' });
    try {
      const ref = await uploadLocalFile(picked, 'image');
      flow.updateNodeData(id, { upload: { url: ref.url, name: ref.name }, recordId: undefined, asset: undefined, assetId: undefined, assetOf: undefined });
    } catch (err) {
      toast((err as Error).message, 'error', 6000);
    } finally {
      flow.updateNodeData(id, { busy: '' });
    }
  }

  return (
    <Frame
      id={id}
      kind="image"
      selected={selected}
      width={boxWidth(data.ratio, data.aspect)}
      tools={
        <>
          <button className="cnode-btn" type="button" {...tip('上传一张图片放进这个节点')} aria-label="上传图片" onClick={() => file.current!.click()}>
            <Icon name="upload" />
          </button>
          <DetailTool data={data} />
        </>
      }
      panel={
        <>
          {(refLimit > 0 || hasRefs) && <Refs id={id} model={data.model} limit={refLimit} />}
          <Prompt id={id} value={data.prompt} placeholder={promptHint(linked, hasRefs ? '想怎么改这张图？例如：把背景改成雪夜' : '描述想生成的图片：主体、环境、构图、光线和风格')} />
          {data.error && !data.busy && <p className="cnode-error">{data.error}</p>}
          <Bar working={working} action="生成图片" onSend={() => generate(flow, id)}>
            <Dropdown variant="tool" icon="cube" label="模型" value={data.model} options={models.map((m) => ({ value: m, label: m }))} onChange={(model) => flow.updateNodeData(id, { model, ratio: imageRatios(model).includes(data.ratio) ? data.ratio : imageRatios(model)[0] || data.ratio })} />
            {ratios.length > 0 && <Dropdown variant="tool" label="比例" value={data.ratio} options={ratios.map((r) => ({ value: r, label: r }))} onChange={(ratio) => flow.updateNodeData(id, { ratio })} />}
          </Bar>
        </>
      }
    >
      <input
        ref={file}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        hidden
        onChange={(e) => {
          upload(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <Result kind="image" data={data} onShape={(aspect) => Math.abs(aspect - (data.aspect || 0)) > 0.01 && flow.updateNodeData(id, { aspect })} />
    </Frame>
  );
}

// ---------- 视频 ----------

const ROLES: FrameRole[] = ['reference', 'first', 'last'];


// 改一条图片连线的用途。连线上的标签和输入面板里的小图都能点开它。
function pickRole(anchor: HTMLElement, model: string | undefined, current: FrameRole, onPick: (role: FrameRole) => void) {
  const able = traits(model);
  const usable: Record<FrameRole, boolean> = { reference: able.reference, first: able.frames, last: able.lastFrame };
  openMenu(anchor, {
    label: '这张图怎么用',
    items: ROLES.map((role) => ({ value: role, label: ROLE_LABELS[role], selected: role === current, disabled: !usable[role], title: usable[role] ? null : '这个视频模型不支持' })),
    onSelect: (role) => onPick(role as FrameRole),
  });
}

// 面板最上面一排：连进来的素材各一张小图，写着它当什么用；最后一个加号是再加一份参考素材。
// 视频节点收图片、视频、音频，图片可以点开改用途；图片节点只收图片（图生图），limit 是它的模型最多收几张。
function Refs({ id, model, limit }: { id: string; model: string; limit?: number }) {
  const forImage = limit !== undefined;
  const flow = useReactFlow();
  const { snap, addInput } = useContext(CanvasActions);
  const file = useRef<HTMLInputElement>(null);
  useStore('history', 'app');
  const media = useInputs(id).filter((i) => (forImage ? i.link.kind === 'image' : i.link.kind !== 'text'));
  const hasLibrary = !forImage && (state.app.features.library || state.app.features.persons);

  async function upload(picked: File) {
    const kind = kindOfFile(picked);
    if (kind !== 'image' && (forImage || kind !== 'video')) return toast(forImage ? '这里只能上传图片' : '这里只能上传图片和视频', 'info');
    toast(`正在上传${MEDIA[kind].label}…`, 'info', 1800);
    try {
      const ref = await uploadLocalFile(picked, kind);
      addInput(id, kind, { upload: { url: ref.url, name: ref.name } });
    } catch (err) {
      toast((err as Error).message, 'error', 6000);
    }
  }

  function add(button: HTMLElement) {
    // 图片节点只能加图片，直接选文件。
    if (forImage) return file.current!.click();
    const sources = [...(state.app.features.library ? (['library'] as const) : []), ...(state.app.features.persons ? (['person'] as const) : [])];
    const kinds = Object.keys(MEDIA) as Kind[];
    openMenu(button, {
      label: '添加参考素材',
      items: [{ value: 'upload', label: '上传图片或视频' }, ...(hasLibrary ? kinds.map((kind) => ({ value: kind, label: `从素材库选${MEDIA[kind].label}` })) : [])],
      onSelect: (value) => {
        if (value === 'upload') return file.current!.click();
        openAssetPicker({ kind: value as Kind, remaining: 1, sources: [...sources], onPick: (asset) => addInput(id, value as NodeKind, { asset }) });
      },
    });
  }

  return (
    <div className="cnode-refs">
      {media.map(({ edgeId, link, node }) => {
        const output = outputOf(node);
        const thumb = output?.asset ? output.asset.thumb : link.kind === 'image' ? output?.url : null;
        const label = linkLabel(link);
        const face = (
          <>
            {thumb ? <img src={thumb} alt="" draggable={false} /> : <Icon name={NODE_ICONS[link.kind]} size={18} />}
            <span className="cnode-ref-tag">{label}</span>
          </>
        );
        return link.kind === 'image' && !forImage ? (
          <button
            key={edgeId}
            className="cnode-ref"
            type="button"
            aria-haspopup="listbox"
            aria-expanded="false"
            aria-label={`这张图怎么用：${label}`}
            onClick={(e) =>
              pickRole(e.currentTarget, model, link.role || 'reference', (role) => {
                snap();
                flow.updateEdgeData(edgeId, { role });
              })
            }
          >
            {face}
          </button>
        ) : (
          <span key={edgeId} className="cnode-ref">
            {face}
          </span>
        );
      })}
      {(!forImage || media.length < limit) && (
        <button className="cnode-ref cnode-ref-add" type="button" {...tip(forImage ? '添加参考图，按提示词改这张图' : '添加参考素材')} aria-label={forImage ? '添加参考图' : '添加参考素材'} aria-haspopup={forImage ? undefined : 'menu'} aria-expanded={forImage ? undefined : 'false'} onClick={(e) => add(e.currentTarget)}>
          <Icon name="plus" size={18} />
        </button>
      )}
      <input
        ref={file}
        type="file"
        accept={forImage ? 'image/jpeg,image/png,image/webp' : 'image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm'}
        hidden
        onChange={(e) => {
          if (e.target.files?.[0]) upload(e.target.files[0]);
          e.target.value = '';
        }}
      />
    </div>
  );
}

export function VideoNode({ id, data: raw, selected }: NodeProps) {
  const data = raw as unknown as VideoData;
  const flow = useReactFlow();
  const linked = useInputs(id).some((i) => i.link.kind === 'text');
  const working = useWorking(data);
  useStore('models', 'app');
  const models = state.models.includes(data.model) ? state.models : [data.model, ...state.models];
  const able = capabilities(data.model);
  const ratioLabel = (value: string) => RATIOS.find((r) => r.value === value)?.label || value;
  const set = (patch: Partial<VideoData>) => flow.updateNodeData(id, patch);
  return (
    <Frame
      id={id}
      kind="video"
      selected={selected}
      width={boxWidth(data.ratio, data.aspect)}
      tools={<DetailTool data={data} />}
      panel={
        <>
          <Refs id={id} model={data.model} />
          <Prompt id={id} value={data.prompt} placeholder={promptHint(linked, '描述想生成的视频：主体、动作、场景、镜头运动、光线和风格')} />
          {data.error && !data.busy && <p className="cnode-error">{data.error}</p>}
          <Bar working={working} action="生成视频" onSend={() => generate(flow, id)}>
            <Dropdown variant="tool" icon="cube" label="模型" value={data.model} options={models.map((m) => ({ value: m, label: m, note: modelNote(m) || undefined }))} onChange={(model) => set(fitVideo({ ...data, model }))} />
            {able.resolutions.length > 0 && <Dropdown variant="tool" label="分辨率" value={data.resolution} options={able.resolutions.map((r) => ({ value: r, label: r }))} onChange={(resolution) => set({ resolution })} />}
            {able.ratios.length > 0 && <Dropdown variant="tool" label="比例" value={data.ratio} options={able.ratios.map((r) => ({ value: r, label: ratioLabel(r) }))} onChange={(ratio) => set({ ratio })} />}
            {able.durations.length > 0 && <Dropdown variant="tool" label="时长" value={String(data.duration)} options={able.durations.map((d) => ({ value: String(d), label: `${d} 秒` }))} onChange={(duration) => set({ duration: Number(duration) })} />}
          </Bar>
        </>
      }
    >
      <Result kind="video" data={data} onShape={(aspect) => Math.abs(aspect - (data.aspect || 0)) > 0.01 && set({ aspect })} />
    </Frame>
  );
}

// ---------- 音频 ----------

export function AudioNode({ id, data: raw, selected }: NodeProps) {
  const data = raw as unknown as AudioData;
  const flow = useReactFlow();
  const linked = useInputs(id).some((i) => i.link.kind === 'text');
  const working = useWorking(data);
  const [, redraw] = useState(0);
  useStore('app');
  const speech = data.tool !== 'sfx';
  const voices = state.voices || [];

  // 音色列表第一次用到时才读。还没选过音色：有中文的先用第一个中文的。
  useEffect(() => {
    if (!speech || !state.app.hasKey) return;
    let alive = true;
    loadVoices()
      .then((list) => {
        if (!alive || !list?.length) return;
        if (!list.some((v) => v.id === data.voiceId)) {
          const first = list.find((v) => v.language === 'zh') || list[0];
          flow.updateNodeData(id, { voiceId: first.id, voiceName: voiceName(first) });
        }
        redraw((n) => n + 1);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [speech, state.app.hasKey]);

  const tools = [{ value: 'speech', label: '语音' }, ...(state.app.features.sfx ? [{ value: 'sfx', label: '音效' }] : [])];
  return (
    <Frame
      id={id}
      kind="audio"
      selected={selected}
      width={320}
      tools={<DetailTool data={data} />}
      panel={
        <>
          <Prompt id={id} value={data.prompt} placeholder={promptHint(linked, speech ? '输入要朗读的文字' : '描述想要的声音：来源、材质、动作')} />
          {data.error && !data.busy && <p className="cnode-error">{data.error}</p>}
          <Bar working={working} action={speech ? '生成语音' : '生成音效'} onSend={() => generate(flow, id)}>
            {tools.length > 1 && <Dropdown variant="tool" label="类型" value={data.tool} options={tools} onChange={(tool) => flow.updateNodeData(id, { tool })} />}
            {speech && voices.length > 0 && (
              <Dropdown
                variant="tool"
                icon="volume"
                label="音色"
                value={data.voiceId}
                options={voices.map((v) => ({ value: v.id, label: voiceName(v) }))}
                onChange={(voiceId) => flow.updateNodeData(id, { voiceId, voiceName: voiceName(voices.find((v) => v.id === voiceId)!) })}
              />
            )}
          </Bar>
        </>
      }
    >
      <Result kind="audio" data={data} />
    </Frame>
  );
}

// ---------- 连线 ----------

// 一条细线，上面不放标签：图片当参考图、首帧还是尾帧，在视频节点的输入面板里看和改。
// 线两头的节点有一个被选中时，这条线变亮，看得出它连着谁。
export function LinkEdge({ id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected }: EdgeProps) {
  const from = useInternalNode(source);
  const to = useInternalNode(target);
  // 线画到框的边上，不画到加号上：加号平时是藏着的，而且它在屏幕上大小不变，位置会随缩放挪动。
  const startX = from ? from.internals.positionAbsolute.x + (from.measured.width || 0) : sourceX;
  const endX = to ? to.internals.positionAbsolute.x : targetX;
  const [path] = getBezierPath({ sourceX: startX, sourceY, targetX: endX, targetY, sourcePosition, targetPosition });
  return <BaseEdge id={id} path={path} className={`clink ${selected || from?.selected || to?.selected ? 'is-lit' : ''}`} />;
}
