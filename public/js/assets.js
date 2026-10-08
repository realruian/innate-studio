// 素材：缩略图、上传、选择素材的弹窗、素材库页面。

import { h, toast, openModal, copyText, clear, add, fmtTime, fmtBytes, segmented, dropdown } from './dom.js';
import {
  api, ApiError, state, on, KINDS, kindOfType,
  loadAssets, rememberAsset, refreshAsset, loadPersons, loadPersonAssets, assetReadiness,
} from './store.js';

// ---------- 缩略图 ----------

function drawThumb(source, width, height) {
  const scale = Math.min(1, 320 / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.72);
}

async function imageThumb(file) {
  const bitmap = await createImageBitmap(file);
  const url = drawThumb(bitmap, bitmap.width, bitmap.height);
  bitmap.close();
  return url;
}

function videoThumb(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    const finish = (fn) => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error('timeout'))), 6000);
    video.onloadeddata = () => {
      video.currentTime = Math.min(0.2, (video.duration || 1) / 2);
    };
    video.onseeked = () => finish(() => resolve(drawThumb(video, video.videoWidth, video.videoHeight)));
    video.onerror = () => finish(() => reject(new Error('decode')));
    video.src = url;
  });
}

export async function makeThumb(file, kind) {
  try {
    if (kind === 'image') return await imageThumb(file);
    if (kind === 'video') return await videoThumb(file);
  } catch {
    /* 生成不了缩略图就用图标代替 */
  }
  return null;
}

export function thumbEl(thumb, kind) {
  const fallback = () => h('div', { class: 'thumb-fallback' }, KINDS[kind]?.label || '图片');
  if (!thumb) return fallback();
  const img = h('img', { class: 'thumb-img', src: thumb, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
  img.addEventListener('error', () => img.replaceWith(fallback()));
  return img;
}

export const kindOfFile = (file) => ['image', 'video', 'audio'].find((k) => file.type.startsWith(`${k}/`)) || null;

// ---------- 上传 ----------

export function xhrUpload(url, formData, headers, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* 按空响应处理 */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, data?.error?.code || '', data?.error?.message || `上传失败（${xhr.status}）`));
    };
    xhr.onerror = () => reject(new ApiError(0, 'network', '连不上本地服务，请确认终端里的 node server.js 还在运行。'));
    xhr.send(formData);
  });
}

// 接口对每类素材有大小上限。超了的文件不发出去，直接说明原因。
export function checkFileSize(file, kind) {
  const { label, maxBytes } = KINDS[kind];
  if (file.size > maxBytes) throw new Error(`文件太大：${label}最大 ${Math.round(maxBytes / 1024 / 1024)} MB，这个文件有 ${fmtBytes(file.size)}。请先裁剪或压缩。`);
}

export async function uploadVirtualAsset(file, kind, onProgress) {
  checkFileSize(file, kind);
  const thumb = await makeThumb(file, kind);
  const form = new FormData();
  form.append('file', file);
  form.append('asset_type', KINDS[kind].type);
  const asset = await xhrUpload(
    '/api/assets/upload',
    form,
    { 'X-Asset-Name': encodeURIComponent(file.name), 'X-Asset-Type': KINDS[kind].type },
    onProgress,
  );
  const saved = thumb ? await api('PATCH', `/api/assets/${asset.id}`, { thumb }).catch(() => asset) : asset;
  rememberAsset(saved);
  return saved;
}

export function refFromAsset(asset, kind) {
  return {
    uid: crypto.randomUUID(),
    kind,
    source: 'asset',
    assetId: asset.id,
    personId: asset.personId || null,
    url: asset.asset_url || `asset://${asset.id}`,
    name: asset.name || asset.id,
    thumb: asset.thumb || null,
  };
}

