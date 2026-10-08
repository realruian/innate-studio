// 界面基础件：建节点、图标、提示条、弹窗、浮层菜单、表单控件。
// 所有页面都只用这里的控件，不直接用浏览器原生的下拉框、勾选框和折叠标签。

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'html') el.innerHTML = value; // 只用于内置图标这类可信字符串
      else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'selected' || key === 'muted') el[key] = value;
      else if (key === 'title' || key === 'clipTitle') {
        // title：悬停时显示自绘的提示；clipTitle：只在文字被截断时才显示完整内容。
        if (!value) continue;
        el.dataset.tip = value;
        if (key === 'clipTitle') el.dataset.tipClipped = '1';
      } else el.setAttribute(key, value === true ? '' : value);
    }
  }
  append(el, children);
  if (el.dataset.tip && !el.dataset.tipClipped && !el.hasAttribute('aria-label') && !el.textContent.trim()) el.setAttribute('aria-label', el.dataset.tip);
  return el;
}

// 追加子节点：会展开数组，并跳过 null / false。
export function add(el, ...children) {
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  type: '<path d="M5 6h14M12 6v13M9 19h6"/>',
  frames: '<rect x="3" y="6" width="7" height="12" rx="1.5"/><rect x="14" y="6" width="7" height="12" rx="1.5"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  cube: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" stroke="none"/>',
  volume: '<path d="M4 9.5h3l4.5-4v13l-4.5-4H4z" fill="currentColor" stroke="none"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11"/>',
  mute: '<path d="M4 9.5h3l4.5-4v13l-4.5-4H4z" fill="currentColor" stroke="none"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  gear: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
};

export function icon(name, size = 16) {
  return h('span', {
    class: 'icon',
    'aria-hidden': 'true',
    html: `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`,
  });
}

export function toast(message, type = 'info', ms = 3600) {
  const root = document.getElementById('toast-root');
  const el = h('div', { class: `toast toast-${type}`, role: 'status' }, message);
  root.append(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 220);
  }, ms);
}

// ---------- 提示气泡 ----------
// 代替浏览器的原生 title 提示：鼠标停留半秒后在元素旁边显示一行说明。

let tipEl = null;
let tipTimer = 0;
let tipTarget = null;

function hideTip() {
  clearTimeout(tipTimer);
  tipTarget = null;
  tipEl?.remove();
  tipEl = null;
}

function showTip(target) {
  if (!target.isConnected) return;
  const clipped = target.scrollWidth > target.clientWidth + 1 || target.scrollHeight > target.clientHeight + 1;
  if (target.dataset.tipClipped && !clipped) return;
  tipEl = h('div', { class: 'tooltip', role: 'tooltip' }, target.dataset.tip);
  document.getElementById('layer-root').append(tipEl);
  const a = target.getBoundingClientRect();
  const left = Math.max(8, Math.min(a.left + a.width / 2 - tipEl.offsetWidth / 2, window.innerWidth - tipEl.offsetWidth - 8));
  const below = a.bottom + 6;
  const top = below + tipEl.offsetHeight > window.innerHeight - 8 ? a.top - 6 - tipEl.offsetHeight : below;
  tipEl.style.left = `${Math.round(left)}px`;
  tipEl.style.top = `${Math.round(top)}px`;
}

document.addEventListener('mouseover', (e) => {
  const target = e.target.closest?.('[data-tip]');
  if (target === tipTarget) return;
  hideTip();
  if (!target) return;
  tipTarget = target;
  tipTimer = setTimeout(() => showTip(target), 500);
});
document.addEventListener('mouseout', (e) => {
  if (tipTarget && !tipTarget.contains(e.relatedTarget)) hideTip();
});
document.addEventListener('mousedown', hideTip, true);
document.addEventListener('keydown', hideTip, true);
document.addEventListener('scroll', hideTip, true);

// ---------- 浮层：下拉菜单和气泡面板共用 ----------
// 浮层贴着触发它的按钮显示，不占页面的位置，所以打开时不会把别的内容挤走。

const layers = [];
let lastLayerEscape = -1;

