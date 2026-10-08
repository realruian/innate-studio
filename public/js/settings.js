// 设置弹窗：外观、润色用的模型、API Key 和余额。

import { h, toast, clear, openModal, confirmDialog, segmented, formRow, dropdown } from './dom.js';
import { api, state, loadApp, loadModels, polishModel, setPolishModel } from './store.js';
import { currentTheme, setTheme } from './theme.js';

export function openSettings() {
  const themeEl = h('div');
  const polishEl = h('div', { class: 'form-section' });
  const statusEl = h('div', { class: 'form-section' });
  const creditsEl = h('span', { class: 'muted' }, '—');
  const input = h('input', { class: 'input mono masked', type: 'text', placeholder: 'sk-fk-…', autocomplete: 'off', 'data-1p-ignore': true, 'data-lpignore': 'true', 'aria-label': 'Flatkey API Key' });
  const revealBtn = h('button', { class: 'btn', type: 'button', onClick: () => reveal(input.classList.contains('masked')) }, '显示');
  const saveBtn = h('button', { class: 'btn btn-primary', type: 'button', onClick: save }, '保存');
  const removeBtn = h('button', { class: 'btn', type: 'button', onClick: remove }, '清除已保存的 Key');
  const testEl = h('div', { class: 'small' });

  // 输入框默认遮住内容；显示出来是为了核对粘贴的到底是不是 Key。
  function reveal(show) {
    input.classList.toggle('masked', !show);
    revealBtn.textContent = show ? '隐藏' : '显示';
  }

  function drawTheme() {
    clear(themeEl).append(
      segmented([{ value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }], currentTheme(), (theme) => {
        setTheme(theme);
        drawTheme();
      }),
    );
  }

  // 润色提示词用哪个文本模型。账号里一个可用的都没有时，创作面板上不会出现「润色」。
  function drawPolish() {
    const models = state.catalog.polish;
    clear(polishEl).append(
      formRow(
        '润色用的模型',
        models.length
          ? dropdown({
              label: '润色用的模型',
              value: polishModel(),
              options: models.map((m) => ({ value: m, label: m })),
              onChange: (model) => {
                setPolishModel(model);
                drawPolish();
              },
            })
          : h('span', { class: 'muted' }, state.catalog.known ? '账号里没有可用的文本模型' : '读到模型列表后才能选'),
        '创作面板上的「润色」会让它把提示词补充得更具体',
      ),
    );
  }

  const amount = (n) => n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });

  async function drawCredits() {
    if (!state.app.hasKey) {
      creditsEl.textContent = '—';
      return;
    }
    creditsEl.textContent = '读取中…';
    try {
      const { remaining, used } = await api('GET', '/api/credits');
      creditsEl.textContent = `剩余 ${amount(remaining)} · 已用 ${amount(used)}`;
    } catch {
      creditsEl.textContent = '没有读到';
    }
  }

  function drawStatus() {
    const { hasKey, keyHint, keySource, baseUrl } = state.app;
    clear(statusEl).append(
      formRow('当前 Key', h('span', { class: hasKey ? 'mono' : 'warn-text' }, hasKey ? `${keyHint}${keySource === 'env' ? '（来自环境变量）' : ''}` : '还没有设置')),
      formRow('接口地址', h('span', { class: 'mono' }, baseUrl)),
      formRow('账户余额', creditsEl),
    );
    input.disabled = keySource === 'env';
    saveBtn.disabled = keySource === 'env';
    revealBtn.disabled = keySource === 'env';
    removeBtn.hidden = keySource !== 'file';
  }

  async function test() {
    testEl.className = 'small muted';
    testEl.textContent = '正在连接 Flatkey…';
    await loadModels();
    drawPolish();
    const info = state.modelsInfo;
    if (info.source === 'remote') {
      const { image, audio } = state.catalog;
      const extras = [image.length && '图片', audio.speech && '语音', audio.sfx && '音效', audio.music && '配乐'].filter(Boolean);
      testEl.className = 'small ok-text';
      testEl.textContent = `连接正常。可用的视频模型：${state.models.join('、')}${extras.length ? `；还可以生成${extras.join('、')}` : ''}`;
    } else if (info.error) {
      testEl.className = 'small error-text';
      testEl.textContent = `连接失败：${info.error}`;
    } else {
      testEl.className = 'small warn-text';
      testEl.textContent = info.note || '连接正常，但没有读到视频模型。';
    }
  }

  async function save() {
    const value = input.value.trim();
    if (!value) return toast('请粘贴你的 API Key', 'error');
    if (/[^\x21-\x7e]/.test(value)) {
      reveal(true);
      return toast('这不像是 API Key：里面有中文或空格，可能是剪贴板里的其他内容。请复制 Flatkey 控制台里以 sk-fk- 开头的那一串。', 'error', 8000);
    }
    if (!value.startsWith('sk-fk-')) {
      const ok = await confirmDialog({ title: '这看起来不像 Flatkey 的 Key', message: 'Flatkey 的 Key 通常以 sk-fk- 开头，你粘贴的内容不是。仍然保存吗？', okText: '仍然保存' });
      if (!ok) return;
    }
    saveBtn.disabled = true;
    try {
      state.app = await api('PUT', '/api/key', { apiKey: value });
      input.value = '';
      reveal(false);
      await loadApp();
      drawStatus();
      drawCredits();
      toast('API Key 已保存', 'success');
      await test();
    } catch (err) {
      toast(err.message, 'error', 6000);
    } finally {
      saveBtn.disabled = state.app.keySource === 'env';
    }
  }

  async function remove() {
    const ok = await confirmDialog({ title: '清除已保存的 API Key？', message: '清除后需要重新填写才能生成。进行中的任务也会暂停查询。', okText: '清除', danger: true });
    if (!ok) return;
    try {
      await api('DELETE', '/api/key');
      await loadApp();
      drawStatus();
      drawCredits();
      testEl.textContent = '';
      toast('已清除', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  input.addEventListener('keydown', (e) => e.key === 'Enter' && save());

  openModal({
    title: '设置',
    size: 'md',
    content: [
      h('div', { class: 'section-title' }, '外观'),
      h('div', { class: 'form-section' }, formRow('主题', themeEl)),
      h('div', { class: 'section-title' }, '提示词润色'),
      polishEl,
      h('div', { class: 'section-title' }, 'Flatkey API Key'),
      statusEl,
      h('div', { class: 'row' }, input, revealBtn, saveBtn),
      h(
        'p',
        { class: 'small muted' },
        'Key 只保存在这台电脑上（data/config.json），由本地服务在请求 Flatkey 时带上，不会写进网页代码。在 ',
        h('a', { href: 'https://console.flatkey.ai/keys?lng=zh', target: '_blank', rel: 'noopener' }, 'Flatkey 控制台'),
        ' 里可以创建 Key。',
      ),
      h('div', { class: 'row wrap' }, h('button', { class: 'btn', type: 'button', onClick: test }, '测试连接'), removeBtn),
      testEl,
    ],
  });
  drawTheme();
  drawPolish();
  drawStatus();
  drawCredits();
}
