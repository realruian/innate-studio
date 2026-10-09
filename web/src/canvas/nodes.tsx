// 画布上的四种节点和连线。
// 节点本身只是一块内容：上面一行名字，下面一个框放结果。选中它之后，下方才出现输入面板：参考素材、提示词、模型和参数、生成键。
// 左右两个加号是连接点：拖出去连到别的节点，点一下是在那一侧接一个新节点。
// 跟着画布缩放的只有框和里面的内容；名字、加号、操作条、输入面板在屏幕上的大小不变，缩得再小也看得清、点得到。

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { BaseEdge, Handle, NodeToolbar, Position, getBezierPath, useConnection, useEdges, useInternalNode, useReactFlow, useStore as useFlowStore, useUpdateNodeInternals, type ConnectionLineComponentProps, type EdgeProps, type Node, type NodeProps } from '@xyflow/react';
import { api, state, useStore, loadVoices, isPendingTask, polishModel, KINDS as MEDIA } from '../store.ts';
import { RATIOS, capabilities, imageRatios, imageRefLimit, traits, voiceName } from '../composer/state.ts';
import { modelNote } from '../../../shared/models.ts';
import { kindOfFile, recordName, uploadLocalFile, uploadVirtualAsset } from '../media.ts';
import { openAssetPicker } from '../assets.tsx';
import { Icon, type IconName } from '../ui/Icon.tsx';
import { Dropdown, tip } from '../ui/controls.tsx';
import { openMenu, openModal, openPopover, toast } from '../ui/layers.tsx';
import { VideoPlayer, AudioPlayer } from '../player.tsx';
import { openDetail } from '../history.tsx';
import type { Kind } from '../types.ts';
import { BOX_HEIGHT, NODE_LABELS, ROLE_LABELS, canLink, nodeWidth, joinPrompt, linkLabel, PINS, PIN_LABELS, type AudioData, type FrameRole, type GroupData, type ImageData, type Pin, type StackData, type LinkData, type NodeKind, type TextData, type VideoData } from './model.ts';
import { fitVideo, generate, outputOf, recordOf, runAll } from './run.ts';

// 画布页交给节点用的几件事。snap：会改动画布结构的操作，动手之前调一下，撤销时回到这一刻。
// addInput：在某个节点左边加一个节点并连进它，extra 是新节点一出来就带着的内容（上传的文件、素材库里的素材）。
// ungroup：解散一个分组（只去掉框，里面的节点留着）。saveWorkflow：把一个分组存成工作流。
// unstack：把一叠摊开；只给一个成员就只取回它。
export const CanvasActions = createContext<{ snap: () => void; addInput: (targetId: string, kind: NodeKind, extra?: Record<string, unknown>) => void; ungroup: (groupId: string) => void; saveWorkflow: (groupId: string) => void; unstack: (stackId: string, memberId?: string) => void }>({
  snap() {},
  addInput() {},
  ungroup() {},
  saveWorkflow() {},
  unstack() {},
});

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

function Frame({ id, kind, no, pins = [], selected, width, tools, panel, children }: { id: string; kind: NodeKind; no?: number; pins?: Pin[]; selected?: boolean; width: number; tools?: ReactNode; panel: ReactNode; children: ReactNode }) {
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
      {/* 名字在左，只选中这一个节点时右端是它的几个操作（上传、看详情）。删除用键盘或右键菜单。 */}
      <div className="cnode-title">
        <span className="cnode-name">
          <Icon name={NODE_ICONS[kind]} size={14} />
          <span>{no ? `${NODE_LABELS[kind]} ${no}` : NODE_LABELS[kind]}</span>
          {pins.map((pin) => (
            <span key={pin} className={`cpin is-${pin}`} role="img" aria-label={`${PIN_LABELS[pin]}标记`} />
          ))}
        </span>
        {alone && (
          <span className="cnode-acts nodrag">
            <button className="cnode-btn" type="button" {...tip('颜色标记')} aria-label="颜色标记" aria-haspopup="dialog" aria-expanded="false" onClick={(e) => openPopover(e.currentTarget, <PinSheet value={pins} onChange={(pin) => flow.updateNodeData(id, { pin })} />, { label: '颜色标记' })}>
              <span className={`cpin ${pins.length ? `is-${pins[0]}` : 'is-none'}`} />
            </button>
            {tools}
          </span>
        )}
      </div>
      <div className="cnode-box">{children}</div>
      <Handle type="target" position={Position.Left} className="cnode-port">
        <Icon name="plus" size={12} />
      </Handle>
      <Handle type="source" position={Position.Right} className="cnode-port">
        <Icon name="plus" size={12} />
      </Handle>
      {fits && <Handle id="body" type={wants} position={wants === 'target' ? Position.Left : Position.Right} className="cnode-drop" isConnectableStart={false} />}
      {/* 输入面板画在画布的缩放之外，所以大小不变；位置仍然贴着节点。 */}
      <NodeToolbar isVisible={alone} position={Position.Bottom} offset={20}>
        <div className="cnode-panel nowheel">{panel}</div>
      </NodeToolbar>
    </div>
  );
}

