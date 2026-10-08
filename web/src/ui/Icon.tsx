import { ICONS, type IconName } from './icons.ts';

export type { IconName };

// shown 只在 IconSwap 里用：标出叠在一起的几个图标里当前显示的那个。
// stroke 是线条粗细，和 Hugeicons 自己的 strokeWidth 是一个意思，默认 1.5。
export function Icon({ name, size = 16, stroke = 1.5, shown }: { name: IconName; size?: number; stroke?: number; shown?: boolean }) {
  return (
    <span className="icon" aria-hidden="true" data-shown={shown ? '' : undefined}>
      <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: ICONS[name] }} />
    </span>
  );
}

// 会随状态换的图标（播放和暂停、有声和静音）：几个图标叠在同一个位置，换的时候一个缩小淡出、一个放大淡入。
export function IconSwap({ icons, show, size = 16 }: { icons: IconName[]; show: IconName; size?: number }) {
  return (
    <span className="icon-swap">
      {icons.map((name) => (
        <Icon key={name} name={name} size={size} shown={name === show} />
      ))}
    </span>
  );
}
