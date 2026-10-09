// 生成记录：任务进度、播放、下载、复用参数、详情。视频、图片、音频（语音、音效、配乐）都在这里。
// 有两处用到：创作页输入框下面的「最近生成」（只列最新几条），和单独的「创作记录」页（全部，带筛选和搜索）。

import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { api, state, emit, useStore, loadHistory, isPendingTask, isTimedOutTask, goTo } from './store.ts';
import { fmtTime, fmtDuration, fmtBytes } from './format.ts';
import { videoFamily } from './request.ts';
import { stopPlaying } from './playback.ts';
import { VideoPlayer, AudioPlayer } from './player.tsx';
import { Thumb } from './assets.tsx';
import { Icon } from './ui/Icon.tsx';
import { Segmented, tip, clipTip } from './ui/controls.tsx';
import { toast, openModal, openMenu, confirmDialog, copyText } from './ui/layers.tsx';
import { enter } from './ui/motion.ts';
import { setForm, setStudio, useImageForVideo, useVideoForMusic, useVideoAsSource } from './composer/state.ts';
import { VIDEO_TASKS, videoFamilyOf, referenceModeLabel, type VideoTask } from '../../shared/models.ts';
import type { CreateType, HistoryItem, Ref } from './types.ts';

const MODE_LABELS: Record<string, string> = { text: '文生视频', frames: '首尾帧' };
const STATUS_LABELS: Record<string, string> = { queued: '排队中', in_progress: '生成中', completed: '已完成', failed: '失败' };
const KIND_LABELS = { video: '视频', image: '图片', audio: '音频' };
// 五种内容，和创作页输入框上方的切换是同一组。
const TYPE_LABELS: Record<CreateType, string> = { video: '视频', image: '图片', speech: '语音', sfx: '音效', music: '配乐' };
// 生成中的卡片上那句说明：各种内容要等多久差别很大。
const WAIT_HINTS: Record<CreateType, string> = { video: '通常需要几分钟，可以关掉页面，回来再看', image: '通常十几秒', speech: '通常几秒', sfx: '通常几秒', music: '通常不到一分钟' };

const message = (err: unknown) => (err as Error).message;

// 这条记录是哪种内容：视频、图片，或者音频里的语音、音效、配乐。
const typeOf = (item: HistoryItem): CreateType => (item.kind === 'audio' ? item.tool! : item.kind);
const typeLabel = (item: HistoryItem) => TYPE_LABELS[typeOf(item)];
// 没有提示词的记录（配乐）用它的类型来称呼。
const nameOf = (item: HistoryItem) => item.prompt || typeLabel(item);
const done = (item: HistoryItem) => item.status === 'completed' && Boolean(item.mediaUrl);

const RECENT_COUNT = 6;

function modeOf(item: HistoryItem) {
  if (videoFamily(item.model) === 'grok') return item.payload?.image || item.payload?.frame_images?.length ? '图生视频' : '文生视频';
  const mode = seedanceModeOf(item);
  return mode === 'reference' ? referenceModeLabel(item.model) : MODE_LABELS[mode];
}

function seedanceModeOf(item: HistoryItem): string {
  if (item.form?.mode) return item.form.mode;
  const roles: string[] = (item.payload?.content || []).map((c: { role?: string }) => c.role).filter(Boolean);
  if (roles.some((r) => r === 'first_frame' || r === 'last_frame')) return 'frames';
  return roles.length ? 'reference' : 'text';
}

function refsOf(item: HistoryItem): Ref[] {
  const f = item.form;
  if (!f || item.kind !== 'video') return [];
  if (videoFamily(item.model) === 'grok') return f.mode === 'frames' && f.frames?.first ? [f.frames.first] : [];
  if (f.mode === 'frames') return [f.frames?.first, f.frames?.last].filter(Boolean);
  if (f.mode === 'reference') return [...(f.refs?.image || []), ...(f.refs?.video || []), ...(f.refs?.audio || [])];
  return [];
}

// ---------- 对一条记录能做的事 ----------

