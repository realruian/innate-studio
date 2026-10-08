// 全局状态、本地服务调用、轮询。

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api(method, url, body, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiError(0, 'network', '连不上本地服务，请确认终端里的 node server.js 还在运行。');
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON 响应按空处理 */
  }
  if (!res.ok) throw new ApiError(res.status, data?.error?.code || '', data?.error?.message || `请求失败（${res.status}）`);
  return data;
}

export const KINDS = {
  image: { label: '图片', type: 'Image', accept: 'image/*', max: 9, maxBytes: 30 * 1024 * 1024 },
  video: { label: '视频', type: 'Video', accept: 'video/*', max: 3, maxBytes: 50 * 1024 * 1024 },
  audio: { label: '音频', type: 'Audio', accept: 'audio/*', max: 3, maxBytes: 15 * 1024 * 1024 },
};

export const kindOfType = (type) => ({ image: 'image', video: 'video', audio: 'audio' })[String(type || '').toLowerCase()] || 'image';

export const state = {
  view: 'create',
  // 创作页当前选的是哪种内容（视频、图片、语音、音效、配乐）。下面的「最近生成」跟着它走。
  createType: 'video',
  app: { hasKey: false, keyHint: '', keySource: '', baseUrl: '' },
  models: ['seedance-2.0', 'seedance-2.0-fast'],
  modelsInfo: { source: 'default', error: '', note: '' },
  // 视频之外账号还能用什么。known 为 false 表示还没读到模型列表，这时不拦任何一种创作。
  catalog: { known: false, image: [], polish: [], audio: { speech: false, sfx: false, music: false } },
  voices: null,
  history: [],
  historyLoaded: false,
  assets: [],
  persons: null,
  personsError: '',
  personAssets: {},
  watchedPersons: new Set(),
  watchedPersonView: '',
};

const listeners = {};

export function on(event, fn) {
  (listeners[event] ||= new Set()).add(fn);
}

export function emit(event) {
  listeners[event]?.forEach((fn) => fn());
}

// 页面切换由 main.js 实现。其他模块通过 goTo 请求切换，比如在创作记录页点「复用」要回到创作页。
let navigator = () => {};
export const setNavigator = (fn) => {
  navigator = fn;
};
export const goTo = (view) => navigator(view);

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

export function setPolishModel(model) {
  try {
    localStorage.setItem(POLISH_KEY, model);
  } catch {
    /* 存不了就只在本次打开期间生效 */
  }
}

let historySignature = '';

export async function loadHistory() {
  const data = await api('GET', '/api/history');
  const signature = JSON.stringify(data.items.map((i) => [i.id, i.status, i.progress, i.mediaUrl, i.pollError, i.downloadError, i.error?.message]));
  state.history = data.items;
  if (signature !== historySignature || !state.historyLoaded) {
    historySignature = signature;
    state.historyLoaded = true;
    emit('history');
  }
}

export const isPendingTask = (item) => item.status === 'queued' || item.status === 'in_progress';
// 等太久、本地服务已停止自动查询的任务。它在 Flatkey 那边不一定失败了，可以手动再查一次。
export const isTimedOutTask = (item) => item.status === 'failed' && item.error?.code === 'poll_timeout';

let historyTimer = null;

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

function putAsset(asset) {
  const index = state.assets.findIndex((a) => a.id === asset.id);
  if (asset.kind !== 'virtual') return;
  if (index === -1) state.assets.unshift(asset);
  else state.assets[index] = asset;
}

export function rememberAsset(asset) {
  putAsset(asset);
  emit('assets');
}

export async function refreshAsset(id) {
  const asset = await api('GET', `/api/assets/${id}`);
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
    state.personsError = err.message;
  }
  emit('persons');
}

export async function loadPersonAssets(personId) {
  state.personAssets[personId] = (await api('GET', `/api/real-persons/${personId}/assets?limit=50`)).items;
  emit('assets');
  return state.personAssets[personId];
}

export function findAsset(id) {
  const virtual = state.assets.find((a) => a.id === id);
  if (virtual) return virtual;
  for (const list of Object.values(state.personAssets)) {
    const hit = list.find((a) => a.id === id);
    if (hit) return hit;
  }
  return null;
}

// 素材能不能用于某个模型。虚拟素材看 available_models，真人素材只看 status。
export function assetReadiness(asset, model) {
  if (!asset) return { ready: false, tone: 'pending', label: '查询中' };
  const status = asset.status || '';
  if (status === 'Failed') return { ready: false, tone: 'error', label: '处理失败' };
  if (status === 'Expired') return { ready: false, tone: 'error', label: '已过期' };
  if (status === 'Deleting' || status === 'Deleted') return { ready: false, tone: 'error', label: '已删除' };
  if (status === 'Active') return { ready: true, tone: 'ok', label: '可用' };
  if (model && (asset.available_models || []).includes(model)) return { ready: true, tone: 'ok', label: '可用' };
  if (status === 'Creating') return { ready: false, tone: 'pending', label: '上传中' };
  return { ready: false, tone: 'pending', label: '处理中' };
}

const SETTLED = new Set(['Active', 'Failed', 'Expired', 'Deleted']);

export function startAssetLoop() {
  const run = async () => {
    const jobs = state.assets.filter((a) => !SETTLED.has(a.status || '')).map((a) => refreshAsset(a.id).catch(() => {}));
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
