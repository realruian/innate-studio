// 素材的界面：缩略图、上传面板、选择素材的弹窗、素材库页面。文件处理在 media.ts。

import { useEffect, useRef, useState } from 'react';
import { api, state, useStore, KINDS, kindOfType, loadAssets, rememberAsset, refreshAsset, loadPersons, loadPersonAssets, loadCharacters, assetReadiness } from './store.ts';
import { kindOfFile, uploadVirtualAsset, uploadLocalFile, refFromAsset, refFromRecord, assetFromRecord, recordName, type Progress } from './media.ts';
import { fmtTime, fmtBytes } from './format.ts';
import { toast, openModal, copyText } from './ui/layers.tsx';
import { Segmented, Dropdown, tip, clipTip } from './ui/controls.tsx';
import { refsFromCharacter } from './composer/state.ts';
import type { Asset, HistoryItem, Kind, Ref } from './types.ts';

const message = (err: unknown) => (err as Error).message;

export function Thumb({ thumb, kind }: { thumb?: string | null; kind: Kind }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!thumb || failed === thumb) return <div className="thumb-fallback">{KINDS[kind]?.label || '图片'}</div>;
  return <img className="thumb-img" src={thumb} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(thumb)} />;
}

// ---------- 上传面板 ----------

interface UploadRow {
  id: number;
  name: string;
  size: number;
  progress: number;
  status: 'uploading' | 'done' | 'error';
  text: string;
}

interface UploadPaneProps<T> {
  // 为空时按文件类型自动判断。
  kind: Kind | null;
  limit?: number;
  upload: (file: File, kind: Kind, onProgress: Progress) => Promise<T>;
  onUploaded?: (result: T, kind: Kind) => void;
  onAllDone?: () => void;
  note?: string;
}

