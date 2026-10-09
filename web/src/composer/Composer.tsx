// 创作输入框：上面选要生成什么（视频、图片、语音、音效、配乐），框里是素材、提示词和一排工具栏，右下角提交。
// 状态和动作在 state.ts。

import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { state, useStore, KINDS, polishModel, goTo, loadCharacters } from '../store.ts';
import { RES_RANK } from '../request.ts';
import { modelNote, referenceModeLabel } from '../../../shared/models.ts';
import { Icon, type IconName } from '../ui/Icon.tsx';
import { Segmented, Toggle, Dropdown, FormRow, tip, clipTip } from '../ui/controls.tsx';
import { openPopover, openMenu, toast } from '../ui/layers.tsx';
import { enter, enterEach, reducedMotion, useOnChange, EASE_OUT } from '../ui/motion.ts';
import { Thumb, openAssetPicker } from '../assets.tsx';
import { openSettings } from '../settings.tsx';
import { SkillPanel } from '../skills.tsx';
import type { Kind, Ref, VideoForm } from '../types.ts';
import {
  composer, RESOLUTIONS, RATIOS, SR_RESOLUTIONS,
  typeOf, draftPrompt, isGrok, isOpenRouter, traits, availableTypes, capabilities, imageRatios, imageRefLimit, usedAssetIds, refStatus, currentRequest,
  update, setMode, swapFrames, updateSr, updateStudio, setType, typePrompt, polish, undoPolish, submit, registerPrompt,
  voiceName, voiceNote, togglePreview, setVoiceFilter, pickVoice, stopPreview, useCharacter, activeSkill, setSkill,
} from './state.ts';

const SR_SCENES = [
  { value: '', label: '不指定' },
  { value: 'aigc', label: 'AIGC 内容' },
  { value: 'short_series', label: '短剧' },
  { value: 'ugc', label: 'UGC' },
  { value: 'old_film', label: '老片' },
];
const MODES: { value: VideoForm['mode']; label: string; icon: IconName; note: string }[] = [
  { value: 'text', label: '文生视频', icon: 'type', note: '只用文字' },
  { value: 'frames', label: '首尾帧', icon: 'frames', note: '指定首帧，尾帧可选' },
  { value: 'reference', label: '参考生成', icon: 'layers', note: '图片、视频、音频作参考' },
];
// 只能给首帧、不能给尾帧的模型，第二种方式叫「图生视频」。
const FIRST_FRAME_MODE: (typeof MODES)[number] = { value: 'frames', label: '图生视频', icon: 'frames', note: '给一张首帧' };
// 当前模型能用的生成方式。第三种的名字跟着模型走：Seedance 叫「全能参考」，别的模型叫「参考生成」。
function modesFor() {
  const can = traits();
  return [MODES[0], ...(can.frames ? [can.lastFrame ? MODES[1] : FIRST_FRAME_MODE] : []), ...(can.reference ? [{ ...MODES[2], label: referenceModeLabel(composer.form.model) }] : [])];
}
const INPUT_TYPES = [
  { value: 'auto', label: '自动判断', note: '推荐' },
  { value: 'reference', label: 'reference', note: '参考' },
  { value: 'first_last_frame', label: 'first_last_frame', note: '首尾帧' },
];
// 和官方提示词里指代素材的叫法一致：图片1、视频1、音频1。
const REF_PREFIX: Record<Kind, string> = { image: '图片', video: '视频', audio: '音频' };

const IMAGE_COUNTS = [1, 2, 3, 4];
const SFX_DURATIONS = [1, 2, 3, 5, 8, 10, 15, 20];
const SFX_INFLUENCES = [
  { value: '0.3', label: '自由发挥', note: '默认' },
  { value: '0.6', label: '贴近描述' },
  { value: '0.9', label: '严格按描述' },
];

// ---------- 参考素材 ----------

function RefTile({ item, label, onRemove }: { item: Ref; label?: string; onRemove: () => void }) {
  const s = refStatus(item);
  return (
    <div className={`ref-tile tone-${s.tone}`} {...tip(item.name)}>
      <Thumb thumb={item.thumb} kind={item.kind} />
      {label && <span className="ref-index">{label}</span>}
      {!s.ready && <span className={`ref-state ${s.tone === 'error' ? 'is-error' : ''}`}>{s.label}</span>}
      <button className="ref-remove" type="button" aria-label="移除" onClick={onRemove}>
        <Icon name="x" size={10} stroke={2} />
      </button>
    </div>
  );
}

