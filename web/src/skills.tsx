// 技能：一套写提示词的规则。在输入框里选一个技能，只写一句简单的话，发送时文本模型按规则把它扩写成完整的提示词。
// 这里是三样东西：输入框上点开的技能面板、新建和查看技能的弹窗、侧栏的「技能」页。选中哪个技能记在创作表单里（composer/state.ts）。

import { useEffect, useRef, useState } from 'react';
import { api, state, useStore, loadSkills, goTo } from './store.ts';
import { Icon } from './ui/Icon.tsx';
import { Segmented, tip } from './ui/controls.tsx';
import { confirmDialog, openMenu, openModal, toast } from './ui/layers.tsx';
import { composer, activeSkill, setSkill } from './composer/state.ts';
import type { Skill } from './types.ts';

type SkillType = Skill['type'];
const TYPE_LABELS: Record<SkillType, string> = { video: '视频', image: '图片' };
const TYPE_OPTIONS = (Object.keys(TYPE_LABELS) as SkillType[]).map((value) => ({ value, label: TYPE_LABELS[value] }));
const message = (err: unknown) => (err as Error).message;
const matches = (skill: Skill, query: string) => `${skill.name}\n${skill.description}`.toLowerCase().includes(query);

// 一行技能：图标、名字、官方标记，下面一行说明。面板和「技能」页都用它。
function SkillLine({ skill, typed }: { skill: Skill; typed?: boolean }) {
  return (
    <>
      <Icon name="wand" size={18} />
      <span className="skill-text">
        <span className="skill-name">
          <span className="ellipsis">{skill.name}</span>
          {skill.official && <span className="badge badge-pending">官方</span>}
          {typed && <span className="badge badge-pending">{TYPE_LABELS[skill.type]}</span>}
        </span>
        <span className="skill-desc ellipsis">{skill.description || '暂无简介'}</span>
      </span>
    </>
  );
}

// ---------- 新建、编辑、查看 ----------

// 官方技能只能看。自己建的可以改。skill 没有 id 就是新建。
function Editor({ skill, done }: { skill: Partial<Skill>; done: () => void }) {
  const locked = Boolean(skill.official);
  const name = useRef<HTMLInputElement>(null);
  const description = useRef<HTMLInputElement>(null);
  const rules = useRef<HTMLTextAreaElement>(null);
  const [type, setType] = useState<SkillType>(skill.type || 'video');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (locked) return;
    const timer = setTimeout(() => name.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, []);

  async function save() {
    const body = { name: name.current!.value, description: description.current!.value, type, rules: rules.current!.value };
    setSaving(true);
    try {
      await (skill.id ? api('PUT', `/api/skills/${skill.id}`, body) : api('POST', '/api/skills', body));
      await loadSkills();
      done();
    } catch (err) {
      toast(message(err), 'error', 6000);
      setSaving(false);
    }
  }

  return (
    <>
      <label className="field-label">名称</label>
      <input ref={name} className="input" type="text" defaultValue={skill.name || ''} maxLength={30} readOnly={locked} placeholder="例如：产品展示" />
      <label className="field-label">简介</label>
      <input ref={description} className="input" type="text" defaultValue={skill.description || ''} maxLength={120} readOnly={locked} placeholder="技能简介" />
      <label className="field-label">适用类型</label>
      <div>{locked ? <span className="badge badge-pending">{TYPE_LABELS[type]}</span> : <Segmented options={TYPE_OPTIONS} value={type} onChange={setType} />}</div>
      <label className="field-label">规则</label>
      <textarea ref={rules} className="input skill-rules" rows={12} defaultValue={skill.rules || ''} maxLength={8000} readOnly={locked} placeholder="提示词扩写规则：内容要求、禁止项、输出格式" />
      {locked && <p className="muted small">官方技能不可修改</p>}
      {!locked && (
        <div className="modal-actions">
          <button className="btn btn-primary" disabled={saving} onClick={save}>
            保存
          </button>
        </div>
      )}
    </>
  );
}

export function openSkillEditor(skill: Partial<Skill> = {}) {
  const modal = openModal({ title: skill.official ? skill.name! : skill.id ? '编辑技能' : '新建技能', size: 'md', content: <Editor skill={skill} done={() => modal.close()} /> });
}

// ---------- 输入框上的技能面板 ----------

