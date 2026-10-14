// 豆包语音这个产品上的两个接口：语音合成，和按文字描述生成一段声音（音效、配乐用它）。
//
// 语音合成（官方文档《单向流式语音合成(HTTP)》）。一次把文字发过去，音频分成很多段返回：
// 响应体是一个接一个的 JSON，每个里面的 data 是一段 base64 的 MP3，按顺序拼起来就是整段音频。
// code 是 0 表示这一段正常，20000000 是结束的标记，其余都是出错。
// 请求头 X-Control-Require-Usage-Tokens-Return 让结束的那一段带上 usage.text_words（计费字符数），费用按它估算。

import crypto from 'node:crypto';
import { DOUBAO_SPEECH } from './config.js';
import { HttpError } from './http.js';
import { upstreamError } from './ark.js';
import { speechKey } from './keys.js';

const DOUBAO_OK = new Set([0, 20000000]);

export async function doubaoSpeech(text, speaker) {
  let res;
  try {
    res = await fetch(`${DOUBAO_SPEECH.baseUrl}/api/v3/tts/unidirectional`, {
      method: 'POST',
      headers: { 'X-Api-Key': speechKey(), 'X-Api-Resource-Id': DOUBAO_SPEECH.model, 'X-Api-Request-Id': crypto.randomUUID(), 'X-Control-Require-Usage-Tokens-Return': 'text_words', 'Content-Type': 'application/json' },
      body: JSON.stringify({ req_params: { text, speaker, audio_params: { format: 'mp3', sample_rate: 24000 } } }),
      signal: AbortSignal.timeout(3 * 60 * 1000),
    });
  } catch (err) {
    throw new HttpError(502, 'upstream_unreachable', `连接豆包语音失败：${err.name === 'TimeoutError' ? '请求超时' : err.cause?.code || err.message}`);
  }
  const parts = jsonSequence(await res.text());
  const failed = parts.find((part) => !DOUBAO_OK.has(Number(part?.code ?? 0)));
  if (!res.ok || failed) {
    const reason = failed?.message || parts[0]?.message || parts[0]?.error?.message || `HTTP ${res.status}`;
    // 出错的 code 可能夹在 200 的流里，这时状态码没有意义，按服务出错算。
    const err = upstreamError('豆包语音', res.ok ? 502 : res.status, String(failed?.code || `http_${res.status}`), reason);
    if (res.status === 401 || res.status === 403) err.message = '豆包语音的 API Key 无效，或账号未开通语音合成';
    throw err;
  }
  const audio = Buffer.concat(parts.filter((part) => typeof part?.data === 'string' && part.data).map((part) => Buffer.from(part.data, 'base64')));
  if (!audio.length) throw new HttpError(502, 'bad_upstream_response', '豆包语音未返回音频');
  const words = Number(parts.find((part) => part?.usage?.text_words != null)?.usage.text_words);
  return { audio, usage: words > 0 ? { text_words: words } : null };
}

// 把一串首尾相接的 JSON 拆开。它们之间可能有换行，也可能没有，所以按花括号配对来切，字符串里的花括号不算。
function jsonSequence(text) {
  const out = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        try {
          out.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          /* 这一段不是完整的 JSON，跳过 */
        }
      }
    }
  }
  return out;
}

// 音频生成（官方文档《音频生成 HTTP 接口》，模型 seed-audio-1.0）。发一段文字描述，一次返回整段音频，最长 120 秒。
// 没有时长这个参数：要多长写在描述里。返回里 audio 是 base64 的音频，original_duration 是模型生成的秒数，按它计费。
// 出错时状态码不是 200，正文是 { code, message }。
// 这一段是照文档写的，2026-10-09 还没有用真实的 Key 调过。
export async function doubaoAudio(prompt) {
  let res;
  try {
    res = await fetch(`${DOUBAO_SPEECH.baseUrl}/api/v3/tts/create`, {
      method: 'POST',
      headers: { 'X-Api-Key': speechKey(), 'X-Api-Request-Id': crypto.randomUUID(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: DOUBAO_SPEECH.audioModel, text_prompt: prompt, audio_config: { format: 'mp3' } }),
      signal: AbortSignal.timeout(5 * 60 * 1000),
    });
  } catch (err) {
    throw new HttpError(502, 'upstream_unreachable', `连接豆包语音失败：${err.name === 'TimeoutError' ? '请求超时' : err.cause?.code || err.message}`);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.audio) {
    const err = upstreamError('豆包语音', res.ok ? 502 : res.status, String(data?.code || `http_${res.status}`), data?.message || '未返回音频');
    if (res.status === 401 || res.status === 403) err.message = '豆包语音的 API Key 无效，或账号未开通音频生成';
    throw err;
  }
  const seconds = Number(data.original_duration) || Number(data.duration) || 0;
  return { audio: Buffer.from(data.audio, 'base64'), usage: seconds > 0 ? { audio_seconds: seconds } : null };
}
