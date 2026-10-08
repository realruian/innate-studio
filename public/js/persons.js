// 真人档案：创建档案、认证链接、档案下的真人素材。

import { h, toast, clear, add, openModal, confirmDialog, copyText, fmtTime, segmented } from './dom.js';
import { api, state, on, KINDS, loadPersons, loadPersonAssets } from './store.js';
import { assetCard, uploadPane, xhrUpload, makeThumb } from './assets.js';

const PERSON_STATUS = {
  pending_verification: { label: '待认证', tone: 'pending' },
  verifying: { label: '认证中', tone: 'pending' },
  active: { label: '已认证', tone: 'ok' },
  failed: { label: '认证失败', tone: 'error' },
  expired: { label: '认证已过期', tone: 'error' },
};

let selectedId = '';
let assetsError = '';

function showVerificationUrl(url, title = '认证链接') {
  openModal({
    title,
    size: 'md',
    content: url
      ? [
          h('p', { class: 'confirm-text' }, '把下面的链接交给真人本人，由本人打开并完成认证。'),
          h('div', { class: 'row' }, h('input', { class: 'input mono', readonly: true, value: url, onFocus: (e) => e.target.select() }), h('button', { class: 'btn btn-primary', onClick: () => copyText(url, '已复制认证链接') }, '复制')),
          h('div', { class: 'notice notice-warn' }, h('span', null, '这个链接是一次性的，不要公开。关闭这个窗口后不会再显示，需要时可以重新生成。')),
        ]
      : h('p', { class: 'confirm-text' }, 'Flatkey 的响应里没有认证链接，请稍后在档案上点「新的认证链接」重试。'),
  });
}

function openCreatePerson() {
  const input = h('input', { class: 'input', type: 'text', placeholder: '例如：品牌代言人-正面', maxlength: '60' });
  const button = h('button', { class: 'btn btn-primary', onClick: submit }, '创建档案');
  // 同一次创建在重试时复用同一个幂等键，避免重复建档。
  const key = crypto.randomUUID();
  async function submit() {
    const name = input.value.trim();
    if (!name) return toast('请填写档案名称', 'error');
    button.disabled = true;
    try {
      const person = await api('POST', '/api/real-persons', { name }, { 'Idempotency-Key': key });
      modal.close();
      selectedId = person.id;
      await loadPersons();
      showVerificationUrl(person.verification_url, '档案已创建');
    } catch (err) {
      toast(err.message, 'error', 6000);
      button.disabled = false;
    }
  }
  input.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  const modal = openModal({
    title: '新建真人档案',
    size: 'sm',
    content: [h('label', { class: 'field-label' }, '档案名称'), input, h('div', { class: 'modal-actions' }, button)],
  });
  setTimeout(() => input.focus(), 0);
}

async function newVerification(person) {
  const ok = await confirmDialog({ title: '生成新的认证链接？', message: `会为「${person.name || person.id}」创建一个新的认证会话。`, okText: '生成' });
  if (!ok) return;
  try {
    const data = await api('POST', `/api/real-persons/${person.id}/verification-sessions`, undefined, { 'Idempotency-Key': crypto.randomUUID() });
    showVerificationUrl(data.verification_url);
  } catch (err) {
    toast(err.message, 'error', 6000);
  }
}

async function uploadPersonAsset(personId, name, file, kind, onProgress) {
  if (file.size > KINDS[kind].maxBytes) {
    throw new Error(`超过${KINDS[kind].label}大小上限（${Math.round(KINDS[kind].maxBytes / 1024 / 1024)} MiB）`);
  }
  const thumb = await makeThumb(file, kind);
  const form = new FormData();
  form.append('asset_type', KINDS[kind].type);
  form.append('name', name || file.name);
  form.append('file', file);
  const asset = await xhrUpload(
    `/api/real-persons/${personId}/assets`,
    form,
    { 'Idempotency-Key': crypto.randomUUID(), 'X-Asset-Name': encodeURIComponent(name || file.name), 'X-Asset-Type': KINDS[kind].type },
    onProgress,
  );
  if (thumb && asset.id) await api('PATCH', `/api/assets/${asset.id}`, { thumb, kind: 'person', personId }).catch(() => {});
  return asset;
}

