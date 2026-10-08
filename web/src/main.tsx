// 入口：把页面画出来，读取 Key 的状态，启动轮询。

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App.tsx';
import { state, on, emit, loadApp, loadModels, loadAssets, startHistoryLoop, startAssetLoop } from './store.ts';
import { initComposer } from './composer/state.ts';
import { openSettings } from './settings.tsx';
import { toast } from './ui/layers.tsx';

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// 保存 Key 之后重新读取模型列表。
let hadKey: boolean | null = null;
on('app', () => {
  if (hadKey === false && state.app.hasKey) loadModels().catch(() => {});
  hadKey = state.app.hasKey;
});

async function start() {
  try {
    await loadApp();
  } catch (err) {
    toast((err as Error).message, 'error', 8000);
  }
  initComposer();
  state.booted = true;
  emit('boot');
  startHistoryLoop();
  startAssetLoop();
  loadAssets().catch(() => {});
  if (state.app.hasKey) loadModels().catch(() => {});
  else openSettings();
}

// 自动化走查要直接改状态来模拟接口的变化，所以把状态挂出来。
Object.assign(window, { __studio: { state, emit } });

start();