// 上传面板：拖拽或选择文件，逐个上传并显示进度。
// kind 为空时按文件类型自动判断。upload(file, kind, onProgress) 返回素材。
export function uploadPane({ kind, limit = 1, upload, onUploaded, onAllDone, note }) {
  const rows = h('div', { class: 'upload-rows' });
  const input = h('input', {
    type: 'file',
    class: 'visually-hidden',
    accept: kind ? KINDS[kind].accept : 'image/*,video/*,audio/*',
    multiple: limit > 1,
    onChange: () => {
      handle([...input.files]);
      input.value = '';
    },
  });

  async function handle(files) {
    const accepted = [];
    for (const file of files) {
      const fileKind = kindOfFile(file);
      if (!fileKind || (kind && fileKind !== kind)) {
        toast(`「${file.name}」不是${kind ? KINDS[kind].label : '图片、视频或音频'}文件，已跳过`, 'error');
        continue;
      }
      accepted.push({ file, kind: fileKind });
    }
    if (accepted.length > limit) toast(`最多还能添加 ${limit} 个，多出的已忽略`, 'info');
    let failed = 0;
    for (const { file, kind: fileKind } of accepted.slice(0, limit)) {
      const bar = h('div', { class: 'bar-fill' });
      const status = h('span', { class: 'muted small' }, '上传中');
      rows.append(
        h(
          'div',
          { class: 'upload-row' },
          h('div', { class: 'upload-row-main' }, h('div', { class: 'ellipsis' }, file.name), h('div', { class: 'bar' }, bar)),
          h('span', { class: 'muted small' }, fmtBytes(file.size)),
          status,
        ),
      );
      try {
        const asset = await upload(file, fileKind, (p) => {
          bar.style.width = `${Math.round(p * 100)}%`;
        });
        bar.style.width = '100%';
        status.textContent = '已上传';
        status.className = 'small ok-text';
        onUploaded?.(asset, fileKind);
      } catch (err) {
        failed += 1;
        status.textContent = err.message;
        status.className = 'small error-text';
        bar.parentElement.classList.add('bar-error');
      }
    }
    if (accepted.length && !failed) onAllDone?.();
  }

  const zone = h(
    'div',
    {
      class: 'dropzone',
      tabindex: '0',
      role: 'button',
      onClick: () => input.click(),
      onKeydown: (e) => (e.key === 'Enter' || e.key === ' ') && input.click(),
      onDragover: (e) => {
        e.preventDefault();
        zone.classList.add('over');
      },
      onDragleave: () => zone.classList.remove('over'),
      onDrop: (e) => {
        e.preventDefault();
        zone.classList.remove('over');
        handle([...e.dataTransfer.files]);
      },
    },
    h('div', { class: 'dropzone-title' }, '点击选择文件，或把文件拖到这里'),
    h('div', { class: 'muted small' }, note || (kind ? `支持${KINDS[kind].label}文件` : '支持图片、视频、音频文件')),
  );
  return h('div', null, zone, input, rows);
}

// ---------- 选择素材的弹窗（创作页用） ----------

