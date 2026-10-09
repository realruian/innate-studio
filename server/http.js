// HTTP 的基础：出错的形状、读请求体、返回 JSON 和文件、登记接口。

import fs from 'node:fs';
import path from 'node:path';
import { MAX_JSON_BYTES } from './config.js';

export class HttpError extends Error {
  constructor(status, code, message, upstream) {
    super(message);
    this.status = status;
    this.code = code;
    this.upstream = upstream;
  }
}

export function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    // 超过上限时不掐断连接：浏览器要等自己发完才读响应，中途断开它只会报"网络错误"，
    // 页面上就成了"连不上本地服务"。所以把剩下的内容读完丢掉，再正常返回 413。
    const tooLarge = () => new HttpError(413, 'payload_too_large', `文件过大，超过 ${Math.round(limit / 1024 / 1024)} MB`);
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

export async function readJsonBody(req) {
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

export const MIME = {
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

export const notFound = (res) => sendJson(res, 404, { error: { code: 'not_found', message: '文件不存在' } });

// cache 是这份文件可以让浏览器存多久（Cache-Control 的值）；不给就每次都重新取。
export function serveFile(req, res, file, { download, cache = 'no-store' } = {}) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return notFound(res);
  }
  if (!stat.isFile()) return notFound(res);

  const headers = {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': cache,
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

// 接口登记在这里，server.js 按请求方法和路径来找。处理函数拿到 { req, res, params, query, space, user }，
// 返回的对象当 JSON 发回去，返回 null 是 204。space 是发请求的人自己的那份数据，user 是他的账号（本机模式下是 null）。
// access 只在多人模式下起作用：不写是登录了就能用，'open' 是不登录也能用，'admin' 是只有管理员能用。
export const routes = [];
export const route = (method, pattern, handler, access = 'user') => routes.push({ method, pattern, handler, access });
