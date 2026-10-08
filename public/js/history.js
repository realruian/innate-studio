// 创作记录：任务进度、播放、下载、复用参数、详情。

import { h, toast, clear, openModal, confirmDialog, copyText, fmtTime, fmtDuration, fmtBytes, segmented } from './dom.js';
import { api, state, on, loadHistory, isPendingTask } from './store.js';
import { thumbEl } from './assets.js';
import { setForm } from './composer.js';

const MODE_LABELS = { text: '文生视频', frames: '首尾帧', reference: '参考生成' };
const STATUS_LABELS = { queued: '排队中', in_progress: '生成中', completed: '已完成', failed: '失败' };

let filter = 'all';
let query = '';
const cards = new Map();

function modeOf(item) {
  if (item.form?.mode) return item.form.mode;
  const roles = (item.payload?.content || []).map((c) => c.role).filter(Boolean);
  if (roles.some((r) => r === 'first_frame' || r === 'last_frame')) return 'frames';
  return roles.length ? 'reference' : 'text';
}

function refsOf(item) {
  const f = item.form;
  if (!f) return [];
  if (f.mode === 'frames') return [f.frames?.first, f.frames?.last].filter(Boolean);
  if (f.mode === 'reference') return [...(f.refs?.image || []), ...(f.refs?.video || []), ...(f.refs?.audio || [])];
  return [];
}

function paramChips(item) {
  const p = item.payload || {};
  const chips = [MODE_LABELS[modeOf(item)], item.model, p.resolution, p.ratio === 'adaptive' ? '自适应' : p.ratio, p.duration === -1 ? '时长自动' : p.duration && `${p.duration} 秒`];
  if (p.super_resolution_config) chips.push('超分');
  return chips.filter(Boolean);
}

