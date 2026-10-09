// 右上角的余额和消费：按钮上是账户余额，点开是余额、今日、本月三个数和每次生成的费用。
// 余额是用账号的 Access Key 到火山引擎费用中心查的；没配 Access Key 时按钮上改成本月花了多少，三个数换成今日、本月、累计。
// 每次生成的费用火山引擎不返回，是按用量和按量单价估算的（shared/models.ts 的 estimateCost）。

import { useEffect } from 'react';
import { state, useStore, loadBalance } from './store.ts';
import { openSettings } from './settings.tsx';
import { openPopover } from './ui/layers.tsx';
import { openDetail } from './history.tsx';
import { fmtTime, fmtYuan } from './format.ts';
import { estimateCost, modelLabel } from '../../shared/models.ts';
import type { HistoryItem } from './types.ts';

const KIND_LABELS = { video: '视频', image: '图片', audio: '语音' };

// 算得出费用的记录，新的在前。失败的不收费，本来也没有用量。
function charges() {
  return state.history
    .filter((item) => item.status === 'completed')
    .map((item) => ({ item, cost: estimateCost(item), at: item.completedAt || item.createdAt || 0 }))
    .filter((c): c is { item: HistoryItem; cost: number; at: number } => c.cost != null)
    .sort((a, b) => b.at - a.at);
}

const sumSince = (list: ReturnType<typeof charges>, from: number) => list.reduce((sum, c) => (c.at >= from ? sum + c.cost : sum), 0);
const startOfMonth = () => new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
const startOfDay = () => new Date().setHours(0, 0, 0, 0);

function SpendPanel({ close }: { close: () => void }) {
  useStore('history', 'balance', 'app');
  const list = charges();
  const totals = [
    state.balance != null ? (['余额', state.balance] as const) : null,
    ['今日', sumSince(list, startOfDay())] as const,
    ['本月', sumSince(list, startOfMonth())] as const,
    state.balance == null ? (['累计', sumSince(list, 0)] as const) : null,
  ].filter((t) => t != null);
  return (
    <div className="spend">
      <dl className="spend-totals">
        {totals.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{fmtYuan(value)}</dd>
          </div>
        ))}
      </dl>
      {list.length ? (
        <ul className="spend-list">
          {list.map(({ item, cost, at }) => (
            <li key={item.id}>
              <button
                className="spend-row"
                type="button"
                onClick={() => {
                  close();
                  openDetail(item.id);
                }}
              >
                <span className="spend-what">
                  <span className="spend-prompt">{item.prompt || KIND_LABELS[item.kind]}</span>
                  <span className="spend-meta">
                    {KIND_LABELS[item.kind]} · {modelLabel(item.model)} · {fmtTime(at)}
                  </span>
                </span>
                <span className="spend-cost">{fmtYuan(cost)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="spend-empty">暂无消费记录</p>
      )}
      <p className="spend-note">每次费用按火山引擎按量单价估算，以账单为准</p>
      {!state.app.billing.hasKey && (
        <button
          className="btn btn-sm spend-setup"
          type="button"
          onClick={() => {
            close();
            openSettings();
          }}
        >
          配置 Access Key 以显示余额
        </button>
      )}
    </div>
  );
}

export function SpendButton() {
  useStore('history', 'app', 'balance');
  const ark = state.app.provider === 'ark';
  const list = charges();
  // 打开页面、换了 Access Key、又生成完一条，都重新查一次余额。
  useEffect(() => {
    loadBalance();
  }, [ark, state.app.billing.hasKey, state.app.billing.keyHint, list.length]);
  if (!ark) return null;
  const [label, value] = state.balance != null ? ['余额', state.balance] : ['本月', sumSince(list, startOfMonth())];
  return (
    <button
      className="spend-btn"
      type="button"
      aria-haspopup="dialog"
      aria-expanded="false"
      onClick={(e) => {
        const layer = openPopover(e.currentTarget, <SpendPanel close={() => layer?.close()} />, { className: 'spend-popover', label: '余额和消费明细', align: 'end' });
      }}
    >
      <span className="spend-btn-label">{label}</span>
      {fmtYuan(value)}
    </button>
  );
}
