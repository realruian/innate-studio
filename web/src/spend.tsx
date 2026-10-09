// 右上角的余额和消费：按钮上是各个账户的余额，点开是余额、今日、本月几个数和每次生成的费用。
// 账户有三个，配了哪个显示哪个：火山引擎的是用账号的 Access Key 到费用中心查的；AiHubMix 的是用 Manage Key 查的，单位是美元；
// MiniMax 没有查询接口，是用户手动填的余额（元或积分）减去之后估算的花费。一个都没配时按钮上改成本月花了多少，几个数换成今日、本月、累计。
// 每次生成的费用平台不返回，是按用量和按量单价估算的（shared/models.ts 的 estimateCost）。

import { useEffect } from 'react';
import { state, useStore, loadBalance, usesCredits } from './store.ts';
import { openAdmin } from './settings.tsx';
import { openPopover } from './ui/layers.tsx';
import { openDetail } from './history.tsx';
import { fmtCredits, fmtTime, fmtUsd, fmtYuan } from './format.ts';
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

// 配好了的账户和各自的余额，写成能直接显示的字。
function balances(): [string, string][] {
  const list: [string, string][] = [];
  if (state.balance != null) list.push(['火山引擎', fmtYuan(state.balance)]);
  if (state.minimaxBalance) list.push(['MiniMax', (state.minimaxBalance.unit === 'credits' ? fmtCredits : fmtYuan)(state.minimaxBalance.remaining)]);
  if (state.aihubmixBalance) list.push(['AiHubMix', state.aihubmixBalance.remaining != null ? fmtUsd(state.aihubmixBalance.remaining) : '获取失败']);
  return list;
}

function SpendPanel({ close }: { close: () => void }) {
  useStore('history', 'balance', 'app');
  const list = charges();
  const accounts = balances();
  const totals: (readonly [string, string])[] = [
    ...accounts,
    ['今日', fmtYuan(sumSince(list, startOfDay()))] as const,
    ['本月', fmtYuan(sumSince(list, startOfMonth()))] as const,
    ...(accounts.length ? [] : [['累计', fmtYuan(sumSince(list, 0))] as const]),
  ];
  return (
    <div className="spend">
      <dl className="spend-totals">
        {totals.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
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
      <p className="spend-note">{`每次费用按官方按量单价估算，以账单为准${state.minimaxBalance ? '；MiniMax 余额为手动填写后按估算扣减' : ''}`}</p>
      {accounts.length < 3 && (
        <button
          className="btn btn-sm spend-setup"
          type="button"
          onClick={() => {
            close();
            openAdmin();
          }}
        >
          {accounts.length ? '配置其他账户余额' : '配置账户余额'}
        </button>
      )}
    </div>
  );
}

// 成员看到的：剩多少积分、今日和本月花了多少、每条记录扣了多少。
const creditCharges = () =>
  state.history
    .filter((item) => (item.credits?.charged || 0) > 0)
    .map((item) => ({ item, cost: item.credits!.charged, at: item.createdAt || 0 }))
    .sort((a, b) => b.at - a.at);

function CreditsPanel({ close }: { close: () => void }) {
  useStore('history', 'balance');
  const list = creditCharges();
  const totals = [
    ['剩余', fmtCredits(state.credits || 0)],
    ['今日', fmtCredits(sumSince(list, startOfDay()))],
    ['本月', fmtCredits(sumSince(list, startOfMonth()))],
  ];
  return (
    <div className="spend">
      <dl className="spend-totals">
        {totals.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
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
                <span className="spend-cost">{fmtCredits(cost)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="spend-empty">暂无消费记录</p>
      )}
      <p className="spend-note">提交时预扣，完成后按实际用量结算，失败全额退回</p>
    </div>
  );
}

function CreditsButton() {
  useStore('balance');
  return (
    <button
      className="spend-btn"
      type="button"
      aria-haspopup="dialog"
      aria-expanded="false"
      onClick={(e) => {
        const layer = openPopover(e.currentTarget, <CreditsPanel close={() => layer?.close()} />, { className: 'spend-popover', label: '积分明细', align: 'end' });
      }}
    >
      <span className="spend-btn-item">
        <span className="spend-btn-label">积分</span>
        {(state.credits || 0).toLocaleString('zh-CN')}
      </span>
    </button>
  );
}

export function SpendButton() {
  useStore('app');
  return usesCredits() ? <CreditsButton /> : <PlatformSpendButton />;
}

function PlatformSpendButton() {
  useStore('history', 'app', 'balance');
  const list = charges();
  // 打开页面、换了 Access Key、又生成完一条，都重新查一次余额。
  useEffect(() => {
    loadBalance();
  }, [state.app.billing.hasKey, state.app.billing.keyHint, state.app.aihubmixManage.keyHint, list.length]);
  const accounts = balances();
  const shown: [string, string][] = accounts.length ? accounts : [['本月', fmtYuan(sumSince(list, startOfMonth()))]];
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
      {shown.map(([label, value]) => (
        <span key={label} className="spend-btn-item">
          <span className="spend-btn-label">{label}</span>
          {value}
        </span>
      ))}
    </button>
  );
}