// 一个只放一份素材的格子：有就显示缩略图，没有就是一个「+」。
function Slot({ item, label, onAdd, onRemove }: { item: Ref | null; label: string; onAdd: () => void; onRemove: () => void }) {
  return (
    <div className="frame-slot">
      {item ? (
        <RefTile item={item} onRemove={onRemove} />
      ) : (
        <button className="ref-tile ref-add" type="button" aria-label={`添加${label}`} onClick={onAdd}>
          <Icon name="plus" size={18} />
        </button>
      )}
      <span className="small muted">{label}</span>
    </div>
  );
}

function MediaBlock() {
  const { form, studio } = composer;
  const type = studio.type;
  const imageRefs = type === 'image' ? imageRefLimit() : 0;
  const hidden = !(type === 'music' || (type === 'video' && form.mode !== 'text') || imageRefs > 0);
  let content: ReactNode = null;

  if (hidden) {
    content = null;
  } else if (type === 'image') {
    // 图生图：这个模型收几张参考图，就能加几张。用的是本机的图片，不经过素材库。
    const refs = studio.image.refs || [];
    const setRefs = (next: Ref[]) => updateStudio('image', { refs: next });
    content = (
      <div className="ref-row">
        {refs.map((ref, i) => (
          <RefTile key={ref.uid} item={ref} label={`图片${i + 1}`} onRemove={() => setRefs(refs.filter((r) => r.uid !== ref.uid))} />
        ))}
        {refs.length < imageRefs && (
          <button className="ref-tile ref-add" type="button" aria-label="添加参考图" {...tip('添加参考图，按提示词改这张图')} onClick={() => openAssetPicker({ kind: 'image', local: true, remaining: imageRefs - refs.length, onPick: (ref) => setRefs([...(composer.studio.image.refs || []), ref].slice(0, imageRefs)) })}>
            <Icon name="plus" size={18} />
          </button>
        )}
      </div>
    );
  } else if (type === 'music') {
    const video = studio.music.video;
    const setVideo = (next: Ref | null) => updateStudio('music', { video: next });
    const label = video?.duration ? `要配乐的视频 · ${Math.round(video.duration)} 秒` : '要配乐的视频';
    // 配乐要把视频文件传给模型，所以只能选本机有的：生成记录里的，或者从电脑里选一个。
    content = (
      <div className="frames-row">
        <Slot item={video} label={label} onAdd={() => openAssetPicker({ kind: 'video', local: true, sources: ['records', 'upload'], onPick: setVideo })} onRemove={() => setVideo(null)} />
      </div>
    );
  } else if (form.mode === 'frames') {
    const frame = (key: 'first' | 'last', label: string) => {
      const setRef = (value: Ref | null) => update({ frames: { ...form.frames, [key]: value } });
      return <Slot item={form.frames[key]} label={label} onAdd={() => openAssetPicker({ kind: 'image', remaining: 1, usedIds: usedAssetIds(), local: traits().localFiles, onPick: setRef })} onRemove={() => setRef(null)} />;
    };
    // 有的模型只有首帧。
    content = (
      <div className="frames-row">
        {frame('first', '首帧')}
        {traits().lastFrame && (
          <>
            <button className="frames-swap" type="button" aria-label="互换首帧和尾帧" disabled={!form.frames.first && !form.frames.last} onClick={swapFrames} {...tip('互换首帧和尾帧')}>
              <Icon name="swap" />
            </button>
            {frame('last', '尾帧（可选）')}
          </>
        )}
      </div>
    );
  } else {
    // 这个模型不收的素材类型不让添加；已经加进来的仍然显示，方便移除。
    const allowed = traits().refKinds;
    const kinds = (Object.keys(KINDS) as Kind[]).filter((kind) => allowed.includes(kind) || form.refs[kind].length > 0);
    const setList = (kind: Kind, next: Ref[]) => update({ refs: { ...composer.form.refs, [kind]: next } });
    // 三种素材共用一个「+」，不用先选类型：上传的、选中的是什么就放进哪一类。
    // OpenRouter 上只有图片能加：它的参考视频和音频只收公网链接，本机的文件发不过去，而这里不提供填链接。
    const addable = isOpenRouter() ? allowed.filter((kind) => kind === 'image') : allowed;
    const addRef = () =>
      openAssetPicker({
        limits: Object.fromEntries(addable.map((kind) => [kind, KINDS[kind].max - form.refs[kind].length])),
        usedIds: usedAssetIds(),
        local: isOpenRouter(),
        onPick: (ref) => setList(ref.kind, [...composer.form.refs[ref.kind], ref].slice(0, KINDS[ref.kind].max)),
      });
    const full = addable.every((kind) => form.refs[kind].length >= KINDS[kind].max);
    content = (
      <div className="ref-row">
        {kinds.flatMap((kind) =>
          form.refs[kind].map((ref, i) => <RefTile key={ref.uid} item={ref} label={`${REF_PREFIX[kind]}${i + 1}`} onRemove={() => setList(kind, composer.form.refs[kind].filter((r) => r.uid !== ref.uid))} />),
        )}
        {!full && (
          <button className="ref-tile ref-add" type="button" aria-label="添加参考素材" {...tip(`添加参考素材：${addable.map((kind) => KINDS[kind].label).join('、')}`)} onClick={addRef}>
            <Icon name="plus" size={18} />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="media-block" hidden={hidden}>
      {content}
    </div>
  );
}

// ---------- 工具栏 ----------

// 比例的形状示意：按 "宽:高" 画一个小方框，写不成比例的（自适应）画虚线框。
function RatioShape({ value }: { value: string }) {
  const [w, h] = String(value).split(':').map(Number);
  if (!w || !h) return <span className="ratio-shape ratio-auto" />;
  const scale = 14 / Math.max(w, h);
  return <span className="ratio-shape" style={{ width: Math.max(6, Math.round(w * scale)), height: Math.max(6, Math.round(h * scale)) }} />;
}

// 工具栏上打开一块面板的按钮。面板贴着按钮显示，里面的内容自己跟着状态变。
function PanelButton({ name, label, ariaLabel, className, panel, onClose, children }: { name: string; label: string; ariaLabel?: string; className: string; panel: (close: () => void) => ReactNode; onClose?: () => void; children: ReactNode }) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <button
      ref={ref}
      className="dropdown dropdown-tool"
      type="button"
      data-control={name}
      aria-haspopup="dialog"
      aria-expanded="false"
      aria-label={ariaLabel || label}
      onClick={() => {
        const layer = openPopover(ref.current!, <div className="popover-body">{panel(() => layer?.close())}</div>, { className, label, onClose });
      }}
    >
      {children}
    </button>
  );
}

function VideoToolbar() {
  const { form } = composer;
  const modes = modesFor();
  const can = traits();
  const mode = modes.find((m) => m.value === form.mode) || modes[0];
  const ratio = RATIOS.find((r) => r.value === form.ratio) || RATIOS[0];
  const models = state.models.includes(form.model) ? state.models : [form.model, ...state.models];
  const { durations, autoDuration } = capabilities();
  return (
    <>
      <Dropdown
        key="mode"
        variant="tool"
        control="mode"
        icon={mode.icon}
        label="生成方式"
        value={form.mode}
        options={modes.map((m) => ({ value: m.value, label: m.label, note: m.note }))}
        onChange={(value) => setMode(value as VideoForm['mode'])}
      />
      <Dropdown key="model" variant="tool" control="model" icon="cube" label="模型" value={form.model} options={models.map((m) => ({ value: m, label: m, note: modelNote(m) || undefined }))} onChange={(model) => update({ model })} />
      <PanelButton key="frame" name="frame" label="画面" ariaLabel={`画面：${ratio.label}，${form.resolution}`} className="frame-popover" panel={() => <FramePanel />}>
        <span className="ratio-box">
          <RatioShape value={form.ratio} />
        </span>
        <span>{`${ratio.label} · ${form.resolution}`}</span>
      </PanelButton>
      <Dropdown
        key="duration"
        variant="tool"
        control="duration"
        icon="clock"
        label="时长"
        value={form.durationAuto ? 'auto' : String(form.duration)}
        options={[...durations.map((d) => ({ value: String(d), label: `${d} 秒` })), ...(autoDuration ? [{ value: 'auto', label: '由模型决定', display: '时长自动' }] : [])]}
        onChange={(value) => update(value === 'auto' ? { durationAuto: true } : { durationAuto: false, duration: Number(value) })}
      />
      {/* 「更多」里的设置这个模型一项也用不上时，不显示入口。 */}
      {(can.audio || can.seed || can.seedanceExtras) && (
        <PanelButton key="more" name="more" label="更多设置" className="more-popover" panel={() => <MorePanel />}>
          <Icon name="sliders" />
          <span>更多</span>
        </PanelButton>
      )}
    </>
  );
}

function ImageRatioButton() {
  const ref = useRef<HTMLButtonElement>(null);
  // 只列当前模型收的比例；它一个都不收就不显示这个入口。
  const ratios = imageRatios().map((value) => ({ value, label: value }));
  const ratio = ratios.find((r) => r.value === composer.studio.image.ratio) || ratios[0];
  if (!ratio) return null;
  return (
    <button
      ref={ref}
      className="dropdown dropdown-tool"
      type="button"
      data-control="ratio"
      aria-haspopup="listbox"
      aria-expanded="false"
      aria-label={`画面比例：${ratio.label}`}
      onClick={() => openMenu(ref.current!, { label: '画面比例', items: ratios.map((r) => ({ ...r, selected: r === ratio })), onSelect: (value) => updateStudio('image', { ratio: value }) })}
    >
      <span className="ratio-box">
        <RatioShape value={ratio.value} />
      </span>
      <span>{ratio.label}</span>
    </button>
  );
}

function ImageToolbar() {
  const sub = composer.studio.image;
  const known = state.catalog.image;
  const models = known.includes(sub.model) || !known.length ? known : [sub.model, ...known];
  return (
    <>
      <Dropdown key="image-model" variant="tool" control="model" icon="cube" label="模型" value={sub.model} options={(models.length ? models : [sub.model]).map((m) => ({ value: m, label: m }))} onChange={(model) => updateStudio('image', { model })} />
      <ImageRatioButton key="image-ratio" />
      <Dropdown key="count" variant="tool" control="count" icon="layers" label="数量" value={String(sub.count)} options={IMAGE_COUNTS.map((n) => ({ value: String(n), label: `${n} 张` }))} onChange={(value) => updateStudio('image', { count: Number(value) })} />
    </>
  );
}

function SfxToolbar() {
  const sub = composer.studio.sfx;
  return (
    <>
      <Dropdown
        key="sfx-duration"
        variant="tool"
        control="duration"
        icon="clock"
        label="时长"
        value={String(sub.duration)}
        options={[{ value: 'auto', label: '由模型决定', display: '时长自动' }, ...SFX_DURATIONS.map((d) => ({ value: String(d), label: `${d} 秒` }))]}
        onChange={(duration) => updateStudio('sfx', { duration })}
      />
      <Dropdown key="influence" variant="tool" control="influence" icon="sliders" label="和描述的贴合度" value={String(sub.influence)} options={SFX_INFLUENCES} onChange={(influence) => updateStudio('sfx', { influence })} />
    </>
  );
}

function Toolbar() {
  const { studio } = composer;
  if (studio.type === 'image') return <ImageToolbar />;
  if (studio.type === 'sfx') return <SfxToolbar />;
  if (studio.type === 'music') return <span className="composer-hint">会按画面生成一段和视频一样长的音乐</span>;
  if (studio.type === 'speech') {
    const name = studio.speech.voiceName;
    return (
      <PanelButton name="voice" label="音色" ariaLabel={`音色：${name || '未选择'}`} className="voice-popover" panel={(close) => <VoicePanel close={close} />} onClose={stopPreview}>
        <Icon name="user" />
        <span>{name || '选择音色'}</span>
      </PanelButton>
    );
  }
  return <VideoToolbar />;
}

// 「画面」面板：比例和分辨率放在一起。
function FramePanel() {
  useStore('composer');
  const { form } = composer;
  const { resolutions: allowed, ratios } = capabilities();
  // Flatkey 的模型固定列三档，不支持的那档变灰；OpenRouter 各模型的档位差别大（768p、2K、4K），直接列它支持的。
  const resolutions = isOpenRouter() ? allowed : RESOLUTIONS;
  return (
    <>
      <div className="popover-title">画面比例</div>
      <div className="ratio-grid" role="radiogroup" aria-label="画面比例">
        {RATIOS.map((r) => (
          <button key={r.value} type="button" className={`ratio-option ${form.ratio === r.value ? 'active' : ''}`} role="radio" aria-checked={form.ratio === r.value} disabled={!ratios.includes(r.value)} onClick={() => update({ ratio: r.value })}>
            <span className="ratio-box">
              <RatioShape value={r.value} />
            </span>
            <span>{r.label}</span>
          </button>
        ))}
      </div>
      <div className="popover-title">分辨率</div>
      <Segmented options={resolutions.map((r) => ({ value: r, label: r, disabled: !allowed.includes(r) }))} value={form.resolution} onChange={(resolution) => update({ resolution })} />
      {!isOpenRouter() && allowed.length < RESOLUTIONS.length && <div className="small muted">{form.model} 不支持 1080p</div>}
      {(isGrok() || isOpenRouter()) && form.mode === 'frames' && <div className="small muted">有首帧时，画面比例跟着首帧走</div>}
    </>
  );
}

// 面板里的数字输入框。值由用户打字决定，所以只给初始值，不在重画时覆盖。
function NumberInput({ value, onInput, inputRef, ...attrs }: { value: string | number; onInput: (value: string) => void; inputRef?: React.Ref<HTMLInputElement> } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onInput' | 'value'>) {
  return <input ref={inputRef} className="input" type="number" inputMode="numeric" defaultValue={String(value ?? '')} onInput={(e) => onInput(e.currentTarget.value)} {...attrs} />;
}

// 「更多」面板：不常改的设置都收在这里。
function MorePanel() {
  useStore('composer');
  const { form } = composer;
  const can = traits();
  const seedInput = useRef<HTMLInputElement>(null);
  const randomSeed = () => {
    const seed = String(Math.floor(Math.random() * 2147483647));
    seedInput.current!.value = seed;
    update({ seed });
  };
  return (
    <>
      {(can.audio || can.seedanceExtras) && <div className="popover-title">输出</div>}
      {can.audio && (
        <FormRow label="生成有声视频" desc="同时生成与画面同步的声音">
          <Toggle checked={form.generateAudio} onChange={(generateAudio) => update({ generateAudio })} label="生成有声视频" />
        </FormRow>
      )}
      {can.seedanceExtras && (
        <FormRow label="水印">
          <Toggle checked={form.watermark} onChange={(watermark) => update({ watermark })} label="水印" />
        </FormRow>
      )}
      {(can.seed || can.seedanceExtras) && <div className="popover-title">高级</div>}
      {can.seed && (
        <FormRow label="随机种子">
          <div className="row">
            <NumberInput inputRef={seedInput} value={form.seed} onInput={(seed) => update({ seed })} placeholder="留空则每次随机" step="1" aria-label="随机种子" />
            <button className="btn" type="button" onClick={randomSeed}>
              随机
            </button>
          </div>
        </FormRow>
      )}
      {can.seedanceExtras && <SeedanceExtras />}
    </>
  );
}

// 只有 Flatkey 上的 Seedance 才有的几项：联网搜索、输入模式、超分。
function SeedanceExtras() {
  const { form } = composer;
  const sr = form.sr;
  return (
    <>
      <FormRow label="联网搜索" desc="让任务先联网检索相关信息">
        <Toggle checked={form.webSearch} onChange={(webSearch) => update({ webSearch })} label="联网搜索" />
      </FormRow>
      <FormRow label="输入模式">
        <Dropdown label="输入模式" value={form.inputType} options={INPUT_TYPES} onChange={(inputType) => update({ inputType })} />
      </FormRow>
      <FormRow label="画质超分" desc="生成后再提升分辨率或帧率">
        <Toggle checked={sr.enabled} onChange={(enabled) => updateSr({ enabled })} label="画质超分" />
      </FormRow>
      {sr.enabled && (
        <div className="sub-panel">
          <FormRow label="目标">
            <Segmented
              options={[
                { value: 'resolution', label: '目标分辨率' },
                { value: 'limit', label: '短边像素' },
              ]}
              value={sr.by}
              onChange={(by) => updateSr({ by })}
            />
          </FormRow>
          {sr.by === 'resolution' ? (
            <FormRow label="目标分辨率" desc="必须高于原始分辨率">
              <Segmented options={SR_RESOLUTIONS.map((r) => ({ value: r, label: r.toUpperCase().replace('P', 'p'), disabled: RES_RANK[r] <= RES_RANK[form.resolution] }))} value={sr.resolution} onChange={(resolution) => updateSr({ resolution })} />
            </FormRow>
          ) : (
            <FormRow label="短边像素">
              <NumberInput value={sr.limit} onInput={(limit) => updateSr({ limit })} min="64" max="2160" step="1" placeholder="64 – 2160" aria-label="短边像素" />
            </FormRow>
          )}
          <FormRow label="场景">
            <Dropdown label="场景" value={sr.scene} options={SR_SCENES} onChange={(scene) => updateSr({ scene })} />
          </FormRow>
          <FormRow label="超分模式">
            <Segmented
              options={[
                { value: 'standard', label: '标准' },
                { value: 'professional', label: '专业' },
              ]}
              value={sr.tool}
              onChange={(tool) => updateSr({ tool })}
            />
          </FormRow>
          <FormRow label="输出帧率">
            <NumberInput value={sr.fps} onInput={(fps) => updateSr({ fps })} min="1" max="120" step="1" placeholder="不改（1 – 120）" aria-label="输出帧率" />
          </FormRow>
        </div>
      )}
    </>
  );
}

// 「音色」面板：按语言筛一下，每个音色可以先试听再选。
function VoicePanel({ close }: { close: () => void }) {
  useStore('composer');
  if (!state.voices) return <div className="empty small-empty">{composer.voicesError ? `读取音色失败：${composer.voicesError}` : '正在读取音色…'}</div>;
  const match = { all: () => true, zh: (language: string) => language === 'zh', en: (language: string) => language === 'en', other: (language: string) => language !== 'zh' && language !== 'en' };
  // 有的平台只给音色的名字，不知道是什么语言，这时不显示按语言筛选的那一排。
  const languages = state.voices.some((voice) => voice.language);
  return (
    <>
      {/* 没有筛选的那一排时，补一个和其他菜单一样的小标题。 */}
      {!languages && <div className="popover-title voice-title">音色</div>}
      {languages && <Segmented
        options={[
          { value: 'all', label: '全部' },
          { value: 'zh', label: '中文' },
          { value: 'en', label: '英语' },
          { value: 'other', label: '其他' },
        ]}
        value={composer.voiceFilter}
        onChange={setVoiceFilter}
      />}
      <div className="voice-list" role="listbox" aria-label="音色">
        {state.voices
          .filter((voice) => !languages || match[composer.voiceFilter](voice.language))
          .map((voice) => {
            const selected = voice.id === composer.studio.speech.voiceId;
            return (
              <div key={voice.id} className={`voice-row ${selected ? 'selected' : ''}`}>
                <button
                  className="voice-pick"
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => {
                    pickVoice(voice);
                    close();
                  }}
                >
                  <span className="voice-name">{voiceName(voice)}</span>
                  <span className="voice-note ellipsis" {...clipTip(voiceNote(voice))}>
                    {voiceNote(voice)}
                  </span>
                </button>
                {voice.previewUrl && (
                  <button className="entry-action-btn" type="button" onClick={() => togglePreview(voice)}>
                    {composer.previewing === voice.id ? '停止' : '试听'}
                  </button>
                )}
                <span className="menu-item-check">{selected && <Icon name="check" size={14} />}</span>
              </div>
            );
          })}
      </div>
    </>
  );
}

