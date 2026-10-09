// 一张画布：可以无限平移缩放的桌面，上面摆节点、拉连线。打开时整个窗口都是它，改动之后自动保存。

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Background, BackgroundVariant, MiniMap, Panel, ReactFlow, ReactFlowProvider, SelectionMode, useEdgesState, useNodesState, useReactFlow, useViewport, type Connection, type Edge, type Node, type OnConnectEnd, type Viewport } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api, state, useStore, KINDS as MEDIA } from '../store.ts';
import { composer, imageRefLimit, traits } from '../composer/state.ts';
import { kindOfFile, uploadLocalFile } from '../media.ts';
import { openAssetPicker } from '../assets.tsx';
import { Icon } from '../ui/Icon.tsx';
import { tip } from '../ui/controls.tsx';
import { openMenu, toast } from '../ui/layers.tsx';
import type { Kind } from '../types.ts';
import { NODE_LABELS, canLink, sourcesOf, stripNodeData, targetsOf, type LinkData, type NodeKind } from './model.ts';
import { coverOf, newNodeData } from './run.ts';
import { AudioNode, CanvasActions, ImageNode, LinkEdge, NODE_ICONS, TextNode, VideoNode } from './nodes.tsx';

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
  const [ready, setReady] = useState(false);
  const [name, setName] = useState('');
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [moved, setMoved] = useState(0);
  const [showMap, setShowMap] = useState(false);
  const [, setUndoDepth] = useState(0);
  // 生成完成之后封面可能要换，所以生成记录变了也要重新算一遍要存的内容。
  const records = useStore('history', 'app');
  const wrap = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const past = useRef<Snap[]>([]);
  const future = useRef<Snap[]>([]);
  const lastSaved = useRef('');
  const pending = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const started = useRef(false);

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
        setNodes(doc.nodes || []);
        setEdges((doc.edges || []).map((edge) => ({ ...edge, type: 'link' })));
        setName(doc.name);
        setReady(true);
        // 等节点画出来再定位：存过视口就回到那里，没存过就把内容放进视野。
        requestAnimationFrame(() => (doc.viewport ? flow.setViewport(doc.viewport) : flow.fitView({ maxZoom: 1, padding: 0.2 })));
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

  // link 是新节点要和哪个节点连上：from 是它的上游，to 是它的下游。extra 是节点一出来就带着的内容：上传的文件，或者从素材库选的素材。
  const addNode = useCallback(
    (kind: NodeKind, at?: { x: number; y: number }, link?: { from?: Node; to?: Node }, extra?: Record<string, unknown>) => {
      snap();
      const box = wrap.current!.getBoundingClientRect();
      // 没指定位置就放在视野中间；那里已经有节点了就往右挪，直到不压着别的节点。
      const position = at || flow.screenToFlowPosition({ x: box.left + box.width / 2 - 160, y: box.top + box.height / 2 - 120 });
      // 节点宽窄不一，按量出来的宽度让开；还没量过的按最宽的算。
      for (let moved = true; !at && moved; ) {
        moved = false;
        for (const n of flow.getNodes()) {
          const width = n.measured?.width || 430;
          if (Math.abs(n.position.y - position.y) < 200 && position.x < n.position.x + width + 60 && position.x + 430 > n.position.x) {
            position.x = n.position.x + width + 80;
            moved = true;
          }
        }
      }
      const data = { ...newNodeData(kind, { form: composer.form, image: composer.studio.image, speech: composer.studio.speech }), ...extra };
      const node: Node = { id: crypto.randomUUID(), type: kind, position, data, selected: true };
      setNodes((items) => [...items.map((n) => (n.selected ? { ...n, selected: false } : n)), node]);
      if (link?.from) setEdges((items) => [...items, makeEdge(link.from!, node)]);
      if (link?.to) setEdges((items) => [...items, makeEdge(node, link.to!)]);
    },
    [flow, setEdges, setNodes, snap],
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
        style={{ '--inv': 1 / zoom } as CSSProperties}
        onDoubleClick={(e) => (e.target as Element).classList.contains('react-flow__pane') && menuAt(e.clientX, e.clientY, KINDS)}
        onClick={(e) => {
          // 直接点一下加号（没有拖动）：菜单出在加号外侧。
          const port = (e.target as Element).closest<HTMLElement>('.cnode-port');
          if (!port?.dataset.nodeid) return;
          const box = port.getBoundingClientRect();
          const downstream = port.classList.contains('source');
          extend(port.dataset.nodeid, downstream, downstream ? box.right + 8 : box.left - 8, box.top, true);
        }}
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
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onConnectEnd={onConnectEnd}
          isValidConnection={isValidConnection}
          onNodeDragStart={snap}
          onBeforeDelete={async () => {
            snap();
            return true;
          }}
          onMoveEnd={() => setMoved((n) => n + 1)}
          minZoom={0.2}
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
            [...(e.target.files || [])].forEach((picked) => upload(picked));
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
