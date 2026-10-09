// 模拟火山方舟的视频、图片、对话接口，形状按它的官方文档写（2026-10-09 读的，还没有用真实的 Key 跑过）。只用于测试，不会访问外网。
// 地址里没有 /api/v3 前缀：真实的接口地址是 https://ark.cn-beijing.volces.com/api/v3，这里的 url 对应的就是带着 /api/v3 的那一段。
//
// 约定：
// - 提示词里带 REJECT：创建时直接返回 400
// - 提示词里带 NOTOPEN：创建时返回 404，错误码是 ModelNotOpen
// - 提示词里带 FAIL：任务变成 failed
// - 其余任务按时间走 queued → running → succeeded
// - 生图的提示词里带 FAIL：返回 500
// - 豆包语音（另一个产品，另一个 Key）：音频分两段返回，文字里带 FAIL 时在流里返回出错的 code

import http from 'node:http';
import crypto from 'node:crypto';

export const MOCK_ARK_KEY = '0a1b2c3d-mock-4e5f-ark0-testkey00001';
export const MOCK_SPEECH_KEY = 'mock-doubao-speech-key-0001';
export const MOCK_ACCESS_KEY = { id: 'AKLTmockaccesskeyid0001', secret: 'bW9ja3NlY3JldGFjY2Vzc2tleQ==' };

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

export function startMock({ port = 0, taskSeconds = 14 } = {}) {
  const tasks = new Map();
  const log = [];

  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const fail = (res, status, code, message) => json(res, status, { error: { code, message: `${message} Request id: mock`, param: '', type: status === 401 ? 'Unauthorized' : 'BadRequest' } });
  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
    });

  function taskView(t, base) {
    const age = (Date.now() - t.start) / 1000;
    const { model, resolution, ratio, duration } = t.payload;
    const view = { id: t.id, model, created_at: Math.floor(t.start / 1000), updated_at: Math.floor(Date.now() / 1000), resolution, ratio, duration, service_tier: 'default' };
    if (age < taskSeconds * 0.1) return { ...view, status: 'queued' };
    if (t.fail) return { ...view, status: 'failed', error: { code: 'OutputVideoSensitiveContentDetected', message: 'The request failed because the output video may contain sensitive information.' } };
    if (age < taskSeconds) return { ...view, status: 'running' };
    return { ...view, status: 'succeeded', content: { video_url: `${base}/tos/${t.id}.mp4` }, usage: { completion_tokens: 108900, total_tokens: 108900 }, seed: 78674, framespersecond: 24 };
  }

  const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://mock');
    const base = `http://127.0.0.1:${server.address().port}`;
    const body = await readBody(req);
    const authed = req.headers.authorization === `Bearer ${MOCK_ARK_KEY}`;
    log.push({ method: req.method, pathname, authed, body: body.toString('utf8') });

    // 生成的视频放在对象存储上，地址本身带签名，下载不用 Key。
    const file = /^\/tos\/([\w-]+)\.mp4$/.exec(pathname);
    if (req.method === 'GET' && file && tasks.has(file[1])) {
      const bytes = Buffer.from(`mock ark video ${file[1]}`);
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bytes.length });
      return res.end(bytes);
    }

    // 费用中心查余额：不认 API Key，要带签名。这里只核对签名头的样子和 Access Key ID。
    if (req.method === 'GET' && pathname === '/' && new URL(req.url, 'http://mock').searchParams.get('Action') === 'QueryBalanceAcct') {
      const ok = new RegExp(`^HMAC-SHA256 Credential=${MOCK_ACCESS_KEY.id}/\\d{8}/cn-north-1/billing/request, SignedHeaders=host;x-content-sha256;x-date, Signature=[0-9a-f]{64}$`).test(req.headers.authorization || '');
      if (!ok || !/^\d{8}T\d{6}Z$/.test(req.headers['x-date'] || '')) return json(res, 401, { ResponseMetadata: { Error: { Code: 'SignatureDoesNotMatch', Message: 'signature mismatch' } } });
      return json(res, 200, { ResponseMetadata: { Action: 'QueryBalanceAcct', Service: 'billing' }, Result: { AccountID: 2100000001, ArrearsBalance: '0.00', AvailableBalance: '77.01', CashBalance: '83.01', CreditLimit: '0.00', FreezeAmount: '6.00' } });
    }

    // 豆包语音：Key 放在 X-Api-Key 里，响应体是一个接一个的 JSON，中间没有分隔。
    if (req.method === 'POST' && pathname === '/api/v3/tts/unidirectional') {
      if (req.headers['x-api-key'] !== MOCK_SPEECH_KEY) return json(res, 401, { code: 45000010, message: 'invalid api key' });
      const { req_params: params } = JSON.parse(body.toString('utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (/FAIL/.test(params.text)) return res.end(JSON.stringify({ code: 55000000, message: 'synthesis failed {internal}' }));
      const audio = Buffer.from(`mock mp3 ${params.speaker} ${params.text}`);
      const chunk = (bytes) => JSON.stringify({ code: 0, message: '', data: bytes.toString('base64') });
      return res.end(chunk(audio.subarray(0, 9)) + chunk(audio.subarray(9)) + JSON.stringify({ code: 20000000, message: 'OK', data: null, usage: { text_words: params.text.length } }));
    }

    if (!authed) return fail(res, 401, 'AuthenticationError', 'the API key or AK/SK in the request is missing or invalid.');

    if (req.method === 'GET' && pathname === '/contents/generations/tasks') return json(res, 200, { items: [], total: 0 });

    if (req.method === 'POST' && pathname === '/contents/generations/tasks') {
      const payload = JSON.parse(body.toString('utf8'));
      const text = (payload.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
      if (/REJECT/.test(text)) return fail(res, 400, 'InvalidParameter', 'the parameter `content` specified in the request is not valid.');
      if (/NOTOPEN/.test(text)) return fail(res, 404, 'ModelNotOpen', `Your account has not activated the model ${payload.model}.`);
      const id = `cgt-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      tasks.set(id, { id, start: Date.now(), fail: /FAIL/.test(text), payload });
      return json(res, 200, { id });
    }

    const task = /^\/contents\/generations\/tasks\/([\w-]+)$/.exec(pathname);
    if (req.method === 'GET' && task) {
      if (!tasks.has(task[1])) return fail(res, 404, 'ResourceNotFound', 'the specified task is not found.');
      return json(res, 200, taskView(tasks.get(task[1]), base));
    }

    // 一次出一张，要了 b64_json 就返回 base64；用量里只有张数和 token，没有金额。
    if (req.method === 'POST' && pathname === '/images/generations') {
      const payload = JSON.parse(body.toString('utf8'));
      if (/FAIL/.test(payload.prompt || '')) return fail(res, 500, 'InternalServiceError', 'The service encountered an unexpected internal error.');
      return json(res, 200, { model: payload.model, created: Math.floor(Date.now() / 1000), data: [{ b64_json: PNG.toString('base64'), size: payload.size }], usage: { generated_images: 1, output_tokens: 16384, total_tokens: 16384 } });
    }

    if (req.method === 'POST' && pathname === '/chat/completions') {
      const { model, messages } = JSON.parse(body.toString('utf8'));
      return json(res, 200, { model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: `润色后的：${messages.at(-1).content}` } }] });
    }

    fail(res, 404, 'NotFound', `no route ${req.method} ${pathname}`);
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({ port: server.address().port, url: `http://127.0.0.1:${server.address().port}`, log, tasks, close: () => new Promise((done) => server.close(done)) });
    });
  });
}