async function removeItem(item: HistoryItem) {
  const ok = await confirmDialog({
    title: '删除这条记录？',
    message: '只删除本机上的记录和已保存的文件，不影响平台上的任务和计费。删除后无法恢复。',
    okText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api('DELETE', `/api/history/${encodeURIComponent(item.id)}`);
    await loadHistory();
  } catch (err) {
    toast(message(err), 'error');
  }
}

function reuse(item: HistoryItem) {
  if (item.kind !== 'video') {
    setStudio(typeOf(item) as 'image' | 'speech' | 'sfx' | 'music', item.form || { prompt: item.prompt });
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

async function refresh(item: HistoryItem) {
  try {
    await api('POST', `/api/history/${encodeURIComponent(item.id)}/refresh`);
    await loadHistory();
  } catch (err) {
    toast(message(err), 'error');
  }
}

// 查询超时的任务：再向平台查一次，并说明这次查到了什么。
async function recheck(item: HistoryItem) {
  try {
    const next = await api<HistoryItem>('POST', `/api/history/${encodeURIComponent(item.id)}/refresh`);
    await loadHistory();
    if (next.status === 'completed') toast('任务已经完成', 'success');
    else if (isTimedOutTask(next)) toast(next.pollError ? `查询状态出错：${next.pollError}` : '还是没有结果', 'info');
  } catch (err) {
    toast(message(err), 'error');
  }
}

// 把一张生成的图片拿去生成视频。Seedance 要先把图传进素材库，会等一小会儿。
async function animate(item: HistoryItem) {
  try {
    await useImageForVideo(item);
    toast('已选好这张图，写下提示词就可以生成视频', 'success');
  } catch (err) {
    toast(message(err), 'error', 6000);
  }
}

// 延长或编辑一条视频。只有 Flatkey 上的 Seedance 能做（要把视频传进素材库当参考），用的是 OpenRouter 或者账号里没有 Seedance 型号时不出现这两个入口。
const canRework = (item: HistoryItem) => done(item) && item.kind === 'video' && state.app.provider === 'flatkey' && state.models.some((id) => videoFamilyOf(id) === 'seedance');
async function rework(item: HistoryItem, task: VideoTask) {
  if (!item.savedLocally) return toast('这条视频还没保存到本机，稍后再试', 'info');
  try {
    await useVideoAsSource(item, task);
    toast(`已选好这段视频，${VIDEO_TASKS[task].hint}`, 'success');
  } catch (err) {
    toast(message(err), 'error', 6000);
  }
}

async function score(item: HistoryItem) {
  if (!item.savedLocally) return toast('这条视频还没保存到本机，稍后再试', 'info');
  await useVideoForMusic(item);
  toast('已选好这段视频，点右下角的发送键生成配乐', 'success');
}

// 已经存到本机的直接下载，还没存下来的在新标签页打开原地址。
const downloadProps = (item: HistoryItem): { href?: string; download?: string; target?: string } => (item.savedLocally ? { href: `${item.mediaUrl}?download=1`, download: '' } : { href: item.mediaUrl, target: '_blank' });

function download(item: HistoryItem) {
  const link = document.createElement('a');
  link.rel = 'noopener';
  for (const [name, value] of Object.entries(downloadProps(item))) link.setAttribute(name, value);
  document.body.append(link);
  link.click();
  link.remove();
}

// 卡片右上角的「更多」。菜单内容按点开那一刻的状态来定：生成中的可以刷新，查询超时的可以再查一次，已完成的可以下载。
// 已完成的视频可以拿去配乐，已完成的图片可以拿去生成视频。
function openCardMenu(button: HTMLElement, id: string, scope: Scope) {
  const item = state.history.find((i) => i.id === id);
  if (!item) return;
  const actions: Record<string, () => void> = {
    download: () => download(item),
    refresh: () => refresh(item),
    recheck: () => recheck(item),
    reuse: () => reuse(item),
    score: () => score(item),
    extend: () => rework(item, 'extend'),
    edit: () => rework(item, 'edit'),
    animate: () => animate(item),
    detail: () => openDetail(item.id, scope),
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
      canRework(item) && { value: 'extend', label: VIDEO_TASKS.extend.label },
      canRework(item) && { value: 'edit', label: VIDEO_TASKS.edit.label },
      done(item) && item.kind === 'video' && state.catalog.audio.music && { value: 'score', label: '配乐' },
      done(item) && item.kind === 'image' && { value: 'animate', label: '生成视频' },
      { value: 'detail', label: '详情' },
      { value: 'remove', label: '删除', danger: true },
    ].filter((entry) => Boolean(entry)) as { value: string; label: string; danger?: boolean }[],
    onSelect: (value) => actions[value](),
  });
}

// ---------- 画面 ----------

// 图片：比例和画框差不多就铺满，差得多（比如竖图）就完整显示、两边留底色，不裁画面。详情里总是完整显示。
function ImageView({ item, large }: { item: HistoryItem; large: boolean }) {
  const [cover, setCover] = useState(false);
  return (
    <div className="image-view">
      <img
        className={`media-image${cover ? ' cover' : ''}`}
        src={item.mediaUrl}
        alt={item.prompt || '生成的图片'}
        onLoad={large ? undefined : (e) => setCover(Math.abs(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight / (16 / 9) - 1) < 0.03)}
      />
    </div>
  );
}

function AudioView({ item, large }: { item: HistoryItem; large: boolean }) {
  const voice = item.tool === 'speech' && item.payload?.voice_name;
  // 详情里的配乐：原视频还在本机的话，画面和音乐一起放，才听得出配得怎么样。
  const source = item.tool === 'music' && item.form?.video?.url;
  if (large && source) return <VideoPlayer src={source} soundtrack={item.mediaUrl} autoplay label="配乐预览" />;
  // 配乐没有提示词，写上它是给多长的视频配的。
  const seconds = item.tool === 'music' && Math.round(item.payload?.duration_seconds || 0);
  const text = item.prompt || (seconds ? `给一段 ${seconds} 秒的视频配的音乐` : '');
  return <AudioPlayer src={item.mediaUrl} kind={voice ? `${typeLabel(item)} · ${voice}` : typeLabel(item)} text={text} label={nameOf(item)} />;
}

// 平台返回的失败原因是英文的。认识的换成人话，并说一句可以怎么办；不认识的原样显示，只去掉末尾的请求编号。
// 只登记实际遇到过的。
const KNOWN_FAILURES: [RegExp, string][] = [[/output audio .*copyright/i, '生成的声音可能涉及版权，被平台拦下了。可以关掉「更多」里的「生成有声视频」再试一次。']];
function explainFailure(message?: string) {
  if (!message) return '未知错误';
  return KNOWN_FAILURES.find(([pattern]) => pattern.test(message))?.[1] || message.replace(/\s*Request id:.*$/i, '').trim();
}

function MediaBox({ item, large = false }: { item: HistoryItem; large?: boolean }) {
  if (done(item)) {
    if (item.kind === 'image') return <ImageView item={item} large={large} />;
    if (item.kind === 'audio') return <AudioView item={item} large={large} />;
    return <VideoPlayer src={item.videoUrl} autoplay={large} clickToPlay={large} frameRatio={large ? null : 16 / 9} showLength={!large} label={item.prompt || '生成的视频'} />;
  }
  if (item.status === 'failed') {
    const reason = explainFailure(item.error?.message);
    return (
      <div className="card-state is-failed">
        <span className="state-mark">
          <Icon name="alert" size={18} />
        </span>
        <div className="state-title">{isTimedOutTask(item) ? '查询超时' : '生成失败'}</div>
        {/* 原因最多两行，放不下的悬停看全文，点开详情也有。 */}
        <div className="state-text" {...clipTip(reason)}>
          {reason}
        </div>
        {item.kind === 'video' && !isTimedOutTask(item) && <div className="state-note">预扣的余额会自动退还</div>}
      </div>
    );
  }
  if (item.status === 'completed') {
    return (
      <div className="card-state">
        <div className="state-title">已完成，但没有拿到{KIND_LABELS[item.kind]}地址</div>
      </div>
    );
  }
  // 只有视频任务会报进度；其余的只知道还在生成。
  const video = item.kind === 'video';
  const progress = Math.max(0, Math.min(100, item.progress || 0));
  return (
    <div className="card-state is-pending">
      <div className="state-title cursor-text">{item.status === 'queued' ? '排队中' : video ? `生成中 ${progress}%` : `正在生成${typeLabel(item)}`}</div>
      {video && (
        <div className="bar wide">
          <div className="bar-fill" style={{ width: `${item.status === 'queued' ? 4 : Math.max(6, progress)}%` }} />
        </div>
      )}
      <div className="small muted">{item.pollError ? `查询状态出错：${item.pollError}` : WAIT_HINTS[typeOf(item)]}</div>
    </div>
  );
}

// 画面要不要重画，看这几项有没有变。视频存到本机后地址会变，但画面不用重画：重画会打断正在播放的视频。
const mediaSignature = (i: HistoryItem) => JSON.stringify([i.status, i.progress, Boolean(i.mediaUrl), i.error?.message, i.pollError]);
const CardMedia = memo(
  ({ item }: { item: HistoryItem; signature: string }) => <MediaBox item={item} />,
  (before, after) => before.signature === after.signature,
);

// 一张卡片只有画面。提示词、参数、时间都在详情里，点画面打开；
// 操作收在画面右上角的「更多」里，鼠标移上去才出现。
// index 是它在列表里排第几：一批卡片一起出现时，靠后的晚一点进场。新提交的任务排在最前，单独进场。
function Card({ item, index, scope }: { item: HistoryItem; index: number; scope: Scope }) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    enter(ref.current, { y: 8, duration: 260, delay: Math.min(index, 8) * 35 });
  }, []);
  return (
    <article ref={ref} className={`card status-${item.status}`} aria-label={nameOf(item)}>
      {/* 控制条和「更多」上的点击各管各的，不算在"点画面打开详情"里。 */}
      <div className="card-media" onClick={(e) => !(e.target as Element).closest('.player-bar, .audio-controls, .card-more') && openDetail(item.id, scope)}>
        <CardMedia item={item} signature={mediaSignature(item)} />
        <button className="card-more" type="button" {...tip('更多')} aria-label="更多操作" aria-haspopup="menu" aria-expanded="false" onClick={(e) => openCardMenu(e.currentTarget, item.id, scope)}>
          <Icon name="more" size={16} />
        </button>
      </div>
    </article>
  );
}

