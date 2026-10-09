// 浅色 / 深色主题，也可以跟着电脑的外观走。实际生效靠 <html data-theme>（只有 light、dark 两种），
// 初始值由 index.html 里的内联脚本在样式加载前定好。

const THEME_KEY = 'innate-studio.theme';

export type ThemeChoice = 'light' | 'dark' | 'system';

const systemLight = matchMedia('(prefers-color-scheme: light)');
const resolve = (choice: ThemeChoice) => (choice === 'system' ? (systemLight.matches ? 'light' : 'dark') : choice);

// 用户选的是哪一项。没选过是深色。
export function themeChoice(): ThemeChoice {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'system') return saved;
  } catch {
    /* 读不到就按现在页面上的来 */
    return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  }
  return 'dark';
}

export function setTheme(choice: ThemeChoice) {
  document.documentElement.dataset.theme = resolve(choice);
  try {
    localStorage.setItem(THEME_KEY, choice);
  } catch {
    /* 存不了就只在本次打开期间生效 */
  }
}

// 选了跟随系统时，电脑的外观一变这里马上跟着变。
systemLight.addEventListener('change', () => {
  if (themeChoice() === 'system') document.documentElement.dataset.theme = resolve('system');
});