export function openAssetPicker({ kind, remaining = 1, usedIds = [], onPick }) {
  const meta = KINDS[kind];
  let tab = 'upload';
  const pane = h('div', { class: 'tab-pane' });
  const tabsEl = h('div');
  let left = remaining;
  const used = new Set(usedIds);

  const pick = (ref) => {
    onPick(ref);
    left -= 1;
  };

  function renderTabs() {
    clear(tabsEl).append(
      segmented(
        [
          { value: 'upload', label: '本地上传' },
          { value: 'url', label: '粘贴链接' },
          { value: 'library', label: '素材库' },
          { value: 'person', label: '真人素材' },
        ],
        tab,
        (next) => {
          tab = next;
          renderTabs();
          renderPane();
        },
        'tabs',
      ),
    );
  }

  function assetGrid(list, emptyText) {
    const usable = list.filter((a) => kindOfType(a.asset_type) === kind && a.status !== 'Deleted');
    if (!usable.length) return h('div', { class: 'empty small-empty' }, emptyText);
    return h(
      'div',
      { class: 'pick-grid' },
      usable.map((asset) => {
        const r = used.has(asset.id) ? { tone: 'ok', label: '已添加' } : assetReadiness(asset);
        return h(
          'button',
          {
            class: 'pick-card',
            type: 'button',
            disabled: used.has(asset.id),
            title: asset.name || asset.id,
            onClick: () => {
              pick(refFromAsset(asset, kind));
              modal.close();
            },
          },
          h('div', { class: 'pick-thumb' }, thumbEl(asset.thumb, kind)),
          h('div', { class: 'pick-name ellipsis' }, asset.name || asset.id),
          h('span', { class: `badge badge-${r.tone}` }, r.label),
        );
      }),
    );
  }

  function renderPane() {
    clear(pane);
    if (tab === 'upload') {
      pane.append(
        uploadPane({
          kind,
          limit: left,
          upload: uploadVirtualAsset,
          onUploaded: (asset) => pick(refFromAsset(asset, kind)),
          onAllDone: () => modal.close(),
          note: `文件会先上传到你的 Flatkey 素材库，处理完成后才能用于生成${left > 1 ? `；最多还能添加 ${left} 个` : ''}`,
        }),
      );
    } else if (tab === 'url') {
      const input = h('input', { class: 'input', type: 'url', placeholder: 'https://example.com/reference.png', autocomplete: 'off' });
      const submit = () => {
        const url = input.value.trim();
        if (!/^https:\/\/\S+$/i.test(url)) return toast('请填写 https:// 开头的公网地址', 'error');
        let name = url;
        try {
          name = decodeURIComponent(new URL(url).pathname.split('/').pop()) || url;
        } catch {
          /* 用完整地址当名字 */
        }
        pick({ uid: crypto.randomUUID(), kind, source: 'url', url, name, thumb: kind === 'image' ? url : null });
        modal.close();
      };
      input.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
      pane.append(
        h('label', { class: 'field-label' }, `${meta.label}地址`),
        h('div', { class: 'row' }, input, h('button', { class: 'btn btn-primary', onClick: submit }, '添加')),
        h('p', { class: 'muted small' }, '链接会原样发给 Seedance，需要是公网能直接访问的 https 地址。想反复使用，可以到「素材库」里用链接创建素材。'),
      );
      setTimeout(() => input.focus(), 0);
    } else if (tab === 'library') {
      pane.append(assetGrid(state.assets, `素材库里还没有${meta.label}素材。可以切到「本地上传」添加。`));
    } else {
      renderPersonPane();
    }
  }

  let personId = '';
  async function renderPersonPane() {
    clear(pane).append(h('div', { class: 'empty small-empty' }, '正在读取真人档案…'));
    if (state.persons === null) await loadPersons();
    if (tab !== 'person') return;
    clear(pane);
    if (state.personsError) {
      pane.append(h('div', { class: 'notice notice-warn' }, h('span', null, `读取真人档案失败：${state.personsError}`)));
      return;
    }
    const active = state.persons.filter((p) => p.status === 'active');
    if (!active.length) {
      pane.append(h('div', { class: 'empty small-empty' }, '还没有认证通过的真人档案。可以到「真人档案」页面创建。'));
      return;
    }
    if (!active.some((p) => p.id === personId)) personId = active[0].id;
    const select = dropdown({
      label: '真人档案',
      value: personId,
      options: active.map((p) => ({ value: p.id, label: p.name || p.id })),
      onChange: (id) => {
        personId = id;
        renderPersonPane();
      },
    });
    const listEl = h('div', null, h('div', { class: 'empty small-empty' }, '正在读取素材…'));
    pane.append(h('label', { class: 'field-label' }, '真人档案'), select, listEl);
    try {
      const list = await loadPersonAssets(personId);
      clear(listEl).append(assetGrid(list, `这个档案下还没有${meta.label}素材。`));
    } catch (err) {
      clear(listEl).append(h('div', { class: 'notice notice-warn' }, h('span', null, err.message)));
    }
  }

  const modal = openModal({ title: `添加${meta.label}`, size: 'md', content: [tabsEl, pane] });
  renderTabs();
  renderPane();
}

// ---------- 素材库页面 ----------

let libraryFilter = 'all';

