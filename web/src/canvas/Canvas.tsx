// 一张画布：可以无限平移缩放的桌面，上面摆节点、拉连线。打开时整个窗口都是它，改动之后自动保存。

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Background, BackgroundVariant, MiniMap, Panel, ReactFlow, ReactFlowProvider, SelectionMode, ViewportPortal, useEdgesState, useNodesState, useReactFlow, useStoreApi, useViewport, type Connection, type Edge, type Node, type NodeChange, type OnConnectEnd, type Viewport } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api, canvasPath, state, useStore, KINDS as MEDIA } from '../store.ts';
import { composer, imageRefLimit, traits } from '../composer/state.ts';
import { kindOfFile, uploadLocalFile } from '../media.ts';
import { openAssetPicker } from '../assets.tsx';
import { Icon } from '../ui/Icon.tsx';
import { tip } from '../ui/controls.tsx';
import { openMenu, openPopover, toast } from '../ui/layers.tsx';
import { reducedMotion } from '../ui/motion.ts';
import type { HistoryItem, Kind } from '../types.ts';
import { BOX_HEIGHT, NODE_LABELS, TITLE_ROOM, canLink, MAX_STACK, PINS, PIN_LABELS, clipOf, groupFrame, isGroup, isStack, nodeWidth, numbered, pasteClip, snapTo, sourcesOf, stripNodeData, targetsOf, tidy, type Clip, type GroupData, type Guide, type LinkData, type NodeKind, type Pin, type Rect } from './model.ts';
import { coverOf, newNodeData } from './run.ts';
import { AudioNode, CanvasActions, DragLine, GroupNode, ImageNode, LinkEdge, NODE_ICONS, StackNode, TextNode, VideoNode } from './nodes.tsx';
import { Finder, HistoryPicker, WorkflowPicker } from './panels.tsx';

interface Doc {
  id: string;
  name: string;
  nodes: Node[];
  edges: Edge[];
  viewport: Viewport | null;
}
interface Snap {
  nodes: Node[];
  edges: Edge[];
}

const nodeTypes = { text: TextNode, image: ImageNode, video: VideoNode, audio: AudioNode, group: GroupNode, stack: StackNode };
const edgeTypes = { link: LinkEdge };
const KINDS: NodeKind[] = ['text', 'image', 'video', 'audio'];
// 画布上能上传的文件。音频只收 MP3 和 WAV。
const UPLOAD_ACCEPT = 'image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm,audio/mpeg,audio/wav,.mp3,.wav';
const SAVE_DELAY_MS = 600;
const MAX_UNDO = 50;
// 复制的节点放进系统剪贴板时用的类型。换一张画布、换一个标签页也能粘贴。
const CLIP_TYPE = 'application/x-innate-canvas';
// 最近一次复制的内容，右键菜单里的「粘贴」用它（网页不能随便读系统剪贴板）。
let copied: Clip | null = null;
// 选中节点时下方输入面板大约占多高（屏幕上的像素）。把新节点挪进视野时给它留出位置。
const PANEL_ROOM = 240;
// 拖动节点时，离别的节点的边线、中线多近就吸过去（屏幕上的像素）。
const SNAP_REACH = 6;

// 一个节点的框在画布上占的位置，不算上面那行名字：对齐看的是框。
const membersOf = (node: Node) => (node.data as unknown as GroupData).members || [];

// 分组的框不存位置和大小，每次按成员现在占的范围算出来，垫在所有节点下面。成员都不在了就不画。
function framed(nodes: Node[]): Node[] {
  if (!nodes.some(isGroup)) return nodes;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return nodes.map((node) => {
    if (!isGroup(node)) return node;
    const frame = frameOf(node, byId);
    return frame ? { ...node, position: { x: frame.x, y: frame.y }, style: { width: frame.width, height: frame.height }, zIndex: -1, hidden: false } : { ...node, hidden: true };
  });
}
function frameOf(group: Node, byId: Map<string, Node>) {
  const rects = membersOf(group)
    .map((id) => byId.get(id))
    .filter((member): member is Node => Boolean(member) && !member!.hidden)
    .map((member) => ({ x: member.position.x, y: member.position.y, width: member.measured?.width || nodeWidth(member.type as NodeKind, member.data), height: TITLE_ROOM + BOX_HEIGHT }));
  return groupFrame(rects);
}

const boxOf = (node: Node, position = node.position): Rect => ({ x: position.x, y: position.y + TITLE_ROOM, width: node.measured?.width || nodeWidth(node.type as NodeKind, node.data), height: BOX_HEIGHT });

// 存进画布的只有节点的位置和内容、连线的两头和用途；选中状态、量出来的尺寸这些不存。
// 收在一叠里的节点是藏着的，这一点要存。
const savedNodes = (nodes: Node[]) => nodes.map(({ id, type, position, data, hidden }) => ({ id, type, position, data: stripNodeData(data), ...(hidden ? { hidden: true } : {}) }));
const savedEdges = (edges: Edge[]) => edges.map(({ id, source, target, data }) => ({ id, source, target, type: 'link', data }));

function makeEdge(source: Node, target: Node): Edge {
  const data: LinkData = { kind: source.type as NodeKind };
  // 图片连到视频默认当参考图；目标模型不支持参考生成（Grok）时当首帧。连到图片的都是参考图，不分用途。
  if (data.kind === 'image' && target.type === 'video') data.role = traits((target.data as { model?: string }).model).reference ? 'reference' : 'first';
  return { id: crypto.randomUUID(), source: source.id, target: target.id, type: 'link', data: data as unknown as Record<string, unknown> };
}