// 选颜色标记：几个色点，点一下标上、再点一下去掉，可以同时标几种；最后是「无」，一次清掉。它画在画布外面的浮层里，所以自己记着选了什么。
function PinSheet({ value, onChange }: { value: Pin[]; onChange: (pins: Pin[]) => void }) {
  const [picked, setPicked] = useState(value);
  const set = (next: Pin[]) => {
    setPicked(next);
    onChange(next);
  };
  return (
    <div className="popover-body cpins" role="group" aria-label="颜色标记">
      {PINS.map((pin) => (
        <button key={pin} type="button" className={`cpins-item ${picked.includes(pin) ? 'active' : ''}`} aria-pressed={picked.includes(pin)} aria-label={PIN_LABELS[pin]} {...tip(PIN_LABELS[pin])} onClick={() => set(picked.includes(pin) ? picked.filter((p) => p !== pin) : PINS.filter((p) => p === pin || picked.includes(p)))}>
          <span className={`cpin is-${pin}`} />
        </button>
      ))}
      <button type="button" className="cpins-none" disabled={!picked.length} onClick={() => set([])}>
        无
      </button>
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

// 输入框自己留一份正在打的字，再抄一份给节点。
// 不能直接拿节点里存的字当输入框的内容：节点的数据要过一拍才更新，这一拍里 React 会把输入框改回旧的内容，
// 输入法正在拼的那段就被打断了，结果是候选框出不来、只能打上英文字母。
// 光标在输入框里的时候不从节点往回抄，免得把正在打的字冲掉；不在的时候跟着节点走（比如模型写好了新内容）。
function useDraft(value: string, commit: (next: string) => void) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);
  return {
    value: draft,
    onChange: (e: { target: { value: string } }) => {
      setDraft(e.target.value);
      commit(e.target.value);
    },
    onFocus: () => {
      focused.current = true;
    },
    onBlur: () => {
      focused.current = false;
    },
  };
}

function Prompt({ id, value, placeholder }: { id: string; value: string; placeholder: string }) {
  const flow = useReactFlow();
  const draft = useDraft(value, (prompt) => flow.updateNodeData(id, { prompt }));
  return <textarea className="cnode-prompt" placeholder={placeholder} {...draft} />;
}

// 输入面板最下面一行：左边是模型和参数，右边是生成键。ready：有没有东西可以发（写了提示词，或者连了能用的节点），没有就是灰的。
function Bar({ working, ready, action, onSend, children }: { working: boolean; ready: boolean; action: string; onSend: () => void; children: ReactNode }) {
  return (
    <div className="cnode-bar">
      <div className="cnode-params">{children}</div>
      <button className="send-btn" type="button" {...tip(working ? '正在生成' : action)} aria-label={action} disabled={working || !ready} onClick={onSend}>
        {working ? <span className="spinner" /> : <Icon name="arrowUp" size={18} />}
      </button>
    </div>
  );
}

interface ParamGroup {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}

