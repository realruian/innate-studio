#!/usr/bin/env node

// Innate Studio 本地服务：托管页面、保管 API Key、转发请求给模型平台、轮询任务并保存历史。
// 平台有三个，在设置里切换：Flatkey 能生成视频（Seedance、Grok）、图片、音频（语音、音效、配乐）；OpenRouter 能生成视频、图片和语音；
// 火山方舟是字节官方的接口，能生成视频（Seedance）和图片（Seedream）。三边都能润色提示词。
// 服务本身不依赖第三方包。页面是 web/ 里的 React 源码，用 npm run build 构建到 web/dist 之后由这里托管。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { videoFamilyOf, polishGuide, POLISH_KINDS, PROVIDERS, isProvider, videoSpecOf, ARK_VIDEO_MODELS, ARK_IMAGE_MODELS, ARK_TEXT_MODELS, isBorrowedImageModel } from './shared/models.ts';
import { OFFICIAL_SKILLS } from './shared/skills.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 5178;
const HOST = '127.0.0.1';
const trimSlash = (url) => url.replace(/\/+$/, '');
// 每个平台各自的接口地址、Key 的环境变量名、Key 存在 config.json 里的哪个字段。平台的名字和各自能用的功能登记在 shared/models.ts。
const UPSTREAMS = {
  flatkey: { baseUrl: trimSlash(process.env.FLATKEY_BASE_URL || 'https://router.flatkey.ai'), envKey: 'FLATKEY_API_KEY', configKey: 'apiKey' },
  openrouter: { baseUrl: trimSlash(process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api'), envKey: 'OPENROUTER_API_KEY', configKey: 'openrouterKey' },
  // 火山方舟的地址里已经带着版本号，所以它的接口路径前面没有 /v1。
  ark: { baseUrl: trimSlash(process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3'), envKey: 'ARK_API_KEY', configKey: 'arkKey' },
};
const DATA_DIR = path.resolve(process.env.SEEDANCE_DATA_DIR || path.join(__dirname, 'data'));
// 生成结果按类型分目录存；uploads 放的是从本机选来当输入的文件（Grok 的首帧、要配乐的视频）。
const MEDIA_DIRS = { video: 'videos', image: 'images', audio: 'audio' };
const mediaDir = (name) => path.join(DATA_DIR, name);
const resultDir = (item) => mediaDir(MEDIA_DIRS[item.kind] || MEDIA_DIRS.video);
const PUBLIC_DIR = path.join(__dirname, 'web', 'dist');

const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
const MAX_JSON_BYTES = 6 * 1024 * 1024;
const POLL_INTERVAL_MS = 6000;
// 任务提交后超过这么久还没有结果，就停止自动查询。可以用环境变量 SEEDANCE_PENDING_LIMIT_MS 改。
const MAX_PENDING_MS = Number(process.env.SEEDANCE_PENDING_LIMIT_MS) || 6 * 60 * 60 * 1000;
const DOWNLOAD_RETRY_MS = 30000;
const MAX_DOWNLOAD_ATTEMPTS = 6;
const DEFAULT_MODELS = { flatkey: ['seedance-2.0', 'seedance-2.0-fast'], openrouter: ['bytedance/seedance-2.5', 'bytedance/seedance-2.0'], ark: Object.keys(ARK_VIDEO_MODELS) };
// 语音两边用的是同一个 ElevenLabs 模型，只是型号的写法不同。
const SPEECH_MODEL = { flatkey: 'eleven_multilingual_v2', openrouter: 'elevenlabs/eleven-multilingual-v2' };
const SFX_MODEL = 'eleven_sound_v1';
const MUSIC_MODEL = 'sonilo-video-to-music';
// 润色提示词只需要少数几个文本模型：按这个顺序，取账号里有的。
const POLISH_MODELS = {
  flatkey: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'glm-5.3', 'grok-4.7'],
  openrouter: ['anthropic/claude-haiku-5.5', 'anthropic/claude-sonnet-5.5', 'anthropic/claude-opus-5.5', 'z-ai/glm-5.3', 'x-ai/grok-4.7'],
  ark: ARK_TEXT_MODELS,
};
const MAX_IMAGES = 4;

for (const name of [...Object.values(MEDIA_DIRS), 'uploads']) fs.mkdirSync(mediaDir(name), { recursive: true });

// ---------- 本地存储 ----------

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(name, value, mode) {
  const file = path.join(DATA_DIR, name);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

const config = readJson('config.json', {});
const history = readJson('history.json', []);
const assets = readJson('assets.json', {});
const canvases = readJson('canvases.json', []);
const characters = readJson('characters.json', []);
const skills = readJson('skills.json', []);
const workflows = readJson('workflows.json', []);

const saveConfig = () => writeJson('config.json', config, 0o600);
const saveHistory = () => writeJson('history.json', history);
const saveAssets = () => writeJson('assets.json', assets);
const saveCanvases = () => writeJson('canvases.json', canvases);
const saveCharacters = () => writeJson('characters.json', characters);
const saveSkills = () => writeJson('skills.json', skills);
const saveWorkflows = () => writeJson('workflows.json', workflows);

// Key 要放进 HTTP 请求头，只能由可见的 ASCII 字符组成。
const isUsableKey = (value) => /^[\x21-\x7e]+$/.test(value);
const badKeyMessage = (provider) => {
  const { keyPrefix } = PROVIDERS[provider];
  return `这不像是 API Key：里面有中文、空格或其他不能用的字符。请到 ${labelOf(provider)} 的控制台复制${keyPrefix ? `以 ${keyPrefix} 开头的` : ''}那一串，再粘贴进来。`;
};

// 当前用哪个平台。没选过就是 Flatkey。
const currentProvider = () => (isProvider(config.provider) ? config.provider : 'flatkey');
// 一条记录是在哪个平台提交的。加这个字段之前的记录都是 Flatkey 的。
const providerOf = (item) => (isProvider(item.provider) ? item.provider : 'flatkey');
const labelOf = (provider) => PROVIDERS[provider].label;

for (const [provider, { configKey }] of Object.entries(UPSTREAMS)) {
  if (!config[configKey] || isUsableKey(config[configKey])) continue;
  delete config[configKey];
  saveConfig();
  console.log(`之前保存的 ${labelOf(provider)} API Key 含有非法字符，已清除，请在「设置」里重新填写。`);
}

function apiKey(provider = currentProvider()) {
  const { envKey, configKey } = UPSTREAMS[provider];
  return process.env[envKey] || config[configKey] || '';
}

function providerState(provider) {
  const key = apiKey(provider);
  return {
    hasKey: Boolean(key),
    keyHint: key ? `${key.slice(0, 6)}…${key.slice(-4)}` : '',
    keySource: process.env[UPSTREAMS[provider].envKey] ? 'env' : key ? 'file' : '',
    baseUrl: UPSTREAMS[provider].baseUrl,
  };
}

// 最外面几项说的是当前平台；providers 里是每个平台各自的 Key 状态，设置页用。
function keyState() {
  const provider = currentProvider();
  return {
    ...providerState(provider),
    provider,
    features: PROVIDERS[provider].features,
    providers: Object.keys(UPSTREAMS).map((id) => ({ id, label: labelOf(id), ...providerState(id) })),
  };
}

// ---------- 调用模型平台 ----------

class HttpError extends Error {
  constructor(status, code, message, upstream) {
    super(message);
    this.status = status;
    this.code = code;
    this.upstream = upstream;
  }
}

const ERROR_HINTS = {
  invalid_api_key: 'API Key 无效或已被撤销',
  insufficient_balance: '账号余额不足，任务没有创建',
  model_not_allowed: '这个 Key 没有使用该模型的权限',
  model_not_found: '平台不认识这个模型 ID',
  rate_limit_exceeded: '请求太频繁，请稍后再试',
  upstream_unavailable: '模型服务暂时不可用，请稍后重试',
  // 下面是火山方舟的错误码（官方文档《错误码》）。
  AuthenticationError: 'API Key 无效或已被删除',
  AccountOverdueError: '火山引擎账号欠费了，充值后才能继续用',
  ModelNotOpen: '账号还没有开通这个模型。Seedance 2.0、2.5 要账户余额大于 200 元才能开通，到火山方舟控制台的「开通管理」里开',
  'InvalidEndpointOrModel.NotFound': '火山方舟不认识这个模型，或者账号没有开通它',
  'InvalidEndpointOrModel.ModelIDAccessDisabled': '账号关掉了直接用模型 ID 调用，到火山方舟控制台里打开',
  ModelAccountRpmRateLimitExceeded: '请求太频繁，请稍后再试',
  ModelAccountIpmRateLimitExceeded: '生图太频繁，请稍后再试',
  APIAccountRpmRateLimitExceeded: '请求太频繁，请稍后再试',
  SetLimitExceeded: '达到了账号里给这个模型设置的用量上限，到火山方舟控制台里调整',
  InputTextSensitiveContentDetected: '提示词没有通过内容审核',
  InputImageSensitiveContentDetected: '参考图片没有通过内容审核',
  'InputImageSensitiveContentDetected.PrivacyInformation': '参考图片里有真人人脸，Seedance 不收',
  InputVideoSensitiveContentDetected: '参考视频没有通过内容审核',
  'InputVideoSensitiveContentDetected.PrivacyInformation': '参考视频里有真人人脸，Seedance 不收',
  InputAudioSensitiveContentDetected: '参考音频没有通过内容审核',
  OutputVideoSensitiveContentDetected: '生成的视频没有通过内容审核',
  OutputImageSensitiveContentDetected: '生成的图片没有通过内容审核',
};

// 这几种错误都发生在连接建立之前，请求还没发出去，重试不会重复下单。
const CONNECT_ERRORS = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);
const MAX_CONNECT_ATTEMPTS = 3;

// binary 为 true 时，成功的响应按文件内容返回（语音、音效直接返回 MP3），不当成 JSON 解析。
// provider 不传就是当前平台；查询已有的任务时要传那条任务自己的平台。
async function callUpstream(method, pathname, { json, body, headers = {}, timeoutMs = 60000, binary = false, provider = currentProvider() } = {}) {
  const name = labelOf(provider);
  const key = apiKey(provider);
  if (!key) throw new HttpError(401, 'no_api_key', `还没有设置 ${name} 的 API Key，请先在「设置」里填写。`);

  if (!isUsableKey(key)) throw new HttpError(400, 'invalid_key', badKeyMessage(provider));

  const requestHeaders = { Authorization: `Bearer ${key}`, ...headers };
  let payload = body;
  if (json !== undefined) {
    requestHeaders['Content-Type'] = 'application/json';
    payload = JSON.stringify(json);
  }

  let res;
  for (let attempt = 1; ; attempt += 1) {
    try {
      res = await fetch(UPSTREAMS[provider].baseUrl + pathname, {
        method,
        headers: requestHeaders,
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });
      break;
    } catch (err) {
      if (CONNECT_ERRORS.has(err.cause?.code) && attempt < MAX_CONNECT_ATTEMPTS) continue;
      const reason = err.name === 'TimeoutError' ? '请求超时' : err.cause?.code || err.message;
      throw new HttpError(502, 'upstream_unreachable', `连接 ${name} 失败：${reason}`);
    }
  }

  if (binary && res.ok) {
    const type = res.headers.get('content-type') || '';
    const data = Buffer.from(await res.arrayBuffer());
    if (/^(application\/json|text\/)/i.test(type) || !data.length) throw new HttpError(502, 'bad_upstream_response', `${name} 没有返回文件内容`);
    return { status: res.status, data, type };
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text.slice(0, 2000) };
    }
  }

  if (!res.ok) {
    const e = data?.error;
    const message = (typeof e === 'string' ? e : e?.message) || data?.message || `${name} 返回 ${res.status}`;
    const code = String((typeof e === 'object' && e?.code) || data?.code || `http_${res.status}`);
    const hint = ERROR_HINTS[code] ? `${ERROR_HINTS[code]}。` : '';
    throw new HttpError(res.status, code, `${hint}${name} 返回（${res.status}）：${message}`, data);
  }
  return { status: res.status, data };
}

function listOf(data) {
  if (Array.isArray(data)) return data;
  for (const key of ['data', 'items', 'assets', 'real_persons', 'list', 'results']) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  return [];
}

// ---------- 视频任务 ----------

const STATUS_ALIASES = {
  queued: 'queued', pending: 'queued', submitted: 'queued', created: 'queued',
  in_progress: 'in_progress', processing: 'in_progress', running: 'in_progress', generating: 'in_progress',
  completed: 'completed', succeeded: 'completed', success: 'completed',
  failed: 'failed', failure: 'failed', error: 'failed', cancelled: 'failed', canceled: 'failed', expired: 'failed',
};

const isPending = (item) => item.status === 'queued' || item.status === 'in_progress';
const isMusic = (item) => item.tool === 'music';
const isTimedOut = (item) => item.status === 'failed' && item.error?.code === 'poll_timeout';

function applyTaskState(item, data) {
  if (!data) return;
  const status = STATUS_ALIASES[String(data.status || '').toLowerCase()];
  if (status) item.status = status;
  if (typeof data.progress === 'number') item.progress = data.progress;
  // OpenRouter 的用量只有一个以美元计的 cost。
  if (data.usage) item.usage = typeof data.usage.cost === 'number' ? { cost_usd: data.usage.cost } : data.usage;
  if (data.completed_at) item.completedAt = data.completed_at * 1000;
  // 视频的下载地址在 metadata.url，配乐的在 audio[0].url；OpenRouter 的在 unsigned_urls[0]，火山方舟的在 content.video_url。
  const resultUrl = data.metadata?.url || data.audio?.[0]?.url || data.unsigned_urls?.[0] || data.content?.video_url;
  if (resultUrl) item.remoteUrl = resultUrl;
  if (item.status === 'completed') {
    item.progress = 100;
    item.error = null;
    if (!item.completedAt) item.completedAt = Date.now();
  }
  if (item.status === 'failed') {
    const e = data.error;
    item.error = {
      message: (typeof e === 'string' ? e : e?.message) || '视频生成失败',
      code: (typeof e === 'object' && e?.code) || '',
    };
    // 火山方舟的失败原因是英文的，认得的错误码在前面加一句中文说明。
    const hint = providerOf(item) === 'ark' && ERROR_HINTS[item.error.code];
    if (hint) item.error.message = `${hint}（${item.error.message}）`;
  }
}

// 每个平台提交和查询视频任务的接口路径。
const VIDEO_TASKS_PATH = { flatkey: '/v1/videos', openrouter: '/v1/videos', ark: '/contents/generations/tasks' };

const polling = new Set();
const downloading = new Set();

async function pollTask(item) {
  if (polling.has(item.id)) return;
  polling.add(item.id);
  const provider = providerOf(item);
  try {
    const { data } = await callUpstream('GET', `${isMusic(item) ? '/v1/video-to-music' : VIDEO_TASKS_PATH[provider]}/${encodeURIComponent(item.id)}`, { timeoutMs: 20000, provider });
    applyTaskState(item, data);
    item.pollError = null;
  } catch (err) {
    if (err.status === 404 || err.code === 'task_not_exist') {
      item.status = 'failed';
      item.error = { message: `${labelOf(provider)} 查不到这个任务`, code: 'task_not_found' };
    } else {
      item.pollError = err.message;
    }
  } finally {
    item.lastPolledAt = Date.now();
    // 先查再判断：服务停了很久再启动时，任务可能早就完成了。查过这一次仍没有结果才算超时。
    if (isPending(item) && Date.now() - item.createdAt > MAX_PENDING_MS) {
      item.status = 'failed';
      item.error = { message: `等了很久还没有结果，已停止自动查询。任务可能还在 ${labelOf(provider)} 那边进行，可以再查一次。`, code: 'poll_timeout' };
    }
    polling.delete(item.id);
    saveHistory();
  }
  if (item.status === 'completed') downloadResult(item);
}

// 任务完成后把结果（视频是 MP4，配乐是 MP3）存到本地，历史记录不依赖远端地址是否还有效。
async function downloadResult(item) {
  if (!item.remoteUrl || item.localFile || downloading.has(item.id)) return;
  if ((item.downloadAttempts || 0) >= MAX_DOWNLOAD_ATTEMPTS) return;
  downloading.add(item.id);
  item.downloadAttempts = (item.downloadAttempts || 0) + 1;
  item.lastDownloadAt = Date.now();

  const audio = item.kind === 'audio';
  const file = `${item.id.replace(/[^\w.-]/g, '_')}.${audio ? 'mp3' : 'mp4'}`;
  const dir = resultDir(item);
  const tmp = path.join(dir, `${file}.part`);
  try {
    const provider = providerOf(item);
    const { baseUrl } = UPSTREAMS[provider];
    const url = new URL(item.remoteUrl, baseUrl);
    const headers = {};
    // 只在提交这条任务的平台自己的域名下才带上 Key，避免把 Key 发给别的主机。OpenRouter 的结果地址必须带 Key 才能下载。
    if (url.origin === new URL(baseUrl).origin && apiKey(provider)) headers.Authorization = `Bearer ${apiKey(provider)}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10 * 60 * 1000) });
    if (!res.ok || !res.body) throw new Error(`下载返回 ${res.status}`);
    const type = res.headers.get('content-type') || '';
    if (/^(application\/json|text\/)/i.test(type)) throw new Error(`下载到的不是${audio ? '音频' : '视频'}（${type}）`);
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
    const { size } = fs.statSync(tmp);
    if (!size) throw new Error('下载到空文件');
    fs.renameSync(tmp, path.join(dir, file));
    item.localFile = file;
    item.fileSize = size;
    item.downloadError = null;
  } catch (err) {
    item.downloadError = err.message;
    fs.rmSync(tmp, { force: true });
  } finally {
    downloading.delete(item.id);
    saveHistory();
  }
}

function tick() {
  const now = Date.now();
  for (const item of history) {
    // direct 的记录没有上游任务可查，结果由发起它的那次请求自己写回来。
    if (item.direct) continue;
    // 每条任务回它自己的平台去查。那个平台的 Key 被清掉了就先不查。
    if (!apiKey(providerOf(item))) continue;
    if (isPending(item)) {
      if (now - (item.lastPolledAt || 0) >= POLL_INTERVAL_MS) pollTask(item);
    } else if (item.status === 'completed' && !item.localFile && item.remoteUrl) {
      if (now - (item.lastDownloadAt || 0) >= DOWNLOAD_RETRY_MS) downloadResult(item);
    }
  }
}

// mediaUrl 是结果文件的地址，三种类型都有；videoUrl 只有视频有，页面上放视频的地方用它。
function historyView(item) {
  const kind = item.kind || 'video';
  const mediaUrl = item.localFile ? `/media/${MEDIA_DIRS[kind]}/${item.localFile}` : item.remoteUrl || null;
  return {
    ...item,
    kind,
    mediaUrl,
    videoUrl: kind === 'video' ? mediaUrl : null,
    savedLocally: Boolean(item.localFile),
  };
}

// ---------- 直接返回结果的生成（图片、语音、音效） ----------

const newId = (prefix) => `${prefix}_${crypto.randomBytes(12).toString('hex')}`;

function newItem(fields) {
  return { createdAt: Date.now(), status: 'in_progress', progress: 0, error: null, usage: null, remoteUrl: null, localFile: null, ...fields };
}

function finishItem(item, buffer, ext, extra = {}) {
  // 等结果的这段时间里，记录可能已经被用户删掉了，那就不再落盘。
  if (!history.includes(item)) return;
  const file = `${item.id}.${ext}`;
  fs.writeFileSync(path.join(resultDir(item), file), buffer);
  Object.assign(item, { status: 'completed', progress: 100, completedAt: Date.now(), localFile: file, fileSize: buffer.length, ...extra });
}

// 这几个接口是一次请求直接返回结果，上游没有任务可查。
// 所以先建记录、立刻返回给页面，请求在后台跑；跑完把文件存到本机，再把结果写回记录。
function runDirect(items, work) {
  for (const item of [...items].reverse()) {
    item.direct = true;
    history.unshift(item);
  }
  saveHistory();
  work()
    .catch((err) => {
      if (!(err instanceof HttpError)) console.error(err);
      for (const item of items) {
        if (item.status === 'completed') continue;
        item.status = 'failed';
        item.error = { message: err instanceof HttpError ? err.message : `本地服务出错：${err.message}`, code: err.code || '' };
      }
    })
    .finally(saveHistory);
}

// 这类请求跟着进程走。服务重启后没法接着等，上次没跑完的直接标为中断。
for (const item of history) {
  if (!item.direct || !isPending(item)) continue;
  item.status = 'failed';
  item.error = { message: '服务重启时这次生成被中断了，请重新生成。', code: 'interrupted' };
}

function requireKey() {
  if (!apiKey()) throw new HttpError(401, 'no_api_key', '还没有设置 API Key，请先在「设置」里填写。');
}

// ---------- 本机文件 ----------

const MEDIA_PATH = /^\/media\/(videos|images|audio|uploads)\/([\w-]+(?:\.[\w-]+)*\.(mp4|mov|webm|jpg|jpeg|png|webp|mp3|wav))$/;
const UPLOAD_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav' };

// 把页面传来的 /media/... 地址对应到本机文件。只认这几个目录下的文件名，不接受带路径的写法。
function localMediaFile(url) {
  const match = MEDIA_PATH.exec(String(url || '').split('?')[0]);
  const file = match && path.join(mediaDir(match[1]), match[2]);
  if (!file || !fs.existsSync(file)) throw new HttpError(400, 'file_not_found', '找不到这个本机文件，可能已经被删除');
  return file;
}

// 只存在本机的图片要直接放进请求：Flatkey 上 Grok 的首帧（image），OpenRouter 的首尾帧（frame_images）和参考图（input_references）。
// 页面传来的是本机地址，发给上游前换成 data URL；记录里存的仍是原来的短地址。
function withLocalImages(payload) {
  const inline = (holder) => {
    const url = holder?.url;
    if (typeof url !== 'string' || !url.startsWith('/media/')) return holder;
    const file = localMediaFile(url);
    const type = MIME[path.extname(file).toLowerCase()] || 'image/jpeg';
    return { ...holder, url: `data:${type};base64,${fs.readFileSync(file).toString('base64')}` };
  };
  const next = { ...payload };
  if (payload.image) next.image = inline(payload.image);
  for (const field of ['frame_images', 'input_references']) {
    if (!Array.isArray(payload[field])) continue;
    next[field] = payload[field].map((entry) => {
      // OpenRouter 的参考视频和音频只收公网的 https 链接（2026-10-09 实测：内嵌数据会被拒绝）。
      if (entry?.video_url || entry?.audio_url) {
        const url = (entry.video_url || entry.audio_url).url;
        if (!/^https:\/\//i.test(url || '')) throw new HttpError(400, 'invalid_request', '参考视频和音频需要是公网能直接访问的 https 链接');
        return entry;
      }
      return entry?.image_url ? { ...entry, image_url: inline(entry.image_url) } : entry;
    });
  }
  return next;
}

// ---------- 素材 ----------

function assetIdOf(data) {
  const uri = data?.asset_url || data?.asset_uri || '';
  return data?.id || data?.asset_id || uri.replace(/^asset:\/\//, '') || '';
}

function upsertAsset(data, extra = {}) {
  const id = assetIdOf(data);
  if (!id) throw new HttpError(502, 'bad_upstream_response', '平台没有返回素材 ID', data);
  const prev = assets[id] || { id, addedAt: Date.now() };
  const next = { ...prev };
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== '') next[key] = value;
  }
  for (const key of ['asset_type', 'status', 'created_at']) {
    if (data[key] !== undefined) next[key] = data[key];
  }
  if (Array.isArray(data.available_models)) next.available_models = data.available_models;
  if (data.name && !next.name) next.name = data.name;
  next.asset_url = data.asset_url || data.asset_uri || `asset://${id}`;
  const e = data.error;
  if (e) next.error = typeof e === 'string' ? e : e.message || '';
  next.checkedAt = Date.now();
  assets[id] = next;
  saveAssets();
  return next;
}

function normalizePersonAsset(raw, personId) {
  const id = assetIdOf(raw);
  const meta = assets[id] || {};
  return {
    id,
    kind: 'person',
    personId,
    asset_type: raw.asset_type || meta.asset_type || '',
    status: raw.status || '',
    name: raw.name || meta.name || '',
    asset_url: raw.asset_uri || raw.asset_url || (id ? `asset://${id}` : ''),
    created_at: raw.created_at,
    thumb: meta.thumb || null,
    error: typeof raw.error === 'string' ? raw.error : raw.error?.message || '',
  };
}

function normalizePerson(raw) {
  return {
    id: raw.id || raw.person_id || '',
    name: raw.name || '',
    status: raw.status || '',
    verification_url: raw.verification_url || raw.verification_session?.verification_url || '',
    created_at: raw.created_at,
    raw,
  };
}

const decodeHeader = (value) => {
  try {
    return decodeURIComponent(String(value || ''));
  } catch {
    return '';
  }
};

// ---------- HTTP 基础 ----------

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    // 超过上限时不掐断连接：浏览器要等自己发完才读响应，中途断开它只会报"网络错误"，
    // 页面上就成了"连不上本地服务"。所以把剩下的内容读完丢掉，再正常返回 413。
    const tooLarge = () => new HttpError(413, 'payload_too_large', `文件太大，超过 ${Math.round(limit / 1024 / 1024)} MB`);
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) chunks.length = 0;
      else chunks.push(chunk);
    });
    req.on('end', () => (size > limit ? reject(tooLarge()) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  if (!/^application\/json/i.test(req.headers['content-type'] || '')) {
    throw new HttpError(415, 'unsupported_media_type', '请求必须是 JSON');
  }
  const buf = await readBody(req, MAX_JSON_BYTES);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', '请求体不是合法的 JSON');
  }
}

