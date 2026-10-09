// 设置弹窗：外观、润色用的模型、用哪个平台、API Key 和余额。

import { useEffect, useRef, useState } from 'react';
import { api, state, useStore, loadApp, loadModels, switchProvider, polishModel, setPolishModel } from './store.ts';
import { PROVIDERS, type ProviderId } from '../../shared/models.ts';
import { currentTheme, setTheme } from './theme.ts';
import { Segmented, FormRow, Dropdown } from './ui/controls.tsx';
import { toast, openModal, confirmDialog } from './ui/layers.tsx';

const amount = (n: number) => n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const message = (err: unknown) => (err as Error).message;

function Settings() {
  useStore('app', 'models');
  const [theme, setThemeState] = useState(currentTheme());
  const [polish, setPolish] = useState(polishModel());
  // 输入框默认遮住内容；显示出来是为了核对粘贴的到底是不是 Key。
  const [masked, setMasked] = useState(true);
  const [saving, setSaving] = useState(false);
  const [credits, setCredits] = useState('—');
  const [test, setTest] = useState({ tone: '', text: '' });
  const [switching, setSwitching] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const { hasKey, keyHint, keySource, baseUrl, provider } = state.app;
  const { label: platform, keyPrefix, keysUrl } = PROVIDERS[provider];
  const fromEnv = keySource === 'env';
  const models = state.catalog.polish;

  async function readCredits() {
    if (!state.app.hasKey) return setCredits('—');
    setCredits('读取中…');
    try {
      const { remaining, used, unit } = await api('GET', '/api/credits');
      const sign = unit === 'usd' ? '$' : '';
      setCredits(`剩余 ${sign}${amount(remaining)} · 已用 ${sign}${amount(used)}`);
    } catch {
      setCredits('没有读到');
    }
  }
  useEffect(() => {
    readCredits();
  }, []);

  // 换平台：之后新提交的生成都走新平台，两个平台的 Key 各存各的。
  async function changeProvider(next: ProviderId) {
    if (next === provider || switching) return;
    setSwitching(true);
    setTest({ tone: '', text: '' });
    input.current!.value = '';
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

  async function testConnection() {
    setTest({ tone: 'muted', text: `正在连接 ${platform}…` });
    await loadModels();
    const info = state.modelsInfo;
    if (info.source === 'remote') {
      const { image, audio } = state.catalog;
      const extras = [image.length && '图片', audio.speech && '语音', audio.sfx && '音效', audio.music && '配乐'].filter(Boolean);
      setTest({ tone: 'ok-text', text: `连接正常。可用的视频模型：${state.models.join('、')}${extras.length ? `；还可以生成${extras.join('、')}` : ''}` });
    } else if (info.error) {
      setTest({ tone: 'error-text', text: `连接失败：${info.error}` });
    } else {
      setTest({ tone: 'warn-text', text: info.note || '连接正常，但没有读到视频模型。' });
    }
  }

  async function save() {
    const value = input.current!.value.trim();
    if (!value) return toast('请粘贴你的 API Key', 'error');
    if (/[^\x21-\x7e]/.test(value)) {
      setMasked(false);
      return toast(`这不像是 API Key：里面有中文或空格，可能是剪贴板里的其他内容。请复制 ${platform} 控制台里以 ${keyPrefix} 开头的那一串。`, 'error', 8000);
    }
    if (!value.startsWith(keyPrefix)) {
      const ok = await confirmDialog({ title: `这看起来不像 ${platform} 的 Key`, message: `${platform} 的 Key 通常以 ${keyPrefix} 开头，你粘贴的内容不是。仍然保存吗？`, okText: '仍然保存' });
      if (!ok) return;
    }
    setSaving(true);
    try {
      state.app = await api('PUT', '/api/key', { apiKey: value, provider });
      input.current!.value = '';
      setMasked(true);
      await loadApp();
      readCredits();
      toast('API Key 已保存', 'success');
      await testConnection();
    } catch (err) {
      toast(message(err), 'error', 6000);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    const ok = await confirmDialog({ title: `清除已保存的 ${platform} API Key？`, message: '清除后需要重新填写才能生成。进行中的任务也会暂停查询。', okText: '清除', danger: true });
    if (!ok) return;
    try {
      await api('DELETE', `/api/key?provider=${provider}`);
      await loadApp();
      readCredits();
      setTest({ tone: '', text: '' });
      toast('已清除', 'success');
    } catch (err) {
      toast(message(err), 'error');
    }
  }

  return (
    <>
      <div className="section-title">外观</div>
      <div className="form-section">
        <FormRow label="主题">
          <div>
            <Segmented
              options={[
                { value: 'light', label: '浅色' },
                { value: 'dark', label: '深色' },
              ]}
              value={theme}
              onChange={(next) => {
                setTheme(next);
                setThemeState(currentTheme());
              }}
            />
          </div>
        </FormRow>
      </div>
      <div className="section-title">提示词润色</div>
      {/* 润色提示词用哪个文本模型。账号里一个可用的都没有时，创作面板上不会出现「润色」。 */}
      <div className="form-section">
        <FormRow label="润色用的模型" desc="创作面板上的「润色」会让它把提示词补充得更具体">
          {models.length ? (
            <Dropdown
              label="润色用的模型"
              value={models.includes(polish) ? polish : polishModel()}
              options={models.map((m) => ({ value: m, label: m }))}
              onChange={(model) => {
                setPolishModel(model);
                setPolish(model);
              }}
            />
          ) : (
            <span className="muted">{state.catalog.known ? '账号里没有可用的文本模型' : '读到模型列表后才能选'}</span>
          )}
        </FormRow>
      </div>
      <div className="section-title">模型平台</div>
      <div className="form-section">
        <FormRow label="用哪个平台生成" desc="两个平台的 Key 各存各的，随时可以换回来">
          <div>
            <Segmented options={(Object.keys(PROVIDERS) as ProviderId[]).map((id) => ({ value: id, label: PROVIDERS[id].label, disabled: switching }))} value={provider} onChange={changeProvider} />
          </div>
        </FormRow>
      </div>
      {provider === 'openrouter' && <p className="small muted">OpenRouter 上能生成视频、图片和语音，也能润色提示词。音效、配乐、素材库、真人档案只有 Flatkey 有，切换回去就能用；延长和修改视频也只在 Flatkey 上。</p>}
      <div className="section-title">{platform} API Key</div>
      <div className="form-section">
        <FormRow label="当前 Key">
          <span className={hasKey ? 'mono' : 'warn-text'}>{hasKey ? `${keyHint}${fromEnv ? '（来自环境变量）' : ''}` : '还没有设置'}</span>
        </FormRow>
        <FormRow label="接口地址">
          <span className="mono">{baseUrl}</span>
        </FormRow>
        <FormRow label="账户余额">
          <span className="muted">{credits}</span>
        </FormRow>
      </div>
      <div className="row">
        <input
          ref={input}
          className={`input mono${masked ? ' masked' : ''}`}
          type="text"
          placeholder={`${keyPrefix}…`}
          autoComplete="off"
          data-1p-ignore=""
          data-lpignore="true"
          aria-label={`${platform} API Key`}
          disabled={fromEnv}
          onKeyDown={(e) => e.key === 'Enter' && save()}
        />
        <button className="btn" type="button" disabled={fromEnv} onClick={() => setMasked(!masked)}>
          {masked ? '显示' : '隐藏'}
        </button>
        <button className="btn btn-primary" type="button" disabled={fromEnv || saving} onClick={save}>
          保存
        </button>
      </div>
      <p className="small muted">
        Key 只保存在这台电脑上（data/config.json），由本地服务在请求 {platform} 时带上，不会写进网页代码。在{' '}
        <a href={keysUrl} target="_blank" rel="noopener">
          {platform} 控制台
        </a>{' '}
        里可以创建 Key。
      </p>
      <div className="row wrap">
        <button className="btn" type="button" onClick={testConnection}>
          测试连接
        </button>
        <button className="btn" type="button" hidden={keySource !== 'file'} onClick={remove}>
          清除已保存的 Key
        </button>
      </div>
      <div className={`small ${test.tone}`}>{test.text}</div>
    </>
  );
}

export function openSettings() {
  openModal({ title: '设置', size: 'md', content: <Settings /> });
}
