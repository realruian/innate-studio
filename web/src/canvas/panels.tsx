// 浮在画布上的两块：节点搜索，和从生成历史里把结果放回画布。

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Node } from '@xyflow/react';
import { state, useStore } from '../store.ts';
import { fmtTime } from '../format.ts';
import { Icon } from '../ui/Icon.tsx';
import { Segmented } from '../ui/controls.tsx';
import type { HistoryItem, Kind } from '../types.ts';
import { NODE_LABELS, type NodeKind } from './model.ts';
import { NODE_ICONS } from './nodes.tsx';

// ---------- 节点搜索 ----------

// 一个节点在搜索里显示的名字（图片 1），和能被搜到的字：名字、提示词、文本节点里的内容。
const nameOf = (node: Node) => `${NODE_LABELS[node.type as NodeKind]}${node.data.no ? ` ${node.data.no}` : ''}`;
const wordsOf = (node: Node) => [nameOf(node), node.data.prompt, node.data.text].filter(Boolean).join('\n');

// 结果里每个节点下面那行小字：先给命中的那一段，没有关键词就给提示词或文本的开头。
function excerpt(node: Node, query: string) {
  const body = [node.data.text, node.data.prompt].filter(Boolean).join(' ').replace(/\s+/g, ' ');
  const at = query ? body.toLowerCase().indexOf(query) : -1;
  const from = Math.max(0, at - 12);
  return (from > 0 ? '…' : '') + body.slice(from, from + 60);
}

// 输入关键词，上下键选、回车跳过去。Esc 先清空关键词，再按一次关掉。
export function Finder({ nodes, onJump, onClose }: { nodes: Node[]; onJump: (id: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const word = query.trim().toLowerCase();
  const found = useMemo(() => nodes.filter((node) => !word || wordsOf(node).toLowerCase().includes(word)).slice(0, 50), [nodes, word]);
  const current = Math.min(at, Math.max(0, found.length - 1));

  useEffect(() => {
    input.current?.focus();
  }, []);
  // 新的浏览器里 scrollIntoView 会返回一个 Promise，不能直接当 effect 的返回值（React 会把它当成清理函数去调）。
  useEffect(() => {
    list.current?.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  return (
    <div className="cfind nowheel" role="dialog" aria-label="搜索节点">
      <div className="search-field">
        <Icon name="search" size={16} />
        <input
          ref={input}
          className="input search"
          value={query}
          placeholder="搜索节点的名字、提示词、文本"
          aria-label="搜索节点"
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value);
            setAt(0);
          }}
          onKeyDown={(e) => {
            // 输入法还在拼字的时候，回车和方向键是它的。
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setAt((current + (e.key === 'ArrowDown' ? 1 : found.length - 1)) % Math.max(1, found.length));
            } else if (e.key === 'Enter' && found[current]) {
              onJump(found[current].id);
            } else if (e.key === 'Escape') {
              e.stopPropagation();
              if (query) setQuery('');
              else onClose();
            }
          }}
        />
      </div>
      <div ref={list} className="cfind-list" role="listbox" aria-label="搜索结果">
        {found.map((node, index) => (
          <button key={node.id} type="button" role="option" aria-selected={index === current} className={`cfind-item ${index === current ? 'active' : ''}`} onClick={() => onJump(node.id)} onPointerMove={() => setAt(index)}>
            <Icon name={NODE_ICONS[node.type as NodeKind]} size={16} />
            <span className="cfind-name">{nameOf(node)}</span>
            <span className="cfind-text ellipsis">{excerpt(node, word)}</span>
          </button>
        ))}
        {!found.length && <div className="cfind-empty">{nodes.length ? '没有搜到' : '画布上还没有节点'}</div>}
      </div>
    </div>
  );
}

// ---------- 生成历史 ----------

type Filter = 'all' | Kind;
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
  { value: 'audio', label: '音频' },
];

// 生成过的内容，按时间从新到旧。点一个，它就作为一个新节点回到画布上；原来的记录不动。
export function HistoryPicker({ onPick }: { onPick: (item: HistoryItem) => void }) {
  useStore('history');
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const word = query.trim().toLowerCase();
  const done = state.history.filter((item) => item.status === 'completed' && item.mediaUrl);
  const shown = done.filter((item) => (filter === 'all' || item.kind === filter) && (!word || (item.prompt || '').toLowerCase().includes(word))).slice(0, 120);
  return (
    <div className="popover-body chist">
      <div className="chist-head">
        <Segmented options={FILTERS} value={filter} onChange={setFilter} />
        <div className="search-field">
          <Icon name="search" size={16} />
          <input className="input search" value={query} placeholder="搜提示词" aria-label="搜提示词" spellCheck={false} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </div>
      <div className="chist-grid">
        {shown.map((item) => (
          <button key={item.id} type="button" className={`chist-item is-${item.kind}`} aria-label={`放回画布：${item.prompt || NODE_LABELS[item.kind]}`} onClick={() => onPick(item)}>
            {item.kind === 'image' ? (
              <img src={item.mediaUrl} alt="" loading="lazy" draggable={false} />
            ) : item.kind === 'video' ? (
              <video src={`${item.mediaUrl}#t=0.1`} preload="metadata" muted playsInline tabIndex={-1} />
            ) : (
              <Icon name="music" size={20} />
            )}
            <span className="chist-cap ellipsis">{item.kind === 'audio' ? item.prompt || '音频' : fmtTime(item.completedAt || item.createdAt || 0)}</span>
          </button>
        ))}
        {!shown.length && <div className="cfind-empty">{done.length ? '没有符合的内容' : '还没有生成过内容'}</div>}
      </div>
    </div>
  );
}
