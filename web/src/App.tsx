// 整个页面：侧边栏（导航和设置）和四个页面。页面第一次打开时才画，之后切走只是藏起来。

import { useEffect, useRef } from 'react';
import { state, useStore, goTo, loadPersons } from './store.ts';
import { Icon, type IconName } from './ui/Icon.tsx';
import { LayerHosts } from './ui/layers.tsx';
import { tip } from './ui/controls.tsx';
import { Composer } from './composer/Composer.tsx';
import { focusComposer } from './composer/state.ts';
import { Recent, Records } from './history.tsx';
import { Library } from './assets.tsx';
import { Persons } from './persons.tsx';
import { openSettings } from './settings.tsx';
import type { ViewId } from './types.ts';

// 「新建创作」是一个动作按钮，不是页签，所以始终是凸起的样子，不参与"当前页"高亮。
const VIEWS: { id: ViewId; label: string; icon: IconName; action?: boolean }[] = [
  { id: 'create', label: '新建创作', icon: 'plus', action: true },
  { id: 'records', label: '创作记录', icon: 'history' },
  { id: 'library', label: '素材库', icon: 'folder' },
  { id: 'persons', label: '真人档案', icon: 'user' },
];
const BRAND_MARK =
  '<svg viewBox="0 0 20 20" width="20" height="20"><rect width="20" height="20" rx="6" fill="currentColor"/><path d="M8 6.3v7.4l6-3.7z" fill="var(--bg-side)"/></svg>';
const NO_KEY = '还没有设置 API Key';

export function App() {
  const visit = useStore('view');
  useStore('boot', 'app');
  const { view } = state;
  const main = useRef<HTMLElement>(null);
  const opened = useRef(new Set<ViewId>(['create'])).current;
  opened.add(view);

  // 每次切换页面（包括再点一次当前页）之后要做的事。
  useEffect(() => {
    // 离开一个页面时停掉它里面正在放的视频和音频，免得声音留在后台。
    for (const media of main.current!.querySelectorAll<HTMLMediaElement>('.view[hidden] :is(video, audio)')) media.pause();
    if (view === 'persons') loadPersons();
    if (view === 'create') {
      main.current!.querySelector('.view-create')!.scrollTo({ top: 0 });
      focusComposer();
    }
  }, [visit]);

  return (
    <>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" dangerouslySetInnerHTML={{ __html: BRAND_MARK }} />
          Seedance Studio
        </div>
        <nav className="nav">
          {VIEWS.map((v) => {
            const current = !v.action && view === v.id;
            return (
              <button key={v.id} className={`nav-item ${v.action ? 'nav-new' : ''} ${current ? 'active' : ''}`} type="button" aria-current={current ? 'page' : undefined} onClick={() => goTo(v.id)}>
                <Icon name={v.icon} />
                <span>{v.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          {/* 设置入口只在缺少 API Key 时带一个提醒点；Key 的具体内容放在设置里看。 */}
          <button className="nav-item" type="button" onClick={openSettings}>
            <Icon name="gear" />
            <span>设置</span>
            {!state.app.hasKey && <span className="dot dot-warn nav-dot" {...tip(NO_KEY)} aria-label={NO_KEY} />}
          </button>
        </div>
      </aside>
      <main ref={main} className="main">
        <div className="view view-create" hidden={view !== 'create'}>
          {state.booted && (
            <>
              <Composer />
              <Recent />
            </>
          )}
        </div>
        <div className="view" hidden={view !== 'records'}>
          {opened.has('records') && <Records />}
        </div>
        <div className="view" hidden={view !== 'library'}>
          {opened.has('library') && <Library />}
        </div>
        <div className="view" hidden={view !== 'persons'}>
          {opened.has('persons') && <Persons />}
        </div>
      </main>
      <LayerHosts />
    </>
  );
}
