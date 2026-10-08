// 动效。规则见 DESIGN.md 第 7 节。
// 进场这类一次性的动效用浏览器自带的动画接口（element.animate）：只在调用的那一刻播一遍，
// 页面切走再切回来不会重播，播完也不在节点上留样式。状态之间的过渡（悬停、按下、滑块）写在样式表里。

import { useLayoutEffect, useRef } from 'react';

// 和样式表里的 --ease-out 是同一条曲线：起步快、收尾慢，进场和出场都用它。
export const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';

// 系统设置了「减弱动态效果」时，只留淡入淡出，不做位移和缩放。
export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

interface EnterOptions {
  // 从下方多少像素移上来。
  y?: number;
  // 从多大缩放到原大小（比如 0.96）。配合样式里的 transform-origin，看起来像从触发它的地方长出来。
  scale?: number;
  // 起始的模糊像素。只给大标题这类少量文字用。
  blur?: number;
  duration?: number;
  delay?: number;
}

// 进场：从透明、稍微偏一点的位置到位。
export function enter(el: Element | null | undefined, { y = 8, scale, blur = 0, duration = 220, delay = 0 }: EnterOptions = {}) {
  if (!el) return null;
  const reduce = reducedMotion();
  const from: Keyframe = { opacity: 0 };
  const to: Keyframe = { opacity: 1 };
  if (!reduce) {
    const transform = [y ? `translateY(${y}px)` : '', scale ? `scale(${scale})` : ''].filter(Boolean).join(' ');
    if (transform) {
      from.transform = transform;
      to.transform = 'none';
    }
    if (blur) {
      from.filter = `blur(${blur}px)`;
      to.filter = 'blur(0)';
    }
  }
  // backwards：等待 delay 的那段时间里先停在起始状态，不会先闪现一下再消失。
  return el.animate([from, to], { duration: reduce ? Math.min(duration, 150) : duration, delay: reduce ? 0 : delay, easing: EASE_OUT, fill: 'backwards' });
}

// 一组元素依次进场，每个比前一个晚 stagger 毫秒。
export function enterEach(els: Iterable<Element | null | undefined>, { stagger = 40, delay = 0, ...options }: EnterOptions & { stagger?: number } = {}) {
  let index = 0;
  for (const el of els) {
    enter(el, { ...options, delay: delay + index * stagger });
    index += 1;
  }
}

// 出场：比进场短、比进场轻，播完再把节点拿掉。
export function leave(el: Element | null | undefined, { scale, duration = 120 }: { scale?: number; duration?: number } = {}) {
  if (!el) return Promise.resolve();
  const to: Keyframe = { opacity: 0 };
  if (scale && !reducedMotion()) to.transform = `scale(${scale})`;
  return el.animate([{ opacity: 1 }, to], { duration, easing: EASE_OUT, fill: 'forwards' }).finished.then(
    () => {},
    () => {},
  );
}

// key 变了之后（不含第一次画出来）在画面更新前调一次 run。用来给"换了一种内容"配进场动效。
export function useOnChange(key: string, run: () => void) {
  const last = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (last.current !== null && last.current !== key) run();
    last.current = key;
  });
}