// 点开之后的那一页：每组参数一行小方块。它画在画布外面的浮层里，所以自己记着选了什么。
function ParamSheet({ groups }: { groups: ParamGroup[] }) {
  const [picked, setPicked] = useState(() => groups.map((group) => group.value));
  return (
    <div className="popover-body cnode-sheet">
      {groups.map((group, index) => (
        <div key={group.label} className="cnode-sheet-group" role="radiogroup" aria-label={group.label}>
          <div className="popover-title">{group.label}</div>
          <div className="cnode-opts">
            {group.options.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={picked[index] === option.value}
                className={`cnode-opt ${picked[index] === option.value ? 'active' : ''}`}
                onClick={() => {
                  setPicked((now) => now.map((value, n) => (n === index ? option.value : value)));
                  group.onChange(option.value);
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// 几个参数合成一项：按钮上把当前的值用圆点隔开写成一行（9:16 · 720p · 5 秒），点开一起改。
function Params({ label, groups }: { label: string; groups: ParamGroup[] }) {
  const ref = useRef<HTMLButtonElement>(null);
  const shown = groups.filter((group) => group.options.length > 0);
  if (!shown.length) return null;
  const summary = shown.map((group) => group.options.find((option) => option.value === group.value)?.label || group.value);
  return (
    <button ref={ref} type="button" className="dropdown dropdown-tool cnode-param" aria-haspopup="dialog" aria-expanded="false" aria-label={`${label}：${summary.join('，')}`} onClick={() => openPopover(ref.current!, <ParamSheet groups={shown} />, { label })}>
      <span className="dropdown-value">
        {summary.map((text, index) => (
          <span key={index}>{text}</span>
        ))}
      </span>
      <Icon name="chevron" size={12} />
    </button>
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
  if (data.upload && kind === 'audio') {
    return (
      <div className={`cnode-sound ${INERT}`}>
        <AudioPlayer src={data.upload.url} kind="上传的音频" text={data.upload.name} />
      </div>
    );
  }
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

// 名字行右端的操作：有内容时一个「全屏查看」，再加一个「更多」（下载、存到素材库、换一张图）。
// onUpload：图片节点可以上传一张图放进来；节点还空着的时候只有这一个按钮。
function NodeTools({ id, kind, data, onUpload }: { id: string; kind: Kind; data: MediaData; onUpload?: () => void }) {
  const flow = useReactFlow();
  useStore('history', 'app');
  const record = recordOf(data);
  // 这个节点里现在放着的东西：生成的结果、上传的文件，或者素材库里的素材。
  const done = record?.status === 'completed' && record.mediaUrl ? record : null;
  const file = data.asset ? null : done ? { url: done.mediaUrl!, name: recordName(done), local: Boolean(done.savedLocally) } : data.upload ? { ...data.upload, local: true } : null;
  const canSave = Boolean(file?.local) && state.app.features.library;

  function view() {
    if (done) return openDetail(done.id);
    const url = data.upload?.url || data.asset?.url;
    if (!url) return;
    openModal({ title: data.upload?.name || data.asset?.name || MEDIA[kind].label, size: 'detail', content: <div className="cnode-view">{kind === 'image' ? <img src={url} alt="" /> : kind === 'video' ? <VideoPlayer src={url} label={MEDIA[kind].label} /> : <AudioPlayer src={url} />}</div> });
  }

  function download() {
    if (!file) return;
    const link = document.createElement('a');
    // 存在本机的文件让服务按附件给出；还在平台上的就在新标签页里打开。
    link.href = file.local ? `${file.url}?download=1` : file.url;
    if (file.local) link.download = file.name;
    else link.target = '_blank';
    link.rel = 'noopener';
    link.click();
  }

  async function save() {
    if (!file) return;
    toast('正在存到素材库…', 'info', 1800);
    try {
      const res = await fetch(file.url);
      if (!res.ok) throw new Error('这个文件已经不在本机了');
      const blob = await res.blob();
      const asset = await uploadVirtualAsset(new File([blob], `${file.name}.${file.url.split('.').pop()}`, { type: blob.type }), kind);
      // 记在节点上：之后拿它去给 Seedance 当参考，不用再传一遍。
      flow.updateNodeData(id, { assetId: asset.id, assetOf: file.url });
      toast('已存到素材库', 'success');
    } catch (err) {
      toast((err as Error).message, 'error', 6000);
    }
  }

  const items = [...(file ? [{ value: 'download', label: '下载' }] : []), ...(canSave ? [{ value: 'save', label: '存到素材库' }] : []), ...(onUpload ? [{ value: 'upload', label: file || data.asset ? '换一张图' : '上传图片' }] : [])];
  const act = (value: string) => (value === 'download' ? download() : value === 'save' ? save() : onUpload?.());
  const hasContent = Boolean(done || data.upload || data.asset);
  if (!hasContent && !onUpload) return null;
  return (
    <>
      {hasContent && (
        <button className="cnode-btn" type="button" {...tip('全屏查看')} aria-label="全屏查看" onClick={view}>
          <Icon name="expand" size={16} />
        </button>
      )}
      {!hasContent && onUpload ? (
        <button className="cnode-btn" type="button" {...tip('上传一张图片放进这个节点')} aria-label="上传图片" onClick={onUpload}>
          <Icon name="upload" size={16} />
        </button>
      ) : (
        items.length > 0 && (
          <button className="cnode-btn" type="button" {...tip('更多')} aria-label="更多操作" aria-haspopup="menu" aria-expanded="false" onClick={(e) => openMenu(e.currentTarget, { label: '更多操作', items, onSelect: act })}>
            <Icon name="more" size={16} />
          </button>
        )
      )}
    </>
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
  const draft = useDraft(data.text || '', (text) => flow.updateNodeData(id, { text }));
  const { snap } = useContext(CanvasActions);
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

  const write = () => generate(flow, id, snap);

  return (
    <Frame
      id={id}
      kind="text"
      no={data.no}
      pins={(data as { pin?: Pin[] }).pin}
      selected={selected}
      width={BOX_HEIGHT}
      panel={
        <>
          <Refs id={id} kind="text" />
          <Prompt id={id} value={data.prompt || ''} placeholder={data.text ? '想怎么改？例如：改成三个分镜，每个一句话' : '想让模型写什么？例如：写一段 15 秒短视频的分镜'} />
          {data.error && !data.busy && <p className="cnode-error">{data.error}</p>}
          <Bar working={Boolean(data.busy)} ready={Boolean((data.prompt || '').trim())} action="让模型写" onSend={write}>
            {models.length > 0 ? (
              <Dropdown variant="tool" chevron label="文本模型" value={model} options={models.map((m) => ({ value: m, label: m }))} onChange={(next) => flow.updateNodeData(id, { model: next })} />
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
        <textarea
          ref={area}
          className={`cnode-text-edit ${INERT}`}
          {...draft}
          onBlur={() => {
            draft.onBlur();
            setEditing(false);
          }}
        />
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
  const { snap } = useContext(CanvasActions);
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
      no={data.no}
      pins={(data as { pin?: Pin[] }).pin}
      selected={selected}
      width={nodeWidth('image', data)}
      tools={<NodeTools id={id} kind="image" data={data} onUpload={() => file.current!.click()} />}
      panel={
        <>
          <Refs id={id} kind="image" model={data.model} limit={refLimit} />
          <Prompt id={id} value={data.prompt} placeholder={promptHint(linked, hasRefs ? '想怎么改这张图？例如：把背景改成雪夜' : '描述想生成的图片：主体、环境、构图、光线和风格')} />
          {data.error && !data.busy && <p className="cnode-error">{data.error}</p>}
          <Bar working={working} ready={Boolean(data.prompt.trim()) || linked} action="生成图片" onSend={() => generate(flow, id, snap)}>
            <Dropdown variant="tool" chevron label="模型" value={data.model} options={models.map((m) => ({ value: m, label: m }))} onChange={(model) => flow.updateNodeData(id, { model, ratio: imageRatios(model).includes(data.ratio) ? data.ratio : imageRatios(model)[0] || data.ratio })} />
            <Params
              label="参数"
              groups={[
                { label: '比例', value: data.ratio, options: ratios.map((r) => ({ value: r, label: r })), onChange: (ratio) => flow.updateNodeData(id, { ratio }) },
                { label: '张数', value: String(data.count || 1), options: IMAGE_COUNTS.map((n) => ({ value: String(n), label: `${n} 张` })), onChange: (count) => flow.updateNodeData(id, { count: Number(count) }) },
              ]}
            />
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
// 一次最多出几份：图片是接口一次能出的张数，视频是连着提交几次。
const IMAGE_COUNTS = [1, 2, 3, 4];
const VIDEO_COUNTS = [1, 2, 3, 4];


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

// 面板最上面一排：连进来的节点各一个小方块，写着它当什么用；最后一个加号是再加一份参考素材。
// 连进来的文本节点也在这里（它的内容会拼进提示词）。视频节点收图片、视频、音频，图片可以点开改用途；
// 图片节点只收图片（图生图），limit 是它的模型最多收几张；文本、音频节点只收文本。这一排每种节点都有，最后一个加号一直在。
function Refs({ id, kind, model = '', limit = 0 }: { id: string; kind: NodeKind; model?: string; limit?: number }) {
  const forImage = kind === 'image';
  const flow = useReactFlow();
  const { snap, addInput } = useContext(CanvasActions);
  const file = useRef<HTMLInputElement>(null);
  useStore('history', 'app');
  const inputs = useInputs(id);
  // 文本排在前面。这个节点的模型不收的素材也照样显示，方便看出问题在哪。
  const media = [...inputs.filter((i) => i.link.kind === 'text'), ...inputs.filter((i) => i.link.kind !== 'text')];
  const used = inputs.filter((i) => i.link.kind === 'image').length;
  const canUpload = kind === 'video' || (forImage && used < limit);
  const hasLibrary = kind === 'video' && (state.app.features.library || state.app.features.persons);
  const only = !canUpload && !hasLibrary;

  async function upload(picked: File) {
    const kind = kindOfFile(picked);
    if (!kind || (forImage && kind !== 'image')) return toast(forImage ? '这里只能上传图片' : '这里只能上传图片、视频和音频', 'info');
    toast(`正在上传${MEDIA[kind].label}…`, 'info', 1800);
    try {
      const ref = await uploadLocalFile(picked, kind);
      addInput(id, kind, { upload: { url: ref.url, name: ref.name } });
    } catch (err) {
      toast((err as Error).message, 'error', 6000);
    }
  }

  // 加号：这个节点还能接什么就列什么。文本哪种节点都能接；图片节点还能接参考图，视频节点还能接图片、视频、音频。只有一样时不弹菜单。
  function add(button: HTMLElement) {
    const sources = [...(state.app.features.library ? (['library'] as const) : []), ...(state.app.features.persons ? (['person'] as const) : [])];
    const kinds = Object.keys(MEDIA) as Kind[];
    const items = [
      ...(canUpload ? [{ value: 'upload', label: forImage ? '上传参考图' : '上传图片、视频或音频' }] : []),
      ...(hasLibrary ? kinds.map((item) => ({ value: item, label: `从素材库选${MEDIA[item].label}` })) : []),
      { value: 'text', label: '文本节点' },
    ];
    const pick = (value: string) => {
      if (value === 'upload') return file.current!.click();
      if (value === 'text') return addInput(id, 'text');
      openAssetPicker({ kind: value as Kind, remaining: 1, sources: [...sources], onPick: (asset) => addInput(id, value as NodeKind, { asset }) });
    };
    if (items.length === 1) return pick(items[0].value);
    openMenu(button, { label: '接一个节点进来', items, onSelect: pick });
  }

  return (
    <div className="cnode-refs">
      {media.map(({ edgeId, link, node }) => {
        if (link.kind === 'text') {
          const text = ((node.data as unknown as TextData).text || '').trim();
          return (
            <span key={edgeId} className="cnode-ref is-text" {...tip(text ? (text.length > 80 ? `${text.slice(0, 80)}…` : text) : '连进来的文本节点还是空的')}>
              <Icon name="type" size={18} />
              <span className="cnode-ref-tag">文本</span>
            </span>
          );
        }
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
      <button className="cnode-ref cnode-ref-add" type="button" {...tip(only ? '接一个文本节点进来，它的内容会拼进提示词' : forImage ? '添加参考图或文本' : '添加参考素材或文本')} aria-label={only ? '接一个文本节点进来' : '接一个节点进来'} aria-haspopup={only ? undefined : 'menu'} aria-expanded={only ? undefined : 'false'} onClick={(e) => add(e.currentTarget)}>
        <Icon name="plus" size={18} />
      </button>
      <input
        ref={file}
        type="file"
        accept={forImage ? 'image/jpeg,image/png,image/webp' : 'image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm,audio/mpeg,audio/wav,.mp3,.wav'}
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
  const inputs = useInputs(id);
  const linked = inputs.some((i) => i.link.kind === 'text');
  const working = useWorking(data);
  useStore('models', 'app');
  const models = state.models.includes(data.model) ? state.models : [data.model, ...state.models];
  const able = capabilities(data.model);
  const ratioLabel = (value: string) => RATIOS.find((r) => r.value === value)?.label || value;
  const set = (patch: Partial<VideoData>) => flow.updateNodeData(id, patch);
  const { snap } = useContext(CanvasActions);
  return (
    <Frame
      id={id}
      kind="video"
      no={data.no}
      pins={(data as { pin?: Pin[] }).pin}
      selected={selected}
      width={nodeWidth('video', data)}
      tools={<NodeTools id={id} kind="video" data={data} />}
      panel={
        <>
          <Refs id={id} kind="video" model={data.model} />
          <Prompt id={id} value={data.prompt} placeholder={promptHint(linked, '描述想生成的视频：主体、动作、场景、镜头运动、光线和风格')} />
          {data.error && !data.busy && <p className="cnode-error">{data.error}</p>}
          <Bar working={working} ready={Boolean(data.prompt.trim()) || inputs.length > 0} action="生成视频" onSend={() => generate(flow, id, snap)}>
            <Dropdown variant="tool" chevron label="模型" value={data.model} options={models.map((m) => ({ value: m, label: m, note: modelNote(m) || undefined }))} onChange={(model) => set(fitVideo({ ...data, model }))} />
            <Params
              label="参数"
              groups={[
                { label: '比例', value: data.ratio, options: able.ratios.map((r) => ({ value: r, label: ratioLabel(r) })), onChange: (ratio) => set({ ratio }) },
                { label: '分辨率', value: data.resolution, options: able.resolutions.map((r) => ({ value: r, label: r })), onChange: (resolution) => set({ resolution }) },
                { label: '时长', value: String(data.duration), options: able.durations.map((d) => ({ value: String(d), label: `${d} 秒` })), onChange: (duration) => set({ duration: Number(duration) }) },
                { label: '段数', value: String(data.count || 1), options: VIDEO_COUNTS.map((n) => ({ value: String(n), label: `${n} 段` })), onChange: (count) => set({ count: Number(count) }) },
              ]}
            />
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
      no={data.no}
      pins={(data as { pin?: Pin[] }).pin}
      selected={selected}
      width={nodeWidth('audio')}
      tools={<NodeTools id={id} kind="audio" data={data} />}
      panel={
        <>
          <Refs id={id} kind="audio" />
          <Prompt id={id} value={data.prompt} placeholder={promptHint(linked, speech ? '输入要朗读的文字' : '描述想要的声音：来源、材质、动作')} />
          {data.error && !data.busy && <p className="cnode-error">{data.error}</p>}
          <Bar working={working} ready={Boolean(data.prompt.trim()) || linked} action={speech ? '生成语音' : '生成音效'} onSend={() => generate(flow, id)}>
            {tools.length > 1 && <Dropdown variant="tool" chevron label="类型" value={data.tool} options={tools} onChange={(tool) => flow.updateNodeData(id, { tool })} />}
            {speech && voices.length > 0 && (
              <Dropdown
                variant="tool"
                chevron
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

// ---------- 分组 ----------

// 分组只是一个框：垫在成员下面，左上角是组名。拖这个框，里面的节点一起走。
// 组名双击改。只选中这一个分组时，名字后面是「更多」：执行整组、存为工作流、解散分组。
export function GroupNode({ id, data: raw, selected }: NodeProps) {
  const data = raw as unknown as GroupData;
  const flow = useReactFlow();
  const alone = useAlone(selected);
  const { snap, ungroup, saveWorkflow } = useContext(CanvasActions);
  const [naming, setNaming] = useState(false);
  const draft = useDraft(data.name || '', (name) => flow.updateNodeData(id, { name }));
  const name = data.name?.trim() || `分组${data.no ? ` ${data.no}` : ''}`;
  const acts: Record<string, () => void> = { run: () => runAll(flow, data.members, snap), save: () => saveWorkflow(id), ungroup: () => ungroup(id) };
  return (
    <div className={`cgroup ${selected ? 'selected' : ''}`}>
      <div className="cgroup-title">
        {naming ? (
          <input
            className="cgroup-name-edit nodrag"
            autoFocus
            maxLength={30}
            placeholder={name}
            aria-label="组名"
            {...draft}
            onBlur={() => {
              draft.onBlur();
              setNaming(false);
            }}
            onKeyDown={(e) => !e.nativeEvent.isComposing && (e.key === 'Enter' || e.key === 'Escape') && e.currentTarget.blur()}
          />
        ) : (
          <span className="cgroup-name" onDoubleClick={() => setNaming(true)}>
            {name}
          </span>
        )}
        <span className="cgroup-count">{data.members.length} 个节点</span>
        {alone && (
          <button
            className="cnode-btn nodrag"
            type="button"
            {...tip('更多')}
            aria-label="分组操作"
            aria-haspopup="menu"
            aria-expanded="false"
            onClick={(e) =>
              openMenu(e.currentTarget, {
                label: '分组操作',
                items: [
                  { value: 'run', label: '执行整组' },
                  { value: 'save', label: '存为工作流' },
                  { value: 'ungroup', label: '解散分组', note: '⇧ ⌘ G' },
                ],
                onSelect: (value) => acts[value](),
              })
            }
          >
            <Icon name="more" size={16} />
          </button>
        )}
      </div>
      <div className="cgroup-frame" />
    </div>
  );
}

// ---------- 堆叠 ----------

// 一叠里某个节点的小图：图片、视频是画面，文本是开头几个字，音频是图标。
function Mini({ node }: { node: Node }) {
  useStore('history');
  const kind = node.type as NodeKind;
  if (kind === 'text') return <span className="cstack-words">{((node.data as unknown as TextData).text || '').slice(0, 40) || '空的文本'}</span>;
  const output = outputOf(node);
  const thumb = output?.asset ? output.asset.thumb : output?.url;
  if (thumb && kind === 'image') return <img src={thumb} alt="" draggable={false} />;
  if (thumb && kind === 'video') return <video src={`${thumb}#t=0.1`} preload="metadata" muted playsInline tabIndex={-1} />;
  return <Icon name={NODE_ICONS[kind]} size={20} />;
}

// 一叠：框里是最上面那个节点的画面，后面露出两层边，右上角写着一共几个。
// 选中它，下面展开一个画廊：点其中一个把它取回画布；右上角可以整叠摊开。
export function StackNode({ id, data: raw, selected }: NodeProps) {
  const data = raw as unknown as StackData;
  const flow = useReactFlow();
  const alone = useAlone(selected);
  const { unstack } = useContext(CanvasActions);
  // 成员是藏着的节点，它们变了这里也要跟着变。
  const all = useFlowStore((s) => s.nodes);
  const members = data.members.map((member) => all.find((node) => node.id === member)).filter((node): node is Node => Boolean(node));
  return (
    <div className={`cnode cstack ${selected ? 'selected' : ''}`} style={{ width: BOX_HEIGHT }}>
      <div className="cnode-title">
        <span className="cnode-name">
          <Icon name="layers" size={14} />
          <span>{`堆叠${data.no ? ` ${data.no}` : ''}`}</span>
        </span>
        {alone && (
          <span className="cnode-acts nodrag">
            <button className="cnode-btn" type="button" {...tip('取消堆叠：里面的节点都摊回画布')} aria-label="取消堆叠" onClick={() => unstack(id)}>
              <Icon name="grid" size={16} />
            </button>
          </span>
        )}
      </div>
      <div className="cnode-box cstack-box">
        {members[0] && <Mini node={members[0]} />}
        <span className="cstack-count">{members.length}</span>
      </div>
      <NodeToolbar isVisible={alone} position={Position.Bottom} offset={20}>
        <div className="cnode-panel cstack-panel nowheel">
          <div className="cstack-grid">
            {members.map((member) => (
              <button key={member.id} type="button" className="cstack-item" {...tip('点一下把它取回画布')} aria-label={`取回 ${NODE_LABELS[member.type as NodeKind]}${member.data.no ? ` ${member.data.no}` : ''}`} onClick={() => unstack(id, member.id)}>
                <Mini node={member} />
                <span className="chist-cap ellipsis">{`${NODE_LABELS[member.type as NodeKind]}${member.data.no ? ` ${member.data.no}` : ''}`}</span>
              </button>
            ))}
          </div>
        </div>
      </NodeToolbar>
    </div>
  );
}

// ---------- 连线 ----------

// 流光走一遍的节奏：用八成半的时间从上游匀着滑到下游（两头稍缓），剩下的停一下再来。
// 不用原版那条「起步很快、后面几乎不动」的曲线：连线短，那样光一闪就过去了，大半时间看不见。
const BEAM_DUR = '2.4s';
const BEAM_TIMES = '0;0.85;1';
const BEAM_EASE = '0.4 0 0.2 1;0 0 1 1';

// 一条细线，上面不放标签：图片当参考图、首帧还是尾帧，在视频节点的输入面板里看和改。
// 线两头的节点有一个被选中时，这条线变成彩色并带流光，看得出它连着谁；平时是普通的灰线。
export function LinkEdge({ id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected }: EdgeProps) {
  const from = useInternalNode(source);
  const to = useInternalNode(target);
  // 线画到框的边上，不画到加号上：加号平时是藏着的，而且它在屏幕上大小不变，位置会随缩放挪动。
  const startX = from ? from.internals.positionAbsolute.x + (from.measured.width || 0) : sourceX;
  const endX = to ? to.internals.positionAbsolute.x : targetX;
  const [path] = getBezierPath({ sourceX: startX, sourceY, targetX: endX, targetY, sourcePosition, targetPosition });
  // 流光那段渐变沿着起点到终点的方向走，长度是两点距离的一半，收在 100 到 320 之间。
  const dx = endX - startX;
  const dy = targetY - sourceY;
  const span = Math.hypot(dx, dy) || 1;
  const ux = dx / span;
  const uy = dy / span;
  const reach = Math.min(320, Math.max(100, span * 0.5));
  // 两头的节点有一个被选中：线变成彩色，上面有一段光顺着线从上游流到下游。线自己被选中时不流，免得盖住选中的样子。
  const lit = !selected && Boolean(from?.selected || to?.selected);
  return (
    <>
      <BaseEdge id={id} path={path} className={`clink ${lit ? 'is-lit' : ''}`} />
      {lit && (
        <>
          {/* 流光的做法取自 Magic UI 的 Animated Beam：不另画一段粗线，而是在原来的细线上再描一遍，
              描边用一条两头透明的渐变，让这条渐变顺着上游到下游的方向滑过去。两头是淡出的，所以没有硬边。 */}
          <defs>
            <linearGradient id={`beam-${id}`} gradientUnits="userSpaceOnUse" x1={startX - reach * ux} y1={sourceY - reach * uy} x2={startX} y2={sourceY}>
              <animate attributeName="x1" dur={BEAM_DUR} repeatCount="indefinite" calcMode="spline" keyTimes={BEAM_TIMES} keySplines={BEAM_EASE} values={`${startX - reach * ux};${endX};${endX}`} />
              <animate attributeName="y1" dur={BEAM_DUR} repeatCount="indefinite" calcMode="spline" keyTimes={BEAM_TIMES} keySplines={BEAM_EASE} values={`${sourceY - reach * uy};${targetY};${targetY}`} />
              <animate attributeName="x2" dur={BEAM_DUR} repeatCount="indefinite" calcMode="spline" keyTimes={BEAM_TIMES} keySplines={BEAM_EASE} values={`${startX};${endX + reach * ux};${endX + reach * ux}`} />
              <animate attributeName="y2" dur={BEAM_DUR} repeatCount="indefinite" calcMode="spline" keyTimes={BEAM_TIMES} keySplines={BEAM_EASE} values={`${sourceY};${targetY + reach * uy};${targetY + reach * uy}`} />
              <stop offset="0%" className="clink-beam-tail" stopOpacity="0" />
              <stop offset="60%" className="clink-beam-tail" />
              <stop offset="88%" className="clink-beam-head" />
              <stop offset="100%" className="clink-beam-head" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={path} className="clink-beam" stroke={`url(#beam-${id})`} />
        </>
      )}
    </>
  );
}

// 正在拉的那条线：一直跟着鼠标走，拖到节点上也不提前吸过去，松手才连上。能不能连，看那个节点有没有浮起来。
// 这条线画在画布坐标里，而 React Flow 给的 pointer 是屏幕上的位置，要按当前的平移和缩放换算过来，不然只有 100%、没平移过的时候才对得上。
export function DragLine({ fromX, fromY, fromPosition, pointer }: ConnectionLineComponentProps) {
  const [x, y, zoom] = useFlowStore((s) => s.transform);
  const [path] = getBezierPath({ sourceX: fromX, sourceY: fromY, sourcePosition: fromPosition, targetX: (pointer.x - x) / zoom, targetY: (pointer.y - y) / zoom, targetPosition: fromPosition === Position.Right ? Position.Left : Position.Right });
  return <path d={path} fill="none" className="react-flow__connection-path" />;
}
