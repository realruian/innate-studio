// 一张画布：可以无限平移缩放的桌面，上面摆节点、拉连线。打开时整个窗口都是它，改动之后自动保存。

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Background, BackgroundVariant, MiniMap, Panel, ReactFlow, ReactFlowProvider, SelectionMode, ViewportPortal, useEdgesState, useNodesState, useReactFlow, useViewport, type Connection, type Edge, type Node, type NodeChange, type OnConnectEnd, type Viewport } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api, state, useStore, KINDS as MEDIA } from '../store.ts';
import { composer, imageRefLimit, traits } from '../composer/state.ts';
import { kindOfFile, uploadLocalFile } from '../media.ts';
import { openAssetPicker } from '../assets.tsx';
import { Icon } from '../ui/Icon.tsx';
import { tip } from '../ui/controls.tsx';
import { openMenu, toast } from '../ui/layers.tsx';
import { reducedMotion } from '../ui/motion.ts';
import type { Kind } from '../types.ts';
import { BOX_HEIGHT, NODE_LABELS, TITLE_ROOM, canLink, clipOf, nodeWidth, numbered, pasteClip, snapTo, sourcesOf, stripNodeData, targetsOf, tidy, type Clip, type Guide, type LinkData, type NodeKind, type Rect } from './model.ts';
import { coverOf, newNodeData } from './run.ts';
import { AudioNode, CanvasActions, DragLine, ImageNode, LinkEdge, NODE_ICONS, TextNode, VideoNode } from './nodes.tsx';

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

const nodeTypes = { text: TextNode, image: ImageNode, video: VideoNode, audio: AudioNode };
const edgeTypes = { link: LinkEdge };
const KINDS: NodeKind[] = ['text', 'image', 'video', 'audio'];
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
const boxOf = (node: Node, position = node.position): Rect => ({ x: position.x, y: position.y + TITLE_ROOM, width: node.measured?.width || nodeWidth(node.type as NodeKind, node.data), height: BOX_HEIGHT });

// 存进画布的只有节点的位置和内容、连线的两头和用途；选中状态、量出来的尺寸这些不存。
const savedNodes = (nodes: Node[]) => nodes.map(({ id, type, position, data }) => ({ id, type, position, data: stripNodeData(data) }));
const savedEdges = (edges: Edge[]) => edges.map(({ id, source, target, data }) => ({ id, source, target, type: 'link', data }));

function makeEdge(source: Node, target: Node): Edge {
  const data: LinkData = { kind: source.type as NodeKind };
  // 图片连到视频默认当参考图；目标模型不支持参考生成（Grok）时当首帧。连到图片的都是参考图，不分用途。
  if (data.kind === 'image' && target.type === 'video') data.role = traits((target.data as { model?: string }).model).reference ? 'reference' : 'first';
  return { id: crypto.randomUUID(), source: source.id, target: target.id, type: 'link', data: data as unknown as Record<string, unknown> };
}

