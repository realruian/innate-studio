// 盖在页面上面的几样东西：提示条、提示气泡、浮层（下拉菜单和气泡面板）、弹窗。
// 打开和关闭都是普通函数（openMenu、openModal、toast…），哪里都能调；画出来由 <LayerHosts /> 负责。

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon.tsx';
import { enter, leave } from './motion.ts';

// 一个能被订阅的列表：打开、关闭就是往里加、往外拿。
function createList<T>() {
  let items: T[] = [];
  const subscribers = new Set<() => void>();
  return {
    get: () => items,
    set(next: T[]) {
      items = next;
      subscribers.forEach((fn) => fn());
    },
    subscribe(fn: () => void) {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
  };
}

function useList<T>(list: ReturnType<typeof createList<T>>) {
  return useSyncExternalStore(list.subscribe, list.get);
}

let nextId = 1;

// ---------- 提示条 ----------

type ToastType = 'info' | 'success' | 'error';
const toasts = createList<{ id: number; message: string; type: ToastType; leaving: boolean }>();

export function toast(message: string, type: ToastType = 'info', ms = 3600) {
  const id = nextId++;
  toasts.set([...toasts.get(), { id, message, type, leaving: false }]);
  setTimeout(() => {
    toasts.set(toasts.get().map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    setTimeout(() => toasts.set(toasts.get().filter((t) => t.id !== id)), 220);
  }, ms);
}

function ToastView({ message, type, leaving }: { message: string; type: ToastType; leaving: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    enter(ref.current, { y: 8, duration: 200 });
  }, []);
  return (
    <div ref={ref} className={`toast toast-${type}${leaving ? ' leaving' : ''}`} role="status">
      {message}
    </div>
  );
}

function ToastHost() {
  return useList(toasts).map((t) => <ToastView key={t.id} {...t} />);
}

export async function copyText(text: string, okMessage = '已复制') {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMessage, 'success', 1800);
  } catch {
    toast('复制失败，请手动选中复制', 'error');
  }
}

// ---------- 提示气泡 ----------
// 代替浏览器的原生 title 提示：鼠标在带 data-tip 的元素上停留半秒后，在它旁边显示一行说明。
// 带 data-tip-clipped 的只在文字被截断时才显示完整内容。

function TooltipHost() {
  const [tip, setTip] = useState<{ target: HTMLElement; text: string } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let timer = 0;
    let target: HTMLElement | null = null;
    const hide = () => {
      clearTimeout(timer);
      target = null;
      setTip(null);
    };
    const show = (el: HTMLElement) => {
      if (!el.isConnected) return;
      const clipped = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
      if (el.dataset.tipClipped && !clipped) return;
      setTip({ target: el, text: el.dataset.tip || '' });
    };
    const onOver = (e: MouseEvent) => {
      const next = (e.target as Element).closest?.<HTMLElement>('[data-tip]') ?? null;
      if (next === target) return;
      hide();
      if (!next) return;
      target = next;
      timer = window.setTimeout(() => show(next), 500);
    };
    const onOut = (e: MouseEvent) => {
      if (target && !target.contains(e.relatedTarget as Node | null)) hide();
    };
    document.addEventListener('mouseover', onOver);
    document.addEventListener('mouseout', onOut);
    document.addEventListener('mousedown', hide, true);
    document.addEventListener('keydown', hide, true);
    document.addEventListener('scroll', hide, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mouseover', onOver);
      document.removeEventListener('mouseout', onOut);
      document.removeEventListener('mousedown', hide, true);
      document.removeEventListener('keydown', hide, true);
      document.removeEventListener('scroll', hide, true);
    };
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !tip) return;
    const a = tip.target.getBoundingClientRect();
    const left = Math.max(8, Math.min(a.left + a.width / 2 - el.offsetWidth / 2, window.innerWidth - el.offsetWidth - 8));
    const below = a.bottom + 6;
    const top = below + el.offsetHeight > window.innerHeight - 8 ? a.top - 6 - el.offsetHeight : below;
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    enter(el, { y: 0, scale: 0.97, duration: 120 });
  }, [tip]);

  return tip ? (
    <div ref={ref} className="tooltip" role="tooltip">
      {tip.text}
    </div>
  ) : null;
}

