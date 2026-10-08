// 设置弹窗：外观、API Key。

import { h, toast, clear, openModal, confirmDialog, segmented, formRow } from './dom.js';
import { api, state, loadApp, loadModels } from './store.js';
import { currentTheme, setTheme } from './theme.js';

export function openSettings() {
  const themeEl = h('div');
  const statusEl = h('div', { class: 'form-section' });
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

  function drawStatus() {
    const { hasKey, keyHint, keySource, baseUrl } = state.app;
    clear(statusEl).append(
      formRow('当前 Key', h('span', { class: hasKey ? 'mono' : 'warn-text' }, hasKey ? `${keyHint}${keySource === 'env' ? '（来自环境变量）' : ''}` : '还没有设置')),
      formRow('接口地址', h('span', { class: 'mono' }, baseUrl)),
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
    const info = state.modelsInfo;
    if (info.source === 'remote') {
      testEl.className = 'small ok-text';
      testEl.textContent = `连接正常，账号可用的 Seedance 模型：${state.models.join('、')}`;
    } else if (info.error) {
      testEl.className = 'small error-text';
      testEl.textContent = `连接失败：${info.error}`;
    } else {
      testEl.className = 'small warn-text';
      testEl.textContent = info.note || '连接正常，但没有读到 Seedance 模型。';
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
      toast('API Key 已保存', 'success');
      await test();
    } catch (err) {
      toast(err.message, 'error', 6000);
    } finally {
      saveBtn.disabled = state.app.keySource === 'env';
    }
  }

  async function remove() {
    const ok = await confirmDialog({ title: '清除已保存的 API Key？', message: '清除后需要重新填写才能生成视频。进行中的任务也会暂停查询。', okText: '清除', danger: true });
    if (!ok) return;
    try {
      await api('DELETE', '/api/key');
      await loadApp();
      drawStatus();
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
  drawStatus();
}
