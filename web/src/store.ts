// 全局状态、本地服务调用、轮询。
// 状态是一个普通对象，改完后用 emit() 说一声是哪一块变了；组件用 useStore() 订阅自己关心的那几块。

import { useSyncExternalStore } from 'react';
import type { AppInfo, Asset, CreateType, HistoryItem, Kind, Person, RefStatus, ViewId, Voice } from './types.ts';

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api<T = any>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const init: RequestInit & { headers: Record<string, string> } = { method, headers: { ...headers } };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiError(0, 'network', '连不上本地服务，请确认终端里的 node server.js 还在运行。');
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON 响应按空处理 */
  }
  if (!res.ok) throw new ApiError(res.status, data?.error?.code || '', data?.error?.message || `请求失败（${res.status}）`);
  return data;
}

export const KINDS: Record<Kind, { label: string; type: string; accept: string; max: number; maxBytes: number }> = {
  image: { label: '图片', type: 'Image', accept: 'image/*', max: 9, maxBytes: 30 * 1024 * 1024 },
  video: { label: '视频', type: 'Video', accept: 'video/*', max: 3, maxBytes: 50 * 1024 * 1024 },
  audio: { label: '音频', type: 'Audio', accept: 'audio/*', max: 3, maxBytes: 15 * 1024 * 1024 },
};

export const kindOfType = (type?: string): Kind => (({ image: 'image', video: 'video', audio: 'audio' }) as Record<string, Kind>)[String(type || '').toLowerCase()] || 'image';

export const state = {
  // 读到 Key 的状态之后才画创作页。
  booted: false,
  view: 'create' as ViewId,
  // 创作页当前选的是哪种内容（视频、图片、语音、音效、配乐）。下面的「最近生成」跟着它走。
  createType: 'video' as CreateType,
  // 记录页的类型筛选。放在这里是因为创作页的「查看全部」要带着类型过去。
  recordsType: 'all' as CreateType | 'all',
  app: { hasKey: false, keyHint: '', keySource: '', baseUrl: '' } as AppInfo,
  models: ['seedance-2.0', 'seedance-2.0-fast'] as string[],
  modelsInfo: { source: 'default', error: '', note: '' },
  // 视频之外账号还能用什么。known 为 false 表示还没读到模型列表，这时不拦任何一种创作。
  catalog: { known: false, image: [] as string[], polish: [] as string[], audio: { speech: false, sfx: false, music: false } },
  voices: null as Voice[] | null,
  history: [] as HistoryItem[],
  historyLoaded: false,
  assets: [] as Asset[],
  persons: null as Person[] | null,
  personsError: '',
  personAssets: {} as Record<string, Asset[]>,
  watchedPersons: new Set<string>(),
  watchedPersonView: '',
};

export type StoreEvent = 'boot' | 'view' | 'app' | 'models' | 'history' | 'assets' | 'persons' | 'createType' | 'recordsType' | 'composer';

const listeners: Partial<Record<StoreEvent, Set<() => void>>> = {};
const versions: Partial<Record<StoreEvent, number>> = {};

export function on(event: StoreEvent, fn: () => void) {
  (listeners[event] ||= new Set()).add(fn);
  return () => {
    listeners[event]?.delete(fn);
  };
}

export function emit(event: StoreEvent) {
  versions[event] = (versions[event] || 0) + 1;
  listeners[event]?.forEach((fn) => fn());
}

// 订阅状态里的几块；其中任何一块 emit 了，组件就重画。返回值每次变化都不同，可以拿来当 effect 的依赖。
export function useStore(...events: StoreEvent[]) {
  return useSyncExternalStore(
    (notify) => {
      const offs = events.map((event) => on(event, notify));
      return () => offs.forEach((off) => off());
    },
    () => events.map((event) => versions[event] || 0).join(','),
  );
}

// 切换页面。重复去同一页也算一次：点「新建创作」要回到顶部并把光标放回输入框。
export function goTo(view: ViewId) {
  state.view = view;
  emit('view');
}

export async function loadApp() {
  state.app = await api('GET', '/api/state');
  emit('app');
}

export async function loadModels() {
  const data = await api('GET', '/api/models');
  state.models = data.models;
  state.modelsInfo = { source: data.source, error: data.error || '', note: data.note || '' };
  state.catalog = { known: !data.error, image: data.imageModels || [], polish: data.polishModels || [], audio: data.audio || {} };
  emit('models');
}

export async function loadVoices() {
  if (!state.voices) state.voices = (await api('GET', '/api/voices')).items;
  return state.voices;
}

// 润色提示词用哪个文本模型。选择存在浏览器里；没选过或选的已经不可用，就用列表里的第一个。
const POLISH_KEY = 'seedance-studio.polish-model';

export function polishModel() {
  let saved = '';
  try {
    saved = localStorage.getItem(POLISH_KEY) || '';
  } catch {
    /* 读不到就用默认的 */
  }
  return state.catalog.polish.includes(saved) ? saved : state.catalog.polish[0] || '';
}