// ---------- 浮层：下拉菜单和气泡面板共用 ----------
// 浮层贴着触发它的按钮显示，不占页面的位置，所以打开时不会把别的内容挤走。

export interface LayerHandle {
  close: (options?: { restoreFocus?: boolean }) => void;
}

interface Layer extends LayerHandle {
  id: number;
  anchor: HTMLElement;
  el: HTMLElement | null;
  content: ReactNode;
  className: string;
  label?: string;
  align: 'start' | 'end';
  minWidth?: number;
  menu: boolean;
}

interface PopoverOptions {
  className?: string;
  label?: string;
  onClose?: () => void;
  align?: 'start' | 'end';
  minWidth?: number;
  menu?: boolean;
}

const layers = createList<Layer>();
let lastLayerEscape = -1;

// 再点一次同一个按钮是收起，这时返回 null。
export function openPopover(anchor: HTMLElement, content: ReactNode, { className = '', label, onClose, align = 'start', minWidth, menu = false }: PopoverOptions = {}): LayerHandle | null {
  const opened = layers.get().find((l) => l.anchor === anchor);
  if (opened) {
    opened.close();
    return null;
  }
  const layer: Layer = {
    id: nextId++,
    anchor,
    el: null,
    content,
    className,
    label,
    align,
    minWidth,
    menu,
    close({ restoreFocus = false } = {}) {
      const index = layers.get().indexOf(layer);
      if (index === -1) return;
      // 从它里面打开的浮层（比如面板里的下拉菜单）先关。
      for (const child of layers.get().slice(index + 1).reverse()) child.close();
      layers.set(layers.get().filter((l) => l !== layer));
      anchor.setAttribute('aria-expanded', 'false');
      if (restoreFocus && anchor.isConnected) anchor.focus();
      onClose?.();
    },
  };
  layers.set([...layers.get(), layer]);
  anchor.setAttribute('aria-expanded', 'true');
  return layer;
}

// 点在浮层外面：从最上层开始逐个关闭，直到遇到包含点击位置的那一层。
// 点在触发按钮上不处理，交给按钮自己的点击逻辑去收起。
document.addEventListener(
  'mousedown',
  (e) => {
    const target = e.target as Node;
    for (const layer of [...layers.get()].reverse()) {
      if (layer.el?.contains(target) || layer.anchor.contains(target)) return;
      layer.close();
    }
  },
  true,
);

document.addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'Escape' || !layers.get().length) return;
    lastLayerEscape = e.timeStamp;
    layers.get().at(-1)!.close({ restoreFocus: true });
  },
  true,
);

// 触发它的按钮已经不在页面上了（比如所在的弹窗关了），浮层也就不该留着。
function closeOrphanLayers() {
  for (const layer of [...layers.get()]) if (!layer.anchor.isConnected) layer.close();
}

