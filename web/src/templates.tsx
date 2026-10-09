// 模板：把一次创作的提示词和参数存下来，之后一键填回创作面板。参考素材不跟着模板走。

import { useEffect, useRef, useState } from 'react';
import { api, state, useStore, loadTemplates, goTo } from './store.ts';
import { fmtTime } from './format.ts';
import { Icon, type IconName } from './ui/Icon.tsx';
import { tip, clipTip } from './ui/controls.tsx';
import { confirmDialog, openMenu, openModal, toast } from './ui/layers.tsx';
import { composer, setForm, setStudio, typeOf } from './composer/state.ts';
import type { Template } from './types.ts';

type TemplateType = Template['type'];
const TYPE_ICONS: Record<TemplateType, IconName> = { video: 'video', image: 'image', speech: 'volume', sfx: 'music' };
const message = (err: unknown) => (err as Error).message;

// 存进模板之前把参考素材去掉：它们是这一次用的文件，换一次创作多半用不上，文件也可能已经不在了。
export function templateForm(type: TemplateType, form: Record<string, any>): Record<string, any> {
  const copy = JSON.parse(JSON.stringify(form || {}));
  delete copy.type;
  if (type === 'video') Object.assign(copy, { frames: { first: null, last: null }, refs: { image: [], video: [], audio: [] } });
  if (type === 'image') copy.refs = [];
  return copy;
}

function NameForm({ initial, okText, done }: { initial: string; okText: string; done: (name: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const timer = setTimeout(() => input.current?.select(), 0);
    return () => clearTimeout(timer);
  }, []);
  const submit = () => done(input.current!.value.trim() || initial);
  return (
    <>
      <label className="field-label">模板名称</label>
      <input ref={input} className="input" type="text" defaultValue={initial} maxLength={60} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      <div className="modal-actions">
        <button className="btn btn-primary" onClick={submit}>
          {okText}
        </button>
      </div>
    </>
  );
}

// 问一个名字，然后存成模板。cover 是一张缩好的小图，没有就用类型的图标。
export function openSaveTemplate({ type, form, cover = null }: { type: TemplateType; form: Record<string, any>; cover?: string | null }) {
  const prompt = String(form?.prompt || '').trim();
  const modal = openModal({
    title: '存为模板',
    subtitle: '存下提示词和参数，不包括参考素材',
    size: 'sm',
    content: (
      <NameForm
        initial={prompt.slice(0, 20) || `${typeOf(type).label}模板`}
        okText="保存"
        done={async (name) => {
          modal.close();
          try {
            await api('POST', '/api/templates', { name, type, form: templateForm(type, form), cover });
            await loadTemplates();
            toast('已存到「模板」', 'success');
          } catch (err) {
            toast(message(err), 'error', 6000);
          }
        }}
      />
    ),
  });
}

// 把创作面板里正在编辑的内容存成模板。配乐没有提示词和参数，存不了。
export function saveCurrent() {
  const { type } = composer.studio;
  if (type === 'music') return toast('配乐没有可以存的参数，换到别的类型再存', 'info');
  openSaveTemplate({ type, form: type === 'video' ? composer.form : composer.studio[type] });
}

export function applyTemplate(template: Template) {
  if (template.type === 'video') setForm(template.form);
  else setStudio(template.type, template.form);
  goTo('create');
  toast(`已套用「${template.name}」`, 'success');
}

export function Templates() {
  useStore('templates');
  const [query, setQuery] = useState('');
  useEffect(() => {
    loadTemplates().catch((err) => toast(`模板读不出来：${message(err)}`, 'error', 6000));
  }, []);

  function more(button: HTMLElement, template: Template) {
    openMenu(button, {
      label: '模板操作',
      items: [
        { value: 'rename', label: '重命名' },
        { value: 'delete', label: '删除', danger: true },
      ],
      onSelect: async (action) => {
        try {
          if (action === 'rename') {
            const modal = openModal({
              title: '重命名',
              size: 'sm',
              content: (
                <NameForm
                  initial={template.name}
                  okText="保存"
                  done={async (name) => {
                    modal.close();
                    if (name !== template.name) await api('PUT', `/api/templates/${template.id}`, { name });
                    await loadTemplates();
                  }}
                />
              ),
            });
            return;
          }
          if (!(await confirmDialog({ title: '删除这份模板？', message: `「${template.name}」会从模板里删掉，不影响已经生成的内容。`, okText: '删除', danger: true }))) return;
          await api('DELETE', `/api/templates/${template.id}`);
          await loadTemplates();
        } catch (err) {
          toast(message(err), 'error', 6000);
        }
      },
    });
  }

  const list = state.templates;
  const shown = (list || []).filter((t) => `${t.name}\n${t.form?.prompt || ''}`.toLowerCase().includes(query));
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>模板</h1>
          <p className="muted">把好用的提示词和参数存成模板，点一下就填回创作面板。</p>
        </div>
        <div className="search-field">
          <Icon name="search" />
          <input className="input search" type="search" placeholder="搜索模板" aria-label="搜索模板" onInput={(e) => setQuery(e.currentTarget.value.trim().toLowerCase())} />
        </div>
      </header>
      <div className="project-grid">
        {!query && (
          <article className="project">
            <button className="project-cover project-new" type="button" onClick={saveCurrent}>
              <Icon name="plus" size={20} />
              <span>存下当前创作</span>
            </button>
            <div className="project-hint">也可以在记录的「更多」里存为模板</div>
          </article>
        )}
        {shown.map((template) => (
          <article key={template.id} className="project">
            <div className="project-media">
              <button className="project-cover" type="button" aria-label={`套用「${template.name}」`} {...tip(template.form?.prompt)} onClick={() => applyTemplate(template)}>
                {template.cover ? <img src={template.cover} alt="" loading="lazy" draggable={false} /> : <Icon name={TYPE_ICONS[template.type]} size={32} stroke={1.2} />}
              </button>
              <button className="project-more" type="button" {...tip('更多')} aria-label="更多操作" aria-haspopup="menu" aria-expanded="false" onClick={(e) => more(e.currentTarget, template)}>
                <Icon name="more" size={16} />
              </button>
            </div>
            <div className="project-name ellipsis" {...clipTip(template.name)}>
              {template.name}
            </div>
            <div className="project-date">
              {typeOf(template.type).label} · {fmtTime(template.updatedAt)}
            </div>
          </article>
        ))}
        {list && query && !shown.length && <div className="empty">没有名字或提示词里带「{query}」的模板</div>}
      </div>
    </div>
  );
}
