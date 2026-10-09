// 画布的项目列表：一个项目是一张画布，在新标签页里打开，整个窗口都是那张画布，侧栏收起来。
// 开着哪张画布看地址（#/canvas/<id>）：刷新之后还在那张画布里，浏览器的后退回到列表。

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { api, canvasInPath, canvasPath, setImmersive } from '../store.ts';
import { fmtTime } from '../format.ts';
import { Icon } from '../ui/Icon.tsx';
import { tip, clipTip } from '../ui/controls.tsx';
import { confirmDialog, openMenu, openModal, toast } from '../ui/layers.tsx';

// 画布用到的库比较大，第一次点进项目时才加载。
const Editor = lazy(() => import('./Canvas.tsx'));

export interface ProjectMeta {
  id: string;
  name: string;
  cover: { url: string; kind: 'image' | 'video' } | null;
  updatedAt: number;
}

function Rename({ project, done }: { project: ProjectMeta; done: (name?: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const timer = setTimeout(() => input.current?.select(), 0);
    return () => clearTimeout(timer);
  }, []);
  const submit = () => done(input.current!.value.trim() || project.name);
  return (
    <>
      <label className="field-label">项目名称</label>
      <input ref={input} className="input" type="text" defaultValue={project.name} maxLength={60} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      <div className="modal-actions">
        <button className="btn btn-primary" onClick={submit}>
          保存
        </button>
      </div>
    </>
  );
}

export function Projects() {
  const [list, setList] = useState<ProjectMeta[] | null>(null);
  const [openId, setOpenId] = useState(canvasInPath);
  const [query, setQuery] = useState('');

  const load = useCallback(() => {
    api<{ items: ProjectMeta[] }>('GET', '/api/canvases')
      .then((data) => setList(data.items))
      .catch((err) => toast(`项目列表读不出来：${(err as Error).message}`, 'error', 6000));
  }, []);
  useEffect(load, [load]);

  // 地址变了（后退、前进、从画布返回）就跟着换。回到列表时重新读一遍，名字和封面可能改过。
  useEffect(() => {
    const sync = () => {
      const id = canvasInPath();
      setOpenId(id);
      setImmersive(Boolean(id));
      if (!id) load();
    };
    // 画布开在别的标签页里，回到这一页时列表也要更新。
    const refresh = () => document.visibilityState === 'visible' && !canvasInPath() && load();
    window.addEventListener('hashchange', sync);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('hashchange', sync);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [load]);

  const leave = useCallback(() => {
    location.hash = canvasPath();
  }, []);

  // 在新标签页里打开一张画布。标签页要在点击的当下就开出来，等请求回来再开会被浏览器当成弹窗拦掉；
  // 真被拦了就在当前页打开。
  async function open(id: string | Promise<string>) {
    const tab = window.open('', '_blank');
    try {
      const url = `${location.pathname}${location.search}${canvasPath(await id)}`;
      if (tab) tab.location.replace(url);
      else location.assign(url);
    } catch (err) {
      tab?.close();
      toast((err as Error).message, 'error', 6000);
    }
  }
  const create = () => open(api<ProjectMeta>('POST', '/api/canvases', {}).then((project) => project.id));
  const enter = (id: string) => open(id);

  function more(button: HTMLElement, project: ProjectMeta) {
    openMenu(button, {
      label: '项目操作',
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
                <Rename
                  project={project}
                  done={async (name) => {
                    modal.close();
                    if (name && name !== project.name) await api('PUT', `/api/canvases/${project.id}`, { name });
                    load();
                  }}
                />
              ),
            });
            return;
          }
          if (!(await confirmDialog({ title: '删除这个项目？', message: `「${project.name}」里的节点和连线会一起删掉。已经生成的内容还在「创作记录」里。`, okText: '删除', danger: true }))) return;
          await api('DELETE', `/api/canvases/${project.id}`);
          load();
        } catch (err) {
          toast((err as Error).message, 'error', 6000);
        }
      },
    });
  }

  if (openId) {
    return (
      <Suspense>
        <Editor key={openId} id={openId} onExit={leave} />
      </Suspense>
    );
  }

  const shown = (list || []).filter((p) => p.name.toLowerCase().includes(query));
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>画布</h1>
          <p className="muted">一个项目是一张无限画布：把文本、图片、视频、音频摆成节点，用连线串成一条生成流程。</p>
        </div>
        <div className="search-field">
          <Icon name="search" />
          <input className="input search" type="search" placeholder="搜索项目" aria-label="搜索项目" onInput={(e) => setQuery(e.currentTarget.value.trim().toLowerCase())} />
        </div>
      </header>
      <div className="project-grid">
        {!query && (
          <article className="project">
            <button className="project-cover project-new" type="button" onClick={create}>
              <Icon name="plus" size={20} />
              <span>开始创作</span>
            </button>
            <div className="project-hint">新建一个项目</div>
          </article>
        )}
        {shown.map((project) => (
          <article key={project.id} className="project">
            <div className="project-media">
              <button className="project-cover" type="button" aria-label={`打开「${project.name}」`} onClick={() => enter(project.id)}>
                {project.cover?.kind === 'video' ? (
                  // 加上 #t=0.1 让浏览器停在开头那一帧，当封面用；不播放。
                  <video src={`${project.cover.url}#t=0.1`} preload="metadata" muted playsInline tabIndex={-1} />
                ) : project.cover ? (
                  <img src={project.cover.url} alt="" loading="lazy" draggable={false} />
                ) : (
                  <Icon name="image" size={32} stroke={1.2} />
                )}
              </button>
              <button className="project-more" type="button" {...tip('更多')} aria-label="更多操作" aria-haspopup="menu" aria-expanded="false" onClick={(e) => more(e.currentTarget, project)}>
                <Icon name="more" size={16} />
              </button>
            </div>
            <div className="project-name ellipsis" {...clipTip(project.name)}>
              {project.name}
            </div>
            <div className="project-date">{fmtTime(project.updatedAt)}</div>
          </article>
        ))}
        {list && query && !shown.length && <div className="empty">没有名字里带「{query}」的项目</div>}
      </div>
    </div>
  );
}