function PopoverView({ layer }: { layer: Layer }) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current!;
    const { anchor } = layer;
    layer.el = el;

    // 优先放在按钮下方；下方放不下而上方更宽裕时放到上方；都不够就限制高度让它自己滚动。
    const place = () => {
      if (!anchor.isConnected) {
        layer.close();
        return;
      }
      const a = anchor.getBoundingClientRect();
      const margin = 8;
      const gap = 6;
      el.style.maxHeight = '';
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      const below = window.innerHeight - a.bottom - gap - margin;
      const above = a.top - gap - margin;
      // align 为 end 时浮层的右边和按钮的右边对齐，用在贴着右边缘的按钮上。
      const wanted = layer.align === 'end' ? a.right - width : a.left;
      const left = Math.max(margin, Math.min(wanted, window.innerWidth - width - margin));
      let top;
      if (height <= below || below >= above) {
        top = a.bottom + gap;
        el.style.maxHeight = `${Math.max(140, below)}px`;
      } else {
        el.style.maxHeight = `${above}px`;
        top = a.top - gap - Math.min(height, above);
      }
      el.style.left = `${Math.round(left)}px`;
      el.style.top = `${Math.round(top)}px`;
      // 出现时从贴着按钮的那个角长出来。
      el.style.transformOrigin = `${top < a.top ? 'bottom' : 'top'} ${layer.align === 'end' ? 'right' : 'left'}`;
    };

    const onScroll = (e: Event) => {
      if (!el.contains(e.target as Node)) place();
    };
    // 里面的内容变了、大小跟着变时重新摆一次位置。
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    });
    observer.observe(el);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    place();
    enter(el, { y: 0, scale: 0.96, duration: 150 });
    if (layer.menu) el.focus();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [layer]);

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const enabled = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('.menu-item:not(:disabled)')];
    const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
    const start = enabled.find((b) => b.classList.contains('selected')) || enabled[0];
    let next: HTMLButtonElement | undefined;
    if (e.key === 'ArrowDown') next = index === -1 ? start : enabled[(index + 1) % enabled.length];
    else if (e.key === 'ArrowUp') next = index === -1 ? start : enabled[(index - 1 + enabled.length) % enabled.length];
    else if (e.key === 'Home') next = enabled[0];
    else if (e.key === 'End') next = enabled.at(-1);
    else if (e.key === 'Tab') layer.close();
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };

  return (
    <div
      ref={ref}
      className={`popover ${layer.className}`}
      role="dialog"
      aria-label={layer.label}
      tabIndex={-1}
      style={layer.minWidth ? { minWidth: layer.minWidth } : undefined}
      onKeyDown={layer.menu ? onMenuKey : undefined}
    >
      {layer.content}
    </div>
  );
}

function PopoverHost() {
  return useList(layers).map((layer) => <PopoverView key={layer.id} layer={layer} />);
}

export interface MenuItem {
  value: string;
  label: string;
  note?: string;
  disabled?: boolean;
  selected?: boolean;
  title?: string | null;
  danger?: boolean;
}

interface MenuOptions {
  label: string;
  items: MenuItem[];
  onSelect: (value: string) => void;
  onClose?: () => void;
  align?: 'start' | 'end';
}

// 下拉菜单。两种用法：选一个值（每项带 selected，当前项打勾，顶部显示标题），
// 或者一组动作（各项都不带 selected，不显示标题和打勾的位置）。
export function openMenu(anchor: HTMLElement, { label, items, onSelect, onClose, align }: MenuOptions): LayerHandle | null {
  const picking = items.some((item) => 'selected' in item);
  const layer = openPopover(
    anchor,
    <>
      {picking && label && <div className="menu-title">{label}</div>}
      <div className="menu-list" role={picking ? 'listbox' : 'menu'} aria-label={label}>
        {items.map((item) => (
          <button
            key={item.value}
            type="button"
            className={`menu-item ${item.selected ? 'selected' : ''} ${item.danger ? 'danger' : ''}`}
            role={picking ? 'option' : 'menuitem'}
            aria-selected={picking ? Boolean(item.selected) : undefined}
            disabled={item.disabled}
            data-tip={item.title || undefined}
            onClick={() => {
              layer?.close({ restoreFocus: true });
              if (!item.selected) onSelect(item.value);
            }}
          >
            <span className="menu-item-label">{item.label}</span>
            {item.note && <span className="menu-item-note">{item.note}</span>}
            {picking && <span className="menu-item-check">{item.selected && <Icon name="check" size={14} />}</span>}
          </button>
        ))}
      </div>
    </>,
    { className: 'menu', label, onClose, align, menu: true, minWidth: Math.max(picking ? 168 : 128, Math.round(anchor.getBoundingClientRect().width)) },
  );
  return layer;
}

// ---------- 弹窗 ----------

interface Modal {
  id: number;
  title: string;
  subtitle?: string;
  content: ReactNode;
  size: 'sm' | 'md' | 'lg' | 'detail';
  // 遮罩的节点。关闭时在它上面播出场动效。
  el: HTMLElement | null;
  // 已经在关了，只是出场动效还没播完。
  leaving: boolean;
  close: () => void;
}

