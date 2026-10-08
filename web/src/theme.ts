// 浅色 / 深色主题。实际生效靠 <html data-theme>，初始值由 index.html 里的内联脚本在样式加载前定好。

const THEME_KEY = 'seedance-studio.theme';

export const currentTheme = (): 'light' | 'dark' => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

export function setTheme(theme: string) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
  try {
    localStorage.setItem(THEME_KEY, currentTheme());
  } catch {
    /* 存不了就只在本次打开期间生效 */
  }
}