function Board({ id, onExit }: { id: string; onExit: () => void }) {
  const flow = useReactFlow();
  const { zoom } = useViewport();
  // 名字、加号这些在屏幕上大小不变，靠这个倒数把画布的缩放抵消掉；最多放大到 2 倍。
  const inv = Math.min(1 / zoom, 2);
  const [ready, setReady] = useState(false);
  const [name, setName] = useState('');
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [moved, setMoved] = useState(0);
  const [showMap, setShowMap] = useState(false);
  const [guides, setGuides] = useState<Guide[]>([]);
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
    } catch (err) {
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
    (kind: NodeKind, at?: { x: number; y: number }, link?: { from?: Node; to?: Node }, extra?: Record<string, unknown>) => {
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
      if (link?.from) setEdges((items) => [...items, makeEdge(link.from!, node)]);
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
    (x: number, y: number, kinds: NodeKind[], link?: { from?: Node; to?: Node }, place?: { x: number; y: number }) => {
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
      if (kind !== 'image' && kind !== 'video') return toast('画布上只能上传图片和视频', 'info');
      toast(`正在上传${MEDIA[kind].label}…`, 'info', 1800);
      try {
        const ref = await uploadLocalFile(picked, kind);
        addNode(kind, at, undefined, { upload: { url: ref.url, name: ref.name } });
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

  // ---------- 对齐 ----------

  // 拖着一个节点靠近别的节点时，把它吸到对方的边线或中线上，并画出参考线。一次拖着好几个时不吸。
  const changeNodes = useCallback(
    (changes: NodeChange<Node>[]) => {
      // 松手时还会来最后一次位置（不带 dragging），它也要吸，不然一松手节点又弹回没对齐的地方。
      const moves = changes.filter((change) => change.type === 'position' && change.position && (change.dragging || change.id === snapping.current));
      const move = moves.length === 1 ? moves[0] : null;
      const me = move?.type === 'position' ? flow.getNode(move.id) : undefined;
      if (move?.type === 'position' && move.position && me) {
        snapping.current = move.dragging ? move.id : '';
        const others = flow.getNodes().filter((node) => node.id !== me.id).map((node) => boxOf(node));
        const snapped = snapTo(boxOf(me, move.position), others, SNAP_REACH / flow.getZoom());
        move.position = { x: move.position.x + snapped.dx, y: move.position.y + snapped.dy };
        setGuides(snapped.guides);
      } else if (changes.some((change) => change.type === 'position')) setGuides((now) => (now.length ? [] : now));
      onNodesChange(changes);
    },
    [flow, onNodesChange],
  );

  // 一键整理：框选了两个以上就只整理它们，否则整理整张画布。
  const arrange = useCallback(() => {
    const all = flow.getNodes();
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
    const picked = flow.getNodes().filter((node) => node.selected);
    return picked.length ? clipOf(savedNodes(picked), savedEdges(flow.getEdges())) : null;
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
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || !mine(e)) return;
      const key = e.key.toLowerCase();
      if (key === 'd') {
        e.preventDefault();
        duplicate();
      } else if (key === 'a') {
        e.preventDefault();
        setNodes((items) => items.map((n) => (n.selected ? n : { ...n, selected: true })));
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
  }, [addNode, duplicate, flow, pasteSpot, place, selection, setNodes, upload]);

  // ---------- 右键菜单 ----------

  // 在空白处点右键：加节点、上传、粘贴。
  function paneMenu(x: number, y: number) {
    const el = anchor.current!;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    const at = flow.screenToFlowPosition({ x, y });
    openMenu(el, {
      label: '画布',
      items: [...KINDS.map((kind) => ({ value: kind, label: `${NODE_LABELS[kind]}节点` })), { value: 'upload', label: '上传图片或视频' }, ...(copied ? [{ value: 'paste', label: '粘贴', note: '⌘ V' }] : []), ...(flow.getNodes().length ? [{ value: 'all', label: '全选', note: '⌘ A' }] : [])],
      onSelect: (value) => {
        if (value === 'upload') {
          dropAt.current = at;
          file.current!.click();
        } else if (value === 'paste') place(copied!, { at });
        else if (value === 'all') setNodes((items) => items.map((n) => (n.selected ? n : { ...n, selected: true })));
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
    openMenu(el, {
      label: '节点',
      items: [
        { value: 'duplicate', label: '创建副本', note: '⌘ D' },
        { value: 'delete', label: '删除', note: '⌫', danger: true },
      ],
      onSelect: (value) => {
        if (value === 'duplicate') duplicate();
        else flow.deleteElements({ nodes: flow.getNodes().filter((n) => n.selected) });
      },
    });
  }

  const isValidConnection = useCallback(
    (link: Connection | Edge) => {
      const source = flow.getNode(link.source);
      const target = flow.getNode(link.target);
      if (!source || !target || source.id === target.id) return false;
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
      menuAt(x, y, kinds, downstream ? { from: node } : { to: node }, place);
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

  function openZoom(button: HTMLElement) {
    const actions: Record<string, () => void> = { in: () => flow.zoomIn(), out: () => flow.zoomOut(), fit: () => flow.fitView({ maxZoom: 1, padding: 0.2 }), full: () => flow.zoomTo(1) };
    openMenu(button, {
      label: '缩放',
      items: [
        { value: 'in', label: '放大' },
        { value: 'out', label: '缩小' },
        { value: 'fit', label: '适应内容' },
        { value: 'full', label: '100%' },
      ],
      onSelect: (value) => actions[value](),
    });
  }

  const actions = useMemo(() => ({ snap, addInput }), [snap, addInput]);
  const hasLibrary = state.app.features.library || state.app.features.persons;

  return (
    <CanvasActions.Provider value={actions}>
      <div
        ref={wrap}
        className="canvas"
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
          nodes={nodes}
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
          onBeforeDelete={async () => {
            snap();
            return true;
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
          selectionOnDrag
          panOnDrag={[1, 2]}
          selectionMode={SelectionMode.Partial}
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
          <Panel position="top-left" className="canvas-title">
            <button className="icon-btn" type="button" {...tip('返回项目列表')} aria-label="返回项目列表" onClick={exit}>
              <Icon name="arrowLeft" />
            </button>
            <input className="canvas-name" value={name} aria-label="项目名称" maxLength={60} spellCheck={false} onChange={(e) => setName(e.target.value)} onBlur={() => !name.trim() && setName('未命名画布')} />
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
            <button className="icon-btn" type="button" aria-label="上传图片或视频" onClick={() => file.current!.click()}>
              <Icon name="upload" size={18} />
              <span className="canvas-tool-name">上传</span>
            </button>
          </Panel>
          <Panel position="bottom-left" className="canvas-foot">
            <button className="icon-btn" type="button" {...tip('撤销（⌘ Z）')} aria-label="撤销" disabled={!past.current.length} onClick={undo}>
              <Icon name="undo" />
            </button>
            <button className="icon-btn" type="button" {...tip('重做（⇧ ⌘ Z）')} aria-label="重做" disabled={!future.current.length} onClick={redo}>
              <Icon name="redo" />
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
          accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm"
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