const modals = createList<Modal>();

// 打开弹窗，返回 { close }。点遮罩或按 Esc 关闭。
export function openModal({ title, subtitle, content, size = 'md', onClose }: { title: string; subtitle?: string; content: ReactNode; size?: Modal['size']; onClose?: () => void }) {
  const modal: Modal = {
    id: nextId++,
    title,
    subtitle,
    content,
    size,
    el: null,
    leaving: false,
    close() {
      if (modal.leaving || !modals.get().includes(modal)) return;
      modal.leaving = true;
      // 从它里面打开的菜单跟着关掉。
      for (const layer of [...layers.get()]) if (modal.el?.contains(layer.anchor)) layer.close();
      const remove = () => {
        modals.set(modals.get().filter((m) => m !== modal));
        setTimeout(closeOrphanLayers, 0);
      };
      // 出场比进场短，而且不再挡着下面的点击；调用的地方不用等它播完。
      if (modal.el) {
        modal.el.style.pointerEvents = 'none';
        leave(modal.el.firstElementChild, { scale: 0.98 });
        leave(modal.el).then(remove);
      } else {
        remove();
      }
      onClose?.();
    },
  };
  modals.set([...modals.get(), modal]);
  return { close: modal.close };
}

document.addEventListener('keydown', (e) => {
  // 这次 Esc 已经用来关掉弹窗里的菜单了，就不再关弹窗。
  if (e.key !== 'Escape' || e.timeStamp === lastLayerEscape) return;
  modals.get().findLast((m) => !m.leaving)?.close();
});

function ModalView({ modal }: { modal: Modal }) {
  const overlay = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    modal.el = overlay.current;
    // 遮罩淡入，弹窗从略小、略低的位置到位。
    enter(overlay.current, { y: 0, duration: 160 });
    enter(overlay.current!.firstElementChild, { y: 8, scale: 0.97, duration: 220 });
  }, [modal]);
  return (
    <div ref={overlay} className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && modal.close()}>
      <div className={`modal modal-${modal.size}`} role="dialog" aria-modal="true" aria-label={modal.title}>
        <header className="modal-head">
          <div>
            <h2>{modal.title}</h2>
            {modal.subtitle && <p className="muted small">{modal.subtitle}</p>}
          </div>
          <button className="modal-close" type="button" aria-label="关闭" onClick={modal.close}>
            <Icon name="x" size={16} />
          </button>
        </header>
        <div className="modal-body">{modal.content}</div>
      </div>
    </div>
  );
}

function ModalHost() {
  return useList(modals).map((modal) => <ModalView key={modal.id} modal={modal} />);
}

export function confirmDialog({ title, message, okText = '确定', cancelText = '取消', danger = false }: { title: string; message: string; okText?: string; cancelText?: string; danger?: boolean }) {
  return new Promise<boolean>((resolve) => {
    let answered = false;
    const answer = (value: boolean) => {
      answered = true;
      modal.close();
      resolve(value);
    };
    const modal = openModal({
      title,
      size: 'sm',
      onClose: () => {
        if (!answered) resolve(false);
      },
      content: (
        <>
          <p className="confirm-text">{message}</p>
          <div className="modal-actions">
            <button className="btn" onClick={() => answer(false)}>
              {cancelText}
            </button>
            <button className={danger ? 'btn btn-danger' : 'btn btn-primary'} onClick={() => answer(true)}>
              {okText}
            </button>
          </div>
        </>
      ),
    });
  });
}

// 放在应用最外层：把上面几样东西画进 index.html 里各自的容器。
export function LayerHosts() {
  return (
    <>
      {createPortal(<ModalHost />, document.getElementById('modal-root')!)}
      {createPortal(
        <>
          <PopoverHost />
          <TooltipHost />
        </>,
        document.getElementById('layer-root')!,
      )}
      {createPortal(<ToastHost />, document.getElementById('toast-root')!)}
    </>
  );
}