function openAddAssetDialog() {
  let tab = 'upload';
  let urlKind = 'image';
  const pane = h('div', { class: 'tab-pane' });
  const tabsEl = h('div');

  function renderTabs() {
    clear(tabsEl).append(
      segmented(
        [
          { value: 'upload', label: '上传文件' },
          { value: 'url', label: '用链接创建' },
          { value: 'import', label: '按 ID 添加' },
        ],
        tab,
        (next) => {
          tab = next;
          renderTabs();
          renderPane();
        },
        'tabs',
      ),
    );
  }

  function renderPane() {
    clear(pane);
    if (tab === 'upload') {
      pane.append(uploadPane({ kind: null, limit: 20, upload: uploadVirtualAsset, onAllDone: () => modal.close() }));
    } else if (tab === 'url') {
      const urlInput = h('input', { class: 'input', type: 'url', placeholder: 'https://cdn.example.com/reference/product.png', autocomplete: 'off' });
      const nameInput = h('input', { class: 'input', type: 'text', placeholder: '可选，方便以后辨认', maxlength: '80' });
      const button = h('button', { class: 'btn btn-primary', onClick: submit }, '创建素材');
      async function submit() {
        const url = urlInput.value.trim();
        if (!/^https:\/\/\S+$/i.test(url)) return toast('请填写 https:// 开头的公网地址', 'error');
        button.disabled = true;
        try {
          const asset = await api('POST', '/api/assets', { url, asset_type: KINDS[urlKind].type, name: nameInput.value.trim() });
          const saved = urlKind === 'image' ? await api('PATCH', `/api/assets/${asset.id}`, { thumb: url }).catch(() => asset) : asset;
          rememberAsset(saved);
          toast('素材已创建，正在处理', 'success');
          modal.close();
        } catch (err) {
          toast(err.message, 'error', 6000);
          button.disabled = false;
        }
      }
      pane.append(
        h('label', { class: 'field-label' }, '素材类型'),
        segmented(
          Object.entries(KINDS).map(([value, k]) => ({ value, label: k.label })),
          urlKind,
          (next) => {
            urlKind = next;
            renderPane();
          },
        ),
        h('label', { class: 'field-label' }, '公网 HTTPS 地址'),
        urlInput,
        h('label', { class: 'field-label' }, '名称'),
        nameInput,
        h('div', { class: 'modal-actions' }, button),
      );
    } else {
      const input = h('input', { class: 'input mono', type: 'text', placeholder: 'ast_… 或 asset://ast_…', autocomplete: 'off' });
      const button = h('button', { class: 'btn btn-primary', onClick: submit }, '添加');
      async function submit() {
        if (!input.value.trim()) return;
        button.disabled = true;
        try {
          rememberAsset(await api('POST', '/api/assets/import', { id: input.value.trim() }));
          toast('已添加到素材库', 'success');
          modal.close();
        } catch (err) {
          toast(err.message, 'error', 6000);
          button.disabled = false;
        }
      }
      input.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
      pane.append(
        h('label', { class: 'field-label' }, '素材 ID'),
        h('div', { class: 'row' }, input, button),
        h('p', { class: 'muted small' }, '用于把以前在别处创建、但不在这个列表里的素材加进来。需要是当前 API Key 能访问的素材。'),
      );
    }
  }

  const modal = openModal({ title: '添加素材', size: 'md', content: [tabsEl, pane] });
  renderTabs();
  renderPane();
}

function openDeleteAssetDialog(asset) {
  const run = async (scope) => {
    try {
      await api('DELETE', `/api/assets/${asset.id}${scope === 'local' ? '?scope=local' : ''}`);
      toast(scope === 'local' ? '已从列表移除' : '已从 Flatkey 删除', 'success');
      modal.close();
      await loadAssets();
    } catch (err) {
      toast(err.message, 'error', 6000);
    }
  };
  const modal = openModal({
    title: '删除素材',
    size: 'sm',
    content: [
      h('p', { class: 'confirm-text' }, `「${asset.name || asset.id}」`),
      h('p', { class: 'muted small' }, '从 Flatkey 删除后，这个素材不能再用于新的生成任务，且无法恢复。只从列表移除不会影响 Flatkey 上的素材。'),
      h(
        'div',
        { class: 'modal-actions' },
        h('button', { class: 'btn', onClick: () => modal.close() }, '取消'),
        h('button', { class: 'btn', onClick: () => run('local') }, '只从列表移除'),
        h('button', { class: 'btn btn-danger', onClick: () => run('remote') }, '从 Flatkey 删除'),
      ),
    ],
  });
}

