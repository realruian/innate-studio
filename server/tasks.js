// 生成记录的一生：建记录、向平台查进度、把结果存到本机。
// 两种来历：视频是平台上的异步任务，要轮询；图片和语音是一次请求直接返回结果（direct），请求在后台跑完再写回记录。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ARK, MINIMAX, MEDIA_DIRS, POLL_INTERVAL_MS, MAX_PENDING_MS, DOWNLOAD_RETRY_MS, MAX_DOWNLOAD_ATTEMPTS } from './config.js';
import { HttpError } from './http.js';
import { openSpaces } from './store.js';
import { apiKey, minimaxKey } from './keys.js';
import { callArk, callMinimax, ERROR_HINTS } from './ark.js';
import { makeThumb } from './thumbs.js';
import { syncCredits } from './credits.js';

const STATUS_ALIASES = {
  queued: 'queued', pending: 'queued', submitted: 'queued', created: 'queued',
  in_progress: 'in_progress', processing: 'in_progress', running: 'in_progress', generating: 'in_progress',
  completed: 'completed', succeeded: 'completed', success: 'completed',
  failed: 'failed', failure: 'failed', error: 'failed', cancelled: 'failed', canceled: 'failed', expired: 'failed',
};

export const VIDEO_TASKS_PATH = '/contents/generations/tasks';
export const MINIMAX_VIDEO_PATH = '/v2/video_generation';

// 视频任务在哪个平台上，就到哪个平台去查。query 返回的东西统一成火山方舟的样子（status、usage、content.video_url），applyTaskState 只认这一种。
// MiniMax 的任务包在 task 里，成片地址叫 content.url；它没有完成时间，记的是查到它完成的那一刻（手动填的余额按这个时刻扣，要精确到毫秒）；任务只能查到 7 天以内的。
const PLATFORMS = {
  ark: {
    ...ARK,
    key: apiKey,
    query: async (id) => (await callArk('GET', `${VIDEO_TASKS_PATH}/${encodeURIComponent(id)}`, { timeoutMs: 20000 })).data,
  },
  minimax: {
    ...MINIMAX,
    key: minimaxKey,
    query: async (id) => {
      const task = (await callMinimax('GET', `/v2/query/video_generation/${encodeURIComponent(id)}`, { timeoutMs: 20000 })).data?.task;
      if (!task) return null;
      return { ...task, content: { video_url: task.content?.url } };
    },
  },
};

export const isPending = (item) => item.status === 'queued' || item.status === 'in_progress';
export const isTimedOut = (item) => item.status === 'failed' && item.error?.code === 'poll_timeout';
// 以前在别的平台（Flatkey、OpenRouter）上提交的记录。那些平台已经从应用里拿掉了，记录留着看，但不再查询。
export const isLegacy = (item) => !Object.hasOwn(PLATFORMS, item.provider);

export const newId = (prefix) => `${prefix}_${crypto.randomBytes(12).toString('hex')}`;

export function newItem(fields) {
  return { provider: 'ark', createdAt: Date.now(), status: 'in_progress', progress: 0, error: null, usage: null, remoteUrl: null, localFile: null, ...fields };
}

export function applyTaskState(item, data) {
  if (!data) return;
  const status = STATUS_ALIASES[String(data.status || '').toLowerCase()];
  if (status) item.status = status;
  if (typeof data.progress === 'number') item.progress = data.progress;
  if (data.usage) item.usage = data.usage;
  if (data.completed_at) item.completedAt = data.completed_at * 1000;
  if (data.content?.video_url) item.remoteUrl = data.content.video_url;
  if (item.status === 'completed') {
    item.progress = 100;
    item.error = null;
    if (!item.completedAt) item.completedAt = Date.now();
  }
  if (item.status === 'failed') {
    const e = data.error;
    const raw = (typeof e === 'string' ? e : e?.message) || '';
    const code = (typeof e === 'object' && e?.code) || '';
    // 平台给的失败原因是英文的：卡片上显示中文的原因，原话留在 detail 里。
    const known = ERROR_HINTS[code] || (/audit|sensitive|moderation|censor/i.test(raw) ? '内容未通过审核，请修改提示词或参考素材后重试' : '');
    item.error = { message: known || '视频生成失败，请稍后重试', code, ...(raw && { detail: `${PLATFORMS[item.provider]?.label || '平台'}${code ? `（${code}）` : ''}：${raw}` }) };
  }
}

const polling = new Set();
const downloading = new Set();

export async function pollTask(space, item) {
  if (polling.has(item.id)) return;
  polling.add(item.id);
  try {
    applyTaskState(item, await PLATFORMS[item.provider].query(item.id));
    item.pollError = null;
  } catch (err) {
    if (err.status === 404 || err.code === 'task_not_exist') {
      item.status = 'failed';
      item.error = { message: `${PLATFORMS[item.provider].label} 上不存在该任务`, code: 'task_not_found' };
    } else {
      item.pollError = err.message;
    }
  } finally {
    item.lastPolledAt = Date.now();
    // 先查再判断：服务停了很久再启动时，任务可能早就完成了。查过这一次仍没有结果才算超时。
    if (isPending(item) && Date.now() - item.createdAt > MAX_PENDING_MS) {
      item.status = 'failed';
      item.error = { message: '查询超时，请稍后重新查询。', code: 'poll_timeout' };
    }
    polling.delete(item.id);
    syncCredits(space, item);
    space.save('history');
  }
  if (item.status === 'completed') downloadResult(space, item);
}

