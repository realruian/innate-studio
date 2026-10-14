// 生成失败时画框里的那一块。创作页、创作记录的卡片，详情左边，画布的节点，都用这一个，长得一样。
// 一个淡红底的圆形提示图标，下面是标题、原因（最多两行，放不下的悬停看全文）、一句灰色的说明。只有图标是红的。

import { Icon } from './Icon.tsx';
import { clipTip } from './controls.tsx';

// 平台返回的失败原因：服务端已经把认识的换成了中文，这里只兜住老记录里的英文原话。
// 认识的换成人话，并说一句可以怎么办；不认识的原样显示，只去掉末尾的请求编号。只登记实际遇到过的。
const KNOWN_FAILURES: [RegExp, string][] = [[/output audio .*copyright/i, '音频涉及版权，未通过平台审核。请关闭「生成有声视频」后重试。']];
export function explainFailure(message?: string) {
  if (!message) return '未知错误';
  const known = KNOWN_FAILURES.find(([pattern]) => pattern.test(message))?.[1];
  if (known) return known;
  // 2026-10-15 之前的记录把原因和平台原话拼在一起存：「中文原因（English…）」或「中文原因。火山方舟 返回（500）：English…」。
  // 只留前面的中文；没有中文原因的，按平台说一句服务出错。
  const quoted = message.match(/^(.*[一-鿿].*?)（[\x20-\x7e]+）$/);
  if (quoted) return quoted[1];
  const legacy = message.match(/^(?:(.*?)。)?\s*([^。]+?) ?返回（(\d+)）：/);
  if (legacy && !legacy[1] && /audit|sensitive|moderation|censor/i.test(message)) return '内容未通过审核，请修改提示词或参考素材后重试';
  if (legacy) return legacy[1] || `${legacy[2]}${Number(legacy[3]) >= 500 || legacy[3] === '200' ? ' 服务暂时异常，请稍后重试' : ' 拒绝了这次请求，请检查提示词和参数'}`;
  return message.replace(/\s*Request id:.*$/i, '').trim();
}

export function FailureState({ title, reason, note, extra }: { title: string; reason?: string; note?: string | null; extra?: string | null }) {
  const text = explainFailure(reason);
  return (
    <>
      <span className="state-mark">
        <Icon name="alert" size={18} />
      </span>
      <div className="state-title">{title}</div>
      <div className="state-text" {...clipTip(text)}>
        {text}
      </div>
      {/* 是哪一条：几条失败放在一起时，光看原因分不出来。 */}
      {extra && (
        <div className="state-extra ellipsis" {...clipTip(extra)}>
          {extra}
        </div>
      )}
      {note && <div className="state-note">{note}</div>}
    </>
  );
}