export function openPopover(anchor, content, { className = '', label, onClose } = {}) {
  const opened = layers.find((l) => l.anchor === anchor);
  if (opened) {
    opened.close();
    return null;
  }
  const el = h('div', { class: `popover ${className}`, role: 'dialog', 'aria-label': label, tabindex: '-1' }, content);
  document.getElementById('layer-root').append(el);

  // 优先放在按钮下方；下方放不下而上方更宽裕时放到上方；都不够就限制高度让它自己滚动。
  function place() {
    // 触发它的按钮已经不在页面上了（比如那一块被重画），浮层也就不该留着。
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
    const left = Math.max(margin, Math.min(a.left, window.innerWidth - width - margin));
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
  }

  const onScroll = (e) => {
    if (!el.contains(e.target)) place();
  };

  const layer = {
    el,
    anchor,
    place,
    close({ restoreFocus = false } = {}) {
      const index = layers.indexOf(layer);
      if (index === -1) return;
      for (const child of layers.slice(index + 1).reverse()) child.close();
      layers.splice(layers.indexOf(layer), 1);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
      el.remove();
      anchor.setAttribute('aria-expanded', 'false');
      if (restoreFocus && anchor.isConnected) anchor.focus();
      onClose?.();
    },
  };

  layers.push(layer);
  anchor.setAttribute('aria-expanded', 'true');
  window.addEventListener('resize', place);
  window.addEventListener('scroll', onScroll, true);
  place();
  return layer;
}

// 点在浮层外面：从最上层开始逐个关闭，直到遇到包含点击位置的那一层。
// 点在触发按钮上不处理，交给按钮自己的点击逻辑去收起。
document.addEventListener(
  'mousedown',
  (e) => {
    for (let i = layers.length - 1; i >= 0; i -= 1) {
      const layer = layers[i];
      if (layer.el.contains(e.target) || layer.anchor.contains(e.target)) return;
      layer.close();
    }
  },
  true,
);

document.addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'Escape' || !layers.length) return;
    lastLayerEscape = e.timeStamp;
    layers.at(-1).close({ restoreFocus: true });
  },
  true,
);

// 下拉菜单。items: [{ value, label, note, disabled, selected, title }]
export function openMenu(anchor, { label, items, onSelect, onClose }) {
  const buttons = items.map((item) =>
    h(
      'button',
      {
        type: 'button',
        class: `menu-item ${item.selected ? 'selected' : ''}`,
        role: 'option',
        'aria-selected': String(Boolean(item.selected)),
        disabled: item.disabled,
        title: item.title,
        onClick: () => {
          layer.close({ restoreFocus: true });
          if (!item.selected) onSelect(item.value);
        },
      },
      h('span', { class: 'menu-item-label' }, item.label),
      item.note && h('span', { class: 'menu-item-note' }, item.note),
      h('span', { class: 'menu-item-check' }, item.selected && icon('check', 14)),
    ),
  );

  const layer = openPopover(anchor, [label && h('div', { class: 'menu-title' }, label), h('div', { class: 'menu-list', role: 'listbox', 'aria-label': label }, buttons)], {
    className: 'menu',
    label,
    onClose,
  });
  if (!layer) return null;
  layer.el.style.minWidth = `${Math.max(168, Math.round(anchor.getBoundingClientRect().width))}px`;
  layer.place();

  const enabled = buttons.filter((b) => !b.disabled);
  layer.el.addEventListener('keydown', (e) => {
    const index = enabled.indexOf(document.activeElement);
    let next = null;
    const start = enabled.find((b) => b.classList.contains('selected')) || enabled[0];
    if (e.key === 'ArrowDown') next = index === -1 ? start : enabled[(index + 1) % enabled.length];
    else if (e.key === 'ArrowUp') next = index === -1 ? start : enabled[(index - 1 + enabled.length) % enabled.length];
    else if (e.key === 'Home') next = enabled[0];
    else if (e.key === 'End') next = enabled.at(-1);
    else if (e.key === 'Tab') layer.close();
    if (next) {
      e.preventDefault();
      next.focus();
    }
  });
  layer.el.focus();
  return layer;
}

// 下拉选择器：按钮上显示当前值，点开是自绘的菜单。
// variant：'tool' 是输入框工具栏里的（图标加文字，无边框）；'field' 是表单里带边框的。
export function dropdown({ label, value, options, onChange, variant = 'field', icon: iconName, control }) {
  const current = options.find((o) => String(o.value) === String(value)) || options[0];
  const tool = variant === 'tool';
  let layer = null;
  const button = h(
    'button',
    {
      type: 'button',
      class: `dropdown dropdown-${variant}`,
      'data-control': control,
      'aria-haspopup': 'listbox',
      'aria-expanded': 'false',
      'aria-label': `${label}：${current.display || current.label}`,
      onClick: () => {
        if (layer) {
          layer.close();
          return;
        }
        layer = openMenu(button, {
          label,
          items: options.map((o) => ({ ...o, selected: o === current })),
          onSelect: onChange,
          onClose: () => {
            layer = null;
          },
        });
      },
    },
    iconName && icon(iconName),
    h('span', { class: 'dropdown-value' }, current.display || current.label, !tool && current.note && h('span', { class: 'dropdown-note' }, current.note)),
    !tool && icon('chevron', 12),
  );
  return button;
}