// 任务完成后把结果存到本机，历史记录不依赖远端地址是否还有效。
export async function downloadResult(space, item) {
  if (!item.remoteUrl || item.localFile || downloading.has(item.id)) return;
  if ((item.downloadAttempts || 0) >= MAX_DOWNLOAD_ATTEMPTS) return;
  downloading.add(item.id);
  item.downloadAttempts = (item.downloadAttempts || 0) + 1;
  item.lastDownloadAt = Date.now();

  const audio = item.kind === 'audio';
  const file = `${item.id.replace(/[^\w.-]/g, '_')}.${audio ? 'mp3' : 'mp4'}`;
  const dir = space.resultDir(item);
  const tmp = path.join(dir, `${file}.part`);
  try {
    const platform = PLATFORMS[item.provider] || PLATFORMS.ark;
    const url = new URL(item.remoteUrl, platform.baseUrl);
    const headers = {};
    // 只在平台自己的域名下才带上 Key，避免把 Key 发给别的主机。
    if (url.origin === new URL(platform.baseUrl).origin && platform.key()) headers.Authorization = `Bearer ${platform.key()}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10 * 60 * 1000) });
    if (!res.ok || !res.body) throw new Error(`下载返回 ${res.status}`);
    const type = res.headers.get('content-type') || '';
    if (/^(application\/json|text\/)/i.test(type)) throw new Error(`下载的文件不是${audio ? '音频' : '视频'}（${type}）`);
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
    const { size } = fs.statSync(tmp);
    if (!size) throw new Error('下载的文件为空');
    fs.renameSync(tmp, path.join(dir, file));
    item.localFile = file;
    item.fileSize = size;
    item.downloadError = null;
    makeThumb(space, item);
  } catch (err) {
    item.downloadError = err.message;
    fs.rmSync(tmp, { force: true });
  } finally {
    downloading.delete(item.id);
    space.save('history');
  }
}

function tick() {
  const now = Date.now();
  for (const space of openSpaces()) {
    for (const item of space.history) {
      // direct 的记录没有任务可查，结果由发起它的那次请求自己写回来。
      // 这个平台的 Key 被清掉了就先不查。
      if (item.direct || isLegacy(item) || !PLATFORMS[item.provider].key()) continue;
      if (isPending(item)) {
        if (now - (item.lastPolledAt || 0) >= POLL_INTERVAL_MS) pollTask(space, item);
      } else if (item.status === 'completed' && !item.localFile && item.remoteUrl) {
        if (now - (item.lastDownloadAt || 0) >= DOWNLOAD_RETRY_MS) downloadResult(space, item);
      }
    }
  }
}

export function startPolling() {
  setInterval(tick, 2000);
  tick();
}

// mediaUrl 是结果文件的地址，三种类型都有；videoUrl 只有视频有，页面上放视频的地方用它；thumbUrl 是列表里用的小图，没做出来就没有。
export function historyView(item) {
  const kind = item.kind || 'video';
  const mediaUrl = item.localFile ? `/media/${MEDIA_DIRS[kind]}/${item.localFile}` : item.remoteUrl || null;
  return {
    ...item,
    kind,
    mediaUrl,
    videoUrl: kind === 'video' ? mediaUrl : null,
    thumbUrl: item.thumbFile ? `/media/thumbs/${item.thumbFile}` : null,
    savedLocally: Boolean(item.localFile),
  };
}

export function finishItem(space, item, buffer, ext, extra = {}) {
  // 等结果的这段时间里，记录可能已经被用户删掉了，那就不再落盘。
  if (!space.history.includes(item)) return;
  const file = `${item.id}.${ext}`;
  fs.writeFileSync(path.join(space.resultDir(item), file), buffer);
  Object.assign(item, { status: 'completed', progress: 100, completedAt: Date.now(), localFile: file, fileSize: buffer.length, ...extra });
  makeThumb(space, item);
}

// 图片和语音是一次请求直接返回结果，平台上没有任务可查。
// 所以先建记录、立刻返回给页面，请求在后台跑；跑完把文件存到本机，再把结果写回记录。
export function runDirect(space, items, work) {
  for (const item of [...items].reverse()) {
    item.direct = true;
    space.history.unshift(item);
  }
  space.save('history');
  work()
    .catch((err) => {
      if (!(err instanceof HttpError)) console.error(err);
      for (const item of items) {
        if (item.status === 'completed') continue;
        item.status = 'failed';
        item.error = { message: err instanceof HttpError ? err.message : `本地服务出错：${err.message}`, code: err.code || '', ...(err.detail && { detail: err.detail }) };
      }
    })
    .finally(() => {
      for (const item of items) syncCredits(space, item);
      space.save('history');
    });
}

// 打开一份空间时把上次留下的记录理一遍：
// 已经拿掉的平台上没跑完的没法再查，结果没存到本机的也下不回来；
// direct 的请求跟着进程走，服务重启后没法接着等，上次没跑完的直接标为中断。
export function settleHistory(space) {
  let changed = false;
  for (const item of space.history) {
    if (!isPending(item)) continue;
    if (item.direct) item.error = { message: '生成已中断，请重新生成。', code: 'interrupted' };
    else if (isLegacy(item)) item.error = { message: '该平台已停用，无法查询该任务。', code: 'provider_removed' };
    else continue;
    item.status = 'failed';
    syncCredits(space, item);
    changed = true;
  }
  if (changed) space.save('history');
}
