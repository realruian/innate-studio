// 入口：侧边栏、页面切换、启动轮询。

import { h, icon, clear, add, toast, fmtAgo } from './dom.js';
import { state, on, loadApp, loadModels, loadAssets, startHistoryLoop, startAssetLoop, isPendingTask } from './store.js';
import { renderComposer, focusComposer } from './composer.js';
import { renderHistory, openDetail } from './history.js';
import { renderLibrary } from './assets.js';
import { renderPersons, enterPersons } from './persons.js';
import { openSettings } from './settings.js';

const VIEWS = [
  { id: 'create', label: '新建创作', icon: 'plus' },
  { id: 'library', label: '素材库', icon: 'folder' },
  { id: 'persons', label: '真人档案', icon: 'user' },
];
const RECENT_LIMIT = 40;

const app = document.getElementById('app');
const nav = h('nav', { class: 'nav' });
const recent = h('div', { class: 'side-list' });
const keyButton = h('button', { class: 'key-status', type: 'button', onClick: openSettings });
const views = {
  create: h('div', { class: 'view view-create' }),
  library: h('div', { class: 'view', hidden: true }),
  persons: h('div', { class: 'view', hidden: true }),
};
const rendered = new Set();

function show(id) {
  state.view = id;
  for (const [key, el] of Object.entries(views)) el.hidden = key !== id;
  if (!rendered.has(id)) {
    rendered.add(id);
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
        { class: `nav-item ${state.view === v.id ? 'active' : ''}`, type: 'button', 'aria-current': state.view === v.id ? 'page' : null, onClick: () => show(v.id) },
        icon(v.icon),
        h('span', null, v.label),
      ),
    ),
  );
}

// 侧栏的「最近生成」：标题是提示词，右侧是进行状态或完成时间。
function drawRecent() {
  clear(recent);
  const items = state.history.slice(0, RECENT_LIMIT);
  if (!items.length) {
    recent.append(h('div', { class: 'side-empty' }, state.historyLoaded ? '还没有生成记录' : '正在读取…'));
    return;
  }
  add(
    recent,
    items.map((item) => {
      let meta = h('span', { class: 'side-row-meta' }, fmtAgo(item.completedAt || item.createdAt));
      if (isPendingTask(item)) meta = h('span', { class: 'spinner', title: '生成中' });
      else if (item.status === 'failed') meta = h('span', { class: 'dot dot-err', title: '生成失败' });
      return h(
        'button',
        { class: 'side-row', type: 'button', title: item.prompt || '', onClick: () => openDetail(item.id) },
        h('span', { class: 'side-row-text' }, item.prompt || '（没有提示词）'),
        meta,
      );
    }),
  );
}

function drawKey() {
  const { hasKey, keyHint } = state.app;
  clear(keyButton).append(
    icon('gear'),
    h('span', { class: 'key-label' }, '设置'),
    h('span', { class: 'key-value' }, hasKey ? keyHint : '未设置 Key'),
    h('span', { class: `dot ${hasKey ? 'dot-ok' : 'dot-warn'}` }),
  );
}

app.append(
  h(
    'aside',
    { class: 'sidebar' },
    h('div', { class: 'brand' }, 'Seedance Studio'),
    nav,
    h('div', { class: 'side-title' }, '最近生成'),
    recent,
    h('div', { class: 'sidebar-foot' }, keyButton),
  ),
  h('main', { class: 'main' }, views.create, views.library, views.persons),
);

on('app', drawKey);
on('history', drawRecent);
drawNav();
drawKey();
drawRecent();

async function start() {
  try {
    await loadApp();
  } catch (err) {
    toast(err.message, 'error', 8000);
  }
  renderComposer(views.create);
  renderHistory(views.create);
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

// 每分钟刷新一次侧栏里的相对时间。
setInterval(drawRecent, 60000);

start();
