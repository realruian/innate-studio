// 角色库：把一个角色的名字、描述和参考图存下来，生成图片或视频时一键带上，同一个角色才能反复出现。

import { useEffect, useRef, useState } from 'react';
import { api, state, useStore, loadCharacters } from './store.ts';
import { fmtTime } from './format.ts';
import { Icon } from './ui/Icon.tsx';
import { SearchBox, tip, clipTip } from './ui/controls.tsx';
import { confirmDialog, openMenu, openModal, toast } from './ui/layers.tsx';
import { Thumb, openAssetPicker } from './assets.tsx';
import { MediaTile, AddTile } from './ui/tiles.tsx';
import { useCharacter } from './composer/state.ts';
import type { Character } from './types.ts';

const MAX_IMAGES = 6;
const message = (err: unknown) => (err as Error).message;

// 新建和编辑用同一个表单。character 没有 id 就是新建，可以带着一张现成的图进来（从生成记录「存为角色」）。
function Editor({ character, done }: { character: Partial<Character>; done: () => void }) {
  const name = useRef<HTMLInputElement>(null);
  const description = useRef<HTMLTextAreaElement>(null);
  const [images, setImages] = useState(character.images || []);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => name.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, []);

  async function save() {
    const body = { name: name.current!.value, description: description.current!.value, images };
    if (!body.name.trim()) return toast('请输入角色名称', 'info');
    setSaving(true);
    try {
      await (character.id ? api('PUT', `/api/characters/${character.id}`, body) : api('POST', '/api/characters', body));
      await loadCharacters();
      done();
    } catch (err) {
      toast(message(err), 'error', 6000);
      setSaving(false);
    }
  }

  return (
    <>
      <label className="field-label">名称</label>
      <input ref={name} className="input" type="text" defaultValue={character.name || ''} maxLength={60} placeholder="例如：林晚" />
      <label className="field-label">描述</label>
      <textarea ref={description} className="input" rows={3} defaultValue={character.description || ''} maxLength={2000} placeholder="外貌特征：年龄、发型、服装、体型" />
      <label className="field-label">
        参考图（{images.length} / {MAX_IMAGES}）
      </label>
      <div className="row character-images">
        {images.map((url) => (
          <MediaTile key={url} onRemove={() => setImages(images.filter((u) => u !== url))}>
            <Thumb thumb={url} kind="image" />
          </MediaTile>
        ))}
        {images.length < MAX_IMAGES && (
          <AddTile
            label="添加参考图"
            onClick={() => openAssetPicker({ title: '添加参考图', kind: 'image', local: true, sources: ['upload', 'records'], usedUrls: images, remaining: MAX_IMAGES - images.length, onPick: (ref) => setImages((list) => (list.includes(ref.url) ? list : [...list, ref.url].slice(0, MAX_IMAGES))) })}
          />
        )}
      </div>
      <p className="muted small">建议上传正脸、全身、侧面各一张</p>
      <div className="modal-actions">
        <button className="btn btn-primary" disabled={saving} onClick={save}>
          保存
        </button>
      </div>
    </>
  );
}

export function openCharacterEditor(character: Partial<Character> = {}) {
  const modal = openModal({ title: character.id ? '编辑角色' : '新建角色', size: 'md', content: <Editor character={character} done={() => modal.close()} /> });
}

function generate(character: Character, type: 'image' | 'video') {
  try {
    useCharacter(character, type);
    toast(`已添加角色「${character.name}」`, 'success');
  } catch (err) {
    toast(message(err), 'error', 6000);
  }
}

export function Characters() {
  useStore('characters');
  const [query, setQuery] = useState('');
  useEffect(() => {
    loadCharacters().catch((err) => toast(`角色加载失败：${message(err)}`, 'error', 6000));
  }, []);

  function more(button: HTMLElement, character: Character) {
    openMenu(button, {
      label: '角色操作',
      items: [
        { value: 'image', label: '生成图片' },
        { value: 'video', label: '生成视频' },
        { value: 'edit', label: '编辑' },
        { value: 'delete', label: '删除', danger: true },
      ],
      onSelect: async (action) => {
        if (action === 'image' || action === 'video') return generate(character, action);
        if (action === 'edit') return openCharacterEditor(character);
        if (!(await confirmDialog({ title: '删除这个角色？', message: `删除「${character.name}」后无法恢复，已生成的内容不受影响。`, okText: '删除', danger: true }))) return;
        try {
          await api('DELETE', `/api/characters/${character.id}`);
          await loadCharacters();
        } catch (err) {
          toast(message(err), 'error', 6000);
        }
      },
    });
  }

  const list = state.characters;
  const shown = (list || []).filter((c) => c.name.toLowerCase().includes(query));
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>角色</h1>
        </div>
        <SearchBox label="搜索角色" onQuery={setQuery} />
      </header>
      <div className="project-grid character-grid">
        {!query && (
          <article className="project">
            <button className="project-cover project-new" type="button" onClick={() => openCharacterEditor()}>
              <Icon name="plus" size={20} />
              <span>新建角色</span>
            </button>
          </article>
        )}
        {shown.map((character) => (
          <article key={character.id} className="project">
            <div className="project-media">
              <button className="project-cover" type="button" aria-label={`用「${character.name}」生成图片`} {...tip('生成图片')} onClick={() => generate(character, 'image')}>
                {character.images[0] ? <img src={character.images[0]} alt="" loading="lazy" draggable={false} /> : <Icon name="mask" size={32} stroke={1.2} />}
              </button>
              <button className="icon-btn icon-btn-sm on-media project-more" type="button" {...tip('更多')} aria-label="更多操作" aria-haspopup="menu" aria-expanded="false" onClick={(e) => more(e.currentTarget, character)}>
                <Icon name="more" size={16} />
              </button>
            </div>
            <div className="project-name ellipsis" {...clipTip(character.name)}>
              {character.name}
            </div>
            <div className="project-date">
              {character.images.length} 张参考图 · {fmtTime(character.updatedAt)}
            </div>
          </article>
        ))}
        {list && query && !shown.length && <div className="empty">未找到「{query}」</div>}
      </div>
    </div>
  );
}
