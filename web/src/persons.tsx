// 真人档案：创建档案、认证链接、档案下的真人素材。

import { useEffect, useRef, useState } from 'react';
import { api, state, emit, useStore, KINDS, loadPersons, loadPersonAssets } from './store.ts';
import { xhrUpload, makeThumb, checkFileSize, type Progress } from './media.ts';
import { fmtTime } from './format.ts';
import { AssetCard, UploadPane } from './assets.tsx';
import { Segmented } from './ui/controls.tsx';
import { toast, openModal, confirmDialog, copyText } from './ui/layers.tsx';
import type { Asset, Kind, Person, Tone } from './types.ts';

const PERSON_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending_verification: { label: '待认证', tone: 'pending' },
  verifying: { label: '认证中', tone: 'pending' },
  active: { label: '已认证', tone: 'ok' },
  failed: { label: '认证失败', tone: 'error' },
  expired: { label: '认证已过期', tone: 'error' },
};
const statusOf = (person: Person) => PERSON_STATUS[person.status || ''] || { label: person.status || '未知', tone: 'pending' as Tone };
const message = (err: unknown) => (err as Error).message;
const KIND_OPTIONS = (Object.keys(KINDS) as Kind[]).map((value) => ({ value, label: KINDS[value].label }));

// 页面上选中的档案。新建档案后要直接选中它，所以放在组件外面。
const page = { selectedId: '', assetsError: '' };

async function select(id: string) {
  page.selectedId = id;
  page.assetsError = '';
  emit('persons');
  try {
    await loadPersonAssets(id);
  } catch (err) {
    page.assetsError = message(err);
    emit('persons');
  }
}

function showVerificationUrl(url: string | undefined, title = '认证链接') {
  openModal({
    title,
    size: 'md',
    content: url ? (
      <>
        <p className="confirm-text">把下面的链接交给真人本人，由本人打开并完成认证。</p>
        <div className="row">
          <input className="input mono" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
          <button className="btn btn-primary" onClick={() => copyText(url, '已复制认证链接')}>
            复制
          </button>
        </div>
        <div className="notice notice-warn">
          <span>这个链接是一次性的，不要公开。关闭这个窗口后不会再显示，需要时可以重新生成。</span>
        </div>
      </>
    ) : (
      <p className="confirm-text">Flatkey 的响应里没有认证链接，请稍后在档案上点「新的认证链接」重试。</p>
    ),
  });
}