function openAddPersonAsset(person) {
  let tab = 'upload';
  let urlKind = 'image';
  const nameInput = h('input', { class: 'input', type: 'text', placeholder: '例如：正面参考素材', maxlength: '80' });
  const pane = h('div', { class: 'tab-pane' });
  const tabsEl = h('div');
  const done = async () => {
    modal.close();
    toast('素材已提交，正在处理', 'success');
    await loadPersonAssets(person.id).catch(() => {});
  };

  function renderTabs() {
    clear(tabsEl).append(
      segmented([{ value: 'upload', label: '上传文件' }, { value: 'url', label: '用链接创建' }], tab, (next) => {
        tab = next;
        renderTabs();
        renderPane();
      }, 'tabs'),
    );
  }

  function renderPane() {
    clear(pane);
    if (tab === 'upload') {
      pane.append(
        uploadPane({
          kind: null,
          limit: 1,
          upload: (file, kind, onProgress) => uploadPersonAsset(person.id, nameInput.value.trim(), file, kind, onProgress),
          onAllDone: done,
          note: '图片小于 30 MiB，视频不超过 50 MiB，音频不超过 15 MiB',
        }),
      );
      return;
    }
    const urlInput = h('input', { class: 'input', type: 'url', placeholder: 'https://cdn.example.com/reference/person.png', autocomplete: 'off' });
    const button = h('button', { class: 'btn btn-primary', onClick: submit }, '创建素材');
    const key = crypto.randomUUID();
    async function submit() {
      const url = urlInput.value.trim();
      if (!/^https:\/\/\S+$/i.test(url)) return toast('请填写 https:// 开头的公网地址', 'error');
      button.disabled = true;
      try {
        const asset = await api('POST', `/api/real-persons/${person.id}/assets`, { url, asset_type: KINDS[urlKind].type, name: nameInput.value.trim() }, { 'Idempotency-Key': key });
        if (urlKind === 'image' && asset.id) await api('PATCH', `/api/assets/${asset.id}`, { thumb: url, kind: 'person', personId: person.id }).catch(() => {});
        await done();
      } catch (err) {
        toast(err.message, 'error', 6000);
        button.disabled = false;
      }
    }
    pane.append(
      h('label', { class: 'field-label' }, '素材类型'),
      segmented(Object.entries(KINDS).map(([value, k]) => ({ value, label: k.label })), urlKind, (next) => {
        urlKind = next;
        renderPane();
      }),
      h('label', { class: 'field-label' }, '公网 HTTPS 地址'),
      urlInput,
      h('div', { class: 'modal-actions' }, button),
    );
  }

  const modal = openModal({
    title: '添加真人素材',
    subtitle: person.name || person.id,
    size: 'md',
    content: [h('label', { class: 'field-label' }, '素材名称'), nameInput, tabsEl, pane],
  });
  renderTabs();
  renderPane();
}

