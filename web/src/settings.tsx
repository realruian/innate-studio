// 设置弹窗：外观和润色用的模型、火山引擎的几个 Key、余额。三组，每组一个灰色小标题加几行。

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, state, useStore, loadApp, loadModels, loadBalance, polishModel, setPolishModel, canManage, isAdmin } from './store.ts';
import { AccountSection, MembersSection } from './account.tsx';
import { AIHUBMIX, ARK, DOUBAO_SPEECH, MINIMAX, VOLC_BILLING } from '../../shared/models.ts';
import { fmtCredits } from './format.ts';
import { themeChoice, setTheme } from './theme.ts';
import { Segmented, FormRow, Dropdown } from './ui/controls.tsx';
import { toast, openModal, confirmDialog } from './ui/layers.tsx';

const amount = (n: number) => n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const message = (err: unknown) => (err as Error).message;

function Settings() {
  useStore('app', 'models');
  const [theme, setThemeState] = useState(themeChoice());
  const [polish, setPolish] = useState(polishModel());
  const { hasKey, keyHint, keySource } = state.app;
  const { label: platform } = ARK;
  const models = state.catalog.polish;

  async function save(value: string) {
    try {
      state.app = await api('PUT', '/api/key', { apiKey: value });
      await loadApp();
      toast('API Key 已保存', 'success');
      // 换了 Key，可用的模型要重新读一遍。
      loadModels();
      return true;
    } catch (err) {
      toast(message(err), 'error', 6000);
      return false;
    }
  }

  async function remove() {
    const ok = await confirmDialog({ title: `清除已保存的${platform} API Key？`, message: '清除后，进行中的任务将暂停查询。', okText: '清除', danger: true });
    if (!ok) return;
    try {
      await api('DELETE', '/api/key');
      await loadApp();
      toast('已清除', 'success');
    } catch (err) {
      toast(message(err), 'error');
    }
  }

  return (
    <div className="settings">
      <section className="settings-group">
        <h3>通用</h3>
        <div className="settings-card">
          <FormRow label="主题">
            <Segmented
              options={[
                { value: 'system', label: '跟随系统' },
                { value: 'light', label: '浅色' },
                { value: 'dark', label: '深色' },
              ]}
              value={theme}
              onChange={(next) => {
                setTheme(next);
                setThemeState(next);
              }}
            />
          </FormRow>
          {/* 润色提示词用哪个文本模型。账号里一个可用的都没有时，创作面板上不会出现「润色」。 */}
          <FormRow label="提示词润色">
            {models.length ? (
              <Dropdown
                label="润色模型"
                value={models.includes(polish) ? polish : polishModel()}
                options={models.map((m) => ({ value: m, label: m }))}
                onChange={(model) => {
                  setPolishModel(model);
                  setPolish(model);
                }}
              />
            ) : (
              <span className="muted">{state.catalog.known ? '暂无可用的文本模型' : '加载中…'}</span>
            )}
          </FormRow>
        </div>
      </section>

      {state.app.user && <AccountSection />}
      {isAdmin() && <MembersSection />}

      {/* Key 和余额：多人模式下只有管理员看得到、改得了。 */}
      {canManage() && (
        <>
      <section className="settings-group">
        <h3>模型平台</h3>
        <div className="settings-card">
          <KeyRow
            name={platform}
            label={`${platform} API Key`}
            desc="Seedance、Seedream、提示词润色"
            placeholder={`粘贴${platform}的 API Key`}
            copyHint={`请从${platform}控制台重新复制。`}
            hasKey={hasKey}
            keyHint={keyHint}
            keySource={keySource}
            onSave={save}
            onRemove={remove}
          />
          <MinimaxKey />
          <AihubmixKey />
          <SpeechKey />
        </div>
      </section>

      <BillingKey />
      <p className="settings-hint">{state.app.hosted ? '密钥仅保存在服务器，成员不可见。' : '密钥仅保存在本地。'}</p>
        </>
      )}
    </div>
  );
}

