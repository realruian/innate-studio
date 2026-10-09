// 设置弹窗：外观、润色用的模型、用哪个平台、API Key 和余额。一组一张卡片。

import { useEffect, useRef, useState } from 'react';
import { api, state, useStore, loadApp, loadModels, switchProvider, polishModel, setPolishModel } from './store.ts';
import { PROVIDERS, DOUBAO_SPEECH, type ProviderId } from '../../shared/models.ts';
import { themeChoice, setTheme } from './theme.ts';
import { Segmented, FormRow, Dropdown } from './ui/controls.tsx';
import { toast, openModal, confirmDialog } from './ui/layers.tsx';

const amount = (n: number) => n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const message = (err: unknown) => (err as Error).message;

function Settings() {
  useStore('app', 'models');
  const [theme, setThemeState] = useState(themeChoice());
  const [polish, setPolish] = useState(polishModel());
  const [credits, setCredits] = useState('—');
  const [switching, setSwitching] = useState(false);
  const { hasKey, keyHint, keySource, provider } = state.app;
  const { label: platform, keyPrefix, keysUrl } = PROVIDERS[provider];
  const models = state.catalog.polish;

  async function readCredits() {
    if (!state.app.hasKey) return setCredits('—');
    setCredits('加载中…');
    try {
      const { remaining, used, unavailable } = await api('GET', '/api/credits');
      // 火山方舟没有查余额的接口。
      if (unavailable) return setCredits('');
      setCredits(`剩余 ${amount(remaining)} · 已用 ${amount(used)}`);
    } catch {
      setCredits('获取失败');
    }
  }
  useEffect(() => {
    readCredits();
  }, []);

  // 换平台：之后新提交的生成都走新平台，两个平台的 Key 各存各的。
  async function changeProvider(next: ProviderId) {
    if (next === provider || switching) return;
    setSwitching(true);
    try {
      await switchProvider(next);
      setPolish(polishModel());
      toast(`已切换到 ${PROVIDERS[next].label}`, 'success');
    } catch (err) {
      toast(message(err), 'error', 6000);
    } finally {
      setSwitching(false);
      readCredits();
    }
  }

  async function save(value: string) {
    if (!value.startsWith(keyPrefix)) {
      const ok = await confirmDialog({ title: 'Key 格式异常', message: `${platform} 的 Key 通常以 ${keyPrefix} 开头，是否仍然保存？`, okText: '仍然保存' });
      if (!ok) return false;
    }
    try {
      state.app = await api('PUT', '/api/key', { apiKey: value, provider });
      await loadApp();
      readCredits();
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
    const ok = await confirmDialog({ title: `清除已保存的 ${platform} API Key？`, message: '清除后，进行中的任务将暂停查询。', okText: '清除', danger: true });
    if (!ok) return;
    try {
      await api('DELETE', `/api/key?provider=${provider}`);
      await loadApp();
      readCredits();
      toast('已清除', 'success');
    } catch (err) {
      toast(message(err), 'error');
    }
  }

  return (
    <div className="settings">
      <section className="settings-group">
        <h3>外观</h3>
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
        </div>
      </section>

      <section className="settings-group">
        <h3>提示词润色</h3>
        <div className="settings-card">
          {/* 润色提示词用哪个文本模型。账号里一个可用的都没有时，创作面板上不会出现「润色」。 */}
          <FormRow label="模型">
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

      <section className="settings-group">
        <h3>模型平台</h3>
        <div className="settings-card">
          <FormRow label="生成平台">
            <Segmented options={(Object.keys(PROVIDERS) as ProviderId[]).map((id) => ({ value: id, label: PROVIDERS[id].label, disabled: switching }))} value={provider} onChange={changeProvider} />
          </FormRow>
        </div>
      </section>

      <section className="settings-group">
        <h3>{platform}</h3>
        <div className="settings-card">
          <KeyRow
            key={provider}
            name={`${platform} `}
            placeholder={keyPrefix ? `${keyPrefix}…` : `粘贴 ${platform} 的 API Key`}
            copyHint={`请从 ${platform} 控制台复制${keyPrefix ? `以 ${keyPrefix} 开头的` : ''} Key。`}
            hasKey={hasKey}
            keyHint={keyHint}
            keySource={keySource}
            onSave={save}
            onRemove={remove}
          />
          {credits && (
            <FormRow label="账户余额">
              <span className="muted amount">{credits}</span>
            </FormRow>
          )}
        </div>
        <p className="settings-hint">
          Key 仅保存在本地，在{' '}
          <a href={keysUrl} target="_blank" rel="noopener">
            {platform} 控制台
          </a>{' '}
          创建。
        </p>
      </section>

      {provider === 'ark' && <SpeechKey />}
    </div>
  );
}

// Key 的那一行。平时只显示尾号和「更换」；要填的时候这一行原地换成输入框，不把下面的内容往下推。
// 还没有 Key 时一直是输入框。onSave 存成了返回 true，这一行才收回去。
function KeyRow({ name, desc, placeholder, copyHint = '', hasKey, keyHint, keySource, onSave, onRemove }: { name: string; desc?: string; placeholder: string; copyHint?: string; hasKey: boolean; keyHint: string; keySource: string; onSave: (value: string) => Promise<boolean>; onRemove: () => void }) {
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
      <FormRow label="API Key" desc={desc}>
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
      <div className="form-label">API Key</div>
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

// 豆包语音的 Key：火山方舟这条线上的语音用它。它和方舟不是一个产品，Key 要另外创建、另外填。
function SpeechKey() {
  useStore('app');
  const { hasKey, keyHint, keySource } = state.app.speech;
  const { label, keysUrl } = DOUBAO_SPEECH;
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
    <section className="settings-group">
      <h3>{label}</h3>
      <div className="settings-card">
        <KeyRow name={label} desc="用于语音生成" placeholder={`粘贴${label}的 API Key`} hasKey={hasKey} keyHint={keyHint} keySource={keySource} onSave={save} onRemove={remove} />
      </div>
      <p className="settings-hint">
        先开通「语音合成大模型」，再在{' '}
        <a href={keysUrl} target="_blank" rel="noopener">
          {label}控制台
        </a>{' '}
        创建，与火山方舟的 Key 不通用。
      </p>
    </section>
  );
}

export function openSettings() {
  openModal({ title: '设置', size: 'md', content: <Settings /> });
}
