#!/usr/bin/env node

// Seedance Studio 本地服务：托管页面、保管 API Key、转发 Flatkey 请求、轮询任务并保存历史。
// 零依赖，需要 Node 18 以上。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 5178;
const HOST = '127.0.0.1';
const BASE_URL = (process.env.FLATKEY_BASE_URL || 'https://router.flatkey.ai').replace(/\/+$/, '');
const DATA_DIR = path.resolve(process.env.SEEDANCE_DATA_DIR || path.join(__dirname, 'data'));
const VIDEO_DIR = path.join(DATA_DIR, 'videos');
const PUBLIC_DIR = path.join(__dirname, 'public');

const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
const MAX_JSON_BYTES = 6 * 1024 * 1024;
const POLL_INTERVAL_MS = 6000;
// 任务提交后超过这么久还没有结果，就停止自动查询。可以用环境变量 SEEDANCE_PENDING_LIMIT_MS 改。
const MAX_PENDING_MS = Number(process.env.SEEDANCE_PENDING_LIMIT_MS) || 6 * 60 * 60 * 1000;
const DOWNLOAD_RETRY_MS = 30000;
const MAX_DOWNLOAD_ATTEMPTS = 6;
const DEFAULT_MODELS = ['seedance-2.0', 'seedance-2.0-fast'];

fs.mkdirSync(VIDEO_DIR, { recursive: true });

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

const saveConfig = () => writeJson('config.json', config, 0o600);
const saveHistory = () => writeJson('history.json', history);
const saveAssets = () => writeJson('assets.json', assets);

// Key 要放进 HTTP 请求头，只能由可见的 ASCII 字符组成。
const isUsableKey = (value) => /^[\x21-\x7e]+$/.test(value);
const BAD_KEY_MESSAGE = '这不像是 API Key：里面有中文、空格或其他不能用的字符。请到 Flatkey 控制台复制以 sk-fk- 开头的那一串，再粘贴进来。';

if (config.apiKey && !isUsableKey(config.apiKey)) {
  delete config.apiKey;
  saveConfig();
  console.log('之前保存的 API Key 含有非法字符，已清除，请在「设置」里重新填写。');
}

function apiKey() {
  return process.env.FLATKEY_API_KEY || config.apiKey || '';
}

function keyState() {
  const key = apiKey();
  return {
    hasKey: Boolean(key),
    keyHint: key ? `${key.slice(0, 6)}…${key.slice(-4)}` : '',
    keySource: process.env.FLATKEY_API_KEY ? 'env' : key ? 'file' : '',
    baseUrl: BASE_URL,
  };
}

// ---------- 调用 Flatkey ----------

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
  model_not_found: 'Flatkey 不认识这个模型 ID',
  rate_limit_exceeded: '请求太频繁，请稍后再试',
  upstream_unavailable: '模型服务暂时不可用，请稍后重试',
};

