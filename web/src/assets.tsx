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
    if (accepted.length > limit) toast(`最多还可添加 ${limit} 个，超出部分已忽略`, 'info');
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
    <div className="upload-pane">
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
        <div className="dropzone-title">点击或拖拽文件到此处上传</div>
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

type Source = 'upload' | 'library' | 'person' | 'records' | 'character';
const SOURCE_LABELS: Record<Source, string> = { upload: '本地上传', library: '素材库', person: '真人素材', records: '生成记录', character: '角色' };

interface PickerOptions {
  // 只选一种素材时给 kind 和 remaining。几种都能选时给 limits（每种还能加几个）：不用先选类型，上传的、选中的是什么就算什么。
  kind?: Kind;
  remaining?: number;
  limits?: Partial<Record<Kind, number>>;
  usedIds?: string[];
  onPick: (ref: Ref) => void;
  // 为 true 时选的是只存在本机的素材（见 media.ts 里"只存在本机的素材"），不经过 Flatkey 的素材库。
  local?: boolean;
  // 这次能用的来源，按显示顺序。
  sources?: Source[];
}

const isHttps = (url: string) => /^https:\/\/\S+$/i.test(url);

function AssetGrid({ list, kinds, used, emptyText, onPick }: { list: Asset[]; kinds: Kind[]; used: Set<string>; emptyText: string; onPick: (asset: Asset, kind: Kind) => void }) {
  const usable = list.filter((a) => kinds.includes(kindOfType(a.asset_type)) && a.status !== 'Deleted');
  if (!usable.length) return <div className="empty small-empty">{emptyText}</div>;
  return (
    <div className="pick-grid">
      {usable.map((asset) => {
        const kind = kindOfType(asset.asset_type);
        const r = used.has(asset.id) ? { tone: 'ok', label: '已添加' } : assetReadiness(asset);
        return (
          <button key={asset.id} className="pick-card" type="button" disabled={used.has(asset.id)} {...tip(asset.name || asset.id)} onClick={() => onPick(asset, kind)}>
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

const labelsOf = (kinds: Kind[]) => kinds.map((kind) => KINDS[kind].label).join('、');

// 生成记录里已经存到本机的结果。选中后：本机素材直接引用这个文件；要进素材库的先传上去。
function RecordGrid({ kinds, local, onPick }: { kinds: Kind[]; local: boolean; onPick: (ref: Ref) => void }) {
  const [busy, setBusy] = useState('');
  const list = state.history.filter((i) => kinds.includes(i.kind) && i.status === 'completed' && i.savedLocally).slice(0, 60);
  if (!list.length) return <div className="empty small-empty">暂无{labelsOf(kinds)}</div>;

  async function choose(item: HistoryItem) {
    setBusy(item.id);
    try {
      onPick(local ? await refFromRecord(item) : refFromAsset(await assetFromRecord(item), item.kind));
    } catch (err) {
      toast(message(err), 'error', 6000);
      setBusy('');
    }
  }

  return (
    <div className="pick-grid">
      {list.map((item) => (
        <button key={item.id} className="pick-card" type="button" disabled={Boolean(busy)} {...tip(item.prompt)} onClick={() => choose(item)}>
          <div className="pick-thumb">{item.kind === 'video' ? <video className="thumb-img" src={item.mediaUrl} preload="metadata" muted playsInline /> : <Thumb thumb={item.kind === 'image' ? item.mediaUrl : null} kind={item.kind} />}</div>
          <div className="pick-name ellipsis">{recordName(item)}</div>
          <span className="badge badge-pending">{busy === item.id ? (local ? '加载中' : '上传中') : fmtTime(item.createdAt)}</span>
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
  if (!list.length) return <div className="empty small-empty">{state.characters ? '暂无可用角色' : '加载中…'}</div>;
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

function PersonAssets({ kinds, used, onPick }: { kinds: Kind[]; used: Set<string>; onPick: (asset: Asset, kind: Kind) => void }) {
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

  if (state.persons === null) return <div className="empty small-empty">加载中…</div>;
  if (state.personsError) {
    return (
      <div className="notice notice-warn">
        <span>真人档案加载失败：{state.personsError}</span>
      </div>
    );
  }
  if (!active.length) return <div className="empty small-empty">暂无已认证的真人档案</div>;
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
          <div className="empty small-empty">加载中…</div>
        ) : (
          <AssetGrid list={list} kinds={kinds} used={used} emptyText={`暂无${labelsOf(kinds)}素材`} onPick={onPick} />
        )}
      </div>
    </>
  );
}

function AssetPicker({ kind, remaining = 1, limits, usedIds = [], onPick, local = false, sources, close }: PickerOptions & { sources: Source[]; close: () => void }) {
  useStore('assets');
  const [tab, setTab] = useState(sources[0]);
  // 每种素材还能加几个。选一个少一个。
  const left = useRef<Partial<Record<Kind, number>>>(limits ?? { [kind!]: remaining }).current;
  const open = (k: Kind) => (left[k] || 0) > 0;
  const kinds = (Object.keys(KINDS) as Kind[]).filter(open);
  const room = kinds.reduce((sum, k) => sum + left[k]!, 0);
  const used = useRef(new Set(usedIds)).current;
  const pick = (ref: Ref) => {
    onPick(ref);
    left[ref.kind] = (left[ref.kind] || 0) - 1;
  };
  const pickAndClose = (ref: Ref) => {
    pick(ref);
    close();
  };
  const pickAsset = (asset: Asset, k: Kind) => pickAndClose(refFromAsset(asset, k));
  // 上传的文件是什么类型就算什么。这里用不了的类型、已经加满的类型，在那一行说明原因。
  const upload = async (file: File, k: Kind, onProgress: Progress): Promise<Ref | Asset> => {
    if (!(k in left)) throw new Error(`不支持${KINDS[k].label}`);
    if (!open(k)) throw new Error(`${KINDS[k].label}数量已达上限`);
    return local ? uploadLocalFile(file, k, onProgress) : uploadVirtualAsset(file, k, onProgress);
  };
  const several = Object.keys(left).length > 1;

  return (
    <>
      <div>
        <Segmented options={sources.map((value) => ({ value, label: SOURCE_LABELS[value] }))} value={tab} onChange={setTab} className="tabs" />
      </div>
      {/* 换来源时弹窗的大小不变：这一块固定高，内容多了在里面滚 */}
      <div className="tab-pane picker-pane">
        {tab === 'upload' && (
          <UploadPane<Ref | Asset>
            kind={several ? null : kinds[0] || kind || null}
            limit={room}
            upload={upload}
            onUploaded={(result, k) => pick(local ? (result as Ref) : refFromAsset(result as Asset, k))}
            onAllDone={close}
            note={local ? undefined : `上传至 Flatkey 素材库，处理完成后可用${room > 1 ? `；最多还可添加 ${room} 个` : ''}`}
          />
        )}
        {tab === 'library' && <AssetGrid list={state.assets} kinds={kinds} used={used} emptyText={`暂无${labelsOf(kinds)}素材`} onPick={pickAsset} />}
        {tab === 'records' && <RecordGrid kinds={kinds} local={local} onPick={pickAndClose} />}
        {tab === 'person' && <PersonAssets kinds={kinds} used={used} onPick={pickAsset} />}
        {tab === 'character' && (
          <CharacterGrid
            remaining={left.image || 0}
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
  const kinds = options.limits ? (Object.keys(options.limits) as Kind[]) : [options.kind!];
  // 角色的参考图是本机的图片，所以只在选本机图片时出现。
  const sources: Source[] = options.sources ?? (options.local ? ['upload', 'records', ...(kinds.includes('image') ? (['character'] as const) : [])] : ['upload', 'library', 'person', 'records']);
  const modal = openModal({ title: kinds.length > 1 ? '添加参考素材' : `添加${KINDS[kinds[0]].label}`, size: 'md', content: <AssetPicker {...options} sources={sources} close={() => modal.close()} /> });
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
      <input ref={nameInput} className="input" type="text" placeholder="可选" maxLength={80} />
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
      <p className="muted small">仅支持当前 API Key 可访问的素材</p>
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
        <p className="muted small">从 Flatkey 删除后无法恢复；仅从列表移除不影响 Flatkey 上的素材。</p>
        <div className="modal-actions">
          <button className="btn" onClick={() => modal.close()}>
            取消
          </button>
          <button className="btn" onClick={() => run('local')}>
            仅从列表移除
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
        {models.length ? <div className="entry-meta">可用模型：{models.join('、')}</div> : asset.kind === 'virtual' && r.tone === 'pending' ? <div className="muted small">暂无可用模型</div> : null}
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
        </div>
        <button className="btn btn-primary" onClick={openAddAssetDialog}>
          添加素材
        </button>
      </header>
      <div className="notice">
        <span>素材处理完成后可用。此处仅显示通过本页创建或添加的素材。</span>
      </div>
      <div>
        <Segmented options={[{ value: 'all', label: '全部' }, ...KIND_OPTIONS]} value={filter} onChange={setFilter} />
      </div>
      <div className="asset-grid">
        {list.length ? (
          list.map((asset) => <AssetCard key={asset.id} asset={asset} onDelete={openDeleteAssetDialog} onRefresh={refresh} />)
        ) : (
          <div className="empty">
            <div className="empty-title">{state.assets.length ? '该分类暂无素材' : '暂无素材'}</div>
          </div>
        )}
      </div>
    </div>
  );
}