// 右下角：润色（有提示词的类型才有）和发送键。发送键不能提交时变淡，鼠标停上去或点一下都会说明原因。
// 输入框右下角的「角色」：点开是一张清单，选中就把这个角色的参考图带进输入框。清单每次点开时现读，在别的页面刚存的也在里面。
const MANAGE = '__manage';

async function pickCharacter(button: HTMLElement, type: 'image' | 'video') {
  const list = await loadCharacters().catch(() => []);
  const usable = list.filter((c) => c.images.length);
  openMenu(button, {
    label: '角色',
    align: 'end',
    items: [...usable.map((c) => ({ value: c.id, label: c.name, note: `${c.images.length} 张图` })), { value: MANAGE, label: usable.length ? '管理角色' : '新建角色' }],
    onSelect: (value) => {
      const character = usable.find((c) => c.id === value);
      if (!character) return goTo('characters');
      try {
        useCharacter(character, type);
        toast(`已带上「${character.name}」的参考图`, 'success');
      } catch (err) {
        toast((err as Error).message, 'error', 6000);
      }
    },
  });
}

function SendArea() {
  if (!state.app.hasKey) {
    return (
      <button className="btn btn-primary btn-sm" type="button" onClick={openSettings}>
        设置 API Key
      </button>
    );
  }
  const type = typeOf();
  const blocked = currentRequest().problems[0] || '';
  const { beforePolish, polishing, submitting, submitError } = composer;
  const canSkill = type.value === 'image' || type.value === 'video';
  const skill = activeSkill();
  return (
    <>
      {(type.value === 'image' || type.value === 'video') && (
        <button key="character" className="entry-action-btn" type="button" data-control="character" aria-haspopup="menu" aria-expanded="false" {...tip('带上角色库里一个角色的参考图')} onClick={(e) => pickCharacter(e.currentTarget, type.value as 'image' | 'video')}>
          角色
        </button>
      )}
      {canSkill && (
        <button
          key="skill"
          className={`entry-action-btn ${skill ? 'active' : ''}`}
          type="button"
          data-control="skill"
          aria-haspopup="dialog"
          aria-expanded="false"
          {...tip('选一套写提示词的规则，只写一句话，发送时帮你扩写')}
          onClick={(e) => {
            const layer = openPopover(e.currentTarget, <div className="popover-body">{<SkillPanel close={() => layer?.close()} />}</div>, { className: 'skill-popover', label: '技能', align: 'end' });
          }}
        >
          <Icon name="wand" />
          技能
        </button>
      )}
      {/* 选了技能就不再润色：两件事都是让文本模型改写提示词。 */}
      {type.polish &&
        !skill &&
        state.catalog.polish.length > 0 &&
        (beforePolish !== null ? (
          <button key="undo" className="entry-action-btn" type="button" data-control="polish" onClick={undoPolish}>
            撤销润色
          </button>
        ) : (
          <button key="polish" className="entry-action-btn" type="button" data-control="polish" {...tip(`让 ${polishModel()} 把提示词补充得更具体`)} disabled={polishing} onClick={polish}>
            {polishing && <span className="spinner" />}
            润色
          </button>
        ))}
      <button key="send" className={`send-btn ${blocked ? 'blocked' : ''}`} type="button" {...tip(blocked || submitError || `${type.action}（⌘ Enter）`)} aria-label={type.action} aria-disabled={blocked ? 'true' : undefined} disabled={submitting} onClick={submit}>
        <span className="icon-swap">
          <Icon name="arrowUp" size={18} shown={!submitting} />
          <span className="spinner" data-shown={submitting ? '' : undefined} />
        </span>
      </button>
    </>
  );
}

