// 整个页面：侧边栏（导航和设置）和七个页面。页面第一次打开时才画，之后切走只是藏起来。

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
import { Projects } from './canvas/Projects.tsx';
import { Characters } from './characters.tsx';
import { Skills } from './skills.tsx';
import { openSettings } from './settings.tsx';
import type { ViewId } from './types.ts';

// 七项是同一层的页签。「创造」是首页，在首页再点一次会回到顶部并把光标放回输入框。
// 素材库和真人档案是 Flatkey 才有的，feature 写着它们各自要平台支持哪一项，平台不支持就不显示。
// 侧栏的图标线宽是 2，比别处的 1.5 粗一档。
// Sparkle 在库里画得比别的图标小一圈（只占画布中间六成），所以放大到 22 显示，线条相应调细，看上去和其他几项一样大、一样粗。
const VIEWS: { id: ViewId; label: string; icon: IconName; size?: number; stroke?: number; feature?: 'library' | 'persons' }[] = [
  { id: 'create', label: '创造', icon: 'sparkle', size: 22, stroke: 1.45 },
  { id: 'canvas', label: '画布', icon: 'workflow' },
  { id: 'records', label: '创作记录', icon: 'history' },
  { id: 'characters', label: '角色', icon: 'userStory' },
  { id: 'skills', label: '技能', icon: 'wandSparkles' },
  { id: 'library', label: '素材库', icon: 'folderLibrary', feature: 'library' },
  { id: 'persons', label: '真人档案', icon: 'userCircle', feature: 'persons' },
];
const NAV_STROKE = 2;
const NO_KEY = '未配置 API Key';

export function App() {
  const visit = useStore('view');
  useStore('boot', 'app', 'immersive');
  const views = VIEWS.filter((v) => !v.feature || state.app.features[v.feature]);
  // 正开着的页面在换平台之后没有了，就回到创作页。
  const view = views.some((v) => v.id === state.view) ? state.view : 'create';
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
      {/* 进了一张画布之后侧栏收起，靠画布左上角的返回键出来。 */}
      <aside className="sidebar" hidden={state.immersive && view === 'canvas'}>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-word" role="img" aria-label="INNATE" />
        </div>
        <nav className="nav">
          {views.map((v) => {
            const current = view === v.id;
            return (
              <button key={v.id} className={`nav-item ${current ? 'active' : ''}`} type="button" aria-current={current ? 'page' : undefined} onClick={() => goTo(v.id)}>
                <Icon name={v.icon} size={v.size} stroke={v.stroke ?? NAV_STROKE} />
                <span>{v.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          {/* 设置入口只在缺少 API Key 时带一个提醒点；Key 的具体内容放在设置里看。 */}
          <button className="nav-item" type="button" onClick={openSettings}>
            <Icon name="gear" stroke={NAV_STROKE} />
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
        <div className="view view-canvas" hidden={view !== 'canvas'}>
          {opened.has('canvas') && state.booted && <Projects />}
        </div>
        <div className="view" hidden={view !== 'records'}>
          {opened.has('records') && <Records />}
        </div>
        <div className="view" hidden={view !== 'characters'}>
          {opened.has('characters') && <Characters />}
        </div>
        <div className="view" hidden={view !== 'skills'}>
          {opened.has('skills') && <Skills />}
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