// 只列当前这种创作能用的技能。点一个就选中，再点一次取消。
export function SkillPanel({ close }: { close: () => void }) {
  useStore('skills', 'composer');
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    loadSkills().catch((err) => toast(`技能加载失败：${message(err)}`, 'error', 6000));
    const timer = setTimeout(() => search.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, []);
  const type = composer.studio.type as SkillType;
  const chosen = activeSkill();
  const list = (state.skills || []).filter((skill) => skill.type === type && matches(skill, query));
  const leave = (then: () => void) => {
    close();
    then();
  };
  return (
    <>
      <div className="pop-search">
        <Icon name="search" size={18} />
        <input ref={search} type="search" placeholder="搜索技能" aria-label="搜索技能" onInput={(e) => setQuery(e.currentTarget.value.trim().toLowerCase())} />
      </div>
      <div className="skill-list" role="listbox" aria-label="技能">
        {list.map((skill) => {
          const selected = skill.id === chosen?.id;
          return (
            <button
              key={skill.id}
              className={`skill-item ${selected ? 'selected' : ''}`}
              type="button"
              role="option"
              aria-selected={selected}
              onClick={() => {
                setSkill(selected ? null : { id: skill.id, name: skill.name });
                close();
              }}
            >
              <SkillLine skill={skill} />
              <span className="skill-check">{selected && <Icon name="check" />}</span>
            </button>
          );
        })}
        {state.skills && !list.length && <div className="empty small-empty">{query ? `未找到「${query}」` : `暂无${TYPE_LABELS[type]}技能`}</div>}
      </div>
      <div className="skill-foot">
        <button className="menu-item skill-action" type="button" onClick={() => leave(() => openSkillEditor({ type }))}>
          <Icon name="plus" size={18} />
          <span>创建技能</span>
        </button>
        <button className="menu-item skill-action" type="button" onClick={() => leave(() => goTo('skills'))}>
          <Icon name="sliders" size={18} />
          <span>管理技能</span>
        </button>
      </div>
    </>
  );
}

// ---------- 「技能」页 ----------

export function Skills() {
  useStore('skills');
  const [query, setQuery] = useState('');
  useEffect(() => {
    loadSkills().catch((err) => toast(`技能加载失败：${message(err)}`, 'error', 6000));
  }, []);

  function more(button: HTMLElement, skill: Skill) {
    openMenu(button, {
      label: '技能操作',
      align: 'end',
      items: [
        { value: 'edit', label: '编辑' },
        { value: 'delete', label: '删除', danger: true },
      ],
      onSelect: async (action) => {
        if (action === 'edit') return openSkillEditor(skill);
        if (!(await confirmDialog({ title: '删除这个技能？', message: `删除「${skill.name}」后无法恢复，已生成的内容不受影响。`, okText: '删除', danger: true }))) return;
        try {
          await api('DELETE', `/api/skills/${skill.id}`);
          await loadSkills();
        } catch (err) {
          toast(message(err), 'error', 6000);
        }
      },
    });
  }

  const shown = (state.skills || []).filter((skill) => matches(skill, query));
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>技能</h1>
        </div>
        <div className="row">
          <div className="search-field">
            <Icon name="search" />
            <input className="input search" type="search" placeholder="搜索技能" aria-label="搜索技能" onInput={(e) => setQuery(e.currentTarget.value.trim().toLowerCase())} />
          </div>
          <button className="btn btn-primary" type="button" onClick={() => openSkillEditor()}>
            <Icon name="plus" />
            新建技能
          </button>
        </div>
      </header>
      <div className="skill-page-list">
        {shown.map((skill) => (
          <div key={skill.id} className="skill-card">
            <button className="skill-item" type="button" {...tip(skill.official ? '查看规则' : '编辑')} onClick={() => openSkillEditor(skill)}>
              <SkillLine skill={skill} typed />
            </button>
            {!skill.official && (
              <button className="icon-btn" type="button" aria-label="更多操作" aria-haspopup="menu" aria-expanded="false" onClick={(e) => more(e.currentTarget, skill)}>
                <Icon name="more" />
              </button>
            )}
          </div>
        ))}
        {state.skills && !shown.length && <div className="empty">没有带「{query}」的技能</div>}
      </div>
    </div>
  );
}
