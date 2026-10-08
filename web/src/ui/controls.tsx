// 表单控件。所有页面都只用这里的控件，不直接用浏览器原生的下拉框、勾选框和折叠标签。

import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon.tsx';
import { openMenu } from './layers.tsx';

// 悬停时显示自绘的提示气泡（代替原生的 title）。用法：<button {...tip('说明')}>
export const tip = (text?: string | null | false) => (text ? { 'data-tip': text } : undefined);
// 只在文字被截断时才显示完整内容。
export const clipTip = (text?: string | null) => (text ? { 'data-tip': text, 'data-tip-clipped': '1' } : undefined);

export interface SegOption<V extends string = string> {
  value: V;
  label: string;
  title?: string | null;
  disabled?: boolean;
}

// 分段选择器。选中项的底色是一块单独的滑块，换选中项时它滑过去。
export function Segmented<V extends string>({ options, value, onChange, className = '' }: { options: SegOption<V>[]; value: V; onChange: (value: V) => void; className?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLSpanElement>(null);

  // 把滑块摆到选中的那一格上。
  const place = () => {
    const active = root.current?.querySelector<HTMLElement>('.seg.active');
    // 所在的页面被藏起来时量不到尺寸，先保持原样，等它显示出来（下面的 ResizeObserver 会知道）再量。
    if (!active || !active.offsetWidth || !thumb.current) return;
    thumb.current.style.width = `${active.offsetWidth}px`;
    thumb.current.style.transform = `translateX(${active.offsetLeft}px)`;
  };
  useLayoutEffect(place);
  useEffect(() => {
    const el = root.current!;
    const observer = new ResizeObserver(place);
    observer.observe(el);
    // 第一次摆好位置之后才打开过渡，不然刚出现时滑块会从最左边滑过来。
    thumb.current!.getBoundingClientRect();
    el.dataset.ready = '';
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={root} className={`segmented ${className}`} role="radiogroup">
      <span ref={thumb} className="seg-thumb" />
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={`seg ${opt.value === value ? 'active' : ''}`}
          role="radio"
          aria-checked={opt.value === value}
          {...tip(opt.title)}
          disabled={opt.disabled}
          onClick={() => opt.value !== value && onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <label className="switch">
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
    </label>
  );
}

// 设置项的一行：左边名称（可带一句说明），右边控件。
export function FormRow({ label, desc, children }: { label: string; desc?: string; children: ReactNode }) {
  return (
    <div className="form-row">
      <div className="form-label">
        {label}
        {desc && <span className="form-desc">{desc}</span>}
      </div>
      <div className="form-control">{children}</div>
    </div>
  );
}

export interface DropdownOption {
  value: string;
  label: string;
  note?: string;
  // 按钮上显示的写法和菜单里的不一样时用它。
  display?: string;
  disabled?: boolean;
}

// 下拉选择器：按钮上显示当前值，点开是自绘的菜单。
// variant：'tool' 是输入框工具栏里的（图标加文字，无边框）；'field' 是表单里带边框的。
export function Dropdown({ label, value, options, onChange, variant = 'field', icon, control }: { label: string; value: string; options: DropdownOption[]; onChange: (value: string) => void; variant?: 'field' | 'tool'; icon?: IconName; control?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const current = options.find((o) => String(o.value) === String(value)) || options[0];
  const tool = variant === 'tool';
  return (
    <button
      ref={ref}
      type="button"
      className={`dropdown dropdown-${variant}`}
      data-control={control}
      aria-haspopup="listbox"
      aria-expanded="false"
      aria-label={`${label}：${current.display || current.label}`}
      onClick={() => openMenu(ref.current!, { label, items: options.map((o) => ({ value: o.value, label: o.label, note: o.note, disabled: o.disabled, selected: o === current })), onSelect: onChange })}
    >
      {icon && <Icon name={icon} />}
      <span className="dropdown-value">
        {current.display || current.label}
        {!tool && current.note && <span className="dropdown-note">{current.note}</span>}
      </span>
      {!tool && <Icon name="chevron" size={12} />}
    </button>
  );
}