// 把一组记录画成卡片网格。卡片按记录的 id 对应，进度更新时正在播放的视频不会被打断。
// 详情里的上一条、下一条就在这一组里走，所以把这一组当前的样子交给卡片。
// all 是只画出前几条时的完整一组：创作页只列最近几条，但在详情里可以一直往后翻。
function CardGrid({ list, all = list, empty }: { list: HistoryItem[]; all?: HistoryItem[]; empty: ReactNode }) {
  const latest = useRef(all);
  latest.current = all;
  const scope = useRef<Scope>(() => latest.current).current;
  return <div className="card-grid">{list.length ? list.map((item, index) => <Card key={item.id} item={item} index={index} scope={scope} />) : empty}</div>;
}

// ---------- 详情 ----------

const SR_SCENE_LABELS: Record<string, string> = { aigc: 'AIGC 内容', short_series: '短剧', ugc: 'UGC', old_film: '老片' };

function describeSuperResolution(sr?: Record<string, any>) {
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

type Entry = [name: string, value: ReactNode, wide?: boolean];
const present = ([, value]: Entry) => value != null && value !== '' && value !== false;

// 详情右边「生成参数」那一组：一格一项，名称在上、取值在下。第三个值为 true 的独占一行。
// 型号名长（OpenRouter 的还带厂商前缀），挤在一格里会从中间断行，所以「模型」独占一行。
function paramsOf(item: HistoryItem): Entry[] {
  const p = item.payload || {};
  if (item.kind === 'image') return [['模型', item.model, true], ['画面比例', p.aspect_ratio]];
  if (item.tool === 'speech') return [['模型', item.model, true], ['音色', p.voice_name || p.voice_id]];
  if (item.tool === 'sfx') {
    return [['模型', item.model, true], ['时长', p.duration_seconds ? `${p.duration_seconds} 秒` : '由模型决定'], ['和描述的贴合度', p.prompt_influence]];
  }
  if (item.tool === 'music') return [['模型', item.model, true], ['视频时长', p.duration_seconds && `${Math.round(p.duration_seconds * 10) / 10} 秒`]];
  const ratio = p.ratio || p.aspect_ratio;
  return [
    ['模式', modeOf(item)],
    ['模型', item.model, true],
    ['分辨率', p.resolution],
    ['画面比例', ratio === 'adaptive' ? '自适应' : ratio],
    ['时长', p.duration === -1 ? '由模型决定' : p.duration && `${p.duration} 秒`],
    ['生成有声视频', p.generate_audio === undefined ? null : p.generate_audio ? '开' : '关'],
    ['水印', p.watermark === undefined ? null : p.watermark ? '开' : '关'],
    ['随机种子', p.seed],
    ['联网搜索', p.web_search ? '开' : null],
    ['输入模式', p.input_type],
    ['画质超分', describeSuperResolution(p.super_resolution_config), true],
  ];
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="detail-section">
      <header className="detail-section-head">
        <h3>{title}</h3>
        {action}
      </header>
      {children}
    </section>
  );
}