function Board({ id, onExit }: { id: string; onExit: () => void }) {
  const flow = useReactFlow();
  const store = useStoreApi();
  const { zoom } = useViewport();
  // 名字、加号这些在屏幕上大小不变，靠这个倒数把画布的缩放抵消掉；最多放大到 2 倍。
  const inv = Math.min(1 / zoom, 2);
  const [ready, setReady] = useState(false);
  const [name, setName] = useState('');
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [moved, setMoved] = useState(0);
  const [showMap, setShowMap] = useState(false);
  // 抓手：开着的时候左键拖动是平移画布，节点点不中也拖不动。
  const [hand, setHand] = useState(false);
  const [finding, setFinding] = useState(false);
  const [guides, setGuides] = useState<Guide[]>([]);
  // 保存到哪一步了：saved 已保存，saving 有改动还没存上，failed 没存上（点一下重试）。
  const [saving, setSaving] = useState<'saved' | 'saving' | 'failed'>('saved');
  // 正被拖着、在吸附的那个节点。
  const snapping = useRef('');
  const [, setUndoDepth] = useState(0);
  // 生成完成之后封面可能要换，所以生成记录变了也要重新算一遍要存的内容。
  const records = useStore('history', 'app');
  const wrap = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const file = useRef<HTMLInputElement>(null);
  // 从右键菜单点的上传：文件选好之后节点落在点右键的位置。
  const dropAt = useRef<{ x: number; y: number } | undefined>(undefined);
  const past = useRef<Snap[]>([]);
  const future = useRef<Snap[]>([]);
  const lastSaved = useRef('');
  const pending = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const started = useRef(false);
  // 鼠标最近在画布上的位置，粘贴时内容落在这里。
  const pointer = useRef<{ x: number; y: number } | null>(null);

  // ---------- 读取和保存 ----------

  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    const body = pending.current;
    pending.current = '';
    if (!body) return;
    try {
      await api('PUT', `/api/canvases/${id}`, JSON.parse(body));
      lastSaved.current = body;
      // 存的这会儿又有了新改动，就还算没存完。
      if (!pending.current) setSaving('saved');
    } catch (err) {
      // 没存上的这一份留着，点「没存上」或者再有改动时重发。
      if (!pending.current) pending.current = body;
      setSaving('failed');
      toast(`画布没存上：${(err as Error).message}`, 'error', 6000);
    }
  }, [id]);

  useEffect(() => {
    // 开发模式下这个 effect 会跑两遍，只读一次。
    if (started.current) return;
    started.current = true;
    api<Doc>('GET', `/api/canvases/${id}`)
      .then((doc) => {
        // 以前存的节点没有编号，打开时补上。
        setNodes(numbered(doc.nodes || []));
        setEdges((doc.edges || []).map((edge) => ({ ...edge, type: 'link' })));
        setName(doc.name);
        setReady(true);
        // 等节点画出来再定位：存过视口就回到那里，没存过就把内容放进视野。
        // 空画布不用定位：这时调 fitView 会一直等到有了第一个节点才生效，把刚加的节点连同视野一起挪走。
        requestAnimationFrame(() => {
          if (doc.viewport) flow.setViewport(doc.viewport);
          else if (doc.nodes?.length) flow.fitView({ maxZoom: 1, padding: 0.2 });
        });
      })
      .catch((err) => {
        toast(`画布读不出来：${(err as Error).message}`, 'error', 6000);
        onExit();
      });
  }, [flow, id, onExit, setEdges, setNodes]);

  // 内容、名字、视口或封面变了，过一会儿自动存。和上次存的一样就不发请求（选中、悬停这些变化不算）。
  useEffect(() => {
    if (!ready) return;
    const body = JSON.stringify({ name, nodes: savedNodes(nodes), edges: savedEdges(edges), viewport: flow.getViewport(), cover: coverOf(nodes) });
    if (!lastSaved.current) {
      lastSaved.current = body;
      return;
    }
    if (body === lastSaved.current) return;
    pending.current = body;
    setSaving('saving');
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_DELAY_MS);
  }, [ready, name, nodes, edges, moved, records, flow, flush]);

  // 关掉或刷新页面之前把没存的发出去。
  useEffect(() => {
    const save = () => {
      if (pending.current) fetch(`/api/canvases/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: pending.current, keepalive: true });
    };
    window.addEventListener('pagehide', save);
    return () => window.removeEventListener('pagehide', save);
  }, [id]);

  const exit = useCallback(async () => {
    await flush();
    onExit();
  }, [flush, onExit]);

  // ---------- 撤销、重做 ----------
  // 只管结构：有哪些节点、摆在哪、怎么连。节点里写的字和生成的结果不跟着退回去。

  const snap = useCallback(() => {
    past.current.push({ nodes: flow.getNodes(), edges: flow.getEdges() });
    if (past.current.length > MAX_UNDO) past.current.shift();
    future.current = [];
    setUndoDepth((n) => n + 1);
  }, [flow]);

  const travel = useCallback(
    (from: Snap[], to: Snap[]) => {
      const target = from.pop();
      if (!target) return;
      const now = flow.getNodes();
      to.push({ nodes: now, edges: flow.getEdges() });
      const live = new Map(now.map((node) => [node.id, node.data]));
      setNodes(target.nodes.map((node) => ({ ...node, selected: false, data: live.get(node.id) || stripNodeData(node.data) })));
      setEdges(target.edges.map((edge) => ({ ...edge, selected: false })));
      setUndoDepth((n) => n + 1);
    },
    [flow, setEdges, setNodes],
  );
  const undo = useCallback(() => travel(past.current, future.current), [travel]);
  const redo = useCallback(() => travel(future.current, past.current), [travel]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'z' || !(e.metaKey || e.ctrlKey) || !wrap.current?.offsetParent) return;
      const el = e.target as HTMLElement;
      // 正在打字时把撤销留给文本框；有弹窗盖着时也不动画布。
      if (el.closest('input, textarea, [contenteditable]') || (el !== document.body && !wrap.current.contains(el))) return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  // ---------- 加节点、连线 ----------

  // 新加的节点要是落在窗口外面，或者它下方的输入面板露不全，就把视野平移过去；本来就看得全的不动。
  const reveal = useCallback(
    (position: { x: number; y: number }, width: number) => {
      const box = wrap.current!.getBoundingClientRect();
      const { x, y, zoom } = flow.getViewport();
      const left = position.x * zoom + x;
      const top = position.y * zoom + y;
      const height = (BOX_HEIGHT + TITLE_ROOM) * zoom;
      // 只挪刚好够的距离，原来在看的内容尽量留在视野里。左边要让开工具栏，上边要让开项目名和节点的操作条。
      const right = left + width * zoom;
      const bottom = top + height + PANEL_ROOM;
      const dx = left < 96 ? 96 - left : right > box.width - 24 ? Math.max(box.width - 24 - right, 96 - left) : 0;
      const dy = top < 96 ? 96 - top : bottom > box.height - 24 ? Math.max(box.height - 24 - bottom, 96 - top) : 0;
      if (dx || dy) flow.setViewport({ x: x + dx, y: y + dy, zoom }, { duration: reducedMotion() ? 0 : 280 });
    },
    [flow],
  );

  // link 是新节点要和哪个节点连上：from 是它的上游，to 是它的下游。extra 是节点一出来就带着的内容：上传的文件，或者从素材库选的素材。
  const addNode = useCallback(
    (kind: NodeKind, at?: { x: number; y: number }, link?: { from?: Node; also?: Node[]; to?: Node }, extra?: Record<string, unknown>) => {
      snap();
      const box = wrap.current!.getBoundingClientRect();
      const data = { ...newNodeData(kind, { form: composer.form, image: composer.studio.image, speech: composer.studio.speech }), ...extra };
      const width = nodeWidth(kind, data);
      // 没指定位置就放在视野中间；那里已经有节点了就往右挪，直到不压着别的节点。
      const position = at || flow.screenToFlowPosition({ x: box.left + box.width / 2 - width / 2, y: box.top + box.height / 2 - 120 });
      // 节点宽窄不一，按量出来的宽度让开；还没量过的按它的内容算。
      for (let moved = true; !at && moved; ) {
        moved = false;
        for (const n of flow.getNodes()) {
          if (isGroup(n) || n.hidden) continue;
          const taken = n.measured?.width || nodeWidth(n.type as NodeKind, n.data);
          if (Math.abs(n.position.y - position.y) < 200 && position.x < n.position.x + taken + 60 && position.x + width + 60 > n.position.x) {
            position.x = n.position.x + taken + 80;
            moved = true;
          }
        }
      }
      const [node] = numbered([{ id: crypto.randomUUID(), type: kind, position, data, selected: true } as Node], flow.getNodes());
      setNodes((items) => [...items.map((n) => (n.selected ? { ...n, selected: false } : n)), node]);
      reveal(position, width);
      if (link?.from) {
        // also：同时选中的其他节点，接得上的也一起连进来。图片连图片要看新节点的模型收几张参考图。
        let room = kind === 'image' ? imageRefLimit((data as { model?: string }).model) : Infinity;
        const sources = [link.from, ...(link.also || [])].filter((source) => {
          if (!canLink(source.type as NodeKind, kind)) return false;
          if (source.type === 'image' && kind === 'image') return room-- > 0;
          return true;
        });
        setEdges((items) => [...items, ...sources.map((source) => makeEdge(source, node))]);
      }
      if (link?.to) setEdges((items) => [...items, makeEdge(node, link.to!)]);
    },
    [flow, reveal, setEdges, setNodes, snap],
  );

  // 在一个节点的左边加一个节点并连进它：输入面板里「添加参考素材」用。已经有节点的位置往下错开。
  const addInput = useCallback(
    (targetId: string, kind: NodeKind, extra?: Record<string, unknown>) => {
      const target = flow.getNode(targetId);
      if (!target) return;
      const at = { x: target.position.x - 420, y: target.position.y };
      while (flow.getNodes().some((n) => Math.abs(n.position.x - at.x) < 300 && Math.abs(n.position.y - at.y) < 200)) at.y += 260;
      addNode(kind, at, { to: target }, extra);
    },
    [addNode, flow],
  );

  // 在鼠标的位置弹出「加什么节点」的菜单。菜单要贴着一个元素显示，这里用一个看不见的点。
  const menuAt = useCallback(
    (x: number, y: number, kinds: NodeKind[], link?: { from?: Node; also?: Node[]; to?: Node }, place?: { x: number; y: number }) => {
      const el = anchor.current!;
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      // place 是新节点放哪；没给就放在菜单弹出的位置。
      const at = place || flow.screenToFlowPosition({ x, y });
      // 接在左边的节点，右边缘要落在松手的位置附近。
      if (link?.to && !place) at.x -= 320;
      openMenu(el, { label: '添加节点', items: kinds.map((kind) => ({ value: kind, label: NODE_LABELS[kind] })), onSelect: (kind) => addNode(kind as NodeKind, at, link) });
    },
    [addNode, flow],
  );

  // 上传：图片、视频各变成一个带着这个文件的节点。at 是拖进来时松手的位置。
  const upload = useCallback(
    async (picked: File, at?: { x: number; y: number }) => {
      const kind = kindOfFile(picked);
      if (!kind) return toast('画布上只能上传图片、视频和音频', 'info');
      toast(`正在上传${MEDIA[kind].label}…`, 'info', 1800);
      try {
        const ref = await uploadLocalFile(picked, kind);
        addNode(kind, at, undefined, { upload: { url: ref.url, name: ref.name } });
        return;
      } catch (err) {
        toast((err as Error).message, 'error', 6000);
      }
    },
    [addNode],
  );

  // 素材库：先问要哪一类，再从素材库或真人素材里挑一份，变成一个节点。
  function pickFromLibrary(button: HTMLElement) {
    const sources = [...(state.app.features.library ? (['library'] as const) : []), ...(state.app.features.persons ? (['person'] as const) : [])];
    openMenu(button, {
      label: '从素材库添加',
      items: (Object.keys(MEDIA) as Kind[]).map((kind) => ({ value: kind, label: MEDIA[kind].label })),
      onSelect: (kind) => openAssetPicker({ kind: kind as Kind, remaining: 1, sources: [...sources], onPick: (asset) => addNode(kind as NodeKind, undefined, undefined, { asset }) }),
    });
  }

  // ---------- 搜索、生成历史 ----------

  // 跳到一个节点：只选中它，把它挪到视野中间，闪一下。缩得太小看不清就放大到 60%。
  const jumpTo = useCallback(
    (nodeId: string) => {
      const node = flow.getNode(nodeId);
      if (!node) return;
      setFinding(false);
      setNodes((items) => items.map((n) => ({ ...n, selected: n.id === nodeId, className: n.id === nodeId ? 'is-found' : undefined })));
      const box = boxOf(node);
      flow.setCenter(box.x + box.width / 2, box.y + box.height / 2 + PANEL_ROOM / 4, { zoom: Math.max(flow.getZoom(), 0.6), duration: reducedMotion() ? 0 : 320 });
      setTimeout(() => setNodes((items) => items.map((n) => (n.className ? { ...n, className: undefined } : n))), 1400);
    },
    [flow, setNodes],
  );

  // 把一条生成记录放回画布：一个带着这份结果的新节点，放在视野中间并选中。原来的提示词也带上。
  const restore = useCallback(
    (item: HistoryItem) => {
      const extra: Record<string, unknown> = { recordId: item.id, prompt: item.prompt || '' };
      if (item.kind === 'audio') extra.tool = item.tool === 'speech' ? 'speech' : 'sfx';
      addNode(item.kind, undefined, undefined, extra);
    },
    [addNode],
  );

  // 生成历史、工作流这两块浮层出在工具栏的右边、和工具栏顶对齐，不盖住工具栏。浮层要贴着一个元素显示，用那个看不见的点。
  function openBeside(button: HTMLElement, content: ReactNode, label: string) {
    const bar = button.closest('.canvas-tools')!.getBoundingClientRect();
    const el = anchor.current!;
    el.style.left = `${bar.right + 12}px`;
    el.style.top = `${bar.top - 6}px`;
    openPopover(el, content, { label });
  }

  // ---------- 对齐 ----------

  // 拖着一个节点靠近别的节点时，把它吸到对方的边线或中线上，并画出参考线。一次拖着好几个时不吸。
  const changeNodes = useCallback(
    (changes: NodeChange<Node>[]) => {
      // 拖的是分组的框：框自己没有位置，把这一下挪动换成挪它的成员。成员自己也在被拖的（一起选中了）就不再挪一遍。
      const moving = new Set(changes.filter((change) => change.type === 'position').map((change) => change.id));
      const frames = changes.filter((change) => change.type === 'position' && change.position && isGroup(flow.getNode(change.id) || {}));
      if (frames.length) {
        setNodes((items) => {
          const byId = new Map(items.map((node) => [node.id, node]));
          const shift = new Map<string, { x: number; y: number }>();
          for (const change of frames) {
            if (change.type !== 'position' || !change.position) continue;
            const group = byId.get(change.id);
            const frame = group && frameOf(group, byId);
            if (!group || !frame) continue;
            for (const member of membersOf(group)) if (!moving.has(member)) shift.set(member, { x: change.position.x - frame.x, y: change.position.y - frame.y });
          }
          return items.map((node) => (shift.has(node.id) ? { ...node, position: { x: node.position.x + shift.get(node.id)!.x, y: node.position.y + shift.get(node.id)!.y } } : node));
        });
        changes = changes.filter((change) => !(change.type === 'position' && frames.includes(change)));
      }
      // 松手时还会来最后一次位置（不带 dragging），它也要吸，不然一松手节点又弹回没对齐的地方。
      const moves = changes.filter((change) => change.type === 'position' && change.position && (change.dragging || change.id === snapping.current));
      const move = moves.length === 1 && !frames.length ? moves[0] : null;
      const me = move?.type === 'position' ? flow.getNode(move.id) : undefined;
      if (move?.type === 'position' && move.position && me) {
        snapping.current = move.dragging ? move.id : '';
        const others = flow.getNodes().filter((node) => node.id !== me.id && !isGroup(node) && !node.hidden).map((node) => boxOf(node));
        const snapped = snapTo(boxOf(me, move.position), others, SNAP_REACH / flow.getZoom());
        move.position = { x: move.position.x + snapped.dx, y: move.position.y + snapped.dy };
        setGuides(snapped.guides);
      } else if (changes.some((change) => change.type === 'position')) setGuides((now) => (now.length ? [] : now));
      onNodesChange(changes);
    },
    [flow, onNodesChange, setNodes],
  );

  // ---------- 分组 ----------

  // 把选中的节点打成一组（至少两个）。它们原来在别的组里就先从那边拿出来。
  const group = useCallback(() => {
    const picked = flow.getNodes().filter((node) => node.selected && !isGroup(node));
    if (picked.length < 2) return toast('先选中至少两个节点，再打组', 'info');
    snap();
    const ids = new Set(picked.map((node) => node.id));
    setNodes((items) => {
      const kept = items
        .map((node) => (isGroup(node) ? { ...node, selected: false, data: { ...node.data, members: membersOf(node).filter((id) => !ids.has(id)) } } : node.selected ? { ...node, selected: false } : node))
        .filter((node) => !isGroup(node) || membersOf(node).length);
      const [made] = numbered([{ id: crypto.randomUUID(), type: 'group', position: { x: 0, y: 0 }, data: { members: [...ids] }, selected: true } as Node], kept);
      return [made, ...kept];
    });
    // 框选之后会留着一个选区框，选中的东西换了，把它收掉。
    store.setState({ nodesSelectionActive: false });
  }, [flow, setNodes, snap, store]);

  // 解散分组：只去掉框，里面的节点留着。给了 id 就解散那一个，没给就解散选中的。
  const ungroup = useCallback(
    (groupId?: string) => {
      if (!flow.getNodes().some((node) => isGroup(node) && (groupId ? node.id === groupId : node.selected))) return;
      snap();
      setNodes((items) => items.filter((node) => !(isGroup(node) && (groupId ? node.id === groupId : node.selected))));
    },
    [flow, setNodes, snap],
  );

  // ---------- 堆叠 ----------

  // 把选中的节点收成一叠（至少两个）。选中的里面已经有一叠，就并进同一叠。分组的框不收。
  const stack = useCallback(() => {
    const picked = flow.getNodes().filter((node) => node.selected && !isGroup(node));
    const loose = picked.filter((node) => !isStack(node));
    const members = [...picked.filter(isStack).flatMap(membersOf), ...loose.map((node) => node.id)];
    if (members.length < 2 || !loose.length) return toast('先选中至少两个节点，再堆叠', 'info');
    if (members.length > MAX_STACK) return toast(`一叠最多放 ${MAX_STACK} 个节点`, 'info');
    snap();
    const inside = new Set(loose.map((node) => node.id));
    const merged = new Set(picked.filter(isStack).map((node) => node.id));
    setNodes((items) => {
      const kept = items.filter((node) => !merged.has(node.id)).map((node) => (inside.has(node.id) ? { ...node, hidden: true, selected: false } : node.selected ? { ...node, selected: false } : node));
      const [made] = numbered([{ id: crypto.randomUUID(), type: 'stack', position: { ...picked[0].position }, data: { members }, selected: true } as Node], kept);
      return [...kept, made];
    });
    store.setState({ nodesSelectionActive: false });
  }, [flow, setNodes, snap, store]);

  // 摊开一叠：里面的节点从这一叠的位置起排成几行。只给了一个成员，就只把它取回来放在这一叠右边；取到只剩一个时这一叠自动散掉。
  const unstack = useCallback(
    (stackId: string, memberId?: string) => {
      const pile = flow.getNode(stackId);
      if (!pile) return;
      snap();
      const members = membersOf(pile);
      const out = memberId && members.length > 2 ? [memberId] : members;
      const rest = members.filter((id) => !out.includes(id));
      const spot = new Map<string, { x: number; y: number }>();
      if (rest.length) spot.set(out[0], { x: pile.position.x + BOX_HEIGHT + 80, y: pile.position.y });
      else {
        // 要取的那个排第一，放在这一叠原来的位置。
        const order = memberId ? [memberId, ...members.filter((id) => id !== memberId)] : members;
        let x = pile.position.x;
        let y = pile.position.y;
        order.forEach((id, index) => {
          if (index && index % 5 === 0) {
            x = pile.position.x;
            y += TITLE_ROOM + BOX_HEIGHT + 56;
          }
          spot.set(id, { x, y });
          const member = flow.getNode(id);
          x += (member ? nodeWidth(member.type as NodeKind, member.data) : BOX_HEIGHT) + 60;
        });
      }
      setNodes((items) =>
        items
          .filter((node) => rest.length || node.id !== stackId)
          .map((node) => {
            if (spot.has(node.id)) return { ...node, hidden: false, position: spot.get(node.id)!, selected: node.id === (memberId || out[0]) };
            if (node.id === stackId) return { ...node, data: { ...node.data, members: rest } };
            return node.selected ? { ...node, selected: false } : node;
          }),
      );
    },
    [flow, setNodes, snap],
  );

  // 成员被删掉之后，分组里不再记着它；一个成员都不剩的分组一起去掉。
  // 堆叠也一样；一叠里只剩一个节点时，这一叠散掉，把那个节点放回它的位置。
  useEffect(() => {
    const ids = new Set(nodes.map((node) => node.id));
    const stale = (node: Node) => (isGroup(node) && (!membersOf(node).length || membersOf(node).some((id) => !ids.has(id)))) || (isStack(node) && membersOf(node).filter((id) => ids.has(id)).length !== membersOf(node).length) || (isStack(node) && membersOf(node).length < 2);
    if (!nodes.some(stale)) return;
    setNodes((items) => {
      const live = new Set(items.map((node) => node.id));
      const pruned = items.map((node) => (isGroup(node) || isStack(node) ? { ...node, data: { ...node.data, members: membersOf(node).filter((id) => live.has(id)) } } : node));
      // 只剩一个成员的那几叠：成员放出来，这一叠去掉。
      const freed = new Map(pruned.filter((node) => isStack(node) && membersOf(node).length === 1).map((node) => [membersOf(node)[0], node.position]));
      return pruned.filter((node) => !((isGroup(node) && !membersOf(node).length) || (isStack(node) && membersOf(node).length < 2))).map((node) => (freed.has(node.id) ? { ...node, hidden: false, position: freed.get(node.id)! } : node));
    });
  }, [nodes, setNodes]);

  // 把一个分组存成工作流：组里的节点和它们之间的连线。
  const saveWorkflow = useCallback(
    async (groupId: string) => {
      const made = flow.getNode(groupId);
      if (!made) return;
      const ids = new Set(membersOf(made));
      const clip = clipOf(savedNodes(flow.getNodes().filter((node) => ids.has(node.id))), savedEdges(flow.getEdges()));
      const data = made.data as unknown as GroupData;
      try {
        await api('POST', '/api/workflows', { name: data.name?.trim() || `分组 ${data.no || ''}`.trim(), ...clip });
        toast('已存为工作流，在左侧工具栏的「工作流」里', 'success');
      } catch (err) {
        toast((err as Error).message, 'error', 6000);
      }
    },
    [flow],
  );

  // 把一份工作流放上画布：节点和连线都是新的，放在视野中间，外面套一个同名的分组。
  const applyWorkflow = useCallback(
    async (workflowId: string) => {
      try {
        const saved = await api<Clip & { name: string }>('GET', `/api/workflows/${workflowId}`);
        // 画布上已经有东西：放在所有节点的下面，左边对齐，不压着谁。空画布就放在视野中间。
        const box = wrap.current!.getBoundingClientRect();
        const solid = flow.getNodes().filter((node) => !isGroup(node) && !node.hidden);
        const at = solid.length
          ? { x: Math.min(...solid.map((node) => node.position.x)), y: Math.max(...solid.map((node) => node.position.y)) + TITLE_ROOM + BOX_HEIGHT + 120 }
          : flow.screenToFlowPosition({ x: box.left + box.width / 2 - 300, y: box.top + box.height / 2 - 200 });
        const pasted = pasteClip({ nodes: saved.nodes.filter((node) => !isGroup(node)), edges: saved.edges }, { at }, () => crypto.randomUUID());
        snap();
        const fresh = numbered(pasted.nodes.map((node) => ({ ...node, data: { ...node.data, no: undefined } }) as Node), flow.getNodes());
        const [made] = numbered([{ id: crypto.randomUUID(), type: 'group', position: { x: 0, y: 0 }, data: { name: saved.name, members: fresh.map((node) => node.id) }, selected: true } as Node], flow.getNodes());
        setNodes((items) => [made, ...items.map((node) => (node.selected ? { ...node, selected: false } : node)), ...fresh]);
        setEdges((items) => [...items, ...pasted.edges.map((edge) => ({ ...edge, type: 'link' }) as Edge)]);
        requestAnimationFrame(() => flow.fitView({ nodes: fresh.map(({ id }) => ({ id })), maxZoom: 1, padding: 0.3, duration: reducedMotion() ? 0 : 280 }));
      } catch (err) {
        toast((err as Error).message, 'error', 6000);
      }
    },
    [flow, setEdges, setNodes, snap],
  );

  // 一键整理：框选了两个以上就只整理它们，否则整理整张画布。
  const arrange = useCallback(() => {
    const all = flow.getNodes().filter((node) => !isGroup(node) && !node.hidden);
    const picked = all.filter((node) => node.selected);
    const scope = picked.length > 1 ? picked : all;
    if (scope.length < 2) return;
    const placed = tidy(scope.map((node) => ({ id: node.id, position: node.position, width: boxOf(node).width })), flow.getEdges());
    if (scope.every((node) => placed.get(node.id)!.x === node.position.x && placed.get(node.id)!.y === node.position.y)) return;
    snap();
    setNodes((items) => items.map((node) => (placed.has(node.id) ? { ...node, position: placed.get(node.id)! } : node)));
    // 整理的是整张画布时，排完把它们都放进视野。
    if (scope === all) requestAnimationFrame(() => flow.fitView({ maxZoom: 1, padding: 0.2, duration: reducedMotion() ? 0 : 280 }));
  }, [flow, setNodes, snap]);

  // ---------- 复制、粘贴、创建副本 ----------

  const selection = useCallback((): Clip | null => {
    // 选中了分组的框，就连它的成员一起带上；分组只有成员都在这次复制里才带。
    const all = flow.getNodes();
    const chosen = new Set(all.filter((node) => node.selected).map((node) => node.id));
    for (const node of all) if (isGroup(node) && node.selected) membersOf(node).forEach((id) => chosen.add(id));
    // 一叠被选中（或者跟着分组被带上），里面藏着的节点也一起。
    for (const node of all) if (isStack(node) && chosen.has(node.id)) membersOf(node).forEach((id) => chosen.add(id));
    const picked = all.filter((node) => chosen.has(node.id) && (!isGroup(node) || membersOf(node).every((id) => chosen.has(id))));
    return picked.some((node) => !isGroup(node)) ? clipOf(savedNodes(picked), savedEdges(flow.getEdges())) : null;
  }, [flow]);

  // 把一份复制下来的节点放上画布并选中它们。
  const place = useCallback(
    (clip: Clip, where: { at?: { x: number; y: number }; by?: { x: number; y: number } }) => {
      if (!clip.nodes.length) return;
      snap();
      // 粘贴出来的是新节点，编号重新排。
      const pasted = pasteClip(clip, where, () => crypto.randomUUID());
      const fresh = { edges: pasted.edges, nodes: numbered(pasted.nodes.map((node) => ({ ...node, data: { ...node.data, no: undefined } })), flow.getNodes()) };
      setNodes((items) => [...items.map((n) => (n.selected ? { ...n, selected: false } : n)), ...fresh.nodes.map((node) => ({ ...node, selected: true }) as Node)]);
      setEdges((items) => [...items.map((e) => (e.selected ? { ...e, selected: false } : e)), ...fresh.edges.map((edge) => ({ ...edge, type: 'link' }) as Edge)]);
    },
    [flow, setEdges, setNodes, snap],
  );

  // 粘贴落在鼠标的位置；鼠标不在画布上就落在视野中间。
  const pasteSpot = useCallback(() => {
    const box = wrap.current!.getBoundingClientRect();
    return flow.screenToFlowPosition(pointer.current || { x: box.left + box.width / 2 - 120, y: box.top + box.height / 2 - 120 });
  }, [flow]);

  const duplicate = useCallback(() => {
    const clip = selection();
    if (clip) place(clip, { by: { x: 40, y: 40 } });
  }, [place, selection]);

  useEffect(() => {
    // 正在打字、选中了一段文字、或者有弹窗盖着的时候，这些按键和剪贴板都留给它们自己。
    const mine = (e: Event) => {
      const el = e.target as HTMLElement;
      if (!wrap.current?.offsetParent || el.closest?.('input, textarea, [contenteditable]')) return false;
      return el === document.body || wrap.current.contains(el);
    };
    const onCopy = (e: ClipboardEvent) => {
      if (!mine(e) || String(window.getSelection())) return;
      const clip = selection();
      if (!clip || !e.clipboardData) return;
      e.preventDefault();
      copied = clip;
      e.clipboardData.setData(CLIP_TYPE, JSON.stringify(clip));
      if (e.type === 'cut') flow.deleteElements({ nodes: clip.nodes.map(({ id }) => ({ id })) });
    };
    const onPaste = (e: ClipboardEvent) => {
      if (!mine(e) || !e.clipboardData) return;
      const at = pasteSpot();
      const raw = e.clipboardData.getData(CLIP_TYPE);
      if (raw) {
        e.preventDefault();
        try {
          place(JSON.parse(raw) as Clip, { at });
        } catch {
          /* 剪贴板里不是画布的内容 */
        }
        return;
      }
      // 从别处复制来的图片、视频文件变成节点；一段文字变成一个文本节点。
      const files = [...e.clipboardData.files];
      if (files.length) {
        e.preventDefault();
        files.forEach((pasted, index) => upload(pasted, { x: at.x + index * 400, y: at.y }));
        return;
      }
      const text = e.clipboardData.getData('text/plain').trim();
      if (text) {
        e.preventDefault();
        addNode('text', at, undefined, { text });
      }
    };
    const onKey = (e: KeyboardEvent) => {
      // ⌘ + 在有的键盘上要同时按 Shift，所以这两个缩放键不拦 Shift。
      const key = e.key.toLowerCase();
      // H 是抓手，V 回到选择（和 Figma 一样）。
      if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && (key === 'h' || key === 'v') && mine(e)) return setHand(key === 'h');
      // ⌘ F 搜索节点，正在打字时也管用（否则会弹出浏览器自己的查找）。
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && key === 'f' && wrap.current?.offsetParent && (e.target === document.body || wrap.current.contains(e.target as HTMLElement))) {
        e.preventDefault();
        return setFinding(true);
      }
      if (!(e.metaKey || e.ctrlKey) || e.altKey || !mine(e) || (e.shiftKey && key !== '+' && key !== '=' && key !== 'g')) return;
      // ⌘ G 打组，⇧ ⌘ G 解散。
      if (key === 'g') {
        e.preventDefault();
        return e.shiftKey ? ungroup() : group();
      }
      if (key === 'd') {
        e.preventDefault();
        duplicate();
      } else if (key === '=' || key === '+') {
        // ⌘ + 和 ⌘ - 缩放画布，不让浏览器去缩放整个页面。
        e.preventDefault();
        flow.zoomIn({ duration: reducedMotion() ? 0 : 160 });
      } else if (key === '-') {
        e.preventDefault();
        flow.zoomOut({ duration: reducedMotion() ? 0 : 160 });
      } else if (key === 'a') {
        e.preventDefault();
        setNodes((items) => items.map((n) => (n.selected || n.hidden ? n : { ...n, selected: true })));
      }
    };
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCopy);
    document.addEventListener('paste', onPaste);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCopy);
      document.removeEventListener('paste', onPaste);
      window.removeEventListener('keydown', onKey);
    };
  }, [addNode, duplicate, flow, group, pasteSpot, place, selection, setNodes, ungroup, upload]);

  // ---------- 右键菜单 ----------

  // 在空白处点右键：加节点、上传、粘贴。
  function paneMenu(x: number, y: number) {
    const el = anchor.current!;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    const at = flow.screenToFlowPosition({ x, y });
    openMenu(el, {
      label: '画布',
      items: [...KINDS.map((kind) => ({ value: kind, label: `${NODE_LABELS[kind]}节点` })), { value: 'upload', label: '上传文件' }, ...(copied ? [{ value: 'paste', label: '粘贴', note: '⌘ V' }] : []), ...(flow.getNodes().length ? [{ value: 'all', label: '全选', note: '⌘ A' }] : [])],
      onSelect: (value) => {
        if (value === 'upload') {
          dropAt.current = at;
          file.current!.click();
        } else if (value === 'paste') place(copied!, { at });
        else if (value === 'all') setNodes((items) => items.map((n) => (n.selected || n.hidden ? n : { ...n, selected: true })));
        else addNode(value as NodeKind, at);
      },
    });
  }

  // 在节点上点右键：对选中的节点创建副本、删除。点的节点不在选中的里面，就先改成只选它。
  function nodeMenu(x: number, y: number, node?: Node) {
    if (node && !node.selected) setNodes((items) => items.map((n) => (n.selected === (n.id === node.id) ? n : { ...n, selected: n.id === node.id })));
    const el = anchor.current!;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    // 这时候选中的是什么：点的是分组的框，菜单里是解散；选中了两个以上的节点，多一项打组。
    const picked = node ? (node.selected ? flow.getNodes().filter((n) => n.selected) : [node]) : flow.getNodes().filter((n) => n.selected);
    const onGroup = picked.length === 1 && isGroup(picked[0]);
    openMenu(el, {
      label: '节点',
      items: [
        { value: 'duplicate', label: '创建副本', note: '⌘ D' },
        ...(picked.filter((n) => !isGroup(n)).length > 1 ? [{ value: 'group', label: '打组', note: '⌘ G' }, { value: 'stack', label: '堆叠' }] : []),
        ...(picked.length === 1 && isStack(picked[0]) ? [{ value: 'unstack', label: '取消堆叠' }] : []),
        onGroup ? { value: 'ungroup', label: '解散分组', note: '⇧ ⌘ G' } : { value: 'delete', label: '删除', note: '⌫', danger: true },
      ],
      onSelect: (value) => {
        if (value === 'duplicate') duplicate();
        else if (value === 'group') group();
        else if (value === 'stack') stack();
        else if (value === 'unstack') unstack(picked[0].id);
        else if (value === 'ungroup') ungroup(picked[0].id);
        else flow.deleteElements({ nodes: flow.getNodes().filter((n) => n.selected) });
      },
    });
  }

  const isValidConnection = useCallback(
    (link: Connection | Edge) => {
      const source = flow.getNode(link.source);
      const target = flow.getNode(link.target);
      if (!source || !target || source.id === target.id || isGroup(source) || isGroup(target) || isStack(source) || isStack(target)) return false;
      if (!canLink(source.type as NodeKind, target.type as NodeKind)) return false;
      const all = flow.getEdges();
      if (all.some((edge) => edge.source === source.id && edge.target === target.id)) return false;
      // 图片连图片是图生图：目标模型得收参考图，而且还没连满。
      if (source.type === 'image' && target.type === 'image') {
        const used = all.filter((edge) => edge.target === target.id && (edge.data as unknown as LinkData)?.kind === 'image').length;
        if (used >= imageRefLimit((target.data as { model?: string }).model)) return false;
      }
      // 视频可以连视频，所以要防着连成一圈：从目标往下游走，走得回起点就不让连。
      const seen = new Set<string>();
      const stack = [target.id];
      while (stack.length) {
        const next = stack.pop()!;
        if (next === source.id) return false;
        if (seen.has(next)) continue;
        seen.add(next);
        for (const edge of all) if (edge.source === next) stack.push(edge.target);
      }
      return true;
    },
    [flow],
  );

  const onConnect = useCallback(
    (link: Connection) => {
      const source = flow.getNode(link.source);
      const target = flow.getNode(link.target);
      if (!source || !target) return;
      snap();
      setEdges((items) => [...items, makeEdge(source, target)]);
    },
    [flow, setEdges, snap],
  );

  // 问要在一个节点的哪一侧接一个什么节点，建好并连上。右边的加号接的是下游，左边的加号接的是上游。
  const extend = useCallback(
    (nodeId: string, downstream: boolean, x: number, y: number, beside = false) => {
      const node = flow.getNode(nodeId);
      if (!node) return;
      // beside：新节点和这个节点顶边对齐，隔开一段摆在左边或右边；那里有节点了就往下错开。
      let place: { x: number; y: number } | undefined;
      if (beside) {
        place = { x: downstream ? node.position.x + (node.measured?.width || 320) + 140 : node.position.x - 430 - 140, y: node.position.y };
        while (flow.getNodes().some((n) => Math.abs(n.position.x - place!.x) < 300 && Math.abs(n.position.y - place!.y) < 200)) place.y += 280;
      }
      // 图片接图片是图生图：下游是新建的图片节点，看默认模型收不收参考图；上游看这个节点的模型还收不收。
      const imageOk = downstream
        ? imageRefLimit(newNodeData('image', { form: composer.form, image: composer.studio.image, speech: composer.studio.speech }).model as string) > 0
        : flow.getEdges().filter((edge) => edge.target === node.id && (edge.data as unknown as LinkData)?.kind === 'image').length < imageRefLimit((node.data as { model?: string }).model);
      const kinds = (downstream ? targetsOf(node.type as NodeKind) : sourcesOf(node.type as NodeKind)).filter((kind) => !(kind === 'image' && node.type === 'image' && !imageOk));
      // 选中了好几个节点、从其中一个的右边接出去：新节点把选中的这些一起接上。
      const also = downstream && node.selected ? flow.getNodes().filter((n) => n.selected && n.id !== node.id) : [];
      menuAt(x, y, kinds, downstream ? { from: node, also } : { to: node }, place);
    },
    [flow, menuAt],
  );

  // 从节点的加号拉出一条线、松在空白处。
  const onConnectEnd = useCallback<OnConnectEnd>(
    (event, link) => {
      if (link.isValid || link.toNode || !link.fromNode) return;
      const point = 'changedTouches' in event ? event.changedTouches[0] : event;
      extend(link.fromNode.id, link.fromHandle?.type === 'source', point.clientX, point.clientY);
    },
    [extend],
  );

  // 点项目名旁边的箭头：列出别的画布，点一个就先存好当前的再换过去；最下面是新建。
  async function switchCanvas(button: HTMLElement) {
    let list: { id: string; name: string }[] = [];
    try {
      list = (await api<{ items: { id: string; name: string }[] }>('GET', '/api/canvases')).items;
    } catch (err) {
      return toast(`项目列表读不出来：${(err as Error).message}`, 'error', 6000);
    }
    openMenu(button, {
      label: '切换画布',
      items: [...list.map((item) => ({ value: item.id, label: item.id === id ? name || item.name : item.name, selected: item.id === id })), { value: 'new', label: '新建画布', selected: false }],
      onSelect: async (value) => {
        await flush();
        try {
          const next = value === 'new' ? (await api<{ id: string }>('POST', '/api/canvases', {})).id : value;
          location.hash = canvasPath(next);
        } catch (err) {
          toast((err as Error).message, 'error', 6000);
        }
      },
    });
  }

  function openZoom(button: HTMLElement) {
    const actions: Record<string, () => void> = { in: () => flow.zoomIn(), out: () => flow.zoomOut(), fit: () => flow.fitView({ maxZoom: 1, padding: 0.2 }), full: () => flow.zoomTo(1) };
    openMenu(button, {
      label: '缩放',
      items: [
        { value: 'in', label: '放大', note: '⌘ +' },
        { value: 'out', label: '缩小', note: '⌘ −' },
        { value: 'fit', label: '适应内容' },
        { value: 'full', label: '100%' },
      ],
      onSelect: (value) => actions[value](),
    });
  }

  const actions = useMemo(() => ({ snap, addInput, ungroup, saveWorkflow, unstack }), [snap, addInput, ungroup, saveWorkflow, unstack]);
  const shown = useMemo(() => framed(nodes), [nodes]);
  // 每种颜色标了哪些节点。收在一叠里的不算。
  const pinned = useMemo(() => {
    const by = Object.fromEntries(PINS.map((pin) => [pin, [] as Node[]])) as Record<Pin, Node[]>;
    for (const node of nodes) if (!node.hidden) for (const pin of (node.data.pin as Pin[] | undefined) || []) by[pin]?.push(node);
    return by;
  }, [nodes]);
  const hasLibrary = state.app.features.library || state.app.features.persons;

  return (
    <CanvasActions.Provider value={actions}>
      <div
        ref={wrap}
        className={`canvas ${hand ? 'is-hand' : ''}`}
        // 节点的名字和加号要在屏幕上保持大小不变，样式里用这个倒数把画布的缩放抵消掉。
        // 50% 以下不再抵消：名字和加号跟着画布一起缩小，不然会比节点本身还大。
        // --ring、--ring-gap 是选中那圈线的粗细和间隔（画布坐标）：屏幕上 100% 时是 1.5 和 3，缩小时收到 1 和 1 为止。
        style={{ '--inv': inv, '--zoom': 1 / inv, '--ring': `${Math.min(1.5, Math.max(1, 1.5 * zoom)) / zoom}px`, '--ring-gap': `${Math.min(3, Math.max(1, 3 * zoom)) / zoom}px` } as CSSProperties}
        onDoubleClick={(e) => (e.target as Element).classList.contains('react-flow__pane') && menuAt(e.clientX, e.clientY, KINDS)}
        onClick={(e) => {
          // 直接点一下加号（没有拖动）：菜单出在加号外侧。
          const port = (e.target as Element).closest<HTMLElement>('.cnode-port');
          if (!port?.dataset.nodeid) return;
          const box = port.getBoundingClientRect();
          const downstream = port.classList.contains('source');
          extend(port.dataset.nodeid, downstream, downstream ? box.right + 8 : box.left - 8, box.top, true);
        }}
        onPointerMove={(e) => (pointer.current = { x: e.clientX, y: e.clientY })}
        onPointerLeave={() => (pointer.current = null)}
        onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          const at = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
          [...e.dataTransfer.files].forEach((dropped, index) => upload(dropped, { x: at.x + index * 400, y: at.y }));
        }}
      >
        <ReactFlow
          nodes={shown}
          // 选中的节点不自动提到最上面：分组的框要一直垫在成员下面。
          elevateNodesOnSelect={false}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={changeNodes}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onConnectEnd={onConnectEnd}
          isValidConnection={isValidConnection}
          onNodeDragStart={snap}
          onNodeDragStop={() => setGuides([])}
          connectionLineComponent={DragLine}
          onBeforeDelete={async ({ nodes: gone, edges: cut }) => {
            snap();
            // 删掉一叠，里面的节点和它们的连线一起删。
            const inside = new Set(gone.filter(isStack).flatMap(membersOf));
            if (!inside.size) return true;
            const have = new Set(cut.map((edge) => edge.id));
            return { nodes: [...gone, ...flow.getNodes().filter((node) => inside.has(node.id))], edges: [...cut, ...flow.getEdges().filter((edge) => !have.has(edge.id) && (inside.has(edge.source) || inside.has(edge.target)))] };
          }}
          onMoveEnd={() => setMoved((n) => n + 1)}
          onPaneContextMenu={(e) => {
            e.preventDefault();
            paneMenu(e.clientX, e.clientY);
          }}
          onNodeContextMenu={(e, node) => {
            // 输入面板、文本框里的右键留给浏览器（粘贴、拼写这些）。
            if ((e.target as Element).closest('input, textarea, .cnode-panel')) return;
            e.preventDefault();
            nodeMenu(e.clientX, e.clientY, node);
          }}
          onSelectionContextMenu={(e) => {
            e.preventDefault();
            nodeMenu(e.clientX, e.clientY);
          }}
          minZoom={0.1}
          maxZoom={2}
          deleteKeyCode={['Backspace', 'Delete']}
          zoomOnDoubleClick={false}
          connectOnClick={false}
          panOnScroll
          selectionOnDrag={!hand}
          nodesDraggable={!hand}
          elementsSelectable={!hand}
          panOnDrag={hand ? true : [1, 2]}
          selectionMode={SelectionMode.Partial}
          // 按住 Shift 或 ⌘ 点击是多选。在空白处拖动本来就是框选，不需要再按 Shift。
          multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
          selectionKeyCode={null}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} />
          {guides.length > 0 && (
            <ViewportPortal>
              <svg className="canvas-guides" aria-hidden="true">
                {guides.map((line, index) => (
                  <line key={index} {...line} />
                ))}
              </svg>
            </ViewportPortal>
          )}
          {showMap && <MiniMap pannable zoomable position="bottom-left" style={{ width: 168, height: 112 }} />}
          {finding && (
            <Panel position="top-center" className="canvas-find">
              <Finder nodes={nodes.filter((node) => !isGroup(node) && !isStack(node) && !node.hidden)} onJump={jumpTo} onClose={() => setFinding(false)} />
            </Panel>
          )}
          <Panel position="top-left" className="canvas-title">
            <button className="icon-btn" type="button" {...tip('返回项目列表')} aria-label="返回项目列表" onClick={exit}>
              <Icon name="arrowLeft" />
            </button>
            <input className="canvas-name" value={name} aria-label="项目名称" maxLength={60} spellCheck={false} onChange={(e) => setName(e.target.value)} onBlur={() => !name.trim() && setName('未命名画布')} />
            <button className="icon-btn canvas-switch" type="button" {...tip('切换画布')} aria-label="切换画布" aria-haspopup="listbox" aria-expanded="false" onClick={(e) => switchCanvas(e.currentTarget)}>
              <Icon name="chevron" size={14} />
            </button>
            {PINS.filter((pin) => pinned[pin].length).map((pin) => (
              <button
                key={pin}
                className="canvas-pin"
                type="button"
                {...tip(`${PIN_LABELS[pin]}标记的节点`)}
                aria-label={`${PIN_LABELS[pin]}标记：${pinned[pin].length} 个节点`}
                aria-haspopup="menu"
                aria-expanded="false"
                onClick={(e) => openMenu(e.currentTarget, { label: `${PIN_LABELS[pin]}标记`, items: pinned[pin].map((node) => ({ value: node.id, label: `${NODE_LABELS[node.type as NodeKind]}${node.data.no ? ` ${node.data.no}` : ''}`, note: String(node.data.prompt || node.data.text || '').slice(0, 14) })), onSelect: jumpTo })}
              >
                <span className={`cpin is-${pin}`} />
                {pinned[pin].length}
              </button>
            ))}
            {saving === 'failed' ? (
              <button className="canvas-saved is-failed" type="button" onClick={flush}>
                没存上，点这里重试
              </button>
            ) : (
              <span className="canvas-saved" role="status">
                {saving === 'saving' ? '保存中…' : '已保存'}
              </span>
            )}
          </Panel>
          <Panel position="center-left" className="canvas-tools">
            {KINDS.map((kind) => (
              <button key={kind} className="icon-btn" type="button" aria-label={`添加${NODE_LABELS[kind]}节点`} onClick={() => addNode(kind)}>
                <Icon name={NODE_ICONS[kind]} size={18} />
                <span className="canvas-tool-name">{NODE_LABELS[kind]}</span>
              </button>
            ))}
            <span className="canvas-tools-split" />
            {hasLibrary && (
              <button className="icon-btn" type="button" aria-label="从素材库添加" aria-haspopup="menu" aria-expanded="false" onClick={(e) => pickFromLibrary(e.currentTarget)}>
                <Icon name="folder" size={18} />
                <span className="canvas-tool-name">素材库</span>
              </button>
            )}
            <button className="icon-btn" type="button" aria-label="上传图片、视频或音频" onClick={() => file.current!.click()}>
              <Icon name="upload" size={18} />
              <span className="canvas-tool-name">上传</span>
            </button>
            <button className="icon-btn" type="button" aria-label="生成历史" aria-haspopup="dialog" aria-expanded="false" onClick={(e) => openBeside(e.currentTarget, <HistoryPicker onPick={restore} />, '生成历史')}>
              <Icon name="history" size={18} />
              <span className="canvas-tool-name">生成历史</span>
            </button>
            <button className="icon-btn" type="button" aria-label="工作流" aria-haspopup="dialog" aria-expanded="false" onClick={(e) => openBeside(e.currentTarget, <WorkflowPicker onPick={applyWorkflow} />, '工作流')}>
              <Icon name="workflow" size={18} />
              <span className="canvas-tool-name">工作流</span>
            </button>
            <button className={`icon-btn ${finding ? 'active' : ''}`} type="button" aria-label="搜索节点" aria-pressed={finding} onClick={() => setFinding((on) => !on)}>
              <Icon name="search" size={18} />
              <span className="canvas-tool-name">搜索节点</span>
            </button>
          </Panel>
          <Panel position="bottom-left" className="canvas-foot">
            <button className="icon-btn" type="button" {...tip('撤销（⌘ Z）')} aria-label="撤销" disabled={!past.current.length} onClick={undo}>
              <Icon name="undo" />
            </button>
            <button className="icon-btn" type="button" {...tip('重做（⇧ ⌘ Z）')} aria-label="重做" disabled={!future.current.length} onClick={redo}>
              <Icon name="redo" />
            </button>
            <button className={`icon-btn ${hand ? 'active' : ''}`} type="button" {...tip(hand ? '抓手：拖动是平移画布。再点一下或按 V 回到选择' : '抓手（H）')} aria-label="抓手" aria-pressed={hand} onClick={() => setHand((on) => !on)}>
              <Icon name="hand" />
            </button>
            <button className="icon-btn" type="button" {...tip('整理节点')} aria-label="整理节点" disabled={nodes.length < 2} onClick={arrange}>
              <Icon name="grid" />
            </button>
            <button className={`icon-btn ${showMap ? 'active' : ''}`} type="button" {...tip('小地图')} aria-label="小地图" aria-pressed={showMap} onClick={() => setShowMap((on) => !on)}>
              <Icon name="map" />
            </button>
            <button className="canvas-zoom" type="button" aria-label={`缩放：${Math.round(zoom * 100)}%`} aria-haspopup="menu" aria-expanded="false" onClick={(e) => openZoom(e.currentTarget)}>
              {Math.round(zoom * 100)}%
            </button>
          </Panel>
        </ReactFlow>
        {ready && !nodes.length && (
          <div className="canvas-empty">
            <span>双击画布</span>
            <span className="brand-mark" aria-hidden="true" />
            <span>创建节点</span>
          </div>
        )}
        <input
          ref={file}
          type="file"
          accept={UPLOAD_ACCEPT}
          multiple
          hidden
          onChange={(e) => {
            const at = dropAt.current;
            dropAt.current = undefined;
            [...(e.target.files || [])].forEach((picked, index) => upload(picked, at && { x: at.x + index * 400, y: at.y }));
            e.target.value = '';
          }}
        />
        <span ref={anchor} className="canvas-anchor" />
      </div>
    </CanvasActions.Provider>
  );
}

export default function Canvas(props: { id: string; onExit: () => void }) {
  return (
    <ReactFlowProvider>
      <Board {...props} />
    </ReactFlowProvider>
  );
}
