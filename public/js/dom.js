// DOM 小工具：建节点、图标、提示条、弹窗。

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
      else el.setAttribute(key, value === true ? '' : value);
    }
  }
  append(el, children);
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
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1"/>',
};

// 界面只用这几枚线性图标，其余一律用文字。
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
    if (e.key === 'Escape' && root.lastElementChild === overlay) close();
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
        h('button', { class: 'modal-close', type: 'button', 'aria-label': '关闭', onClick: close }, '×'),
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

// 侧栏里用的相对时间。
export function fmtAgo(ms) {
  if (!ms) return '';
  const minutes = Math.floor((Date.now() - ms) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)} 小时`;
  return `${Math.floor(minutes / 60 / 24)} 天`;
}

export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

export function fmtBytes(n) {
  if (!n) return '';
  return n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// 简单的分段选择器。options: [{ value, label, title, disabled }]
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
  return h(
    'label',
    { class: 'switch' },
    h('input', { type: 'checkbox', checked, onChange: (e) => onChange(e.target.checked), 'aria-label': label }),
  );
}
