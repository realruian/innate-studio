// 三个账户的余额，各有各的查法：火山引擎到费用中心查，AiHubMix 用 Manage Key 查，MiniMax 没有接口、是手动填的数减去之后的估算花费。
//
// 火山引擎费用中心的《QueryBalanceAcct - 查询用户账户余额信息》：返回可用余额、现金余额、欠费金额，单位是元。
// 这类接口不认 API Key，要用账号的 Access Key 给请求签名（火山引擎 OpenAPI 签名，HMAC-SHA256）：
// 把请求方法、路径、查询串、要签的头和正文的哈希拼成一段，再用 Secret 依次和日期、地域、服务名、request 算出的密钥去签。

import crypto from 'node:crypto';
import { AIHUBMIX_MANAGE, VOLC_BILLING } from './config.js';
import { HttpError } from './http.js';
import { config, openSpaces } from './store.js';
import { MINIMAX_CREDITS_PER_YUAN, estimateCost, videoProvider } from '../shared/models.ts';

const hmac = (key, text) => crypto.createHmac('sha256', key).update(text).digest();
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

export function volcSignedHeaders({ id, secret }, { method, host, query, service, region }) {
  const date = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = date.slice(0, 8);
  const bodyHash = sha256('');
  const signed = 'host;x-content-sha256;x-date';
  const canonical = [method, '/', query, `host:${host}`, `x-content-sha256:${bodyHash}`, `x-date:${date}`, '', signed, bodyHash].join('\n');
  const scope = `${day}/${region}/${service}/request`;
  const signingKey = [day, region, service, 'request'].reduce(hmac, secret);
  const signature = hmac(signingKey, ['HMAC-SHA256', date, scope, sha256(canonical)].join('\n')).toString('hex');
  return { 'X-Date': date, 'X-Content-Sha256': bodyHash, Authorization: `HMAC-SHA256 Credential=${id}/${scope}, SignedHeaders=${signed}, Signature=${signature}` };
}

export async function queryBalance(keys) {
  const url = new URL(VOLC_BILLING.baseUrl);
  // 查询串要按参数名排好序再签。
  const query = 'Action=QueryBalanceAcct&Version=2022-01-01';
  let res;
  try {
    res = await fetch(`${url.origin}/?${query}`, { headers: volcSignedHeaders(keys, { method: 'GET', host: url.host, query, service: 'billing', region: 'cn-north-1' }), signal: AbortSignal.timeout(20000) });
  } catch (err) {
    throw new HttpError(502, 'upstream_unreachable', `连接火山引擎费用中心失败：${err.name === 'TimeoutError' ? '请求超时' : err.cause?.code || err.message}`);
  }
  const data = await res.json().catch(() => null);
  const failure = data?.ResponseMetadata?.Error;
  if (!res.ok || failure || !data?.Result) {
    const denied = res.status === 401 || res.status === 403;
    throw new HttpError(denied ? 401 : 502, String(failure?.Code || `http_${res.status}`), `${denied ? 'Access Key 无效，或没有查看费用中心的权限。' : ''}火山引擎费用中心返回（${res.status}）：${failure?.Message || '没有余额数据'}`);
  }
  const yuan = (value) => Number(value) || 0;
  return { remaining: yuan(data.Result.AvailableBalance), cash: yuan(data.Result.CashBalance), arrears: yuan(data.Result.ArrearsBalance) };
}

// AiHubMix《获取当前用户信息与余额》：GET /api/user/self，认的是 Manage Key，不是普通的 API Key。
// quota 和 used_quota 除以 500000 是美元。文档里的两处示例一处带 Bearer、一处不带，所以带着的不认就不带再试一次。
export async function queryAihubmixBalance(key) {
  let res;
  try {
    for (const auth of [`Bearer ${key}`, key]) {
      res = await fetch(`${AIHUBMIX_MANAGE.baseUrl}/api/user/self`, { headers: { Authorization: auth, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000) });
      if (res.status !== 401) break;
    }
  } catch (err) {
    throw new HttpError(502, 'upstream_unreachable', `连接 AiHubMix 失败：${err.name === 'TimeoutError' ? '请求超时' : err.cause?.code || err.message}`);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success || typeof data.data?.quota !== 'number') {
    const denied = res.status === 401 || res.status === 403;
    throw new HttpError(denied ? 401 : 502, `http_${res.status}`, `${denied ? 'Manage Key 无效。请确认填的是 AiHubMix 的 Manage Key，不是 API Key。' : ''}AiHubMix 返回（${res.status}）：${data?.message || '没有余额数据'}`);
  }
  return { currency: 'USD', remaining: data.data.quota / 500000, used: (data.data.used_quota || 0) / 500000 };
}

// MiniMax 的余额没有查询接口。用户把控制台上看到的余额填进来（amount），记下是什么时候填的（at）；
// 之后在 MiniMax 上生成完的每一条，按估算的费用从里面扣。所有空间的记录都算，因为大家用的是同一个 Key。充值之后要重新填。
// 余额有两种，看用的是哪种 Key：按量付费的 Key 扣账户余额（unit 是 cny，元）；订阅 Key 扣积分（unit 是 credits），费用按目录价折成积分再扣。
export function minimaxBalance() {
  const saved = config.minimaxBalance;
  if (!saved || typeof saved.amount !== 'number') return null;
  let spent = 0;
  for (const space of openSpaces()) {
    for (const item of space.history) {
      if (item.status !== 'completed' || videoProvider(item.model) !== 'minimax' || (item.completedAt || item.createdAt || 0) < saved.at) continue;
      spent += estimateCost(item) || 0;
    }
  }
  const credits = saved.unit === 'credits';
  const remaining = credits ? Math.round(saved.amount - spent * MINIMAX_CREDITS_PER_YUAN) : Math.round((saved.amount - spent) * 100) / 100;
  return { unit: credits ? 'credits' : 'cny', remaining, amount: saved.amount, at: saved.at, estimated: true };
}