// 详情里上一条、下一条走的那一组记录：从哪个列表点开的，就在哪个列表里走。
type Scope = () => HistoryItem[];

// 详情弹窗里的内容。弹窗开着的时候可以直接换到上一条、下一条，不用关掉再点另一张。
function DetailView({ id, scope, close }: { id: string; scope: Scope; close: () => void }) {
  useStore('history');
  const [current, setCurrent] = useState(id);
  const list = scope();
  const index = list.findIndex((i) => i.id === current);
  const item = list[index] || state.history.find((i) => i.id === current);
  const step = (by: number) => {
    const next = list[index + by];
    if (index < 0 || !next) return;
    stopPlaying();
    setCurrent(next.id);
  };
  // 上下方向键也能换。正在输入框里、或者上面还盖着别的弹窗和菜单时不管。
  const stepRef = useRef(step);
  stepRef.current = step;
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.target as Element).closest?.('input, textarea, [contenteditable], [role=menu]')) return;
      const modals = document.querySelectorAll('.modal');
      if (modals[modals.length - 1] !== root.current?.closest('.modal') || document.querySelector('.menu')) return;
      e.preventDefault();
      stepRef.current(e.key === 'ArrowUp' ? -1 : 1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  // 这条记录被删掉了，详情也就没有可看的了。
  useEffect(() => {
    if (!item) close();
  }, [item]);
  if (!item) return null;
  const nav = (by: number, label: string) => (
    <button className={`detail-nav-btn ${by < 0 ? 'is-prev' : ''}`} type="button" aria-label={label} disabled={index < 0 || !list[index + by]} onClick={() => step(by)} {...tip(label)}>
      <Icon name="chevron" size={18} />
    </button>
  );
  return (
    <div ref={root} className="detail">
      <Detail key={item.id} item={item} close={close} nav={<div className="detail-nav">{nav(-1, '上一条')}{nav(1, '下一条')}</div>} />
    </div>
  );
}