function CreatePerson({ close }: { close: () => void }) {
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // 同一次创建在重试时复用同一个幂等键，避免重复建档。
  const key = useRef(crypto.randomUUID()).current;
  useEffect(() => {
    const timer = setTimeout(() => input.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, []);
  async function submit() {
    const name = input.current!.value.trim();
    if (!name) return toast('请填写档案名称', 'error');
    setBusy(true);
    try {
      const person = await api<Person>('POST', '/api/real-persons', { name }, { 'Idempotency-Key': key });
      close();
      page.selectedId = person.id;
      await loadPersons();
      showVerificationUrl(person.verification_url, '档案已创建');
    } catch (err) {
      toast(message(err), 'error', 6000);
      setBusy(false);
    }
  }
  return (
    <>
      <label className="field-label">档案名称</label>
      <input ref={input} className="input" type="text" placeholder="例如：品牌代言人-正面" maxLength={60} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      <div className="modal-actions">
        <button className="btn btn-primary" disabled={busy} onClick={submit}>
          创建档案
        </button>
      </div>
    </>
  );
}

function openCreatePerson() {
  const modal = openModal({ title: '新建真人档案', size: 'sm', content: <CreatePerson close={() => modal.close()} /> });
}

async function newVerification(person: Person) {
  const ok = await confirmDialog({ title: '生成新的认证链接？', message: `会为「${person.name || person.id}」创建一个新的认证会话。`, okText: '生成' });
  if (!ok) return;
  try {
    const data = await api<Person>('POST', `/api/real-persons/${person.id}/verification-sessions`, undefined, { 'Idempotency-Key': crypto.randomUUID() });
    showVerificationUrl(data.verification_url);
  } catch (err) {
    toast(message(err), 'error', 6000);
  }
}

async function uploadPersonAsset(personId: string, name: string, file: File, kind: Kind, onProgress: Progress) {
  checkFileSize(file, kind);
  const thumb = await makeThumb(file, kind);
  const form = new FormData();
  form.append('asset_type', KINDS[kind].type);
  form.append('name', name || file.name);
  form.append('file', file);
  const asset = await xhrUpload<Asset>(
    `/api/real-persons/${personId}/assets`,
    form,
    { 'Idempotency-Key': crypto.randomUUID(), 'X-Asset-Name': encodeURIComponent(name || file.name), 'X-Asset-Type': KINDS[kind].type },
    onProgress,
  );
  if (thumb && asset.id) await api('PATCH', `/api/assets/${asset.id}`, { thumb, kind: 'person', personId }).catch(() => {});
  return asset;
}

function AddPersonAsset({ person, close }: { person: Person; close: () => void }) {
  const [tab, setTab] = useState<'upload' | 'url'>('upload');
  const [urlKind, setUrlKind] = useState<Kind>('image');
  const [busy, setBusy] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const urlInput = useRef<HTMLInputElement>(null);
  const key = useRef(crypto.randomUUID()).current;
  const name = () => nameInput.current!.value.trim();
  const done = async () => {
    close();
    toast('素材已提交，正在处理', 'success');
    await loadPersonAssets(person.id).catch(() => {});
  };
  async function submit() {
    const url = urlInput.current!.value.trim();
    if (!/^https:\/\/\S+$/i.test(url)) return toast('请填写 https:// 开头的公网地址', 'error');
    setBusy(true);
    try {
      const asset = await api<Asset>('POST', `/api/real-persons/${person.id}/assets`, { url, asset_type: KINDS[urlKind].type, name: name() }, { 'Idempotency-Key': key });
      if (urlKind === 'image' && asset.id) await api('PATCH', `/api/assets/${asset.id}`, { thumb: url, kind: 'person', personId: person.id }).catch(() => {});
      await done();
    } catch (err) {
      toast(message(err), 'error', 6000);
      setBusy(false);
    }
  }
  return (
    <>
      <label className="field-label">素材名称</label>
      <input ref={nameInput} className="input" type="text" placeholder="例如：正面参考素材" maxLength={80} />
      <div>
        <Segmented
          options={[
            { value: 'upload', label: '上传文件' },
            { value: 'url', label: '用链接创建' },
          ]}
          value={tab}
          onChange={setTab}
          className="tabs"
        />
      </div>
      <div className="tab-pane">
        {tab === 'upload' ? (
          <UploadPane kind={null} limit={1} upload={(file, kind, onProgress) => uploadPersonAsset(person.id, name(), file, kind, onProgress)} onAllDone={done} note="图片小于 30 MiB，视频不超过 50 MiB，音频不超过 15 MiB" />
        ) : (
          <>
            <label className="field-label">素材类型</label>
            <Segmented options={KIND_OPTIONS} value={urlKind} onChange={setUrlKind} />
            <label className="field-label">公网 HTTPS 地址</label>
            <input ref={urlInput} className="input" type="url" placeholder="https://cdn.example.com/reference/person.png" autoComplete="off" />
            <div className="modal-actions">
              <button className="btn btn-primary" disabled={busy} onClick={submit}>
                创建素材
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function openAddPersonAsset(person: Person) {
  const modal = openModal({ title: '添加真人素材', subtitle: person.name || person.id, size: 'md', content: <AddPersonAsset person={person} close={() => modal.close()} /> });
}

async function deletePersonAsset(person: Person, asset: Asset) {
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
    toast(message(err), 'error', 6000);
  }
}

function PersonList() {
  if (state.persons === null) return <div className="empty small-empty">正在读取…</div>;
  if (state.personsError) {
    return (
      <div className="notice notice-warn">
        <span>读取失败：{state.personsError}</span>
      </div>
    );
  }
  if (!state.persons.length) return <div className="empty small-empty">还没有真人档案</div>;
  return state.persons.map((p) => {
    const s = statusOf(p);
    return (
      <button key={p.id} className={`person-item ${p.id === page.selectedId ? 'active' : ''}`} type="button" onClick={() => select(p.id)}>
        <span className="person-main">
          <span className="ellipsis">{p.name || p.id}</span>
          <span className="small muted mono ellipsis">{p.id}</span>
        </span>
        <span className={`badge badge-${s.tone}`}>{s.label}</span>
      </button>
    );
  });
}

function PersonDetail() {
  const person = state.persons?.find((p) => p.id === page.selectedId);
  if (!person) {
    return (
      <div className="empty">
        <div className="empty-title">选择一个档案查看素材</div>
        <div className="muted">流程：创建档案 → 本人完成认证 → 添加素材 → 素材可用后用于生成。</div>
      </div>
    );
  }
  const s = statusOf(person);
  const active = person.status === 'active';
  const assets = state.personAssets[person.id];
  return (
    <>
      <div className="person-head">
        <div>
          <h2>{person.name || person.id}</h2>
          <div className="small muted">
            <span className="mono">{person.id}</span>
            {person.created_at ? ` · 创建于 ${fmtTime(person.created_at * 1000)}` : ''}
          </div>
        </div>
        <span className={`badge badge-${s.tone}`}>{s.label}</span>
      </div>
      <div className="row wrap">
        <button className="btn" onClick={() => loadPersons().then(() => select(person.id))}>
          刷新状态
        </button>
        <button className="btn" onClick={() => newVerification(person)}>
          新的认证链接
        </button>
        <button className="btn btn-primary" disabled={!active} onClick={() => openAddPersonAsset(person)}>
          添加素材
        </button>
      </div>
      {!active && (
        <div className="notice">
          <span>{person.status === 'failed' || person.status === 'expired' ? '认证没有通过或已过期，请生成新的认证链接让本人重新认证。' : '等本人完成认证、状态变成「已认证」后，才能添加素材。'}</span>
        </div>
      )}
      <h3>素材</h3>
      {page.assetsError ? (
        <div className="notice notice-warn">
          <span>{page.assetsError}</span>
        </div>
      ) : !assets ? (
        <div className="empty small-empty">正在读取素材…</div>
      ) : !assets.length ? (
        <div className="empty small-empty">这个档案下还没有素材</div>
      ) : (
        <div className="asset-grid">
          {assets.map((asset) => (
            <AssetCard key={asset.id} asset={asset} onDelete={(a) => deletePersonAsset(person, a)} />
          ))}
        </div>
      )}
    </>
  );
}

export function Persons() {
  useStore('persons', 'assets');
  // 素材还在处理的话，轮询会盯着正在看的这份档案。
  state.watchedPersonView = page.selectedId;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>真人档案</h1>
          <p className="muted">用于特定真人的脸、声音或视频。需要本人完成认证后才能使用。</p>
        </div>
        <div className="row">
          <button className="btn" onClick={() => loadPersons()}>
            刷新
          </button>
          <button className="btn btn-primary" onClick={openCreatePerson}>
            新建档案
          </button>
        </div>
      </header>
      <div className="notice">
        <span>真人素材是受邀开放的能力，需要 Flatkey 先为你的账号开通。没有开通时，这里的操作会返回错误。</span>
      </div>
      <div className="person-layout">
        <div className="person-list">
          <PersonList />
        </div>
        <div className="person-detail">
          <PersonDetail />
        </div>
      </div>
    </div>
  );
}
