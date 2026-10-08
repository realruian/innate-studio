// 生成记录：任务进度、播放、下载、复用参数、详情。视频、图片、音频（语音、音效、配乐）都在这里。
// 有两处用到：创作页输入框下面的「最近生成」（只列最新几条），和单独的「创作记录」页（全部，带筛选和搜索）。

import { h, icon, toast, clear, openModal, openMenu, confirmDialog, copyText, fmtTime, fmtDuration, fmtBytes, segmented, dropdown } from './dom.js';
import { api, state, on, loadHistory, isPendingTask, isTimedOutTask, goTo } from './store.js';
import { thumbEl } from './assets.js';
import { setForm, setStudio, useImageAsFirstFrame, useVideoForMusic } from './composer.js';
import { videoPlayer, audioPlayer } from './player.js';
import { videoFamily } from './request.js';

const MODE_LABELS = { text: '文生视频', frames: '首尾帧', reference: '参考生成' };
const STATUS_LABELS = { queued: '排队中', in_progress: '生成中', completed: '已完成', failed: '失败' };
const KIND_LABELS = { video: '视频', image: '图片', audio: '音频' };
const TOOL_LABELS = { speech: '语音', sfx: '音效', music: '配乐' };
// 生成中的卡片上那句说明：各种内容要等多久差别很大。
const WAIT_HINTS = { video: '通常需要几分钟，可以关掉页面，回来再看', image: '通常十几秒', speech: '通常几秒', sfx: '通常几秒', music: '通常不到一分钟' };

// 这条记录是哪种内容：视频、图片，或者音频里的语音、音效、配乐。
const typeOf = (item) => (item.kind === 'audio' ? item.tool : item.kind);
const typeLabel = (item) => TOOL_LABELS[item.tool] || KIND_LABELS[item.kind];
// 没有提示词的记录（配乐）用它的类型来称呼。
const nameOf = (item) => item.prompt || typeLabel(item);

const RECENT_COUNT = 6;

function modeOf(item) {
  if (videoFamily(item.model) === 'grok') return item.payload?.image ? '图生视频' : '文生视频';
  return MODE_LABELS[seedanceModeOf(item)];
}

function seedanceModeOf(item) {
  if (item.form?.mode) return item.form.mode;
  const roles = (item.payload?.content || []).map((c) => c.role).filter(Boolean);
  if (roles.some((r) => r === 'first_frame' || r === 'last_frame')) return 'frames';
  return roles.length ? 'reference' : 'text';
}

function refsOf(item) {
  const f = item.form;
  if (!f || item.kind !== 'video') return [];
  if (videoFamily(item.model) === 'grok') return f.mode === 'frames' && f.frames?.first ? [f.frames.first] : [];
  if (f.mode === 'frames') return [f.frames?.first, f.frames?.last].filter(Boolean);
  if (f.mode === 'reference') return [...(f.refs?.image || []), ...(f.refs?.video || []), ...(f.refs?.audio || [])];
  return [];
}