// Key 的那一行。平时只显示尾号和「更换」；要填的时候这一行原地换成输入框，不把下面的内容往下推。
// 还没有 Key 时一直是输入框。onSave 存成了返回 true，这一行才收回去。
function KeyRow({ name, label = 'API Key', desc, placeholder, copyHint = '', hasKey, keyHint, keySource, onSave, onRemove }: { name: string; label?: string; desc?: ReactNode; placeholder: string; copyHint?: string; hasKey: boolean; keyHint: string; keySource: string; onSave: (value: string) => Promise<boolean>; onRemove: () => void }) {
  const [editing, setEditing] = useState(false);
  // 输入框默认遮住内容；显示出来是为了核对粘贴的到底是不是 Key。
  const [masked, setMasked] = useState(true);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);

  async function submit() {
    const value = input.current!.value.trim();
    if (!value) return toast(`请输入${name}API Key`, 'error');
    if (/[^\x21-\x7e]/.test(value)) {
      setMasked(false);
      return toast(`API Key 格式不正确：包含中文或空格。${copyHint}`, 'error', 8000);
    }
    setSaving(true);
    try {
      if (!(await onSave(value))) return;
      if (input.current) input.current.value = '';
      setMasked(true);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  if (hasKey && !editing) {
    return (
      <FormRow label={label} desc={desc}>
        <span className="mono">{keyHint}</span>
        {keySource === 'env' ? (
          <span className="muted">来自环境变量</span>
        ) : (
          <>
            <button className="btn btn-sm" type="button" onClick={() => setEditing(true)}>
              更换
            </button>
            {keySource === 'file' && (
              <button className="btn btn-sm" type="button" onClick={onRemove}>
                清除
              </button>
            )}
          </>
        )}
      </FormRow>
    );
  }
  return (
    <div className="form-row">
      <div className="form-label">{label}</div>
      <div className="form-control key-edit">
        <input ref={input} className={`input mono${masked ? ' masked' : ''}`} type="text" placeholder={placeholder} autoComplete="off" data-1p-ignore="" data-lpignore="true" aria-label={`${name}API Key`} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        <button className="btn" type="button" onClick={() => setMasked(!masked)}>
          {masked ? '显示' : '隐藏'}
        </button>
        <button className="btn btn-primary" type="button" disabled={saving} onClick={submit}>
          保存
        </button>
        {hasKey && (
          <button className="btn" type="button" onClick={() => setEditing(false)}>
            取消
          </button>
        )}
      </div>
    </div>
  );
}

// MiniMax 的 Key：视频模型 MiniMax H3 用它，要国内站的。订阅 Key 扣的是积分，按量付费的 Key 扣的是账户余额；视频资源包不支持 H3。
function MinimaxKey() {
  useStore('app');
  const { hasKey, keyHint, keySource } = state.app.minimax;
  const { label } = MINIMAX;
  async function save(value: string) {
    try {
      state.app = await api('PUT', '/api/key', { apiKey: value, service: 'minimax' });
      await loadApp();
      toast(`${label} 的 API Key 已保存`, 'success');
      return true;
    } catch (err) {
      toast(message(err), 'error', 6000);
      return false;
    }
  }

  async function remove() {
    const ok = await confirmDialog({ title: `清除已保存的 ${label} API Key？`, message: '清除后将无法使用 MiniMax H3。', okText: '清除', danger: true });
    if (!ok) return;
    try {
      await api('DELETE', '/api/key?service=minimax');
      await loadApp();
      toast('已清除', 'success');
    } catch (err) {
      toast(message(err), 'error');
    }
  }

  return (
    <KeyRow
      name={label}
      label={`${label} API Key`}
      desc="MiniMax H3"
      placeholder={`粘贴 ${label} 的 API Key`}
      hasKey={hasKey}
      keyHint={keyHint}
      keySource={keySource}
      onSave={save}
      onRemove={remove}
    />
  );
}

// AiHubMix 的 Key：图片模型 GPT Image 2.5、Nano Banana 2.1 用它。账号要先在它的控制台开启「异步任务」。
function AihubmixKey() {
  useStore('app');
  const { hasKey, keyHint, keySource } = state.app.aihubmix;
  const { label } = AIHUBMIX;
  async function save(value: string) {
    try {
      state.app = await api('PUT', '/api/key', { apiKey: value, service: 'aihubmix' });
      await loadApp();
      toast(`${label} 的 API Key 已保存`, 'success');
      return true;
    } catch (err) {
      toast(message(err), 'error', 6000);
      return false;
    }
  }

  async function remove() {
    const ok = await confirmDialog({ title: `清除已保存的 ${label} API Key？`, message: '清除后将无法使用 GPT Image 2.5 和 Nano Banana 2.1。', okText: '清除', danger: true });
    if (!ok) return;
    try {
      await api('DELETE', '/api/key?service=aihubmix');
      await loadApp();
      toast('已清除', 'success');
    } catch (err) {
      toast(message(err), 'error');
    }
  }

  return (
    <KeyRow
      name={label}
      label={`${label} API Key`}
      desc="GPT Image 2.5、Nano Banana 2.1"
      placeholder={`粘贴 ${label} 的 API Key`}
      hasKey={hasKey}
      keyHint={keyHint}
      keySource={keySource}
      onSave={save}
      onRemove={remove}
    />
  );
}

// 豆包语音的 Key：语音用它。它和方舟不是一个产品，Key 要另外创建、另外填。排在「模型平台」那组里，方舟的 Key 下面。
function SpeechKey() {
  useStore('app');
  const { hasKey, keyHint, keySource } = state.app.speech;
  const { label } = DOUBAO_SPEECH;
  async function save(value: string) {
    try {
      state.app = await api('PUT', '/api/key', { apiKey: value, service: 'speech' });
      await loadApp();
      toast(`${label}的 API Key 已保存`, 'success');
      return true;
    } catch (err) {
      toast(message(err), 'error', 6000);
      return false;
    }
  }

  async function remove() {
    const ok = await confirmDialog({ title: `清除已保存的${label} API Key？`, message: '清除后将无法生成语音。', okText: '清除', danger: true });
    if (!ok) return;
    try {
      await api('DELETE', '/api/key?service=speech');
      await loadApp();
      toast('已清除', 'success');
    } catch (err) {
      toast(message(err), 'error');
    }
  }

  return (
    <KeyRow
      name={label}
      label={`${label} API Key`}
      desc="语音、音效、配乐"
      placeholder={`粘贴${label}的 API Key`}
      hasKey={hasKey}
      keyHint={keyHint}
      keySource={keySource}
      onSave={save}
      onRemove={remove}
    />
  );
}

// 查余额用的火山引擎 Access Key。它是账号级的一对密钥（ID 和 Secret），和方舟、豆包语音的 API Key 都不是一回事。
// 保存时服务端会先查一次余额，查不到就不存。
function BillingKey() {
  useStore('app', 'balance');
  const { hasKey, keyHint, keySource } = state.app.billing;
  const { label } = VOLC_BILLING;
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const id = useRef<HTMLInputElement>(null);
  const secret = useRef<HTMLInputElement>(null);

  async function save() {
    const accessKeyId = id.current!.value.trim();
    const secretAccessKey = secret.current!.value.trim();
    if (!accessKeyId || !secretAccessKey) return toast('请填写 Access Key ID 和 Secret Access Key', 'error');
    setSaving(true);
    try {
      state.app = await api('PUT', '/api/key', { service: 'billing', accessKeyId, secretAccessKey });
      await loadApp();
      await loadBalance();
      setEditing(false);
      toast('Access Key 已保存', 'success');
    } catch (err) {
      toast(message(err), 'error', 8000);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    const ok = await confirmDialog({ title: '清除已保存的 Access Key？', message: '清除后不再显示账户余额。', okText: '清除', danger: true });
    if (!ok) return;
    try {
      await api('DELETE', '/api/key?service=billing');
      await loadApp();
      await loadBalance();
      toast('已清除', 'success');
    } catch (err) {
      toast(message(err), 'error');
    }
  }

  return (
    <section className="settings-group">
      <h3>{label}</h3>
      <div className="settings-card">
        {hasKey && !editing ? (
          <>
            <FormRow
              label="Access Key"
              desc="查询火山引擎余额"
            >
              <span className="mono">{keyHint}</span>
              {keySource === 'env' ? (
                <span className="muted">来自环境变量</span>
              ) : (
                <>
                  <button className="btn btn-sm" type="button" onClick={() => setEditing(true)}>
                    更换
                  </button>
                  <button className="btn btn-sm" type="button" onClick={remove}>
                    清除
                  </button>
                </>
              )}
            </FormRow>
            <FormRow label="可用余额">
              <span className="muted amount">{state.balance != null ? `¥${amount(state.balance)}` : '获取失败'}</span>
            </FormRow>
          </>
        ) : (
          <>
            <FormRow label="Access Key ID">
              <input ref={id} className="input mono" type="text" placeholder="AKLT…" autoComplete="off" data-1p-ignore="" data-lpignore="true" aria-label="Access Key ID" />
            </FormRow>
            <div className="form-row">
              <div className="form-label">Secret Access Key</div>
              <div className="form-control key-edit">
                <input ref={secret} className="input mono masked" type="text" placeholder="粘贴 Secret Access Key" autoComplete="off" data-1p-ignore="" data-lpignore="true" aria-label="Secret Access Key" onKeyDown={(e) => e.key === 'Enter' && save()} />
                <button className="btn btn-primary" type="button" disabled={saving} onClick={save}>
                  保存
                </button>
                {hasKey && (
                  <button className="btn" type="button" onClick={() => setEditing(false)}>
                    取消
                  </button>
                )}
              </div>
            </div>
          </>
        )}
        <OtherBalances />
      </div>
    </section>
  );
}

// 另外两个账户的余额。MiniMax 的余额没有查询接口，手动填控制台上看到的数，之后按估算的费用扣；充值后要重新填。
// MiniMax 的余额有两种：订阅 Key 用的是积分，按量付费的 Key 用的是账户余额（元），填的时候选单位。
// AiHubMix 的要另填一个 Manage Key（不是生图用的 API Key），保存时服务端会先查一次，查不到就不存。
function OtherBalances() {
  useStore('app', 'balance');
  const { hasKey, keyHint, keySource } = state.app.aihubmixManage;
  const minimax = state.minimaxBalance;
  const [saving, setSaving] = useState(false);
  const [unit, setUnit] = useState<'credits' | 'cny'>(minimax?.unit || 'credits');
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function saveMinimax() {
    const value = input.current!.value.trim();
    if (!/^\d+(\.\d{1,2})?$/.test(value)) return toast(unit === 'credits' ? '请输入积分数，例如 4489' : '请输入余额，例如 30 或 26.50', 'error');
    setSaving(true);
    try {
      await api('PUT', '/api/balance/minimax', { amount: Number(value), unit });
      await loadBalance();
      setEditing(false);
      toast('MiniMax 余额已更新', 'success');
    } catch (err) {
      toast(message(err), 'error');
    } finally {
      setSaving(false);
    }
  }

  async function clearMinimax() {
    try {
      await api('DELETE', '/api/balance/minimax');
      await loadBalance();
      toast('已清除', 'success');
    } catch (err) {
      toast(message(err), 'error');
    }
  }

  async function saveManage(value: string) {
    try {
      state.app = await api('PUT', '/api/key', { apiKey: value, service: 'aihubmix-manage' });
      await loadApp();
      await loadBalance();
      toast('Manage Key 已保存', 'success');
      return true;
    } catch (err) {
      toast(message(err), 'error', 8000);
      return false;
    }
  }

  async function removeManage() {
    const ok = await confirmDialog({ title: '清除已保存的 Manage Key？', message: '清除后不再显示 AiHubMix 余额。', okText: '清除', danger: true });
    if (!ok) return;
    try {
      await api('DELETE', '/api/key?service=aihubmix-manage');
      await loadApp();
      await loadBalance();
      toast('已清除', 'success');
    } catch (err) {
      toast(message(err), 'error');
    }
  }

  return (
    <>
        {minimax && !editing ? (
          <FormRow label="MiniMax 余额" desc="手动填写，按估算扣减">
            <span className="muted amount">{minimax.unit === 'credits' ? fmtCredits(minimax.remaining) : `¥${amount(minimax.remaining)}`}</span>
            <button className="btn btn-sm" type="button" onClick={() => setEditing(true)}>
              更新
            </button>
            <button className="btn btn-sm" type="button" onClick={clearMinimax}>
              清除
            </button>
          </FormRow>
        ) : (
          <div className="form-row">
            <div className="form-label">MiniMax 余额</div>
            <div className="form-control key-edit">
              <Segmented
                options={[
                  { value: 'credits', label: '积分' },
                  { value: 'cny', label: '元' },
                ]}
                value={unit}
                onChange={setUnit}
              />
              <input ref={input} className="input" type="text" inputMode="decimal" placeholder={unit === 'credits' ? '当前积分' : '当前余额'} aria-label="MiniMax 余额" onKeyDown={(e) => e.key === 'Enter' && saveMinimax()} />
              <button className="btn btn-primary" type="button" disabled={saving} onClick={saveMinimax}>
                保存
              </button>
              {minimax && (
                <button className="btn" type="button" onClick={() => setEditing(false)}>
                  取消
                </button>
              )}
            </div>
          </div>
        )}
        <KeyRow
          name="AiHubMix Manage "
          label="AiHubMix Manage Key"
          desc="查询 AiHubMix 余额"
          placeholder="粘贴 AiHubMix 的 Manage Key"
          hasKey={hasKey}
          keyHint={keyHint}
          keySource={keySource}
          onSave={saveManage}
          onRemove={removeManage}
        />
        {hasKey && (
          <FormRow label="AiHubMix 余额">
            <span className="muted amount">{state.aihubmixBalance?.remaining != null ? `$${amount(state.aihubmixBalance.remaining)}` : '获取失败'}</span>
          </FormRow>
        )}
    </>
  );
}

export function openSettings() {
  openModal({ title: '设置', size: 'md', content: <Settings /> });
}