async function deletePersonAsset(person, asset) {
  const ok = await confirmDialog({
    title: '从 Flatkey 删除这个素材？',
    message: `「${asset.name || asset.id}」删除后不能再用于新的生成任务，且无法恢复。`,
    okText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api('DELETE', `/api/assets/${asset.id}`);
    toast('已删除', 'success');
    await loadPersonAssets(person.id);
  } catch (err) {
    toast(err.message, 'error', 6000);
  }
}

export function renderPersons(root) {
  const listEl = h('div', { class: 'person-list' });
  const detailEl = h('div', { class: 'person-detail' });

  async function select(id) {
    selectedId = id;
    assetsError = '';
    draw();
    try {
      await loadPersonAssets(id);
    } catch (err) {
      assetsError = err.message;
      draw();
    }
  }

  function drawList() {
    clear(listEl);
    if (state.persons === null) {
      listEl.append(h('div', { class: 'empty small-empty' }, '正在读取…'));
      return;
    }
    if (state.personsError) {
      listEl.append(h('div', { class: 'notice notice-warn' }, h('span', null, `读取失败：${state.personsError}`)));
      return;
    }
    if (!state.persons.length) {
      listEl.append(h('div', { class: 'empty small-empty' }, '还没有真人档案'));
      return;
    }
    add(
      listEl,
      state.persons.map((p) => {
        const s = PERSON_STATUS[p.status] || { label: p.status || '未知', tone: 'pending' };
        return h(
          'button',
          { class: `person-item ${p.id === selectedId ? 'active' : ''}`, type: 'button', onClick: () => select(p.id) },
          h('span', { class: 'person-main' }, h('span', { class: 'ellipsis' }, p.name || p.id), h('span', { class: 'small muted mono ellipsis' }, p.id)),
          h('span', { class: `badge badge-${s.tone}` }, s.label),
        );
      }),
    );
  }

  function drawDetail() {
    clear(detailEl);
    const person = state.persons?.find((p) => p.id === selectedId);
    if (!person) {
      detailEl.append(h('div', { class: 'empty' }, h('div', { class: 'empty-title' }, '选择一个档案查看素材'), h('div', { class: 'muted' }, '流程：创建档案 → 本人完成认证 → 添加素材 → 素材可用后用于生成。')));
      return;
    }
    const s = PERSON_STATUS[person.status] || { label: person.status || '未知', tone: 'pending' };
    const active = person.status === 'active';
    const assets = state.personAssets[person.id];
    add(
      detailEl,
      h(
        'div',
        { class: 'person-head' },
        h('div', null, h('h2', null, person.name || person.id), h('div', { class: 'small muted' }, h('span', { class: 'mono' }, person.id), person.created_at ? ` · 创建于 ${fmtTime(person.created_at * 1000)}` : '')),
        h('span', { class: `badge badge-${s.tone}` }, s.label),
      ),
      h(
        'div',
        { class: 'row wrap' },
        h('button', { class: 'btn', onClick: () => loadPersons().then(() => select(person.id)) }, '刷新状态'),
        h('button', { class: 'btn', onClick: () => newVerification(person) }, '新的认证链接'),
        h('button', { class: 'btn btn-primary', disabled: !active, onClick: () => openAddPersonAsset(person) }, '添加素材'),
      ),
      !active &&
        h(
          'div',
          { class: 'notice' },
          h('span', null, person.status === 'failed' || person.status === 'expired' ? '认证没有通过或已过期，请生成新的认证链接让本人重新认证。' : '等本人完成认证、状态变成「已认证」后，才能添加素材。'),
        ),
      h('h3', null, '素材'),
    );
    if (assetsError) detailEl.append(h('div', { class: 'notice notice-warn' }, h('span', null, assetsError)));
    else if (!assets) detailEl.append(h('div', { class: 'empty small-empty' }, '正在读取素材…'));
    else if (!assets.length) detailEl.append(h('div', { class: 'empty small-empty' }, '这个档案下还没有素材'));
    else detailEl.append(h('div', { class: 'asset-grid' }, assets.map((a) => assetCard(a, { onDelete: (asset) => deletePersonAsset(person, asset) }))));
  }

  function draw() {
    state.watchedPersonView = selectedId;
    drawList();
    drawDetail();
  }

  root.append(
    h(
      'div',
      { class: 'page' },
      h(
        'header',
        { class: 'page-head' },
        h('div', null, h('h1', null, '真人档案'), h('p', { class: 'muted' }, '用于特定真人的脸、声音或视频。需要本人完成认证后才能使用。')),
        h('div', { class: 'row' }, h('button', { class: 'btn', onClick: () => loadPersons() }, '刷新'), h('button', { class: 'btn btn-primary', onClick: openCreatePerson }, '新建档案')),
      ),
      h('div', { class: 'notice' }, h('span', null, '真人素材是受邀开放的能力，需要 Flatkey 先为你的账号开通。没有开通时，这里的操作会返回错误。')),
      h('div', { class: 'person-layout' }, listEl, detailEl),
    ),
  );
  draw();
  on('persons', () => root.isConnected && draw());
  on('assets', () => root.isConnected && !root.hidden && drawDetail());
}

export function enterPersons() {
  loadPersons();
}