async function removeItem(item) {
  const ok = await confirmDialog({
    title: '删除这条记录？',
    message: '只删除本机上的记录和已保存的文件，不影响 Flatkey 上的任务和计费。删除后无法恢复。',
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
  if (item.kind !== 'video') {
    setStudio(typeOf(item), item.form || { prompt: item.prompt });
  } else if (item.form) {
    setForm(item.form);
  } else {
    const p = item.payload || {};
    const basics = { mode: 'text', prompt: item.prompt || '', model: item.model, resolution: p.resolution, ratio: p.ratio };
    setForm(Object.fromEntries(Object.entries(basics).filter(([, value]) => value != null)));
  }
  goTo('create');
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

// 查询超时的任务：再向 Flatkey 查一次，并说明这次查到了什么。
async function recheck(item) {
  try {
    const next = await api('POST', `/api/history/${encodeURIComponent(item.id)}/refresh`);
    await loadHistory();
    if (next.status === 'completed') toast('任务已经完成', 'success');
    else if (isTimedOutTask(next)) toast(next.pollError ? `查询状态出错：${next.pollError}` : '还是没有结果', 'info');
  } catch (err) {
    toast(err.message, 'error');
  }
}

// 把一张生成的图片拿去当视频的首帧。Seedance 要先把图传进素材库，会等一小会儿。
async function animate(item) {
  try {
    await useImageAsFirstFrame(item);
    toast('已把这张图设为首帧，写下提示词就可以生成视频', 'success');
  } catch (err) {
    toast(err.message, 'error', 6000);
  }
}

async function score(item) {
  if (!item.savedLocally) return toast('这条视频还没保存到本机，稍后再试', 'info');
  await useVideoForMusic(item);
  toast('已选好这段视频，点右下角的发送键生成配乐', 'success');
}

function downloadLink(item, children, cls) {
  const href = item.savedLocally ? `${item.mediaUrl}?download=1` : item.mediaUrl;
  return h('a', { class: cls, href, download: item.savedLocally ? '' : null, target: item.savedLocally ? null : '_blank', rel: 'noopener' }, children);
}

function download(item) {
  const link = downloadLink(item);
  document.body.append(link);
  link.click();
  link.remove();
}

// 卡片右上角的「更多」。菜单内容按点开那一刻的状态来定：生成中的可以刷新，查询超时的可以再查一次，已完成的可以下载。
// 已完成的视频可以拿去配乐，已完成的图片可以拿去生成视频。
function openCardMenu(button, id) {
  const item = state.history.find((i) => i.id === id);
  if (!item) return;
  const actions = {
    download: () => download(item),
    refresh: () => refresh(item),
    recheck: () => recheck(item),
    reuse: () => reuse(item),
    score: () => score(item),
    animate: () => animate(item),
    detail: () => openDetail(item.id),
    remove: () => removeItem(item),
  };
  openMenu(button, {
    label: '更多操作',
    align: 'end',
    items: [
      done(item) && { value: 'download', label: '下载' },
      // 图片、语音、音效没有任务可查，生成中只能等。
      isPendingTask(item) && !item.direct && { value: 'refresh', label: '刷新' },
      isTimedOutTask(item) && { value: 'recheck', label: '再查一次' },
      { value: 'reuse', label: '复用' },
      done(item) && item.kind === 'video' && state.catalog.audio.music && { value: 'score', label: '配乐' },
      done(item) && item.kind === 'image' && { value: 'animate', label: '生成视频' },
      { value: 'detail', label: '详情' },
      { value: 'remove', label: '删除', danger: true },
    ].filter(Boolean),
    onSelect: (value) => actions[value](),
  });
}

const done = (item) => item.status === 'completed' && Boolean(item.mediaUrl);

// 图片：比例和画框差不多就铺满，差得多（比如竖图）就完整显示、两边留底色，不裁画面。详情里总是完整显示。
function imageView(item, large) {
  const img = h('img', { class: 'media-image', src: item.mediaUrl, alt: item.prompt || '生成的图片' });
  if (!large) img.addEventListener('load', () => img.classList.toggle('cover', Math.abs(img.naturalWidth / img.naturalHeight / (16 / 9) - 1) < 0.03));
  return h('div', { class: 'image-view' }, img);
}

function audioView(item, large) {
  const voice = item.tool === 'speech' && item.payload?.voice_name;
  // 详情里的配乐：原视频还在本机的话，画面和音乐一起放，才听得出配得怎么样。
  const source = item.tool === 'music' && item.form?.video?.url;
  if (large && source) return videoPlayer({ src: source, soundtrack: item.mediaUrl, autoplay: true, label: '配乐预览' });
  // 配乐没有提示词，写上它是给多长的视频配的。
  const seconds = item.tool === 'music' && Math.round(item.payload?.duration_seconds || 0);
  const text = item.prompt || (seconds ? `给一段 ${seconds} 秒的视频配的音乐` : '');
  return audioPlayer({ src: item.mediaUrl, kind: voice ? `${typeLabel(item)} · ${voice}` : typeLabel(item), text, label: nameOf(item) });
}

function mediaBox(item, large = false) {
  if (done(item)) {
    if (item.kind === 'image') return imageView(item, large);
    if (item.kind === 'audio') return audioView(item, large);
    return videoPlayer({ src: item.videoUrl, autoplay: large, clickToPlay: large, frameRatio: large ? null : 16 / 9, label: item.prompt || '生成的视频' });
  }
  if (item.status === 'failed') {
    return h(
      'div',
      { class: 'card-state is-failed' },
      h('div', { class: 'state-title' }, isTimedOutTask(item) ? '查询超时' : '生成失败'),
      h('div', { class: 'state-text' }, item.error?.message || '未知错误'),
      item.kind === 'video' && !isTimedOutTask(item) && h('div', { class: 'small muted' }, '预扣的余额会自动退还'),
    );
  }
  if (item.status === 'completed') {
    return h('div', { class: 'card-state' }, h('div', { class: 'state-title' }, `已完成，但没有拿到${KIND_LABELS[item.kind]}地址`));
  }
  // 只有视频任务会报进度；其余的只知道还在生成。
  const video = item.kind === 'video';
  const progress = Math.max(0, Math.min(100, item.progress || 0));
  return h(
    'div',
    { class: 'card-state is-pending' },
    h('div', { class: 'state-title cursor-text' }, item.status === 'queued' ? '排队中' : video ? `生成中 ${progress}%` : `正在生成${typeLabel(item)}`),
    video && h('div', { class: 'bar wide' }, h('div', { class: 'bar-fill', style: { width: `${item.status === 'queued' ? 4 : Math.max(6, progress)}%` } })),
    h('div', { class: 'small muted' }, item.pollError ? `查询状态出错：${item.pollError}` : WAIT_HINTS[typeOf(item)]),
  );
}

// 一张卡片只有画面。提示词、参数、时间都在详情里，点画面打开；
// 操作收在画面右上角的「更多」里，鼠标移上去才出现。
function buildCard(item) {
  const mediaEl = mediaBox(item);
  const more = h('button', { class: 'card-more', type: 'button', title: '更多', 'aria-label': '更多操作', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onClick: () => openCardMenu(more, item.id) }, icon('more', 16));
  const el = h(
    'article',
    { class: `card status-${item.status}`, 'aria-label': nameOf(item) },
    // 控制条和「更多」上的点击各管各的，不算在"点画面打开详情"里。
    h('div', { class: 'card-media', onClick: (e) => !e.target.closest('.player-bar, .audio-controls, .card-more') && openDetail(item.id) }, mediaEl, more),
  );
  return { el, mediaEl };
}

// 详情右边「生成参数」那一组：一格一项，名称在上、取值在下。第三个值为 true 的独占一行。
function paramsOf(item) {
  const p = item.payload || {};
  if (item.kind === 'image') return [['模型', item.model], ['画面比例', p.aspect_ratio]];
  if (item.tool === 'speech') return [['模型', item.model], ['音色', p.voice_name || p.voice_id]];
  if (item.tool === 'sfx') {
    return [['模型', item.model], ['时长', p.duration_seconds ? `${p.duration_seconds} 秒` : '由模型决定'], ['和描述的贴合度', p.prompt_influence]];
  }
  if (item.tool === 'music') return [['模型', item.model], ['视频时长', p.duration_seconds && `${Math.round(p.duration_seconds * 10) / 10} 秒`]];
  const ratio = p.ratio || p.aspect_ratio;
  return [
    ['模式', modeOf(item)],
    ['模型', item.model],
    ['分辨率', p.resolution],
    ['画面比例', ratio === 'adaptive' ? '自适应' : ratio],
    ['时长', p.duration === -1 ? '由模型决定' : p.duration && `${p.duration} 秒`],
    ['同步音频', p.generate_audio === undefined ? null : p.generate_audio ? '开' : '关'],
    ['水印', p.watermark === undefined ? null : p.watermark ? '开' : '关'],
    ['随机种子', p.seed],
    ['联网搜索', p.web_search ? '开' : null],
    ['输入模式', p.input_type],
    ['画质超分', describeSuperResolution(p.super_resolution_config), true],
  ];
}

export function openDetail(id) {
  const item = state.history.find((i) => i.id === id);
  if (!item) return;
  // 详情里的视频会自动播放，先停掉列表里正在放的，免得两个声音叠在一起。
  for (const media of document.querySelectorAll('.card video, .card audio')) media.pause();
  const refs = refsOf(item);
  const present = ([, value]) => value != null && value !== '' && value !== false;
  const kindLabel = KIND_LABELS[item.kind];
  const params = paramsOf(item).filter(present);

  // 任务信息：一行一项。
  const facts = [
    ['状态', STATUS_LABELS[item.status] || item.status],
    ['失败原因', item.error ? `${item.error.message}${item.error.code ? `（${item.error.code}）` : ''}` : null],
    ['任务 ID', h('span', { class: 'mono copyable', title: '点击复制', onClick: () => copyText(item.id, '已复制任务 ID') }, item.id)],
    ['提交时间', fmtTime(item.createdAt)],
    ['生成耗时', item.completedAt && item.createdAt ? fmtDuration(item.completedAt - item.createdAt) : null],
    ['Token 用量', item.usage?.total_tokens != null ? String(item.usage.total_tokens) : null],
    ['费用', item.usage?.cost_usd != null ? `约 $${item.usage.cost_usd.toFixed(2)}` : null],
    [`${kindLabel}文件`, item.status !== 'completed' ? null : item.savedLocally ? `已保存到本机${item.fileSize ? `（${fmtBytes(item.fileSize)}）` : ''}` : item.downloadError ? `还没存到本机：${item.downloadError}` : '正在保存到本机…'],
  ].filter(present);

  const section = (title, content, action) => h('section', { class: 'detail-section' }, h('header', { class: 'detail-section-head' }, h('h3', null, title), action), content);
  // 关掉详情再去做下一件事。
  const leaveTo = (label, action) => h('button', { class: 'btn', onClick: () => { modal.close(); action(item); } }, label);
  const modal = openModal({
    title: '生成详情',
    size: 'lg',
    content: h(
      'div',
      { class: 'detail' },
      // 左边：结果，以及能对它做的事。
      h(
        'div',
        { class: 'detail-main' },
        h('div', { class: `detail-media ${item.kind === 'audio' && done(item) ? 'is-audio' : ''}` }, mediaBox(item, true)),
        h(
          'div',
          { class: 'detail-actions' },
          done(item) && downloadLink(item, `下载${kindLabel}`, 'btn btn-primary'),
          leaveTo('复用参数', reuse),
          done(item) && item.kind === 'video' && state.catalog.audio.music && leaveTo('配乐', score),
          done(item) && item.kind === 'image' && leaveTo('生成视频', animate),
          isTimedOutTask(item) && leaveTo('再查一次', recheck),
          !item.savedLocally && item.status === 'completed' && !item.direct && h('button', { class: 'btn', onClick: () => refresh(item).then(() => toast('已重新尝试保存', 'info')) }, '重新保存到本机'),
        ),
      ),
      // 右边：只放信息，分成几组。配乐没有提示词，就没有第一组。
      h(
        'div',
        { class: 'detail-side' },
        item.tool !== 'music' &&
          section(
            item.tool === 'speech' ? '朗读的文字' : '提示词',
            h('p', { class: 'detail-prompt' }, item.prompt || '（没有提示词）'),
            item.prompt && h('button', { class: 'entry-action-btn', type: 'button', onClick: () => copyText(item.prompt, '已复制') }, '复制'),
          ),
        refs.length ? section('参考素材', h('div', { class: 'card-refs' }, refs.map((r) => h('span', { class: 'mini-thumb', title: r.name }, thumbEl(r.thumb, r.kind))))) : null,
        section('生成参数', h('dl', { class: 'param-grid' }, params.map(([k, v, wide]) => h('div', { class: wide ? 'param wide' : 'param' }, h('dt', null, k), h('dd', null, v))))),
        section('任务信息', h('dl', { class: 'kv' }, facts.map(([k, v]) => [h('dt', null, k), h('dd', null, v)]))),
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

// 画面要不要重画，看这几项有没有变。视频存到本机后地址会变，但画面不用重画：重画会打断正在播放的视频。
const mediaSignature = (i) => JSON.stringify([i.status, i.progress, Boolean(i.mediaUrl), i.error?.message, i.pollError]);

// 把一组记录画成卡片网格。只重画有变化的部分，正在播放的视频不会被打断。
function cardGrid(emptyState) {
  const grid = h('div', { class: 'card-grid' });
  const cards = new Map();

  function draw(list) {
    if (!list.length) {
      cards.clear();
      clear(grid).append(emptyState());
      return;
    }
    const wanted = new Set(list.map((i) => i.id));
    for (const [id, entry] of cards) {
      if (!wanted.has(id)) {
        entry.el.remove();
        cards.delete(id);
      }
    }
    grid.querySelector('.empty')?.remove();
    let previous = null;
    for (const item of list) {
      const media = mediaSignature(item);
      let entry = cards.get(item.id);
      if (!entry) {
        entry = { ...buildCard(item), media };
        cards.set(item.id, entry);
      } else if (entry.media !== media) {
        // 卡片本身留着，只换画面那一块：右上角打开着的菜单不会因为进度更新而被关掉。
        const next = mediaBox(item);
        entry.mediaEl.replaceWith(next);
        entry.mediaEl = next;
        entry.el.className = `card status-${item.status}`;
        entry.media = media;
      }
      const expectedNext = previous ? previous.nextSibling : grid.firstChild;
      if (expectedNext !== entry.el) grid.insertBefore(entry.el, expectedNext);
      previous = entry.el;
    }
  }

  return { grid, draw };
}

// 创作页输入框下面：只列最新的几条，刚提交的任务在这里看进度。
export function renderRecent(root) {
  const allButton = h('button', { class: 'entry-action-btn', type: 'button', onClick: () => goTo('records') });
  const { grid, draw } = cardGrid(() =>
    h(
      'div',
      { class: 'empty' },
      h('div', { class: 'empty-title' }, state.historyLoaded ? '还没有生成过内容' : '正在读取记录…'),
      state.historyLoaded ? h('div', { class: 'muted' }, '在上面写下提示词，点右下角的发送键。生成的结果和参数都会保存下来。') : null,
    ),
  );
  const update = () => {
    allButton.textContent = `查看全部 ${state.history.length} 条`;
    allButton.hidden = state.history.length <= RECENT_COUNT;
    draw(state.history.slice(0, RECENT_COUNT));
  };

  root.append(h('section', { class: 'feed' }, h('header', { class: 'feed-head' }, h('h2', null, '最近生成'), allButton), grid));
  update();
  on('history', update);
}

// 「创作记录」页：全部记录，可以按状态和类型筛选、按提示词搜索。
export function renderRecords(root) {
  let filter = 'all';
  let kind = 'all';
  let query = '';
  const filterEl = h('div');
  const kindEl = h('div');
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
  const { grid, draw: drawCards } = cardGrid(() =>
    h(
      'div',
      { class: 'empty' },
      h('div', { class: 'empty-title' }, !state.historyLoaded ? '正在读取记录…' : state.history.length ? '没有符合条件的记录' : '还没有生成过内容'),
      state.historyLoaded && !state.history.length ? h('div', { class: 'muted' }, '点左边的「新建创作」开始。生成的结果和参数都会保存在这里。') : null,
    ),
  );

  function drawFilter() {
    // 状态旁边的数字跟着类型走：选了「图片」，数的就只是图片。
    const pool = state.history.filter(ofKind);
    const count = (fn) => pool.filter(fn).length;
    clear(kindEl).append(
      dropdown({
        label: '类型',
        value: kind,
        options: [{ value: 'all', label: '全部类型' }, ...Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label }))],
        onChange: (next) => {
          kind = next;
          draw();
        },
      }),
    );
    clear(filterEl).append(
      segmented(
        [
          { value: 'all', label: `全部 ${pool.length}` },
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

  const ofKind = (item) => kind === 'all' || item.kind === kind;

  function draw() {
    drawFilter();
    const list = state.history.filter((item) => {
      if (!ofKind(item)) return false;
      if (filter === 'pending' && !isPendingTask(item)) return false;
      if ((filter === 'completed' || filter === 'failed') && item.status !== filter) return false;
      return !query || (item.prompt || '').toLowerCase().includes(query);
    });
    countEl.textContent = query || filter !== 'all' || kind !== 'all' ? `显示 ${list.length} 条` : '';
    drawCards(list);
  }

  root.append(
    h(
      'div',
      { class: 'page' },
      h('header', { class: 'page-head' }, h('div', null, h('h1', null, '创作记录'), h('p', { class: 'muted' }, '生成过的全部视频、图片和音频。点画面看详情，点「复用」把那次的参数填回创作面板。'))),
      h('div', { class: 'page-tools' }, filterEl, h('div', { class: 'feed-tools' }, countEl, kindEl, search)),
      grid,
    ),
  );
  draw();
  on('history', draw);
}