async function removeItem(item) {
  const ok = await confirmDialog({
    title: '删除这条记录？',
    message: '只删除本机上的记录和已保存的视频文件，不影响 Flatkey 上的任务和计费。删除后无法恢复。',
    okText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api('DELETE', `/api/history/${encodeURIComponent(item.id)}`);
    await loadHistory();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function reuse(item) {
  if (item.form) {
    setForm(item.form);
  } else {
    const p = item.payload || {};
    const basics = { mode: 'text', prompt: item.prompt || '', model: item.model, resolution: p.resolution, ratio: p.ratio };
    setForm(Object.fromEntries(Object.entries(basics).filter(([, value]) => value != null)));
  }
  toast('已把这次的参数填回创作面板', 'success');
}

async function refresh(item) {
  try {
    await api('POST', `/api/history/${encodeURIComponent(item.id)}/refresh`);
    await loadHistory();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function downloadLink(item, children, cls) {
  const href = item.savedLocally ? `${item.videoUrl}?download=1` : item.videoUrl;
  return h('a', { class: cls, href, download: item.savedLocally ? '' : null, target: item.savedLocally ? null : '_blank', rel: 'noopener', title: '下载视频' }, children);
}

function mediaBox(item, large = false) {
  if (item.status === 'completed' && item.videoUrl) {
    return h('video', { class: 'card-video', src: item.videoUrl, controls: true, preload: 'metadata', playsinline: true, loop: true, autoplay: large });
  }
  if (item.status === 'failed') {
    return h(
      'div',
      { class: 'card-state is-failed' },
      h('div', { class: 'state-title' }, '生成失败'),
      h('div', { class: 'state-text' }, item.error?.message || '未知错误'),
      h('div', { class: 'small muted' }, '预扣的余额会自动退还'),
    );
  }
  if (item.status === 'completed') {
    return h('div', { class: 'card-state' }, h('div', { class: 'state-title' }, '已完成，但没有拿到视频地址'));
  }
  const progress = Math.max(0, Math.min(100, item.progress || 0));
  return h(
    'div',
    { class: 'card-state is-pending' },
    h('div', { class: 'state-title cursor-text' }, item.status === 'queued' ? '排队中' : `生成中 ${progress}%`),
    h('div', { class: 'bar wide' }, h('div', { class: 'bar-fill', style: { width: `${item.status === 'queued' ? 4 : Math.max(6, progress)}%` } })),
    h('div', { class: 'small muted' }, item.pollError ? `查询状态出错：${item.pollError}` : '通常需要几分钟，可以关掉页面，回来再看'),
  );
}

function buildCard(item) {
  const refs = refsOf(item);
  const done = item.status === 'completed' && item.videoUrl;
  return h(
    'article',
    { class: `card status-${item.status}` },
    h('div', { class: 'card-media' }, mediaBox(item)),
    h(
      'div',
      { class: 'card-body' },
      h('p', { class: 'card-prompt', title: item.prompt }, item.prompt || h('span', { class: 'muted' }, '（没有提示词）')),
      h('div', { class: 'entry-meta' }, paramChips(item).join(' · ')),
      refs.length ? h('div', { class: 'card-refs' }, refs.slice(0, 8).map((r) => h('span', { class: 'mini-thumb', title: r.name }, thumbEl(r.thumb, r.kind)))) : null,
      h(
        'div',
        { class: 'card-foot' },
        h('span', { class: 'small muted' }, fmtTime(item.createdAt)),
        h(
          'div',
          { class: 'card-actions' },
          done && downloadLink(item, '下载', 'entry-action-btn'),
          isPendingTask(item) && h('button', { class: 'entry-action-btn', type: 'button', title: '立即查询状态', onClick: () => refresh(item) }, '刷新'),
          h('button', { class: 'entry-action-btn', type: 'button', title: '把这次的参数填回创作面板', onClick: () => reuse(item) }, '复用'),
          h('button', { class: 'entry-action-btn', type: 'button', onClick: () => openDetail(item.id) }, '详情'),
          h('button', { class: 'entry-action-btn danger', type: 'button', onClick: () => removeItem(item) }, '删除'),
        ),
      ),
    ),
  );
}

export function openDetail(id) {
  const item = state.history.find((i) => i.id === id);
  if (!item) return;
  const p = item.payload || {};
  const refs = refsOf(item);
  const rows = [
    ['状态', STATUS_LABELS[item.status] || item.status],
    ['任务 ID', h('span', { class: 'mono copyable', title: '点击复制', onClick: () => copyText(item.id, '已复制任务 ID') }, item.id)],
    ['模式', MODE_LABELS[modeOf(item)]],
    ['模型', item.model],
    ['分辨率', p.resolution],
    ['画面比例', p.ratio === 'adaptive' ? '自适应' : p.ratio],
    ['时长', p.duration === -1 ? '由模型决定' : p.duration && `${p.duration} 秒`],
    ['同步音频', p.generate_audio === undefined ? null : p.generate_audio ? '开' : '关'],
    ['水印', p.watermark === undefined ? null : p.watermark ? '开' : '关'],
    ['随机种子', p.seed],
    ['联网搜索', p.web_search ? '开' : null],
    ['输入模式', p.input_type],
    ['画质超分', describeSuperResolution(p.super_resolution_config)],
    ['提交时间', fmtTime(item.createdAt)],
    ['生成耗时', item.completedAt && item.createdAt ? fmtDuration(item.completedAt - item.createdAt) : null],
    ['Token 用量', item.usage?.total_tokens != null ? String(item.usage.total_tokens) : null],
    ['视频文件', item.status !== 'completed' ? null : item.savedLocally ? `已保存到本机${item.fileSize ? `（${fmtBytes(item.fileSize)}）` : ''}` : item.downloadError ? `还没存到本机：${item.downloadError}` : '正在保存到本机…'],
    ['失败原因', item.error ? `${item.error.message}${item.error.code ? `（${item.error.code}）` : ''}` : null],
  ].filter(([, value]) => value != null && value !== '' && value !== false);

  const done = item.status === 'completed' && item.videoUrl;
  openModal({
    title: '生成详情',
    size: 'lg',
    content: h(
      'div',
      { class: 'detail' },
      h('div', { class: 'detail-media' }, mediaBox(item, true)),
      h(
        'div',
        { class: 'detail-side' },
        h('div', { class: 'field-label' }, '提示词'),
        h('p', { class: 'detail-prompt' }, item.prompt || '（没有提示词）'),
        refs.length
          ? [h('div', { class: 'field-label' }, '参考素材'), h('div', { class: 'card-refs' }, refs.map((r) => h('span', { class: 'mini-thumb lg', title: r.name }, thumbEl(r.thumb, r.kind))))]
          : null,
        h('dl', { class: 'kv' }, rows.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
        h(
          'div',
          { class: 'detail-actions' },
          done && downloadLink(item, '下载视频', 'btn btn-primary'),
          h('button', { class: 'btn', onClick: () => copyText(item.prompt || '', '已复制提示词') }, '复制提示词'),
          h('button', { class: 'btn', onClick: () => reuse(item) }, '复用参数'),
          !item.savedLocally && item.status === 'completed' && h('button', { class: 'btn', onClick: () => refresh(item).then(() => toast('已重新尝试保存', 'info')) }, '重新保存到本机'),
        ),
        h('details', { class: 'preview' }, h('summary', null, '查看发送的请求'), h('pre', { class: 'code' }, JSON.stringify(p, null, 2))),
      ),
    ),
  });
}

const SR_SCENE_LABELS = { aigc: 'AIGC 内容', short_series: '短剧', ugc: 'UGC', old_film: '老片' };

function describeSuperResolution(sr) {
  if (!sr) return null;
  return [
    sr.resolution ? `目标 ${sr.resolution}` : sr.resolution_limit ? `短边 ${sr.resolution_limit} 像素` : null,
    sr.scene ? `场景：${SR_SCENE_LABELS[sr.scene] || sr.scene}` : null,
    sr.tool_version === 'professional' ? '专业模式' : '标准模式',
    sr.fps ? `${sr.fps} 帧/秒` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

const cardSignature = (i) => JSON.stringify([i.status, i.progress, i.videoUrl, i.error?.message, i.pollError]);

export function renderHistory(root) {
  const grid = h('div', { class: 'card-grid' });
  const filterEl = h('div');
  const countEl = h('span', { class: 'muted small' });
  const search = h('input', {
    class: 'input search',
    type: 'search',
    placeholder: '搜索提示词',
    'aria-label': '搜索提示词',
    onInput: (e) => {
      query = e.target.value.trim().toLowerCase();
      draw();
    },
  });

  function drawFilter() {
    const count = (fn) => state.history.filter(fn).length;
    clear(filterEl).append(
      segmented(
        [
          { value: 'all', label: `全部 ${state.history.length}` },
          { value: 'pending', label: `生成中 ${count(isPendingTask)}` },
          { value: 'completed', label: `已完成 ${count((i) => i.status === 'completed')}` },
          { value: 'failed', label: `失败 ${count((i) => i.status === 'failed')}` },
        ],
        filter,
        (next) => {
          filter = next;
          draw();
        },
        'filters',
      ),
    );
  }

  function draw() {
    drawFilter();
    const list = state.history.filter((item) => {
      if (filter === 'pending' && !isPendingTask(item)) return false;
      if ((filter === 'completed' || filter === 'failed') && item.status !== filter) return false;
      return !query || (item.prompt || '').toLowerCase().includes(query);
    });
    countEl.textContent = query || filter !== 'all' ? `显示 ${list.length} 条` : '';

    if (!list.length) {
      cards.clear();
      clear(grid).append(
        h(
          'div',
          { class: 'empty' },
          h('div', { class: 'empty-title' }, !state.historyLoaded ? '正在读取记录…' : state.history.length ? '没有符合条件的记录' : '还没有生成过视频'),
          state.historyLoaded && !state.history.length ? h('div', { class: 'muted' }, '在左边写下提示词，点「生成视频」。生成的视频和参数都会保存在这里。') : null,
        ),
      );
      return;
    }

    // 只重建有变化的卡片，正在播放的视频不会被打断。
    const wanted = new Set(list.map((i) => i.id));
    for (const [id, entry] of cards) {
      if (!wanted.has(id)) {
        entry.el.remove();
        cards.delete(id);
      }
    }
    grid.querySelector('.empty')?.remove();
    let previous = null;
    let entered = 0;
    for (const item of list) {
      const signature = cardSignature(item);
      let entry = cards.get(item.id);
      if (!entry || entry.signature !== signature) {
        const el = buildCard(item);
        if (entry) {
          entry.el.replaceWith(el);
        } else {
          el.classList.add('entering');
          el.style.animationDelay = `${Math.min(entered * 50, 400)}ms`;
          entered += 1;
        }
        entry = { el, signature };
        cards.set(item.id, entry);
      }
      const expectedNext = previous ? previous.nextSibling : grid.firstChild;
      if (expectedNext !== entry.el) grid.insertBefore(entry.el, expectedNext);
      previous = entry.el;
    }
  }

  root.append(
    h(
      'section',
      { class: 'feed' },
      h('header', { class: 'feed-head' }, h('h1', null, '创作记录'), h('div', { class: 'feed-tools' }, countEl, filterEl, search)),
      grid,
    ),
  );
  draw();
  on('history', draw);
}