// 只接受本机页面发来的请求，挡掉别的网站对本地端口的跨站调用。
function isTrustedRequest(req) {
  const allowed = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
  if (!allowed.has(req.headers.host || '')) return false;
  const origin = req.headers.origin;
  if (origin && !allowed.has(origin.replace(/^http:\/\//, ''))) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  return true;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

function serveFile(req, res, file, { download } = {}) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return sendJson(res, 404, { error: { code: 'not_found', message: '文件不存在' } });
  }
  if (!stat.isFile()) return sendJson(res, 404, { error: { code: 'not_found', message: '文件不存在' } });

  const headers = {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  if (download) headers['Content-Disposition'] = `attachment; filename="${download}"`;

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
    let end = range[1] && range[2] ? Number(range[2]) : stat.size - 1;
    end = Math.min(end, stat.size - 1);
    if (start > end || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file, { start, end }).pipe(res);
  }

  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

// ---------- 路由 ----------

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

route('GET', /^\/api\/state$/, async () => keyState());

// 换了 Key 或者换了平台，之前读到的音色和可用的润色模型都不作数了。
function forgetAccount() {
  voices = null;
  polishAvailable = null;
  polishFailedAt.clear();
}

// 请求里指定了平台就用指定的，没指定就是当前平台。
function providerIn(value) {
  if (value == null || value === '') return currentProvider();
  if (!isProvider(value)) throw new HttpError(400, 'invalid_request', '没有这个平台');
  return value;
}

route('PUT', /^\/api\/key$/, async ({ req }) => {
  const { apiKey: key, provider: wanted } = await readJsonBody(req);
  const provider = providerIn(wanted);
  const value = String(key || '').trim();
  if (!value) throw new HttpError(400, 'invalid_key', 'API Key 不能为空');
  if (!isUsableKey(value)) throw new HttpError(400, 'invalid_key', badKeyMessage(provider));
  config[UPSTREAMS[provider].configKey] = value;
  saveConfig();
  forgetAccount();
  return keyState();
});

route('DELETE', /^\/api\/key$/, async ({ query }) => {
  delete config[UPSTREAMS[providerIn(query.get('provider'))].configKey];
  saveConfig();
  forgetAccount();
  return keyState();
});

// 切换平台。之后新提交的生成都走这个平台；已经提交的任务仍然回它原来的平台查询。
route('PUT', /^\/api\/provider$/, async ({ req }) => {
  const { provider } = await readJsonBody(req);
  if (!isProvider(provider)) throw new HttpError(400, 'invalid_request', '没有这个平台');
  config.provider = provider;
  saveConfig();
  forgetAccount();
  return keyState();
});

// OpenRouter 每个图片模型收哪些画面比例。提交生图时，模型不收的比例不发。读到模型列表之后才有。
let openrouterImageRatios = {};
// OpenRouter 每个图片模型最多收几张参考图（图生图）。0 是不收。
let openrouterImageRefs = {};

// OpenRouter 的视频、图片模型各有专门的列表接口，里面写着每个模型支持什么：视频的整理成 videoSpecs，图片的比例整理成 imageRatios，一起交给页面。
// 视频里 Seedance 排在前面，新的型号在前；图片里 Grok 排在前面（和 Flatkey 上默认用的是同一个）；其余按名字排。
async function openrouterModels() {
  const none = { imageModels: [], audio: { speech: false, sfx: false, music: false } };
  try {
    const get = (pathname) => callUpstream('GET', pathname, { timeoutMs: 20000 });
    const [videos, texts, images, speech] = await Promise.all([get('/v1/videos/models'), get('/v1/models'), get('/v1/images/models'), get('/v1/models?output_modalities=speech')]);
    const imageRatios = {};
    const imageRefs = {};
    for (const model of listOf(images.data)) {
      if (!model?.id) continue;
      imageRatios[model.id] = (model.supported_parameters?.aspect_ratio?.values || []).map(String);
      imageRefs[model.id] = Number(model.supported_parameters?.input_references?.max) || 0;
    }
    openrouterImageRatios = imageRatios;
    openrouterImageRefs = imageRefs;
    const isGrokImage = (id) => /\/grok-imagine-image/i.test(id);
    const rest = {
      imageModels: Object.keys(imageRatios).sort((a, b) => isGrokImage(b) - isGrokImage(a) || a.localeCompare(b)),
      imageRatios,
      imageRefs,
      audio: { speech: listOf(speech.data).some((m) => m?.id === SPEECH_MODEL.openrouter), sfx: false, music: false },
    };
    const videoSpecs = {};
    for (const model of listOf(videos.data)) {
      const spec = model?.id && videoSpecOf(model);
      if (spec) videoSpecs[model.id] = spec;
    }
    const ids = new Set(listOf(texts.data).map((m) => m?.id));
    polishAvailable = POLISH_MODELS.openrouter.filter((id) => ids.has(id));
    const isSeedance = (id) => videoFamilyOf(id) === 'seedance';
    const models = Object.keys(videoSpecs).sort((a, b) => isSeedance(b) - isSeedance(a) || (isSeedance(a) ? b.localeCompare(a) : a.localeCompare(b)));
    if (models.length) return { models, videoSpecs, polishModels: polishAvailable, ...rest, source: 'remote' };
    return { models: DEFAULT_MODELS.openrouter, polishModels: polishAvailable, ...rest, source: 'default', note: 'OpenRouter 的模型列表里没有可用的视频模型，下面显示的是默认型号。' };
  } catch (err) {
    return { models: DEFAULT_MODELS.openrouter, polishModels: [], ...none, source: 'default', error: err.message, errorCode: err.code };
  }
}

// 火山方舟没有能用 API Key 读的模型列表，型号登记在 shared/models.ts。
// 这里只查一次最近的任务列表，用来确认 Key 能用；列表里有哪些任务不关心。账号有没有开通某个模型，要到提交时才知道。
async function arkModels() {
  const imageRatios = {};
  const imageRefs = {};
  for (const [id, { refs, sizes }] of Object.entries(ARK_IMAGE_MODELS)) {
    imageRatios[id] = Object.keys(sizes);
    imageRefs[id] = refs;
  }
  const rest = { imageModels: Object.keys(ARK_IMAGE_MODELS), imageRatios, imageRefs, audio: { speech: false, sfx: false, music: false } };
  // 存了 OpenRouter 的 Key 时，把方舟上没有的 GPT Image 2 和 Nano Banana 也列进图片模型，排在 Seedream 后面。
  // 这一步读不到不影响方舟自己的模型，只是这几个不出现，原因放在 borrowedError 里。
  if (apiKey('openrouter')) {
    try {
      const { data } = await callUpstream('GET', '/v1/images/models', { timeoutMs: 20000, provider: 'openrouter' });
      for (const model of listOf(data).filter((m) => m?.id && isBorrowedImageModel(m)).sort((a, b) => a.id.localeCompare(b.id))) {
        openrouterImageRatios[model.id] = imageRatios[model.id] = (model.supported_parameters?.aspect_ratio?.values || []).map(String);
        openrouterImageRefs[model.id] = imageRefs[model.id] = Number(model.supported_parameters?.input_references?.max) || 0;
        rest.imageModels.push(model.id);
      }
    } catch (err) {
      rest.borrowedError = err.message;
    }
  }
  try {
    await callUpstream('GET', `${VIDEO_TASKS_PATH.ark}?page_num=1&page_size=1`, { timeoutMs: 20000, provider: 'ark' });
    polishAvailable = POLISH_MODELS.ark;
    return { models: DEFAULT_MODELS.ark, videoSpecs: ARK_VIDEO_MODELS, polishModels: polishAvailable, ...rest, source: 'remote' };
  } catch (err) {
    return { models: DEFAULT_MODELS.ark, videoSpecs: ARK_VIDEO_MODELS, polishModels: [], ...rest, source: 'default', error: err.message, errorCode: err.code };
  }
}

// 两类视频模型的请求格式不同：Seedance 用 content 数组，Grok 用 prompt 字符串。其他视频模型还没有接。
// 账号能用的模型，按用途分好。models 是视频模型（Seedance 排在前面），其余是图片、润色用的文本模型和三种音频能力。
route('GET', /^\/api\/models$/, async () => {
  if (currentProvider() === 'openrouter') return openrouterModels();
  if (currentProvider() === 'ark') return arkModels();
  const none = { imageModels: [], polishModels: [], audio: { speech: false, sfx: false, music: false } };
  try {
    const { data } = await callUpstream('GET', '/v1/models', { timeoutMs: 20000 });
    const list = listOf(data).filter((m) => m?.id);
    const ids = new Set(list.map((m) => m.id));
    // 这里生成视频走的是 POST /v1/videos。列表里有的型号只接在别的接口上（标的不是 openai-video），选了也提交不了，所以不列出来。
    const reachable = (m) => !m.supported_endpoint_types || m.supported_endpoint_types.includes('openai-video');
    const video = list
      .filter((m) => videoFamilyOf(m.id) && reachable(m))
      .map((m) => m.id)
      .sort((a, b) => videoFamilyOf(b).localeCompare(videoFamilyOf(a)) || a.localeCompare(b));
    const rest = {
      // 列表里有些图片模型其实没有可用的通道，只有标了 image-generation 的才能走生图接口。
      imageModels: list.filter((m) => m.type === 'image' && (m.supported_endpoint_types || []).includes('image-generation')).map((m) => m.id).sort(),
      polishModels: (polishAvailable = POLISH_MODELS.flatkey.filter((id) => ids.has(id))),
      audio: { speech: ids.has(SPEECH_MODEL.flatkey), sfx: ids.has(SFX_MODEL), music: ids.has(MUSIC_MODEL) },
    };
    if (video.length) return { models: video, ...rest, source: 'remote' };
    return { models: DEFAULT_MODELS.flatkey, ...rest, source: 'default', note: '账号的模型列表里没有 Seedance 模型，下面显示的是文档里的默认型号。' };
  } catch (err) {
    return { models: DEFAULT_MODELS.flatkey, ...none, source: 'default', error: err.message, errorCode: err.code };
  }
});

route('GET', /^\/api\/credits$/, async () => {
  // 火山方舟没有能用 API Key 查余额的接口，余额要到火山引擎控制台的费用中心看。
  if (currentProvider() === 'ark') return { unavailable: true };
  const { data } = await callUpstream('GET', '/v1/credits', { timeoutMs: 20000 });
  // OpenRouter 给的是充值总额和已用金额，单位是美元。
  if (currentProvider() === 'openrouter') {
    const used = Number(data?.data?.total_usage) || 0;
    return { remaining: (Number(data?.data?.total_credits) || 0) - used, used, unit: 'usd' };
  }
  return { remaining: Number(data?.remaining) || 0, used: Number(data?.used) || 0 };
});

route('POST', /^\/api\/videos$/, async ({ req }) => {
  const { payload, form } = await readJsonBody(req);
  // Flatkey 上 Seedance 的提示词和素材在 content 数组里，Grok 的提示词是 prompt 字符串。
  // OpenRouter 上所有模型都是 prompt 字符串，素材在 frame_images 和 input_references 里，可以只给素材不写提示词。
  // 火山方舟这边页面发来的也是 OpenRouter 那种格式，发出去之前在这里换成它自己的 content 数组。
  const hasContent = Array.isArray(payload?.content) && payload.content.length > 0;
  const hasPrompt = typeof payload?.prompt === 'string' && payload.prompt.trim() !== '';
  const hasMedia = ['frame_images', 'input_references'].some((field) => Array.isArray(payload?.[field]) && payload[field].length > 0);
  if (!payload || typeof payload !== 'object' || !payload.model || (!hasContent && !hasPrompt && !hasMedia)) {
    throw new HttpError(400, 'invalid_request', '请求缺少 model 或 content');
  }
  const provider = currentProvider();
  if (provider === 'ark' && !Object.hasOwn(ARK_VIDEO_MODELS, payload.model)) throw new HttpError(400, 'invalid_request', `火山方舟上没有 ${payload.model} 这个视频模型`);
  const request = withLocalImages(payload);
  const { data } = await callUpstream('POST', VIDEO_TASKS_PATH[provider], { json: provider === 'ark' ? arkVideoRequest(request) : request, provider });
  const id = data?.id || data?.task_id;
  if (!id) throw new HttpError(502, 'bad_upstream_response', `${labelOf(provider)} 没有返回任务 ID`, data);

  const item = {
    id,
    provider,
    kind: 'video',
    createdAt: data.created_at ? data.created_at * 1000 : Date.now(),
    model: payload.model,
    prompt: hasContent ? payload.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') : String(payload.prompt || '').trim(),
    payload,
    form: form || null,
    status: 'queued',
    progress: 0,
    error: null,
    usage: null,
    remoteUrl: null,
    localFile: null,
    lastPolledAt: Date.now(),
  };
  applyTaskState(item, data);
  history.unshift(item);
  saveHistory();
  return historyView(item);
});

// 把页面发来的视频请求换成火山方舟的格式：提示词和素材都放进 content 数组，每份素材用 role 说明它的用途。
// 首帧、尾帧的 role 就是页面给的 frame_type（first_frame、last_frame），参考素材按类型是 reference_image、reference_video、reference_audio。
// 没有指定画面比例时（给了首帧）用 adaptive，由模型跟着图片定。水印默认关着，这里写明。
function arkVideoRequest(payload) {
  const content = [];
  const text = String(payload.prompt || '').trim();
  if (text) content.push({ type: 'text', text });
  for (const frame of payload.frame_images || []) content.push({ type: 'image_url', image_url: frame.image_url, role: frame.frame_type });
  for (const ref of payload.input_references || []) {
    const kind = ['image', 'video', 'audio'].find((k) => ref?.[`${k}_url`]);
    if (kind) content.push({ type: `${kind}_url`, [`${kind}_url`]: ref[`${kind}_url`], role: `reference_${kind}` });
  }
  const request = { model: payload.model, content, resolution: payload.resolution, ratio: payload.aspect_ratio || 'adaptive', duration: payload.duration, watermark: false };
  if (typeof payload.generate_audio === 'boolean') request.generate_audio = payload.generate_audio;
  if (Number.isInteger(payload.seed)) request.seed = payload.seed;
  return request;
}

route('GET', /^\/api\/history$/, async () => ({ items: history.map(historyView) }));

route('POST', /^\/api\/history\/([^/]+)\/refresh$/, async ({ params }) => {
  const item = history.find((h) => h.id === params[0]);
  if (!item) throw new HttpError(404, 'not_found', '没有这条记录');
  if (item.direct) return historyView(item);
  if (isPending(item) || isTimedOut(item)) {
    await pollTask(item);
  } else if (item.status === 'completed' && !item.localFile) {
    item.downloadAttempts = 0;
    await downloadResult(item);
  }
  return historyView(item);
});

route('DELETE', /^\/api\/history\/([^/]+)$/, async ({ params }) => {
  const index = history.findIndex((h) => h.id === params[0]);
  if (index === -1) throw new HttpError(404, 'not_found', '没有这条记录');
  const [item] = history.splice(index, 1);
  if (item.localFile) fs.rmSync(path.join(resultDir(item), path.basename(item.localFile)), { force: true });
  saveHistory();
  return null;
});

// ---------- 图片 ----------

route('POST', /^\/api\/images$/, async ({ req }) => {
  const { payload, form } = await readJsonBody(req);
  const model = String(payload?.model || '');
  const prompt = String(payload?.prompt || '').trim();
  if (!model || !prompt) throw new HttpError(400, 'invalid_request', '请求缺少 model 或提示词');
  requireKey();
  const count = Math.min(MAX_IMAGES, Math.max(1, Math.round(Number(payload.n)) || 1));
  const request = { model, prompt, n: count, response_format: 'b64_json' };
  if (payload.aspect_ratio) request.aspect_ratio = String(payload.aspect_ratio);
  // 参考图（图生图）。OpenRouter 的生图接口收（2026-10-09 用 Grok 实测：本机图片内嵌进请求可以用），每个模型收几张看它的模型列表；
  // 火山方舟的 Seedream 也收，张数登记在 shared/models.ts。Flatkey 的不收。
  const refs = Array.isArray(payload.input_references) ? payload.input_references.filter((entry) => typeof entry?.image_url?.url === 'string') : [];
  if (refs.length) {
    if (currentProvider() === 'flatkey') throw new HttpError(400, 'not_on_provider', '参考图生图在 Flatkey 上用不了，OpenRouter 和火山方舟可以');
    const limit = imageProviderOf(model) === 'ark' ? ARK_IMAGE_MODELS[model]?.refs : openrouterImageRefs[model];
    if (limit === 0) throw new HttpError(400, 'invalid_request', `${model} 不收参考图`);
    if (limit && refs.length > limit) throw new HttpError(400, 'invalid_request', `${model} 最多收 ${limit} 张参考图`);
    request.input_references = withLocalImages({ input_references: refs }).input_references;
  }

  // 一次请求出几张，就建几条记录，每张图各自一条。
  const items = Array.from({ length: count }, () =>
    newItem({ id: newId('img'), kind: 'image', model, prompt, payload: { model, prompt, aspect_ratio: request.aspect_ratio, ...(refs.length ? { input_references: refs } : {}) }, form: form || null }),
  );
  const provider = imageProviderOf(model);
  runDirect(items, async () => {
    const { images, cost } = await { flatkey: flatkeyImages, openrouter: openrouterImages, ark: arkImages }[provider](request);
    if (!images.length) throw new HttpError(502, 'bad_upstream_response', `${labelOf(provider)} 没有返回图片`);
    // 费用按张平摊。
    const usage = cost ? { cost_usd: cost / images.length } : null;
    items.forEach((item, index) => {
      const image = images[index];
      if (!image) {
        item.status = 'failed';
        item.error = { message: '这一张没有生成出来', code: 'missing_image' };
        return;
      }
      // 各平台说明图片格式的字段名字不同；没写格式的按 JPG 存（火山方舟的 Seedream 默认出 JPG）。
      const type = image.mime_type || image.media_type;
      const ext = type ? IMAGE_EXT[type] : 'jpg';
      if (!ext) {
        item.status = 'failed';
        item.error = { message: `这个模型返回的是 ${type}，这里存不了这种格式`, code: 'unsupported_image' };
        return;
      }
      finishItem(item, Buffer.from(image.b64_json, 'base64'), ext, { usage });
    });
  });
  return { items: items.map(historyView) };
});

const IMAGE_EXT = { 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg' };

// 这张图交给哪个平台生成。一般就是当前平台；用火山方舟时，方舟没有的型号（带厂商前缀的，像 openai/gpt-image-2）走 OpenRouter，前提是存了它的 Key。
function imageProviderOf(model) {
  const provider = currentProvider();
  if (provider === 'ark' && !Object.hasOwn(ARK_IMAGE_MODELS, model) && model.includes('/') && apiKey('openrouter')) return 'openrouter';
  return provider;
}

// 上游给的费用单位是 tick，一美元是 1e10 个 tick。
async function flatkeyImages(request) {
  const { data } = await callUpstream('POST', '/v1/images/generations', { json: request, timeoutMs: 3 * 60 * 1000, provider: 'flatkey' });
  return { images: listOf(data).filter((image) => image?.b64_json), cost: (Number(data?.usage?.cost_in_usd_ticks) || 0) / 1e10 };
}

// OpenRouter 的生图接口。很多模型一次只出一张，所以要几张就发几次、同时进行，各出一张；有一次失败了，其余成功的照样留下。
// 模型不收的画面比例不发，由它用自己的默认比例。
async function openrouterImages({ model, prompt, n, aspect_ratio, input_references }) {
  const request = { model, prompt };
  if (input_references) request.input_references = input_references;
  const ratios = openrouterImageRatios[model];
  if (aspect_ratio && (!ratios || ratios.includes(aspect_ratio))) request.aspect_ratio = aspect_ratio;
  const results = await Promise.allSettled(Array.from({ length: n }, () => callUpstream('POST', '/v1/images', { json: request, timeoutMs: 5 * 60 * 1000, provider: 'openrouter' })));
  const done = results.filter((r) => r.status === 'fulfilled').map((r) => r.value.data);
  if (!done.length) throw results[0].reason;
  return {
    images: done.flatMap((data) => listOf(data).filter((image) => image?.b64_json)),
    cost: done.reduce((sum, data) => sum + (Number(data?.usage?.cost) || 0), 0),
  };
}

// 火山方舟的生图接口（Seedream）。5.0 pro 和 5.0 flash 一次只出一张，所以和 OpenRouter 一样，要几张就发几次、同时进行。
// 图片大小写成「宽x高」，按画面比例查登记好的像素值；参考图放在 image 数组里，本机的图已经换成内嵌数据。
// 返回的用量只有张数和 token，没有金额，所以不记费用。
async function arkImages({ model, prompt, n, aspect_ratio, input_references }) {
  const spec = ARK_IMAGE_MODELS[model];
  if (!spec) throw new HttpError(400, 'invalid_request', `火山方舟上没有 ${model} 这个图片模型`);
  const request = { model, prompt, size: spec.sizes[aspect_ratio] || spec.sizes['1:1'], response_format: 'b64_json', watermark: false };
  if (input_references) request.image = input_references.map((ref) => ref.image_url.url);
  const results = await Promise.allSettled(Array.from({ length: n }, () => callUpstream('POST', '/images/generations', { json: request, timeoutMs: 5 * 60 * 1000, provider: 'ark' })));
  const done = results.filter((r) => r.status === 'fulfilled').map((r) => r.value.data);
  if (!done.length) throw results[0].reason;
  return { images: done.flatMap((data) => listOf(data).filter((image) => image?.b64_json)), cost: 0 };
}

// ---------- 音频 ----------

let voices = null;

route('GET', /^\/api\/voices$/, async () => {
  // 火山方舟这条线还没有接语音。
  if (currentProvider() === 'ark') return { items: [] };
  // OpenRouter 上音色只有一串名字，写在模型列表里，没有试听，也没有性别和语言。
  if (!voices && currentProvider() === 'openrouter') {
    const { data } = await callUpstream('GET', '/v1/models?output_modalities=speech', { timeoutMs: 20000 });
    const names = listOf(data).find((m) => m?.id === SPEECH_MODEL.openrouter)?.supported_voices || [];
    voices = names.map((name) => ({ id: String(name), name: String(name).replace(/^./, (c) => c.toUpperCase()), gender: '', language: '', accent: '', previewUrl: '' }));
  }
  if (!voices) {
    const { data } = await callUpstream('GET', '/v1/voices', { timeoutMs: 20000 });
    voices = (Array.isArray(data?.voices) ? data.voices : listOf(data))
      .filter((v) => v?.voice_id)
      .map((v) => ({
        id: v.voice_id,
        name: v.name || v.voice_id,
        gender: v.labels?.gender || '',
        language: v.labels?.language || '',
        accent: v.labels?.accent || '',
        previewUrl: v.preview_url || '',
      }));
  }
  return { items: voices };
});

route('POST', /^\/api\/audio\/speech$/, async ({ req }) => {
  const { text, voiceId, voiceName, form } = await readJsonBody(req);
  const script = String(text || '').trim();
  if (!script) throw new HttpError(400, 'invalid_request', '请填写要朗读的文字');
  if (!/^[\w-]+$/.test(voiceId || '')) throw new HttpError(400, 'invalid_request', '请选择音色');
  requireKey();
  const provider = currentProvider();
  if (provider === 'ark') throw new HttpError(400, 'not_on_provider', '火山方舟这条线还没有接语音，可以在「设置」里切换到别的平台');
  const item = newItem({
    id: newId('aud'),
    kind: 'audio',
    tool: 'speech',
    model: SPEECH_MODEL[provider],
    prompt: script,
    payload: { voice_id: voiceId, voice_name: String(voiceName || '') },
    form: form || null,
  });
  runDirect([item], async () => {
    // OpenRouter 的语音接口是 OpenAI 的那种格式，不指定格式的话返回的是没有文件头的 PCM。
    const { data } =
      provider === 'openrouter'
        ? await callUpstream('POST', '/v1/audio/speech', { json: { model: SPEECH_MODEL.openrouter, input: script, voice: voiceId, response_format: 'mp3' }, binary: true, timeoutMs: 3 * 60 * 1000, provider })
        : await callUpstream('POST', `/v1/text-to-speech/${voiceId}`, { json: { text: script, model_id: SPEECH_MODEL.flatkey }, binary: true, timeoutMs: 3 * 60 * 1000, provider });
    finishItem(item, data, 'mp3');
  });
  return historyView(item);
});

route('POST', /^\/api\/audio\/sfx$/, async ({ req }) => {
  const { text, duration, influence, form } = await readJsonBody(req);
  const prompt = String(text || '').trim();
  if (!prompt) throw new HttpError(400, 'invalid_request', '请描述想要的声音');
  requireKey();
  // 不带时长时由模型自己决定。
  const request = { text: prompt };
  const seconds = Number(duration);
  if (duration != null && duration !== '') {
    if (!(seconds >= 0.5 && seconds <= 22)) throw new HttpError(400, 'invalid_request', '音效时长需要在 0.5 到 22 秒之间');
    request.duration_seconds = seconds;
  }
  const weight = Number(influence);
  if (influence != null && influence !== '' && weight >= 0 && weight <= 1) request.prompt_influence = weight;

  const item = newItem({ id: newId('aud'), kind: 'audio', tool: 'sfx', model: SFX_MODEL, prompt, payload: request, form: form || null });
  runDirect([item], async () => {
    const { data } = await callUpstream('POST', '/v1/sound-generation', { json: request, binary: true, timeoutMs: 3 * 60 * 1000 });
    finishItem(item, data, 'mp3');
  });
  return historyView(item);
});

// 配乐：把本机的一段视频传给上游，得到一个异步任务，和视频任务一样轮询。
route('POST', /^\/api\/audio\/music$/, async ({ req }) => {
  const { video, duration, form } = await readJsonBody(req);
  const file = localMediaFile(video);
  if (!/\.(mp4|mov|webm)$/i.test(file)) throw new HttpError(400, 'invalid_request', '配乐需要一段视频');
  const seconds = Number(duration);
  if (!(seconds > 0)) throw new HttpError(400, 'invalid_request', '没有读到视频时长');

  const body = new FormData();
  body.append('model', MUSIC_MODEL);
  body.append('duration_seconds', String(seconds));
  body.append('video', new Blob([fs.readFileSync(file)], { type: MIME[path.extname(file).toLowerCase()] }), path.basename(file));
  const { data } = await callUpstream('POST', '/v1/video-to-music', { body, timeoutMs: 5 * 60 * 1000 });
  const id = data?.id || data?.task_id;
  if (!id) throw new HttpError(502, 'bad_upstream_response', 'Flatkey 没有返回任务 ID', data);

  const item = newItem({
    id,
    kind: 'audio',
    tool: 'music',
    createdAt: data.created_at ? data.created_at * 1000 : Date.now(),
    model: MUSIC_MODEL,
    prompt: '',
    payload: { video, duration_seconds: seconds },
    form: form || null,
    status: 'queued',
    lastPolledAt: Date.now(),
  });
  applyTaskState(item, data);
  history.unshift(item);
  saveHistory();
  return historyView(item);
});

// 从本机选来当输入的文件先存到 data/uploads，之后用返回的地址引用它。
route('POST', /^\/api\/uploads$/, async ({ req }) => {
  const ext = UPLOAD_TYPES[String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()];
  if (!ext) throw new HttpError(415, 'unsupported_media_type', '只支持 JPG、PNG、WebP 图片，MP4、MOV、WebM 视频，MP3、WAV 音频');
  const body = await readBody(req, MAX_UPLOAD_BYTES);
  if (!body.length) throw new HttpError(400, 'invalid_request', '文件是空的');
  const file = `${newId('up')}.${ext}`;
  fs.writeFileSync(path.join(mediaDir('uploads'), file), body);
  return { url: `/media/uploads/${file}`, size: body.length };
});

// ---------- 画布 ----------
// 一张画布是一组节点和连线，原样存、原样取，里面的内容由页面决定。节点只记生成记录的 id，结果还是在 history 里。

// 列表里只给名字、封面和时间，节点和连线点进去才读。封面是画布里最近生成的一张图或一段视频的地址。
const canvasMeta = (canvas) => ({ id: canvas.id, name: canvas.name, cover: canvas.cover || null, updatedAt: canvas.updatedAt });
const canvasName = (name) => String(name || '').trim().slice(0, 60) || '未命名画布';
function findCanvas(id) {
  const canvas = canvases.find((c) => c.id === id);
  if (!canvas) throw new HttpError(404, 'not_found', '没有这张画布');
  return canvas;
}

route('GET', /^\/api\/canvases$/, async () => ({ items: canvases.map(canvasMeta).sort((a, b) => b.updatedAt - a.updatedAt) }));

route('POST', /^\/api\/canvases$/, async ({ req }) => {
  const { name } = await readJsonBody(req);
  const now = Date.now();
  const canvas = { id: newId('cv'), name: canvasName(name), nodes: [], edges: [], viewport: null, cover: null, createdAt: now, updatedAt: now };
  canvases.push(canvas);
  saveCanvases();
  return canvas;
});

route('GET', /^\/api\/canvases\/([\w-]+)$/, async ({ params }) => findCanvas(params[0]));

route('PUT', /^\/api\/canvases\/([\w-]+)$/, async ({ req, params }) => {
  const canvas = findCanvas(params[0]);
  const body = await readJsonBody(req);
  for (const field of ['nodes', 'edges']) {
    if (body[field] === undefined) continue;
    if (!Array.isArray(body[field])) throw new HttpError(400, 'invalid_request', `${field} 需要是数组`);
    canvas[field] = body[field];
  }
  if (body.name !== undefined) canvas.name = canvasName(body.name);
  if (body.viewport !== undefined) canvas.viewport = body.viewport;
  if (body.cover !== undefined) canvas.cover = typeof body.cover?.url === 'string' ? { url: body.cover.url, kind: body.cover.kind === 'video' ? 'video' : 'image' } : null;
  canvas.updatedAt = Date.now();
  saveCanvases();
  return canvasMeta(canvas);
});

route('DELETE', /^\/api\/canvases\/([\w-]+)$/, async ({ params }) => {
  canvases.splice(canvases.indexOf(findCanvas(params[0])), 1);
  saveCanvases();
  return null;
});

// ---------- 角色 ----------
// 一个角色是一个名字、一段描述和几张参考图。生成图片或视频时把这些图当参考图带上，同一个角色才能反复出现。
// 参考图只存本机的图片地址，都在 data/uploads 里：从生成记录里选的图会复制一份过来，免得那条记录删掉之后角色的图也没了。

const MAX_CHARACTER_IMAGES = 6;
const CHARACTER_IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp'];
const characterName = (name) => String(name || '').trim().slice(0, 60) || '未命名角色';
function findCharacter(id) {
  const character = characters.find((c) => c.id === id);
  if (!character) throw new HttpError(404, 'not_found', '没有这个角色');
  return character;
}
function characterImages(urls) {
  if (!Array.isArray(urls)) throw new HttpError(400, 'invalid_request', 'images 需要是数组');
  if (urls.length > MAX_CHARACTER_IMAGES) throw new HttpError(400, 'invalid_request', `一个角色最多放 ${MAX_CHARACTER_IMAGES} 张参考图`);
  return urls.map((url) => {
    const file = localMediaFile(url);
    const ext = path.extname(file).slice(1).toLowerCase();
    if (!CHARACTER_IMAGE_EXTS.includes(ext)) throw new HttpError(400, 'invalid_request', '角色的参考图只能是图片');
    if (path.dirname(file) === mediaDir('uploads')) return `/media/uploads/${path.basename(file)}`;
    const copy = `${newId('up')}.${ext}`;
    fs.copyFileSync(file, path.join(mediaDir('uploads'), copy));
    return `/media/uploads/${copy}`;
  });
}

route('GET', /^\/api\/characters$/, async () => ({ items: [...characters].sort((a, b) => b.updatedAt - a.updatedAt) }));

route('POST', /^\/api\/characters$/, async ({ req }) => {
  const { name, description, images } = await readJsonBody(req);
  const now = Date.now();
  const character = { id: newId('ch'), name: characterName(name), description: String(description || '').trim().slice(0, 2000), images: characterImages(images || []), createdAt: now, updatedAt: now };
  characters.push(character);
  saveCharacters();
  return character;
});

route('PUT', /^\/api\/characters\/([\w-]+)$/, async ({ req, params }) => {
  const character = findCharacter(params[0]);
  const body = await readJsonBody(req);
  if (body.images !== undefined) character.images = characterImages(body.images);
  if (body.name !== undefined) character.name = characterName(body.name);
  if (body.description !== undefined) character.description = String(body.description || '').trim().slice(0, 2000);
  character.updatedAt = Date.now();
  saveCharacters();
  return character;
});

route('DELETE', /^\/api\/characters\/([\w-]+)$/, async ({ params }) => {
  characters.splice(characters.indexOf(findCharacter(params[0])), 1);
  saveCharacters();
  return null;
});

// ---------- 技能 ----------
// 一个技能是一套写提示词的规则：用户只写一句简单的话，发送前让文本模型按规则扩写成完整的提示词。
// 官方技能登记在 shared/skills.ts，不能改；用户自己建的存在 data/skills.json。

const SKILL_TYPES = ['video', 'image'];
const allSkills = () => [...OFFICIAL_SKILLS, ...[...skills].sort((a, b) => b.updatedAt - a.updatedAt)];
function findSkill(id) {
  const skill = allSkills().find((item) => item.id === id);
  if (!skill) throw new HttpError(404, 'not_found', '没有这个技能');
  return skill;
}
function ownSkill(id) {
  const skill = findSkill(id);
  if (skill.official) throw new HttpError(400, 'invalid_request', '官方技能不能修改');
  return skill;
}
// 名称、说明、规则都要有；规则太短等于没有规则。
function skillFields(body, current = {}) {
  const next = {
    name: body.name === undefined ? current.name : String(body.name || '').trim().slice(0, 30),
    description: body.description === undefined ? current.description : String(body.description || '').trim().slice(0, 120),
    type: body.type === undefined ? current.type : body.type,
    rules: body.rules === undefined ? current.rules : String(body.rules || '').trim(),
  };
  if (!next.name) throw new HttpError(400, 'invalid_request', '请给技能起个名字');
  if (!SKILL_TYPES.includes(next.type)) throw new HttpError(400, 'invalid_request', '技能只能用在视频或图片上');
  if (next.rules.length < 10) throw new HttpError(400, 'invalid_request', '请写下这个技能的规则：希望模型怎样把一句话写成提示词');
  if (next.rules.length > 8000) throw new HttpError(400, 'invalid_request', '规则太长，最多 8000 字');
  return next;
}

route('GET', /^\/api\/skills$/, async () => ({ items: allSkills() }));

route('POST', /^\/api\/skills$/, async ({ req }) => {
  const now = Date.now();
  const skill = { id: newId('sk'), ...skillFields(await readJsonBody(req)), createdAt: now, updatedAt: now };
  skills.push(skill);
  saveSkills();
  return skill;
});

// 按技能的规则把用户写的话扩写成提示词。context 是这次生成的设置（时长、有没有声音、带了几张参考图），原样放在用户那句话前面。
route('POST', /^\/api\/skills\/expand$/, async ({ req }) => {
  const { id, text, context, model } = await readJsonBody(req);
  const skill = findSkill(id);
  const draft = String(text || '').trim();
  if (!draft) throw new HttpError(400, 'invalid_request', '请先写下想生成什么');
  if (draft.length > 4000) throw new HttpError(400, 'invalid_request', '内容太长，技能最多处理 4000 字');
  if (!POLISH_MODELS[currentProvider()].includes(model)) throw new HttpError(400, 'invalid_request', '不支持用这个模型扩写');
  const setup = String(context || '').trim().slice(0, 500);
  return askTextModel(model, [{ role: 'system', content: skill.rules }, { role: 'user', content: setup ? `${setup}\n\n${draft}` : draft }], 2000);
});

route('PUT', /^\/api\/skills\/([\w-]+)$/, async ({ req, params }) => {
  const skill = ownSkill(params[0]);
  Object.assign(skill, skillFields(await readJsonBody(req), skill), { updatedAt: Date.now() });
  saveSkills();
  return skill;
});

route('DELETE', /^\/api\/skills\/([\w-]+)$/, async ({ params }) => {
  skills.splice(skills.indexOf(ownSkill(params[0])), 1);
  saveSkills();
  return null;
});

// ---------- 工作流 ----------
// 一份工作流是画布上的一组节点和它们之间的连线，存下来以后可以整套放回任何一张画布。
// 和画布一样原样存、原样取；列表里只给名字、节点数和时间。

const MAX_WORKFLOW_NODES = 200;
const workflowName = (name) => String(name || '').trim().slice(0, 60) || '未命名工作流';
const workflowMeta = (flow) => ({ id: flow.id, name: flow.name, count: flow.nodes.length, updatedAt: flow.updatedAt });
function findWorkflow(id) {
  const flow = workflows.find((w) => w.id === id);
  if (!flow) throw new HttpError(404, 'not_found', '没有这份工作流');
  return flow;
}

route('GET', /^\/api\/workflows$/, async () => ({ items: [...workflows].sort((a, b) => b.updatedAt - a.updatedAt).map(workflowMeta) }));

route('POST', /^\/api\/workflows$/, async ({ req }) => {
  const { name, nodes, edges } = await readJsonBody(req);
  if (!Array.isArray(nodes) || !nodes.length) throw new HttpError(400, 'invalid_request', '工作流里至少要有一个节点');
  if (nodes.length > MAX_WORKFLOW_NODES) throw new HttpError(400, 'invalid_request', `一份工作流最多 ${MAX_WORKFLOW_NODES} 个节点`);
  if (!Array.isArray(edges)) throw new HttpError(400, 'invalid_request', 'edges 需要是数组');
  const now = Date.now();
  const flow = { id: newId('wf'), name: workflowName(name), nodes, edges, createdAt: now, updatedAt: now };
  workflows.push(flow);
  saveWorkflows();
  return workflowMeta(flow);
});

route('GET', /^\/api\/workflows\/([\w-]+)$/, async ({ params }) => findWorkflow(params[0]));

route('PUT', /^\/api\/workflows\/([\w-]+)$/, async ({ req, params }) => {
  const flow = findWorkflow(params[0]);
  const body = await readJsonBody(req);
  if (body.name !== undefined) flow.name = workflowName(body.name);
  flow.updatedAt = Date.now();
  saveWorkflows();
  return workflowMeta(flow);
});

route('DELETE', /^\/api\/workflows\/([\w-]+)$/, async ({ params }) => {
  workflows.splice(workflows.indexOf(findWorkflow(params[0])), 1);
  saveWorkflows();
  return null;
});

// ---------- 提示词润色 ----------

// 发给文本模型的系统提示词按要用的生成模型来选，规则都在 shared/models.ts。

// 账号里列着的文本模型不一定都调得通：有的被限流，有的通道本身有问题。
// 所以选中的模型不行就换下一个；刚失败过的模型十分钟内先不再试，免得每次润色都白等一回。
// 读到模型列表之前是 null，这时按登记的全部型号来试。
let polishAvailable = null;
const polishFailedAt = new Map();
const POLISH_RETRY_MS = 10 * 60 * 1000;

route('POST', /^\/api\/polish$/, async ({ req }) => {
  // target 是这条提示词要拿去用的生成模型和生成方式。
  const { text, kind, model, target = {} } = await readJsonBody(req);
  const draft = String(text || '').trim();
  if (!draft) throw new HttpError(400, 'invalid_request', '请先写下提示词');
  if (draft.length > 4000) throw new HttpError(400, 'invalid_request', '提示词太长，润色最多支持 4000 字');
  if (!POLISH_KINDS.includes(kind)) throw new HttpError(400, 'invalid_request', '这种内容不支持润色');
  const guide = polishGuide({ kind, model: target.model, mode: target.mode, refs: target.refs });
  const known = POLISH_MODELS[currentProvider()];
  if (!known.includes(model)) throw new HttpError(400, 'invalid_request', '不支持用这个模型润色');

  return askTextModel(model, [{ role: 'system', content: guide }, { role: 'user', content: draft }], 1200);
});

const CHAT_PATH = { ark: '/chat/completions' };
// 豆包的文本模型默认会先深度思考再回答，润色用不上，还会把限定的输出长度占掉，所以在火山方舟上关掉。
function chatRequest(model, messages, maxTokens) {
  const request = { model, max_tokens: maxTokens, messages };
  if (currentProvider() === 'ark') request.thinking = { type: 'disabled' };
  return request;
}

// 问文本模型要一段文字。选中的模型不行就按上面说的顺序换下一个，返回文字和实际用的模型。
async function askTextModel(model, messages, maxTokens) {
  const known = POLISH_MODELS[currentProvider()];
  const others = (polishAvailable || known).filter((id) => id !== model);
  const fresh = (id) => Date.now() - (polishFailedAt.get(id) || 0) > POLISH_RETRY_MS;
  // 先试没失败过的；全都刚失败过，就还是从选中的那个试起。
  const candidates = [model, ...others].filter(fresh);
  let lastError;
  for (const candidate of candidates.length ? candidates : [model, ...others]) {
    try {
      const { data } = await callUpstream('POST', CHAT_PATH[currentProvider()] || '/v1/chat/completions', { json: chatRequest(candidate, messages, maxTokens), timeoutMs: 90000 });
      const text = String(data?.choices?.[0]?.message?.content || '').trim();
      if (!text) throw new HttpError(502, 'bad_upstream_response', '模型没有返回内容', data);
      polishFailedAt.delete(candidate);
      return { text, model: candidate };
    } catch (err) {
      // Key 有问题或者连不上平台，换模型也没用。
      if (!(err instanceof HttpError) || err.status === 401 || err.code === 'upstream_unreachable') throw err;
      polishFailedAt.set(candidate, Date.now());
      lastError = err;
    }
  }
  throw lastError;
}

// 画布上的文本节点让模型写一段文字：剧本、分镜、提示词都行。context 是连进来的文本和节点里已有的内容。
// 用的是和润色同一组文本模型，结果直接回到节点里，不进创作记录。
const WRITER_GUIDE = '你是影视和短视频创作的写作助手。按用户的要求写出内容本身：不要寒暄，不要解释你做了什么，不要用 Markdown 标题和加粗。用户给了参考内容时，在它的基础上写。用用户提要求时用的语言回答。';
route('POST', /^\/api\/text$/, async ({ req }) => {
  const { prompt, context, model } = await readJsonBody(req);
  const ask = String(prompt || '').trim();
  const given = String(context || '').trim();
  if (!ask) throw new HttpError(400, 'invalid_request', '请先写下想让模型写什么');
  if (ask.length + given.length > 12000) throw new HttpError(400, 'invalid_request', '内容太长，要求和参考内容加起来最多 12000 字');
  if (!POLISH_MODELS[currentProvider()].includes(model)) throw new HttpError(400, 'invalid_request', '不支持用这个模型写');
  const user = given ? `参考内容：\n${given}\n\n要求：\n${ask}` : ask;
  return askTextModel(model, [{ role: 'system', content: WRITER_GUIDE }, { role: 'user', content: user }], 3000);
});

// ---------- 素材库、真人档案 ----------

route('GET', /^\/api\/assets$/, async () => ({
  items: Object.values(assets).filter((a) => a.kind === 'virtual').sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)),
}));

route('POST', /^\/api\/assets$/, async ({ req }) => {
  const { url, asset_type: assetType, name } = await readJsonBody(req);
  if (!/^https:\/\//i.test(url || '')) throw new HttpError(400, 'invalid_request', '需要一个 https:// 开头的公网地址');
  const { data } = await callUpstream('POST', '/v1/assets', {
    json: { url, asset_type: assetType, moderation: { strategy: 'Default' } },
  });
  return upsertAsset(data, { kind: 'virtual', source: 'url', sourceUrl: url, name: name || '', asset_type: assetType });
});

route('POST', /^\/api\/assets\/upload$/, async ({ req }) => {
  const contentType = req.headers['content-type'] || '';
  if (!/^multipart\/form-data/i.test(contentType)) throw new HttpError(400, 'invalid_request', '上传必须是 multipart/form-data');
  if (!apiKey()) throw new HttpError(401, 'no_api_key', '还没有设置 API Key，请先在「设置」里填写。');
  const body = await readBody(req, MAX_UPLOAD_BYTES);
  const { data } = await callUpstream('POST', '/v1/assets/upload', {
    body,
    headers: { 'Content-Type': contentType },
    timeoutMs: 5 * 60 * 1000,
  });
  return upsertAsset(data, {
    kind: 'virtual',
    source: 'upload',
    name: decodeHeader(req.headers['x-asset-name']),
    asset_type: decodeHeader(req.headers['x-asset-type']) || undefined,
  });
});

route('POST', /^\/api\/assets\/import$/, async ({ req }) => {
  const body = await readJsonBody(req);
  const id = String(body.id || '').trim().replace(/^asset:\/\//, '');
  if (!/^[\w-]+$/.test(id)) throw new HttpError(400, 'invalid_request', '素材 ID 格式不对，应为 ast_ 开头');
  const { data } = await callUpstream('GET', `/v1/assets/${id}`);
  return upsertAsset({ id, ...data }, { kind: assets[id]?.kind || 'virtual', source: assets[id]?.source || 'import' });
});

route('GET', /^\/api\/assets\/([\w-]+)$/, async ({ params }) => {
  const id = params[0];
  try {
    const { data } = await callUpstream('GET', `/v1/assets/${id}`, { timeoutMs: 20000 });
    return upsertAsset({ id, ...data }, { kind: assets[id]?.kind || 'virtual' });
  } catch (err) {
    if (err.status === 404 && assets[id]) {
      assets[id] = { ...assets[id], status: 'Deleted', checkedAt: Date.now() };
      saveAssets();
      return assets[id];
    }
    throw err;
  }
});

route('PATCH', /^\/api\/assets\/([\w-]+)$/, async ({ req, params }) => {
  const id = params[0];
  const body = await readJsonBody(req);
  const prev = assets[id] || { id, addedAt: Date.now(), kind: body.kind === 'person' ? 'person' : 'virtual' };
  const next = { ...prev };
  if (typeof body.name === 'string') next.name = body.name.slice(0, 200);
  if (typeof body.thumb === 'string' && body.thumb.length < 400000) next.thumb = body.thumb;
  if (typeof body.asset_type === 'string') next.asset_type = body.asset_type;
  if (typeof body.personId === 'string') next.personId = body.personId;
  assets[id] = next;
  saveAssets();
  return next;
});

route('DELETE', /^\/api\/assets\/([\w-]+)$/, async ({ params, query }) => {
  const id = params[0];
  if (query.get('scope') !== 'local') {
    try {
      await callUpstream('DELETE', `/v1/assets/${id}`);
    } catch (err) {
      if (err.status !== 404) throw err;
    }
  }
  delete assets[id];
  saveAssets();
  return null;
});

const idempotencyKey = (req) => String(req.headers['idempotency-key'] || '') || crypto.randomUUID();

route('GET', /^\/api\/real-persons$/, async () => {
  const { data } = await callUpstream('GET', '/v1/real-persons');
  return { items: listOf(data).map(normalizePerson) };
});

route('POST', /^\/api\/real-persons$/, async ({ req }) => {
  const { name } = await readJsonBody(req);
  if (!String(name || '').trim()) throw new HttpError(400, 'invalid_request', '请填写档案名称');
  const { data } = await callUpstream('POST', '/v1/real-persons', {
    json: { name: String(name).trim() },
    headers: { 'Idempotency-Key': idempotencyKey(req) },
  });
  return normalizePerson(data || {});
});

route('GET', /^\/api\/real-persons\/([\w-]+)$/, async ({ params }) => {
  const { data } = await callUpstream('GET', `/v1/real-persons/${params[0]}`);
  return normalizePerson(data || {});
});

route('POST', /^\/api\/real-persons\/([\w-]+)\/verification-sessions$/, async ({ req, params }) => {
  const { data } = await callUpstream('POST', `/v1/real-persons/${params[0]}/verification-sessions`, {
    headers: { 'Idempotency-Key': idempotencyKey(req) },
  });
  return { verification_url: data?.verification_url || '', raw: data };
});

route('GET', /^\/api\/real-persons\/([\w-]+)\/assets$/, async ({ params, query }) => {
  const limit = Math.min(100, Math.max(1, Number(query.get('limit')) || 20));
  const { data } = await callUpstream('GET', `/v1/real-persons/${params[0]}/assets?limit=${limit}`);
  return { items: listOf(data).map((a) => normalizePersonAsset(a, params[0])) };
});

route('POST', /^\/api\/real-persons\/([\w-]+)\/assets$/, async ({ req, params }) => {
  const personId = params[0];
  const contentType = req.headers['content-type'] || '';
  const headers = { 'Idempotency-Key': idempotencyKey(req) };
  let result;
  let name = '';
  let assetType = '';
  if (/^multipart\/form-data/i.test(contentType)) {
    if (!apiKey()) throw new HttpError(401, 'no_api_key', '还没有设置 API Key，请先在「设置」里填写。');
    const body = await readBody(req, MAX_UPLOAD_BYTES);
    name = decodeHeader(req.headers['x-asset-name']);
    assetType = decodeHeader(req.headers['x-asset-type']);
    result = await callUpstream('POST', `/v1/real-persons/${personId}/assets`, {
      body,
      headers: { ...headers, 'Content-Type': contentType },
      timeoutMs: 5 * 60 * 1000,
    });
  } else {
    const body = await readJsonBody(req);
    if (!/^https:\/\//i.test(body.url || '')) throw new HttpError(400, 'invalid_request', '需要一个 https:// 开头的公网地址');
    name = body.name || '';
    assetType = body.asset_type || '';
    result = await callUpstream('POST', `/v1/real-persons/${personId}/assets`, {
      json: { url: body.url, asset_type: body.asset_type, ...(name ? { name } : {}) },
      headers,
    });
  }
  const data = result.data || {};
  const id = assetIdOf(data);
  if (id) {
    assets[id] = { ...(assets[id] || { id, addedAt: Date.now() }), kind: 'person', personId, name, asset_type: data.asset_type || assetType };
    saveAssets();
  }
  return normalizePersonAsset({ name, asset_type: assetType, ...data }, personId);
});

// ---------- 服务入口 ----------

const FLATKEY_ONLY = /^\/api\/(audio\/(sfx|music)|assets|real-persons)(\/|$)/;

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathname = decodeURIComponent(url.pathname);
  const isApi = pathname.startsWith('/api/');
  const isMedia = pathname.startsWith('/media/');

  if ((isApi || isMedia) && !isTrustedRequest(req)) {
    return sendJson(res, 403, { error: { code: 'forbidden', message: '只接受本机页面发来的请求' } });
  }

  if (isApi) {
    // 音效、配乐、素材库、真人档案只有 Flatkey 有。读本机已有的素材列表不受影响。
    if (FLATKEY_ONLY.test(pathname) && currentProvider() !== 'flatkey' && !(req.method === 'GET' && pathname === '/api/assets')) {
      throw new HttpError(400, 'not_on_provider', `这个功能只在 Flatkey 上可用，当前用的是 ${labelOf(currentProvider())}。可以在「设置」里切换平台。`);
    }
    for (const { method, pattern, handler } of routes) {
      if (method !== req.method) continue;
      const match = pattern.exec(pathname);
      if (!match) continue;
      const result = await handler({ req, res, params: match.slice(1), query: url.searchParams });
      if (result === null) {
        res.writeHead(204);
        return res.end();
      }
      return sendJson(res, 200, result);
    }
    return sendJson(res, 404, { error: { code: 'not_found', message: '没有这个接口' } });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: { code: 'method_not_allowed', message: '不支持的请求方法' } });
  }

  if (isMedia) {
    const match = MEDIA_PATH.exec(pathname);
    if (!match) return sendJson(res, 404, { error: { code: 'not_found', message: '文件不存在' } });
    const download = url.searchParams.has('download') ? `seedance-${match[2]}` : undefined;
    return serveFile(req, res, path.join(mediaDir(match[1]), match[2]), { download });
  }

  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(PUBLIC_DIR, relative);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJson(res, 404, { error: { code: 'not_found', message: '文件不存在' } });
  }
  return serveFile(req, res, file);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (res.headersSent) return res.end();
    const status = err instanceof HttpError ? err.status : 500;
    if (!(err instanceof HttpError)) console.error(err);
    sendJson(res, status, {
      error: {
        code: err.code || 'internal_error',
        message: err instanceof HttpError ? err.message : `本地服务出错：${err.message}`,
        upstream: err.upstream,
      },
    });
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用。可以换一个端口启动：PORT=5180 node server.js`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`Innate Studio 已启动：http://${HOST}:${PORT}`);
  console.log(`数据目录：${DATA_DIR}`);
  if (!fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) console.log('还没有构建页面，打开会是空的。先运行 npm run build（npm start 会自动构建）。');
  console.log(`当前平台：${labelOf(currentProvider())}`);
  if (!apiKey()) console.log('还没有设置 API Key，打开页面后在「设置」里填写。');
  setInterval(tick, 2000);
  tick();
});