export function Composer() {
  useStore('composer', 'app');
  const { studio } = composer;
  const type = typeOf();
  const text = draftPrompt();
  const skill = activeSkill();
  const prompt = useRef<HTMLTextAreaElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const types = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const params = useRef<HTMLDivElement>(null);
  const resizing = useRef<Animation | null>(null);
  const settledHeight = useRef(0);

  // 文本框里的字由用户打，不由这里逐字回写；只有换类型、润色、复用这些从外面改了文字的时候才写回去。
  // 高度跟着内容长，最高 280。
  useLayoutEffect(() => {
    const el = prompt.current!;
    if (el.value !== text) el.value = text;
    el.style.height = 'auto';
    el.style.height = `${Math.min(280, Math.max(72, el.scrollHeight))}px`;
  });
  useEffect(() => {
    registerPrompt(prompt.current);
    return () => registerPrompt(null);
  }, []);

  // 打开页面时：问句、类型切换、输入框依次进场。
  useLayoutEffect(() => {
    enter(title.current, { y: 12, blur: 4, duration: 420 });
    enter(types.current, { y: 12, duration: 420, delay: 90 });
    enter(card.current, { y: 12, duration: 420, delay: 180 });
  }, []);

  // 换了一种内容：问句换一句，工具栏的入口依次出现。
  useOnChange(studio.type, () => {
    enter(title.current, { y: 6, blur: 3, duration: 200 });
    enterEach(params.current!.children, { y: 4, duration: 180, stagger: 30 });
  });

  // 类型、生成方式、模型家族变了，输入框里的东西就不一样高。高度滑过去，下面的记录跟着挪，不是跳一下。
  // 只管这几种变化：打字撑高文本框时不做动效。
  const shape = `${studio.type}:${composer.form.mode}:${modesFor().length}:${traits().lastFrame}:${studio.type === 'image' && imageRefLimit() > 0}:${Boolean(skill)}`;
  useLayoutEffect(() => {
    const el = card.current!;
    // 上一次还没滑完就又变了，从现在停着的高度接着滑。
    const from = resizing.current?.playState === 'running' ? el.offsetHeight : settledHeight.current;
    resizing.current?.cancel();
    const to = el.offsetHeight;
    if (!from) return;
    enter(el.querySelector('.media-block:not([hidden])'), { y: 4, duration: 200 });
    if (Math.abs(to - from) > 1 && !reducedMotion()) resizing.current = el.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 240, easing: EASE_OUT });
  }, [shape]);
  useLayoutEffect(() => {
    if (resizing.current?.playState !== 'running') settledHeight.current = card.current!.offsetHeight;
  });

  // 读到模型列表后，账号用不了的类型不能选。
  const { known, image, audio } = state.catalog;
  const missing: Record<string, boolean> = { image: known && !image.length, speech: known && !audio.speech, sfx: known && !audio.sfx, music: known && !audio.music };

  return (
    <section className="composer">
      <h1 ref={title} className="composer-title">
        {type.title}
      </h1>
      {/* 平台上只有视频一种时，不用选类型。 */}
      <div ref={types} className="composer-types" hidden={availableTypes().length < 2}>
        <Segmented
          options={availableTypes().map((t) => ({ value: t.value, label: t.label, disabled: missing[t.value] && t.value !== studio.type, title: missing[t.value] ? '这个账号没有对应的模型' : null }))}
          value={studio.type}
          onChange={setType}
          className="type-switch"
        />
      </div>
      <div ref={card} className="composer-card">
        <MediaBlock />
        {/* 选着的技能：一个小标签，在提示词上面。点叉取消。 */}
        {skill && (
          <div className="skill-chip-row">
            <span className="skill-chip">
              <Icon name="wand" />
              <span className="ellipsis">{skill.name}</span>
              <button type="button" aria-label={`取消技能「${skill.name}」`} onClick={() => setSkill(null)}>
                <Icon name="x" size={12} stroke={2} />
              </button>
            </span>
          </div>
        )}
        <textarea
          ref={prompt}
          className="prompt"
          rows={3}
          defaultValue={text}
          hidden={!type.placeholder}
          placeholder={skill ? '写一句简单的话就行，发送时会按技能的规则扩写成完整的提示词' : type.placeholder || ''}
          aria-label={type.value === 'speech' ? '要朗读的文字' : '提示词'}
          onInput={(e) => typePrompt(e.currentTarget.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              if (state.app.hasKey && !composer.submitting) submit();
            }
          }}
        />
        <div className="composer-bar">
          <div ref={params} className="composer-params">
            <Toolbar />
          </div>
          <div className="composer-send">
            <SendArea />
          </div>
        </div>
      </div>
    </section>
  );
}
