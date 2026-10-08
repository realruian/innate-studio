// 设置弹窗：保存 / 清除 API Key，测试连接。

import { h, toast, clear, openModal, confirmDialog } from './dom.js';
import { api, state, loadApp, loadModels } from './store.js';

export function openSettings() {
  const statusEl = h('div');
  const input = h('input', { class: 'input mono', type: 'password', placeholder: 'sk-fk-…', autocomplete: 'off', spellcheck: 'false' });
  const saveBtn = h('button', { class: 'btn btn-primary', onClick: save }, '保存');
  const testEl = h('div', { class: 'small' });
  const showBox = h('input', { type: 'checkbox', onChange: (e) => { input.type = e.target.checked ? 'text' : 'password'; } });
  const removeBtn = h('button', { class: 'btn', onClick: remove }, '清除已保存的 Key');

  function drawStatus() {
    const { hasKey, keyHint, keySource, baseUrl } = state.app;
    clear(statusEl).append(
      h(
        'div',
        { class: `notice ${hasKey ? 'notice-ok' : 'notice-warn'}` },
        h('span', null, hasKey ? `当前使用的 Key：${keyHint}${keySource === 'env' ? '（来自环境变量 FLATKEY_API_KEY）' : ''}` : '还没有设置 API Key，设置后才能生成视频。'),
      ),
      h('div', { class: 'small muted' }, `接口地址：${baseUrl}`),
    );
    input.disabled = keySource === 'env';
    saveBtn.disabled = keySource === 'env';
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
      input.type = 'text';
      showBox.checked = true;
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
      statusEl,
      h('label', { class: 'field-label' }, 'Flatkey API Key'),
      h('div', { class: 'row' }, input, saveBtn),
      h('label', { class: 'check' }, showBox, '显示我粘贴的内容，方便核对'),
      h(
        'p',
        { class: 'small muted' },
        'Key 只保存在这台电脑上（data/config.json），由本地服务在请求 Flatkey 时带上，不会写进网页代码。在 ',
        h('a', { href: 'https://console.flatkey.ai/keys?lng=zh', target: '_blank', rel: 'noopener' }, 'Flatkey 控制台'),
        ' 里可以创建 Key。',
      ),
      h(
        'div',
        { class: 'row wrap' },
        h('button', { class: 'btn', onClick: test }, '测试连接'),
        removeBtn,
      ),
      testEl,
    ],
  });
  drawStatus();
}