async function callUpstream(method, pathname, { json, body, headers = {}, timeoutMs = 60000 } = {}) {
  const key = apiKey();
  if (!key) throw new HttpError(401, 'no_api_key', '还没有设置 API Key，请先在「设置」里填写。');

  if (!isUsableKey(key)) throw new HttpError(400, 'invalid_key', BAD_KEY_MESSAGE);

  const requestHeaders = { Authorization: `Bearer ${key}`, ...headers };
  let payload = body;
  if (json !== undefined) {
    requestHeaders['Content-Type'] = 'application/json';
    payload = JSON.stringify(json);
  }

  let res;
  try {
    res = await fetch(BASE_URL + pathname, {
      method,
      headers: requestHeaders,
      body: payload,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? '请求超时' : err.cause?.code || err.message;
    throw new HttpError(502, 'upstream_unreachable', `连接 Flatkey 失败：${reason}`);
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
    const message = (typeof e === 'string' ? e : e?.message) || data?.message || `Flatkey 返回 ${res.status}`;
    const code = String((typeof e === 'object' && e?.code) || data?.code || `http_${res.status}`);
    const hint = ERROR_HINTS[code] ? `${ERROR_HINTS[code]}。` : '';
    throw new HttpError(res.status, code, `${hint}Flatkey 返回（${res.status}）：${message}`, data);
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
const isTimedOut = (item) => item.status === 'failed' && item.error?.code === 'poll_timeout';

function applyTaskState(item, data) {
  if (!data) return;
  const status = STATUS_ALIASES[String(data.status || '').toLowerCase()];
  if (status) item.status = status;
  if (typeof data.progress === 'number') item.progress = data.progress;
  if (data.usage) item.usage = data.usage;
  if (data.completed_at) item.completedAt = data.completed_at * 1000;
  if (data.metadata?.url) item.remoteUrl = data.metadata.url;
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
  }
}

const polling = new Set();
const downloading = new Set();

async function pollTask(item) {
  if (polling.has(item.id)) return;
  polling.add(item.id);
  try {
    const { data } = await callUpstream('GET', `/v1/videos/${encodeURIComponent(item.id)}`, { timeoutMs: 20000 });
    applyTaskState(item, data);
    item.pollError = null;
  } catch (err) {
    if (err.status === 404) {
      item.status = 'failed';
      item.error = { message: 'Flatkey 查不到这个任务', code: 'task_not_found' };
    } else {
      item.pollError = err.message;
    }
  } finally {
    item.lastPolledAt = Date.now();
    // 先查再判断：服务停了很久再启动时，任务可能早就完成了。查过这一次仍没有结果才算超时。
    if (isPending(item) && Date.now() - item.createdAt > MAX_PENDING_MS) {
      item.status = 'failed';
      item.error = { message: '等了很久还没有结果，已停止自动查询。任务可能还在 Flatkey 那边进行，可以再查一次。', code: 'poll_timeout' };
    }
    polling.delete(item.id);
    saveHistory();
  }
  if (item.status === 'completed') downloadVideo(item);
}

// 任务完成后把 MP4 存到本地，历史记录不依赖远端地址是否还有效。
async function downloadVideo(item) {
  if (!item.remoteUrl || item.localFile || downloading.has(item.id)) return;
  if ((item.downloadAttempts || 0) >= MAX_DOWNLOAD_ATTEMPTS) return;
  downloading.add(item.id);
  item.downloadAttempts = (item.downloadAttempts || 0) + 1;
  item.lastDownloadAt = Date.now();

  const file = `${item.id.replace(/[^\w.-]/g, '_')}.mp4`;
  const tmp = path.join(VIDEO_DIR, `${file}.part`);
  try {
    const url = new URL(item.remoteUrl);
    const headers = {};
    // 只在同一个 Flatkey 域名下才带上 Key，避免把 Key 发给别的主机。
    if (url.origin === new URL(BASE_URL).origin && apiKey()) headers.Authorization = `Bearer ${apiKey()}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10 * 60 * 1000) });
    if (!res.ok || !res.body) throw new Error(`下载返回 ${res.status}`);
    const type = res.headers.get('content-type') || '';
    if (/^(application\/json|text\/)/i.test(type)) throw new Error(`下载到的不是视频（${type}）`);
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
    const { size } = fs.statSync(tmp);
    if (!size) throw new Error('下载到空文件');
    fs.renameSync(tmp, path.join(VIDEO_DIR, file));
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
  if (!apiKey()) return;
  const now = Date.now();
  for (const item of history) {
    if (isPending(item)) {
      if (now - (item.lastPolledAt || 0) >= POLL_INTERVAL_MS) pollTask(item);
    } else if (item.status === 'completed' && !item.localFile && item.remoteUrl) {
      if (now - (item.lastDownloadAt || 0) >= DOWNLOAD_RETRY_MS) downloadVideo(item);
    }
  }
}

function historyView(item) {
  return {
    ...item,
    videoUrl: item.localFile ? `/media/videos/${item.localFile}` : item.remoteUrl || null,
    savedLocally: Boolean(item.localFile),
  };
}

// ---------- 素材 ----------

function assetIdOf(data) {
  const uri = data?.asset_url || data?.asset_uri || '';
  return data?.id || data?.asset_id || uri.replace(/^asset:\/\//, '') || '';
}

function upsertAsset(data, extra = {}) {
  const id = assetIdOf(data);
  if (!id) throw new HttpError(502, 'bad_upstream_response', 'Flatkey 没有返回素材 ID', data);
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
  '.mp4': 'video/mp4',
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

route('PUT', /^\/api\/key$/, async ({ req }) => {
  const { apiKey: key } = await readJsonBody(req);
  const value = String(key || '').trim();
  if (!value) throw new HttpError(400, 'invalid_key', 'API Key 不能为空');
  if (!isUsableKey(value)) throw new HttpError(400, 'invalid_key', BAD_KEY_MESSAGE);
  config.apiKey = value;
  saveConfig();
  return keyState();
});

route('DELETE', /^\/api\/key$/, async () => {
  delete config.apiKey;
  saveConfig();
  return keyState();
});

route('GET', /^\/api\/models$/, async () => {
  try {
    const { data } = await callUpstream('GET', '/v1/models', { timeoutMs: 20000 });
    const ids = listOf(data).map((m) => m?.id).filter((id) => /seedance/i.test(id || ''));
    if (ids.length) return { models: [...new Set(ids)].sort(), source: 'remote' };
    return { models: DEFAULT_MODELS, source: 'default', note: '账号的模型列表里没有 Seedance 模型，下面显示的是文档里的默认型号。' };
  } catch (err) {
    return { models: DEFAULT_MODELS, source: 'default', error: err.message, errorCode: err.code };
  }
});

route('POST', /^\/api\/videos$/, async ({ req }) => {
  const { payload, form } = await readJsonBody(req);
  if (!payload || typeof payload !== 'object' || !payload.model || !Array.isArray(payload.content) || !payload.content.length) {
    throw new HttpError(400, 'invalid_request', '请求缺少 model 或 content');
  }
  const { data } = await callUpstream('POST', '/v1/videos', { json: payload });
  const id = data?.id || data?.task_id;
  if (!id) throw new HttpError(502, 'bad_upstream_response', 'Flatkey 没有返回任务 ID', data);

  const item = {
    id,
    createdAt: data.created_at ? data.created_at * 1000 : Date.now(),
    model: payload.model,
    prompt: payload.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'),
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

route('GET', /^\/api\/history$/, async () => ({ items: history.map(historyView) }));

route('POST', /^\/api\/history\/([^/]+)\/refresh$/, async ({ params }) => {
  const item = history.find((h) => h.id === params[0]);
  if (!item) throw new HttpError(404, 'not_found', '没有这条记录');
  if (isPending(item) || isTimedOut(item)) {
    await pollTask(item);
  } else if (item.status === 'completed' && !item.localFile) {
    item.downloadAttempts = 0;
    await downloadVideo(item);
  }
  return historyView(item);
});

route('DELETE', /^\/api\/history\/([^/]+)$/, async ({ params }) => {
  const index = history.findIndex((h) => h.id === params[0]);
  if (index === -1) throw new HttpError(404, 'not_found', '没有这条记录');
  const [item] = history.splice(index, 1);
  if (item.localFile) fs.rmSync(path.join(VIDEO_DIR, path.basename(item.localFile)), { force: true });
  saveHistory();
  return null;
});

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

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathname = decodeURIComponent(url.pathname);
  const isApi = pathname.startsWith('/api/');
  const isMedia = pathname.startsWith('/media/');

  if ((isApi || isMedia) && !isTrustedRequest(req)) {
    return sendJson(res, 403, { error: { code: 'forbidden', message: '只接受本机页面发来的请求' } });
  }

  if (isApi) {
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
    const match = /^\/media\/videos\/([\w.-]+\.mp4)$/.exec(pathname);
    if (!match) return sendJson(res, 404, { error: { code: 'not_found', message: '文件不存在' } });
    const download = url.searchParams.has('download') ? `seedance-${match[1]}` : undefined;
    return serveFile(req, res, path.join(VIDEO_DIR, match[1]), { download });
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
  console.log(`Seedance Studio 已启动：http://${HOST}:${PORT}`);
  console.log(`数据目录：${DATA_DIR}`);
  if (!apiKey()) console.log('还没有设置 API Key，打开页面后在「设置」里填写。');
  setInterval(tick, 2000);
  tick();
});