// 可展开的一段内容，代替原生的折叠标签。
export function disclosure(label, content, { open = false, onToggle } = {}) {
  const body = h('div', { class: 'disclosure-body', hidden: !open }, content);
  const button = h(
    'button',
    {
      type: 'button',
      class: 'disclosure',
      'aria-expanded': String(open),
      onClick: () => {
        open = !open;
        body.hidden = !open;
        button.setAttribute('aria-expanded', String(open));
        onToggle?.(open);
      },
    },
    icon('chevron', 12),
    label,
  );
  return h('div', { class: 'disclosure-wrap' }, button, body);
}

// 设置项的一行：左边名称（可带一句说明），右边控件。
export function formRow(label, control, desc) {
  return h('div', { class: 'form-row' }, h('div', { class: 'form-label' }, label, desc && h('span', { class: 'form-desc' }, desc)), h('div', { class: 'form-control' }, control));
}

// ---------- 弹窗 ----------

// 打开弹窗，返回 { close, body }。点遮罩或按 Esc 关闭。
export function openModal({ title, subtitle, content, size = 'md', onClose } = {}) {
  const root = document.getElementById('modal-root');
  const body = h('div', { class: 'modal-body' }, content);
  const close = () => {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    onClose?.();
  };
  const onKey = (e) => {
    // 这次 Esc 已经用来关掉弹窗里的菜单了，就不再关弹窗。
    if (e.key !== 'Escape' || e.timeStamp === lastLayerEscape) return;
    if (root.lastElementChild === overlay) close();
  };
  const overlay = h(
    'div',
    { class: 'modal-overlay', onMousedown: (e) => e.target === overlay && close() },
    h(
      'div',
      { class: `modal modal-${size}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h(
        'header',
        { class: 'modal-head' },
        h('div', null, h('h2', null, title), subtitle && h('p', { class: 'muted small' }, subtitle)),
        h('button', { class: 'modal-close', type: 'button', 'aria-label': '关闭', onClick: close }, icon('x', 16)),
      ),
      body,
    ),
  );
  document.addEventListener('keydown', onKey);
  root.append(overlay);
  return { close, body };
}

export function confirmDialog({ title, message, okText = '确定', cancelText = '取消', danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const answer = (value) => {
      answered = true;
      modal.close();
      resolve(value);
    };
    const modal = openModal({
      title,
      size: 'sm',
      onClose: () => !answered && resolve(false),
      content: [
        h('p', { class: 'confirm-text' }, message),
        h(
          'div',
          { class: 'modal-actions' },
          h('button', { class: 'btn', onClick: () => answer(false) }, cancelText),
          h('button', { class: danger ? 'btn btn-danger' : 'btn btn-primary', onClick: () => answer(true) }, okText),
        ),
      ],
    });
  });
}

// ---------- 小工具 ----------

export async function copyText(text, okMessage = '已复制') {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMessage, 'success', 1800);
  } catch {
    toast('复制失败，请手动选中复制', 'error');
  }
}

export function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return sameDay ? `今天 ${time}` : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

export function fmtBytes(n) {
  if (!n) return '';
  return n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// 分段选择器。options: [{ value, label, title, disabled }]
export function segmented(options, value, onChange, extraClass = '') {
  return h(
    'div',
    { class: `segmented ${extraClass}`, role: 'radiogroup' },
    options.map((opt) =>
      h(
        'button',
        {
          type: 'button',
          class: `seg ${opt.value === value ? 'active' : ''}`,
          role: 'radio',
          'aria-checked': String(opt.value === value),
          title: opt.title,
          disabled: opt.disabled,
          onClick: () => opt.value !== value && onChange(opt.value),
        },
        opt.label,
      ),
    ),
  );
}

export function toggle(checked, onChange, label) {
  return h('label', { class: 'switch' }, h('input', { type: 'checkbox', role: 'switch', checked, onChange: (e) => onChange(e.target.checked), 'aria-label': label }));
}