export function assetCard(asset, { onDelete, onRefresh } = {}) {
  const kind = kindOfType(asset.asset_type);
  const r = assetReadiness(asset);
  const models = asset.available_models || [];
  return h(
    'article',
    { class: 'asset-card' },
    h('div', { class: 'asset-thumb' }, thumbEl(asset.thumb, kind), h('span', { class: `badge badge-${r.tone} asset-badge` }, r.label)),
    h(
      'div',
      { class: 'asset-info' },
      h('div', { class: 'asset-name ellipsis', clipTitle: asset.name || asset.id }, asset.name || asset.id),
      h('div', { class: 'muted small' }, `${KINDS[kind].label} · ${fmtTime(asset.created_at ? asset.created_at * 1000 : asset.addedAt)}`),
      models.length
        ? h('div', { class: 'entry-meta' }, `可用模型：${models.join('、')}`)
        : asset.kind === 'virtual' && r.tone === 'pending'
          ? h('div', { class: 'muted small' }, '还没有可用的模型')
          : null,
      asset.error ? h('div', { class: 'error-text small' }, asset.error) : null,
      h(
        'div',
        { class: 'asset-actions' },
        h('button', { class: 'entry-action-btn', type: 'button', title: '复制 asset:// 地址', onClick: () => copyText(asset.asset_url || `asset://${asset.id}`, '已复制素材地址') }, '复制地址'),
        onRefresh && h('button', { class: 'entry-action-btn', type: 'button', onClick: () => onRefresh(asset) }, '刷新'),
        onDelete && h('button', { class: 'entry-action-btn danger', type: 'button', onClick: () => onDelete(asset) }, '删除'),
      ),
    ),
  );
}

export function renderLibrary(root) {
  const grid = h('div', { class: 'asset-grid' });
  const filterEl = h('div');

  function draw() {
    clear(filterEl).append(
      segmented(
        [{ value: 'all', label: '全部' }, ...Object.entries(KINDS).map(([value, k]) => ({ value, label: k.label }))],
        libraryFilter,
        (next) => {
          libraryFilter = next;
          draw();
        },
      ),
    );
    const list = state.assets.filter((a) => libraryFilter === 'all' || kindOfType(a.asset_type) === libraryFilter);
    clear(grid);
    if (!list.length) {
      grid.append(
        h(
          'div',
          { class: 'empty' },
          h('div', { class: 'empty-title' }, state.assets.length ? '这个分类下还没有素材' : '素材库还是空的'),
          h('div', { class: 'muted' }, '把常用的商品图、背景视频、音频存进来，以后生成时直接选用。'),
        ),
      );
      return;
    }
    add(
      grid,
      list.map((asset) =>
        assetCard(asset, {
          onDelete: openDeleteAssetDialog,
          onRefresh: (a) => refreshAsset(a.id).then(() => toast('状态已刷新', 'success', 1500)).catch((err) => toast(err.message, 'error')),
        }),
      ),
    );
  }

  root.append(
    h(
      'div',
      { class: 'page' },
      h(
        'header',
        { class: 'page-head' },
        h('div', null, h('h1', null, '素材库'), h('p', { class: 'muted' }, '非真人的参考素材：商品图、背景视频、音频等。上传一次，可以在多次生成里反复引用。')),
        h('button', { class: 'btn btn-primary', onClick: openAddAssetDialog }, '添加素材'),
      ),
      h(
        'div',
        { class: 'notice' },
        h('span', null, '素材创建后需要处理一段时间。状态显示「可用」，或「可用模型」里出现你要用的模型，就可以用于生成。这里只列出通过本页面创建或添加的素材。'),
      ),
      filterEl,
      grid,
    ),
  );
  draw();
  on('assets', () => root.isConnected && grid.isConnected && draw());
}