// 拖拽或选择文件，逐个上传并显示进度。
export function UploadPane<T>({ kind, limit = 1, upload, onUploaded, onAllDone, note }: UploadPaneProps<T>) {
  const [rows, setRows] = useState<UploadRow[]>([]);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const nextRow = useRef(0);
  const patch = (id: number, change: Partial<UploadRow>) => setRows((list) => list.map((row) => (row.id === id ? { ...row, ...change } : row)));

  async function handle(files: File[]) {
    const accepted: { file: File; kind: Kind }[] = [];
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
      const id = nextRow.current++;
      setRows((list) => [...list, { id, name: file.name, size: file.size, progress: 0, status: 'uploading', text: '上传中' }]);
      try {
        const result = await upload(file, fileKind, (p) => patch(id, { progress: Math.round(p * 100) }));
        patch(id, { progress: 100, status: 'done', text: '已上传' });
        onUploaded?.(result, fileKind);
      } catch (err) {
        failed += 1;
        patch(id, { status: 'error', text: message(err) });
      }
    }
    if (accepted.length && !failed) onAllDone?.();
  }

  return (
    <div>
      <div
        className={`dropzone${over ? ' over' : ''}`}
        tabIndex={0}
        role="button"
        onClick={() => input.current!.click()}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current!.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          handle([...e.dataTransfer.files]);
        }}
      >
        <div className="dropzone-title">点击选择文件，或把文件拖到这里</div>
        <div className="muted small">{note || (kind ? `支持${KINDS[kind].label}文件` : '支持图片、视频、音频文件')}</div>
      </div>
      <input
        ref={input}
        type="file"
        className="visually-hidden"
        accept={kind ? KINDS[kind].accept : 'image/*,video/*,audio/*'}
        multiple={limit > 1}
        onChange={(e) => {
          handle([...(e.currentTarget.files || [])]);
          e.currentTarget.value = '';
        }}
      />
      <div className="upload-rows">
        {rows.map((row) => (
          <div key={row.id} className="upload-row">
            <div className="upload-row-main">
              <div className="ellipsis">{row.name}</div>
              <div className={`bar${row.status === 'error' ? ' bar-error' : ''}`}>
                <div className="bar-fill" style={{ width: `${row.progress}%` }} />
              </div>
            </div>
            <span className="muted small">{fmtBytes(row.size)}</span>
            <span className={row.status === 'done' ? 'small ok-text' : row.status === 'error' ? 'small error-text' : 'muted small'}>{row.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- 选择素材的弹窗（创作页用） ----------

type Source = 'upload' | 'url' | 'library' | 'person' | 'records' | 'character';
const SOURCE_LABELS: Record<Source, string> = { upload: '本地上传', url: '粘贴链接', library: '素材库', person: '真人素材', records: '生成记录', character: '角色' };

interface PickerOptions {
  kind: Kind;
  remaining?: number;
  usedIds?: string[];
  onPick: (ref: Ref) => void;
  // 为 true 时选的是只存在本机的素材（见 media.ts 里"只存在本机的素材"），不经过 Flatkey 的素材库。
  local?: boolean;
  // 这次能用的来源，按显示顺序。
  sources?: Source[];
}

const isHttps = (url: string) => /^https:\/\/\S+$/i.test(url);

function AssetGrid({ list, kind, used, emptyText, onPick }: { list: Asset[]; kind: Kind; used: Set<string>; emptyText: string; onPick: (asset: Asset) => void }) {
  const usable = list.filter((a) => kindOfType(a.asset_type) === kind && a.status !== 'Deleted');
  if (!usable.length) return <div className="empty small-empty">{emptyText}</div>;
  return (
    <div className="pick-grid">
      {usable.map((asset) => {
        const r = used.has(asset.id) ? { tone: 'ok', label: '已添加' } : assetReadiness(asset);
        return (
          <button key={asset.id} className="pick-card" type="button" disabled={used.has(asset.id)} {...tip(asset.name || asset.id)} onClick={() => onPick(asset)}>
            <div className="pick-thumb">
              <Thumb thumb={asset.thumb} kind={kind} />
            </div>
            <div className="pick-name ellipsis">{asset.name || asset.id}</div>
            <span className={`badge badge-${r.tone}`}>{r.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// 生成记录里已经存到本机的结果。选中后：本机素材直接引用这个文件；要进素材库的先传上去。
function RecordGrid({ kind, local, onPick }: { kind: Kind; local: boolean; onPick: (ref: Ref) => void }) {
  const [busy, setBusy] = useState('');
  const list = state.history.filter((i) => i.kind === kind && i.status === 'completed' && i.savedLocally).slice(0, 60);
  if (!list.length) return <div className="empty small-empty">还没有生成过{KINDS[kind].label}。</div>;

  async function choose(item: HistoryItem) {
    setBusy(item.id);
    try {
      onPick(local ? await refFromRecord(item) : refFromAsset(await assetFromRecord(item), kind));
    } catch (err) {
      toast(message(err), 'error', 6000);
      setBusy('');
    }
  }

  return (
    <div className="pick-grid">
      {list.map((item) => (
        <button key={item.id} className="pick-card" type="button" disabled={Boolean(busy)} {...tip(item.prompt)} onClick={() => choose(item)}>
          <div className="pick-thumb">{kind === 'video' ? <video className="thumb-img" src={item.mediaUrl} preload="metadata" muted playsInline /> : <Thumb thumb={kind === 'image' ? item.mediaUrl : null} kind={kind} />}</div>
          <div className="pick-name ellipsis">{recordName(item)}</div>
          <span className="badge badge-pending">{busy === item.id ? (local ? '读取中' : '上传中') : fmtTime(item.createdAt)}</span>
        </button>
      ))}
    </div>
  );
}

// 角色库里的角色。选中一个，把它的参考图都加进来，放不下的不加。
function CharacterGrid({ remaining, onPick }: { remaining: number; onPick: (refs: Ref[]) => void }) {
  useStore('characters');
  useEffect(() => {
    if (!state.characters) loadCharacters().catch((err) => toast(message(err), 'error', 6000));
  }, []);
  const list = (state.characters || []).filter((c) => c.images.length);
  if (!list.length) return <div className="empty small-empty">{state.characters ? '角色库里还没有带参考图的角色。可以到「角色」里新建。' : '正在读取…'}</div>;
  return (
    <div className="pick-grid">
      {list.map((character) => (
        <button key={character.id} className="pick-card" type="button" {...tip(character.description)} onClick={() => onPick(refsFromCharacter(character).slice(0, remaining))}>
          <div className="pick-thumb">
            <Thumb thumb={character.images[0]} kind="image" />
          </div>
          <div className="pick-name ellipsis">{character.name}</div>
          <span className="badge badge-pending">{character.images.length} 张图</span>
        </button>
      ))}
    </div>
  );
}

function PersonAssets({ kind, used, onPick }: { kind: Kind; used: Set<string>; onPick: (asset: Asset) => void }) {
  useStore('persons', 'assets');
  const [chosen, setChosen] = useState('');
  const [error, setError] = useState('');
  const active = (state.persons || []).filter((p) => p.status === 'active');
  const personId = active.some((p) => p.id === chosen) ? chosen : active[0]?.id || '';

  useEffect(() => {
    if (state.persons === null) loadPersons();
  }, []);
  useEffect(() => {
    if (!personId) return;
    setError('');
    loadPersonAssets(personId).catch((err) => setError(message(err)));
  }, [personId]);

  if (state.persons === null) return <div className="empty small-empty">正在读取真人档案…</div>;
  if (state.personsError) {
    return (
      <div className="notice notice-warn">
        <span>读取真人档案失败：{state.personsError}</span>
      </div>
    );
  }
  if (!active.length) return <div className="empty small-empty">还没有认证通过的真人档案。可以到「真人档案」页面创建。</div>;
  const list = state.personAssets[personId];
  return (
    <>
      <label className="field-label">真人档案</label>
      <Dropdown label="真人档案" value={personId} options={active.map((p) => ({ value: p.id, label: p.name || p.id }))} onChange={setChosen} />
      <div>
        {error ? (
          <div className="notice notice-warn">
            <span>{error}</span>
          </div>
        ) : !list ? (
          <div className="empty small-empty">正在读取素材…</div>
        ) : (
          <AssetGrid list={list} kind={kind} used={used} emptyText={`这个档案下还没有${KINDS[kind].label}素材。`} onPick={onPick} />
        )}
      </div>
    </>
  );
}

function UrlSource({ kind, local, onPick }: { kind: Kind; local: boolean; onPick: (ref: Ref) => void }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const timer = setTimeout(() => input.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, []);
  const submit = () => {
    const url = input.current!.value.trim();
    if (!isHttps(url)) return toast('请填写 https:// 开头的公网地址', 'error');
    let name = url;
    try {
      name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '') || url;
    } catch {
      /* 用完整地址当名字 */
    }
    onPick({ uid: crypto.randomUUID(), kind, source: 'url', url, name, thumb: kind === 'image' ? url : null });
  };
  return (
    <>
      <label className="field-label">{KINDS[kind].label}地址</label>
      <div className="row">
        <input ref={input} className="input" type="url" placeholder="https://example.com/reference.png" autoComplete="off" onKeyDown={(e) => e.key === 'Enter' && submit()} />
        <button className="btn btn-primary" onClick={submit}>
          添加
        </button>
      </div>
      <p className="muted small">{local ? '链接会原样发给模型，需要是公网能直接访问的 https 地址。' : '链接会原样发给 Seedance，需要是公网能直接访问的 https 地址。想反复使用，可以到「素材库」里用链接创建素材。'}</p>
    </>
  );
}

function AssetPicker({ kind, remaining = 1, usedIds = [], onPick, local = false, sources, close }: PickerOptions & { sources: Source[]; close: () => void }) {
  useStore('assets');
  const [tab, setTab] = useState(sources[0]);
  const left = useRef(remaining);
  const used = useRef(new Set(usedIds)).current;
  const pick = (ref: Ref) => {
    onPick(ref);
    left.current -= 1;
  };
  const pickAndClose = (ref: Ref) => {
    pick(ref);
    close();
  };
  const pickAsset = (asset: Asset) => pickAndClose(refFromAsset(asset, kind));

  return (
    <>
      <div>
        <Segmented options={sources.map((value) => ({ value, label: SOURCE_LABELS[value] }))} value={tab} onChange={setTab} className="tabs" />
      </div>
      <div className="tab-pane">
        {tab === 'upload' && (
          <UploadPane<Ref | Asset>
            kind={kind}
            limit={left.current}
            upload={local ? uploadLocalFile : uploadVirtualAsset}
            onUploaded={(result) => pick(local ? (result as Ref) : refFromAsset(result as Asset, kind))}
            onAllDone={close}
            note={local ? '文件只保存在这台电脑上' : `文件会先上传到你的 Flatkey 素材库，处理完成后才能用于生成${left.current > 1 ? `；最多还能添加 ${left.current} 个` : ''}`}
          />
        )}
        {tab === 'url' && <UrlSource kind={kind} local={local} onPick={pickAndClose} />}
        {tab === 'library' && <AssetGrid list={state.assets} kind={kind} used={used} emptyText={`素材库里还没有${KINDS[kind].label}素材。可以切到「本地上传」添加。`} onPick={pickAsset} />}
        {tab === 'records' && <RecordGrid kind={kind} local={local} onPick={pickAndClose} />}
        {tab === 'person' && <PersonAssets kind={kind} used={used} onPick={pickAsset} />}
        {tab === 'character' && (
          <CharacterGrid
            remaining={left.current}
            onPick={(refs) => {
              refs.forEach(pick);
              close();
            }}
          />
        )}
      </div>
    </>
  );
}

export function openAssetPicker(options: PickerOptions) {
  // 角色的参考图是本机的图片，所以只在选本机图片时出现。
  const sources: Source[] = options.sources ?? (options.local ? ['upload', 'url', 'records', ...(options.kind === 'image' ? (['character'] as const) : [])] : ['upload', 'url', 'library', 'person', 'records']);
  const modal = openModal({ title: `添加${KINDS[options.kind].label}`, size: 'md', content: <AssetPicker {...options} sources={sources} close={() => modal.close()} /> });
}

// ---------- 素材库页面 ----------

const KIND_OPTIONS = (Object.keys(KINDS) as Kind[]).map((value) => ({ value, label: KINDS[value].label }));

function AssetFromUrl({ close }: { close: () => void }) {
  const [kind, setKind] = useState<Kind>('image');
  const [busy, setBusy] = useState(false);
  const urlInput = useRef<HTMLInputElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  async function submit() {
    const url = urlInput.current!.value.trim();
    if (!isHttps(url)) return toast('请填写 https:// 开头的公网地址', 'error');
    setBusy(true);
    try {
      const asset = await api<Asset>('POST', '/api/assets', { url, asset_type: KINDS[kind].type, name: nameInput.current!.value.trim() });
      const saved = kind === 'image' ? await api<Asset>('PATCH', `/api/assets/${asset.id}`, { thumb: url }).catch(() => asset) : asset;
      rememberAsset(saved);
      toast('素材已创建，正在处理', 'success');
      close();
    } catch (err) {
      toast(message(err), 'error', 6000);
      setBusy(false);
    }
  }
  return (
    <>
      <label className="field-label">素材类型</label>
      <Segmented options={KIND_OPTIONS} value={kind} onChange={setKind} />
      <label className="field-label">公网 HTTPS 地址</label>
      <input ref={urlInput} className="input" type="url" placeholder="https://cdn.example.com/reference/product.png" autoComplete="off" />
      <label className="field-label">名称</label>
      <input ref={nameInput} className="input" type="text" placeholder="可选，方便以后辨认" maxLength={80} />
      <div className="modal-actions">
        <button className="btn btn-primary" disabled={busy} onClick={submit}>
          创建素材
        </button>
      </div>
    </>
  );
}

function AssetById({ close }: { close: () => void }) {
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  async function submit() {
    const id = input.current!.value.trim();
    if (!id) return;
    setBusy(true);
    try {
      rememberAsset(await api<Asset>('POST', '/api/assets/import', { id }));
      toast('已添加到素材库', 'success');
      close();
    } catch (err) {
      toast(message(err), 'error', 6000);
      setBusy(false);
    }
  }
  return (
    <>
      <label className="field-label">素材 ID</label>
      <div className="row">
        <input ref={input} className="input mono" type="text" placeholder="ast_… 或 asset://ast_…" autoComplete="off" onKeyDown={(e) => e.key === 'Enter' && submit()} />
        <button className="btn btn-primary" disabled={busy} onClick={submit}>
          添加
        </button>
      </div>
      <p className="muted small">用于把以前在别处创建、但不在这个列表里的素材加进来。需要是当前 API Key 能访问的素材。</p>
    </>
  );
}

function AddAssetDialog({ close }: { close: () => void }) {
  const [tab, setTab] = useState<'upload' | 'url' | 'import'>('upload');
  return (
    <>
      <div>
        <Segmented
          options={[
            { value: 'upload', label: '上传文件' },
            { value: 'url', label: '用链接创建' },
            { value: 'import', label: '按 ID 添加' },
          ]}
          value={tab}
          onChange={setTab}
          className="tabs"
        />
      </div>
      <div className="tab-pane">
        {tab === 'upload' && <UploadPane kind={null} limit={20} upload={uploadVirtualAsset} onAllDone={close} />}
        {tab === 'url' && <AssetFromUrl close={close} />}
        {tab === 'import' && <AssetById close={close} />}
      </div>
    </>
  );
}

function openAddAssetDialog() {
  const modal = openModal({ title: '添加素材', size: 'md', content: <AddAssetDialog close={() => modal.close()} /> });
}

function openDeleteAssetDialog(asset: Asset) {
  const run = async (scope: 'local' | 'remote') => {
    try {
      await api('DELETE', `/api/assets/${asset.id}${scope === 'local' ? '?scope=local' : ''}`);
      toast(scope === 'local' ? '已从列表移除' : '已从 Flatkey 删除', 'success');
      modal.close();
      await loadAssets();
    } catch (err) {
      toast(message(err), 'error', 6000);
    }
  };
  const modal = openModal({
    title: '删除素材',
    size: 'sm',
    content: (
      <>
        <p className="confirm-text">「{asset.name || asset.id}」</p>
        <p className="muted small">从 Flatkey 删除后，这个素材不能再用于新的生成任务，且无法恢复。只从列表移除不会影响 Flatkey 上的素材。</p>
        <div className="modal-actions">
          <button className="btn" onClick={() => modal.close()}>
            取消
          </button>
          <button className="btn" onClick={() => run('local')}>
            只从列表移除
          </button>
          <button className="btn btn-danger" onClick={() => run('remote')}>
            从 Flatkey 删除
          </button>
        </div>
      </>
    ),
  });
}

export function AssetCard({ asset, onDelete, onRefresh }: { asset: Asset; onDelete?: (asset: Asset) => void; onRefresh?: (asset: Asset) => void }) {
  const kind = kindOfType(asset.asset_type);
  const r = assetReadiness(asset);
  const models = asset.available_models || [];
  return (
    <article className="asset-card">
      <div className="asset-thumb">
        <Thumb thumb={asset.thumb} kind={kind} />
        <span className={`badge badge-${r.tone} asset-badge`}>{r.label}</span>
      </div>
      <div className="asset-info">
        <div className="asset-name ellipsis" {...clipTip(asset.name || asset.id)}>
          {asset.name || asset.id}
        </div>
        <div className="muted small">{`${KINDS[kind].label} · ${fmtTime(asset.created_at ? asset.created_at * 1000 : asset.addedAt)}`}</div>
        {models.length ? <div className="entry-meta">可用模型：{models.join('、')}</div> : asset.kind === 'virtual' && r.tone === 'pending' ? <div className="muted small">还没有可用的模型</div> : null}
        {asset.error ? <div className="error-text small">{asset.error}</div> : null}
        <div className="asset-actions">
          <button className="entry-action-btn" type="button" {...tip('复制 asset:// 地址')} onClick={() => copyText(asset.asset_url || `asset://${asset.id}`, '已复制素材地址')}>
            复制地址
          </button>
          {onRefresh && (
            <button className="entry-action-btn" type="button" onClick={() => onRefresh(asset)}>
              刷新
            </button>
          )}
          {onDelete && (
            <button className="entry-action-btn danger" type="button" onClick={() => onDelete(asset)}>
              删除
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

export function Library() {
  useStore('assets');
  const [filter, setFilter] = useState<Kind | 'all'>('all');
  const list = state.assets.filter((a) => filter === 'all' || kindOfType(a.asset_type) === filter);
  const refresh = (asset: Asset) =>
    refreshAsset(asset.id)
      .then(() => toast('状态已刷新', 'success', 1500))
      .catch((err) => toast(message(err), 'error'));
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>素材库</h1>
          <p className="muted">非真人的参考素材：商品图、背景视频、音频等。上传一次，可以在多次生成里反复引用。</p>
        </div>
        <button className="btn btn-primary" onClick={openAddAssetDialog}>
          添加素材
        </button>
      </header>
      <div className="notice">
        <span>素材创建后需要处理一段时间。状态显示「可用」，或「可用模型」里出现你要用的模型，就可以用于生成。这里只列出通过本页面创建或添加的素材。</span>
      </div>
      <div>
        <Segmented options={[{ value: 'all', label: '全部' }, ...KIND_OPTIONS]} value={filter} onChange={setFilter} />
      </div>
      <div className="asset-grid">
        {list.length ? (
          list.map((asset) => <AssetCard key={asset.id} asset={asset} onDelete={openDeleteAssetDialog} onRefresh={refresh} />)
        ) : (
          <div className="empty">
            <div className="empty-title">{state.assets.length ? '这个分类下还没有素材' : '素材库还是空的'}</div>
            <div className="muted">把常用的商品图、背景视频、音频存进来，以后生成时直接选用。</div>
          </div>
        )}
      </div>
    </div>
  );
}