function Detail({ item, close, nav }: { item: HistoryItem; close: () => void; nav: ReactNode }) {
  const refs = refsOf(item);
  const kindLabel = KIND_LABELS[item.kind];
  const params = paramsOf(item).filter(present);
  // 任务信息：一行一项。
  const facts = (
    [
      ['状态', STATUS_LABELS[item.status] || item.status],
      ['失败原因', item.error ? `${item.error.message}${item.error.code ? `（${item.error.code}）` : ''}` : null],
      [
        '任务 ID',
        <span className="mono copyable" {...tip('点击复制')} onClick={() => copyText(item.id, '已复制任务 ID')}>
          {item.id}
        </span>,
      ],
      ['提交时间', fmtTime(item.createdAt)],
      ['生成耗时', item.completedAt && item.createdAt ? fmtDuration(item.completedAt - item.createdAt) : null],
      ['Token 用量', item.usage?.total_tokens != null ? String(item.usage.total_tokens) : null],
      ['费用', item.usage?.cost_usd != null ? `约 $${item.usage.cost_usd.toFixed(2)}` : null],
      [`${kindLabel}文件`, item.status !== 'completed' ? null : item.savedLocally ? `已保存到本机${item.fileSize ? `（${fmtBytes(item.fileSize)}）` : ''}` : item.downloadError ? `还没存到本机：${item.downloadError}` : '正在保存到本机…'],
    ] as Entry[]
  ).filter(present);

  // 关掉详情再去做下一件事。
  const leaveTo = (label: string, action: (item: HistoryItem) => void) => (
    <button
      className="btn"
      onClick={() => {
        close();
        action(item);
      }}
    >
      {label}
    </button>
  );

  // 能对这条结果做的事，放在右边最下面。
  const actions = (
    <div className="detail-actions">
      {done(item) && (
        <a className="btn btn-primary" rel="noopener" {...downloadProps(item)}>
          下载{kindLabel}
        </a>
      )}
      {leaveTo('复用参数', reuse)}
      {canRework(item) && leaveTo(VIDEO_TASKS.extend.label, (it) => rework(it, 'extend'))}
      {canRework(item) && leaveTo(VIDEO_TASKS.edit.label, (it) => rework(it, 'edit'))}
      {done(item) && item.kind === 'video' && state.catalog.audio.music && leaveTo('配乐', score)}
      {done(item) && item.kind === 'image' && leaveTo('生成视频', animate)}
      {isTimedOutTask(item) && leaveTo('再查一次', recheck)}
      {!item.savedLocally && item.status === 'completed' && !item.direct && (
        <button className="btn" onClick={() => refresh(item).then(() => toast('已重新尝试保存', 'info'))}>
          重新保存到本机
        </button>
      )}
    </div>
  );

  return (
    <>
      {/* 左边：结果。画框的大小是固定的，画面在里面完整显示。 */}
      <div className={`detail-media ${item.kind === 'audio' && done(item) ? 'is-audio' : ''}`}>
        <MediaBox item={item} large />
      </div>
      {nav}
      {/* 右边：上面是信息，分成几组，放不下就在这一栏里滚动；下面是能对它做的事。配乐没有提示词，就没有第一组。 */}
      <div className="detail-side">
        <div className="detail-info">
          {item.tool !== 'music' && (
            <Section
              title={item.tool === 'speech' ? '朗读的文字' : '提示词'}
              action={
                item.prompt && (
                  <button className="entry-action-btn" type="button" onClick={() => copyText(item.prompt!, '已复制')}>
                    复制
                  </button>
                )
              }
            >
              <p className="detail-prompt">{item.prompt || '（没有提示词）'}</p>
            </Section>
          )}
          {refs.length > 0 && (
            <Section title="参考素材">
              <div className="card-refs">
                {refs.map((r) => (
                  <span key={r.uid} className="mini-thumb" {...tip(r.name)} aria-label={r.name}>
                    <Thumb thumb={r.thumb} kind={r.kind} />
                  </span>
                ))}
              </div>
            </Section>
          )}
          <Section title="生成参数">
            <dl className="param-grid">
              {params.map(([name, value, wide]) => (
                <div key={name} className={wide ? 'param wide' : 'param'}>
                  <dt>{name}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </Section>
          <Section title="任务信息">
            <dl className="kv">
              {facts.flatMap(([name, value]) => [<dt key={`${name}-name`}>{name}</dt>, <dd key={`${name}-value`}>{value}</dd>])}
            </dl>
          </Section>
        </div>
        {actions}
      </div>
    </>
  );
}

export function openDetail(id: string, scope: Scope = () => state.history) {
  if (!state.history.some((i) => i.id === id)) return;
  // 详情盖住了列表，先停掉列表里正在放的。详情是图片、或者自动播放被浏览器拦下时，没有新的播放来顶掉它。
  stopPlaying();
  const modal = openModal({ title: '生成详情', size: 'detail', content: <DetailView id={id} scope={scope} close={() => modal.close()} /> });
}

// ---------- 两处列表 ----------

// 创作页输入框下面：只列当前这种内容最新的几条，刚提交的任务在这里看进度。上面切换类型，这里跟着换。
export function Recent() {
  useStore('history', 'createType');
  const type = state.createType;
  const list = state.history.filter((item) => typeOf(item) === type);
  const feed = useRef<HTMLElement>(null);
  // 打开页面时排在问句、输入框之后进场。
  useLayoutEffect(() => {
    enter(feed.current, { y: 12, duration: 420, delay: 270 });
  }, []);
  return (
    <section ref={feed} className="feed">
      <header className="feed-head">
        <h2>最近生成</h2>
        <button
          className="entry-action-btn"
          type="button"
          hidden={list.length <= RECENT_COUNT}
          onClick={() => {
            state.recordsType = type;
            emit('recordsType');
            goTo('records');
          }}
        >
          查看全部 {list.length} 条
        </button>
      </header>
      <CardGrid
        list={list.slice(0, RECENT_COUNT)}
        all={list}
        empty={
          <div className="empty">
            <div className="empty-title">{state.historyLoaded ? `还没有生成过${TYPE_LABELS[type]}` : '正在读取记录…'}</div>
            {state.historyLoaded ? <div className="muted">生成的结果和参数都会保存下来，在这里看进度。</div> : null}
          </div>
        }
      />
    </section>
  );
}

// 记录页的类型筛选，和创作页输入框上方的切换是同一组。
const TYPE_FILTERS = [{ value: 'all' as const, label: '全部' }, ...(Object.keys(TYPE_LABELS) as CreateType[]).map((value) => ({ value, label: TYPE_LABELS[value] }))];

// 搜索用得少，平时只是一个图标，点了才展开成输入框；清空并离开后收回去。
function SearchBox({ onQuery }: { onQuery: (query: string) => void }) {
  const [open, setOpen] = useState(false);
  const field = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    enter(field.current, { y: 0, scale: 0.96, duration: 150 });
    input.current?.focus();
  }, [open]);
  if (!open) {
    return (
      <button className="icon-btn" type="button" aria-label="搜索提示词" {...tip('搜索提示词')} onClick={() => setOpen(true)}>
        <Icon name="search" />
      </button>
    );
  }
  const close = () => {
    onQuery('');
    setOpen(false);
  };
  return (
    <div ref={field} className="search-field">
      <Icon name="search" />
      <input
        ref={input}
        className="input search"
        type="search"
        placeholder="搜索提示词"
        aria-label="搜索提示词"
        onInput={(e) => onQuery(e.currentTarget.value.trim().toLowerCase())}
        onBlur={(e) => !e.currentTarget.value.trim() && close()}
        onKeyDown={(e) => e.key === 'Escape' && close()}
      />
    </div>
  );
}

// 「创作记录」页：全部记录，可以按类型筛选、按提示词搜索。
export function Records() {
  useStore('history', 'recordsType');
  const [query, setQuery] = useState('');
  const type = state.recordsType;
  const list = state.history.filter((item) => (type === 'all' || typeOf(item) === type) && (!query || (item.prompt || '').toLowerCase().includes(query)));
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>创作记录</h1>
          <p className="muted">生成过的全部视频、图片和音频。点画面看详情，点「复用」把那次的参数填回创作面板。</p>
        </div>
      </header>
      <div className="page-tools">
        <div>
          <Segmented
            options={TYPE_FILTERS}
            value={type}
            onChange={(next) => {
              state.recordsType = next;
              emit('recordsType');
            }}
            className="filters"
          />
        </div>
        <SearchBox onQuery={setQuery} />
      </div>
      <CardGrid
        list={list}
        empty={
          <div className="empty">
            <div className="empty-title">{!state.historyLoaded ? '正在读取记录…' : state.history.length ? '没有符合条件的记录' : '还没有生成过内容'}</div>
            {state.historyLoaded && !state.history.length ? <div className="muted">点左边的「创作」开始。生成的结果和参数都会保存在这里。</div> : null}
          </div>
        }
      />
    </div>
  );
}
