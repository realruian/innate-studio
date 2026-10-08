// 入口：侧边栏（导航和设置）、页面切换、启动轮询。

import { h, icon, clear, add, toast } from './dom.js';
import { state, on, loadApp, loadModels, loadAssets, startHistoryLoop, startAssetLoop, setNavigator } from './store.js';
import { renderComposer, focusComposer } from './composer.js';
import { renderRecent, renderRecords } from './history.js';
import { renderLibrary } from './assets.js';
import { renderPersons, enterPersons } from './persons.js';
import { openSettings } from './settings.js';

// 「新建创作」是一个动作按钮，不是页签，所以始终是凸起的样子，不参与"当前页"高亮。
const VIEWS = [
  { id: 'create', label: '新建创作', icon: 'plus', action: true },
  { id: 'records', label: '创作记录', icon: 'history' },
  { id: 'library', label: '素材库', icon: 'folder' },
  { id: 'persons', label: '真人档案', icon: 'user' },
];
const BRAND_MARK =
  '<svg viewBox="0 0 20 20" width="20" height="20"><rect width="20" height="20" rx="6" fill="currentColor"/><path d="M8 6.3v7.4l6-3.7z" fill="var(--bg-side)"/></svg>';

const app = document.getElementById('app');
const nav = h('nav', { class: 'nav' });
const settingsButton = h('button', { class: 'nav-item', type: 'button', onClick: openSettings });
const views = {
  create: h('div', { class: 'view view-create' }),
  records: h('div', { class: 'view', hidden: true }),
  library: h('div', { class: 'view', hidden: true }),
  persons: h('div', { class: 'view', hidden: true }),
};
const rendered = new Set();

function show(id) {
  state.view = id;
  for (const [key, el] of Object.entries(views)) {
    // 离开一个页面时停掉它里面正在放的视频，免得声音留在后台。
    if (key !== id) for (const video of el.querySelectorAll('video')) video.pause();
    el.hidden = key !== id;
  }
  if (!rendered.has(id)) {
    rendered.add(id);
    if (id === 'records') renderRecords(views.records);
    if (id === 'library') renderLibrary(views.library);
    if (id === 'persons') renderPersons(views.persons);
  }
  if (id === 'persons') enterPersons();
  if (id === 'create') {
    views.create.scrollTo({ top: 0 });
    focusComposer();
  }
  drawNav();
}

function drawNav() {
  add(
    clear(nav),
    VIEWS.map((v) =>
      h(
        'button',
        {
          class: `nav-item ${v.action ? 'nav-new' : ''} ${!v.action && state.view === v.id ? 'active' : ''}`,
          type: 'button',
          'aria-current': !v.action && state.view === v.id ? 'page' : null,
          onClick: () => show(v.id),
        },
        icon(v.icon),
        h('span', null, v.label),
      ),
    ),
  );
}

// 设置入口只在缺少 API Key 时带一个提醒点；Key 的具体内容放在设置里看。
function drawSettingsButton() {
  add(clear(settingsButton), icon('gear'), h('span', null, '设置'), !state.app.hasKey && h('span', { class: 'dot dot-warn nav-dot', title: '还没有设置 API Key' }));
}

app.append(
  h(
    'aside',
    { class: 'sidebar' },
    h('div', { class: 'brand' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true', html: BRAND_MARK }), 'Seedance Studio'),
    nav,
    h('div', { class: 'sidebar-foot' }, settingsButton),
  ),
  h('main', { class: 'main' }, views.create, views.records, views.library, views.persons),
);

setNavigator(show);
on('app', drawSettingsButton);
drawNav();
drawSettingsButton();

async function start() {
  try {
    await loadApp();
  } catch (err) {
    toast(err.message, 'error', 8000);
  }
  renderComposer(views.create);
  renderRecent(views.create);
  rendered.add('create');
  startHistoryLoop();
  startAssetLoop();
  loadAssets().catch(() => {});
  if (state.app.hasKey) loadModels().catch(() => {});
  else openSettings();
}

// 保存 Key 之后重新读取模型列表。
let hadKey = null;
on('app', () => {
  if (hadKey === false && state.app.hasKey) loadModels().catch(() => {});
  hadKey = state.app.hasKey;
});

start();
