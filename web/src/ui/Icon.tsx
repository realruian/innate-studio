import { ICONS, type IconName } from './icons.ts';

export type { IconName };

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <span className="icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: ICONS[name] }} />
    </span>
  );
}
