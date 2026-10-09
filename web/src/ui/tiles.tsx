// 素材格子：输入框的参考素材、首尾帧、待配乐视频，角色的参考图，画布输入面板里连进来的节点，都用这两个。
// 尺寸由所在的那一排用 --tile 定（默认 56，画布的面板是 64），别的都一样。

import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';
import { Icon } from './Icon.tsx';
import { tip } from './controls.tsx';

interface MediaTileProps {
  // 格子里的画面：缩略图，或者没有画面时的一个图标。
  children: ReactNode;
  // 底边的一行小字：这份素材当什么用（首帧、参考图）。
  tag?: string;
  // 盖在画面上的状态（处理中、失败）。
  state?: string;
  error?: boolean;
  tipText?: string;
  onRemove?: () => void;
  // 给了就能点：整个画面是一个按钮。
  face?: ButtonHTMLAttributes<HTMLButtonElement>;
  className?: string;
  style?: CSSProperties;
  // 写到节点上的 data-*。
  data?: Record<string, string | number | undefined>;
}

export function MediaTile({ children, tag, state, error, tipText, onRemove, face, className = '', style, data }: MediaTileProps) {
  const inner = (
    <>
      {children}
      {tag && <span className="ref-tag">{tag}</span>}
    </>
  );
  return (
    <div className={`ref-tile ${error ? 'tone-error' : ''} ${className}`} style={style} {...data} {...tip(tipText)}>
      {face ? (
        <button className="ref-face" type="button" {...face}>
          {inner}
        </button>
      ) : (
        inner
      )}
      {state && <span className={`ref-state ${error ? 'is-error' : ''}`}>{state}</span>}
      {onRemove && (
        <button className="ref-remove" type="button" aria-label="移除" onClick={onRemove}>
          <Icon name="x" size={10} stroke={2} />
        </button>
      )}
    </div>
  );
}

interface AddTileProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> {
  label: string;
  tipText?: string;
  // 加号下面的一行小字：这个位置放什么（首帧、尾帧）。
  caption?: string;
  // 压在一摞素材右下角的小圆按钮。
  dot?: boolean;
}

export function AddTile({ label, tipText, caption, dot, className = '', ...attrs }: AddTileProps) {
  return (
    <button className={`${dot ? 'ref-add ref-add-dot' : 'ref-tile ref-add'} ${className}`} type="button" aria-label={label} {...tip(tipText ?? label)} {...attrs}>
      <Icon name="plus" size={dot ? 12 : 18} stroke={dot ? 2 : 1.5} />
      {caption && <span className="ref-caption">{caption}</span>}
    </button>
  );
}