export function setPolishModel(model: string) {
  try {
    localStorage.setItem(POLISH_KEY, model);
  } catch {
    /* 存不了就只在本次打开期间生效 */
  }
}

let historySignature = '';

export async function loadHistory() {
  const data = await api<{ items: HistoryItem[] }>('GET', '/api/history');
  const signature = JSON.stringify(data.items.map((i) => [i.id, i.status, i.progress, i.mediaUrl, i.pollError, i.downloadError, i.error?.message]));
  state.history = data.items;
  if (signature !== historySignature || !state.historyLoaded) {
    historySignature = signature;
    state.historyLoaded = true;
    emit('history');
  }
}

export const isPendingTask = (item: HistoryItem) => item.status === 'queued' || item.status === 'in_progress';
// 等太久、本地服务已停止自动查询的任务。它在 Flatkey 那边不一定失败了，可以手动再查一次。
export const isTimedOutTask = (item: HistoryItem) => item.status === 'failed' && item.error?.code === 'poll_timeout';

let historyTimer: ReturnType<typeof setTimeout> | undefined;

export function startHistoryLoop() {
  clearTimeout(historyTimer);
  const run = async () => {
    try {
      await loadHistory();
    } catch {
      /* 下一轮再试 */
    }
    const busy = state.history.some((i) => isPendingTask(i) || (i.status === 'completed' && !i.savedLocally && !i.downloadError));
    historyTimer = setTimeout(run, busy ? 2500 : 15000);
  };
  run();
}

export async function loadAssets() {
  state.assets = (await api('GET', '/api/assets')).items;
  emit('assets');
}

function putAsset(asset: Asset) {
  const index = state.assets.findIndex((a) => a.id === asset.id);
  if (asset.kind !== 'virtual') return;
  if (index === -1) state.assets.unshift(asset);
  else state.assets[index] = asset;
}

export function rememberAsset(asset: Asset) {
  putAsset(asset);
  emit('assets');
}

export async function refreshAsset(id: string) {
  const asset = await api<Asset>('GET', `/api/assets/${id}`);
  putAsset(asset);
  emit('assets');
  return asset;
}

export async function loadPersons() {
  try {
    state.persons = (await api('GET', '/api/real-persons')).items;
    state.personsError = '';
  } catch (err) {
    state.persons = [];
    state.personsError = (err as Error).message;
  }
  emit('persons');
}

export async function loadPersonAssets(personId: string) {
  state.personAssets[personId] = (await api('GET', `/api/real-persons/${personId}/assets?limit=50`)).items;
  emit('assets');
  return state.personAssets[personId];
}

export function findAsset(id?: string) {
  const virtual = state.assets.find((a) => a.id === id);
  if (virtual) return virtual;
  for (const list of Object.values(state.personAssets)) {
    const hit = list.find((a) => a.id === id);
    if (hit) return hit;
  }
  return null;
}

// 素材能不能用于某个模型。虚拟素材看 available_models，真人素材只看 status。
// status 是这个 Key 下所有相关模型的汇总：只要有一个模型没准备好，它就是 Processing 甚至 Failed，
// 但已经列在 available_models 里的模型照样能用（Flatkey 文档的说法，2026-10-09 用一段视频素材实测过：
// 汇总状态是 Failed，Seedance 2.0 的几个型号都在列表里，提交能成功）。所以先看目标模型在不在列表里。
export function assetReadiness(asset: Asset | null, model?: string): Required<RefStatus> {
  if (!asset) return { ready: false, tone: 'pending', label: '查询中' };
  const status = asset.status || '';
  const usable = asset.available_models || [];
  if (status === 'Expired') return { ready: false, tone: 'error', label: '已过期' };
  if (status === 'Deleting' || status === 'Deleted') return { ready: false, tone: 'error', label: '已删除' };
  if (status === 'Active') return { ready: true, tone: 'ok', label: '可用' };
  if (model && usable.includes(model)) return { ready: true, tone: 'ok', label: '可用' };
  // 没指定模型时（素材库页面）：有模型能用就不算失败，具体哪些能用看下面列出的「可用模型」。
  if (status === 'Failed') return !model && usable.length ? { ready: true, tone: 'ok', label: '部分模型可用' } : { ready: false, tone: 'error', label: '处理失败' };
  if (status === 'Creating') return { ready: false, tone: 'pending', label: '上传中' };
  return { ready: false, tone: 'pending', label: '处理中' };
}

const SETTLED = new Set(['Active', 'Failed', 'Expired', 'Deleted']);

export function startAssetLoop() {
  const run = async () => {
    const jobs: Promise<unknown>[] = state.assets.filter((a) => !SETTLED.has(a.status || '')).map((a) => refreshAsset(a.id).catch(() => {}));
    const persons = new Set(state.watchedPersons);
    if (state.watchedPersonView) persons.add(state.watchedPersonView);
    for (const personId of persons) {
      const list = state.personAssets[personId];
      if (!list || list.some((a) => !SETTLED.has(a.status || ''))) jobs.push(loadPersonAssets(personId).catch(() => {}));
    }
    await Promise.all(jobs);
    setTimeout(run, 4000);
  };
  setTimeout(run, 4000);
}
