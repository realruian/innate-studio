// 视频和音频的播放器。不用浏览器自带的播放控件（它的样式和菜单由浏览器决定，和界面不是一套）。
// 视频：控制条有播放/暂停、时间、进度、静音、全屏，鼠标移到画面上才出现。下载在卡片的「更多」里，不放进播放器。
// clickToPlay 为 false 时点画面不播放：创作记录的卡片里，点画面是打开详情，播放只走播放键。
// 音频：没有画面，所以是一块写着内容的面板，下面一行播放键、时间和进度，一直显示。

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { Icon, IconSwap } from './ui/Icon.tsx';
import { exclusive } from './playback.ts';

const clock = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
};

// 播放键、时间、进度条这一套的行为，视频和音频共用。root 是整个播放器，用来判断它还在不在页面上。
// 进度和时间每一帧都在变，直接写到节点上，不走组件重画。
function useMediaControls(media: RefObject<HTMLMediaElement | null>, root: RefObject<HTMLElement | null>) {
  const [playing, setPlaying] = useState(false);
  const time = useRef<HTMLSpanElement>(null);
  const fill = useRef<HTMLDivElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const duration = () => (media.current && Number.isFinite(media.current.duration) ? media.current.duration : 0);

  function paint() {
    const el = media.current;
    if (!el || !fill.current || !time.current || !track.current) return;
    const total = duration();
    const ratio = total ? Math.min(1, el.currentTime / total) : 0;
    fill.current.style.width = `${ratio * 100}%`;
    time.current.textContent = `${clock(el.currentTime)} / ${clock(total)}`;
    track.current.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  }

  function toggle() {
    const el = media.current;
    if (!el) return;
    if (el.paused) el.play().catch(() => {});
    else el.pause();
  }

  function seekTo(clientX: number) {
    const rect = rail.current!.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    if (duration()) media.current!.currentTime = ratio * duration();
    paint();
  }

  useEffect(() => {
    const el = media.current!;
    // 播放时逐帧刷新进度，暂停或被移出页面后停止。
    let frame = 0;
    const follow = () => {
      paint();
      if (root.current?.isConnected && !el.paused) frame = requestAnimationFrame(follow);
    };
    const onPlay = () => {
      setPlaying(true);
      cancelAnimationFrame(frame);
      follow();
    };
    const onPause = () => {
      setPlaying(false);
      cancelAnimationFrame(frame);
      paint();
    };
    const release = exclusive(el);
    const painted = ['loadedmetadata', 'durationchange', 'seeked', 'timeupdate'];
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    for (const name of painted) el.addEventListener(name, paint);
    if (!el.paused) onPlay();
    return () => {
      cancelAnimationFrame(frame);
      release();
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
      for (const name of painted) el.removeEventListener(name, paint);
    };
  }, []);

  const trackProps = {
    ref: track,
    role: 'slider',
    tabIndex: 0,
    'aria-label': '播放进度',
    'aria-valuemin': 0,
    'aria-valuemax': 100,
    'aria-valuenow': 0,
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragging.current = true;
      seekTo(e.clientX);
    },
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
      if (dragging.current) seekTo(e.clientX);
    },
    onPointerUp: () => {
      dragging.current = false;
    },
    onPointerCancel: () => {
      dragging.current = false;
    },
    onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const step = Math.max(1, duration() / 20);
      media.current!.currentTime = Math.min(duration(), Math.max(0, media.current!.currentTime + (e.key === 'ArrowRight' ? step : -step)));
      paint();
    },
  };

  return { playing, toggle, time, fill, rail, trackProps };
}

interface VideoPlayerProps {
  src?: string;
  autoplay?: boolean;
  label?: string;
  clickToPlay?: boolean;
  // 画框是固定比例时传它（记录卡片是 16:9）。
  frameRatio?: number | null;
  // 给视频配的那段音乐的地址。传了它，视频自己的声音关掉，播放、暂停、拖动时这段音乐跟着画面走，静音键管的也是它。
  soundtrack?: string | null;
}

export function VideoPlayer({ src, autoplay = false, label = '视频', clickToPlay = true, frameRatio = null, soundtrack = null }: VideoPlayerProps) {
  const root = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const music = useRef<HTMLAudioElement>(null);
  const { playing, toggle, time, fill, rail, trackProps } = useMediaControls(video, root);
  const [muted, setMutedState] = useState(false);
  const [cover, setCover] = useState(false);

  function setMuted(next: boolean) {
    (music.current || video.current!).muted = next;
    setMutedState(next);
  }

  function toggleFullscreen() {
    if (document.fullscreenElement === root.current) document.exitFullscreen?.();
    else root.current?.requestFullscreen?.().catch(() => {});
  }

  useEffect(() => {
    const picture = video.current!;
    const sound = music.current;
    if (!sound) return;
    const align = () => {
      if (Math.abs(sound.currentTime - picture.currentTime) > 0.25) sound.currentTime = picture.currentTime;
    };
    const onPlay = () => {
      align();
      sound.play().catch(() => {});
    };
    const onPause = () => sound.pause();
    picture.addEventListener('play', onPlay);
    picture.addEventListener('pause', onPause);
    // 画面循环回到开头、或者被拖动时，音乐跟过去。
    picture.addEventListener('seeked', align);
    if (!picture.paused) onPlay();
    return () => {
      picture.removeEventListener('play', onPlay);
      picture.removeEventListener('pause', onPause);
      picture.removeEventListener('seeked', align);
    };
  }, [soundtrack]);

  return (
    <div ref={root} className="player" role="group" aria-label={label}>
      <video
        ref={video}
        className={`player-video${cover ? ' cover' : ''}`}
        src={src}
        preload="metadata"
        playsInline
        loop
        autoPlay={autoplay}
        muted={Boolean(soundtrack)}
        disablePictureInPicture
        onClick={clickToPlay ? toggle : undefined}
        // 视频比例和画框差不多就铺满画框，不然边上会露出一线黑底；
        // 差得多（比如竖屏视频）就完整显示、两边留黑，不去裁画面。
        onLoadedMetadata={frameRatio ? (e) => setCover(Math.abs(e.currentTarget.videoWidth / e.currentTarget.videoHeight / frameRatio - 1) < 0.03) : undefined}
      />
      {soundtrack && <audio ref={music} src={soundtrack} preload="auto" />}
      <div className="player-bar">
        <button className="player-btn" type="button" aria-label={playing ? '暂停' : '播放'} onClick={toggle}>
          <IconSwap icons={['play', 'pause']} show={playing ? 'pause' : 'play'} />
        </button>
        <span ref={time} className="player-time">
          0:00 / 0:00
        </span>
        <div className="player-track" {...trackProps}>
          <div ref={rail} className="player-rail">
            <div ref={fill} className="player-fill" />
          </div>
        </div>
        <button className="player-btn" type="button" aria-label={muted ? '取消静音' : '静音'} onClick={() => setMuted(!muted)}>
          <IconSwap icons={['volume', 'mute']} show={muted ? 'mute' : 'volume'} />
        </button>
        <button className="player-btn" type="button" aria-label="全屏" onClick={toggleFullscreen}>
          <Icon name="expand" size={16} />
        </button>
      </div>
    </div>
  );
}

// kind 是这段声音的来历（比如"语音 · Anson"），text 是它的内容（朗读的文字、音效的描述）。
export function AudioPlayer({ src, kind, text, label = '音频' }: { src?: string; kind?: string; text?: string; label?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const { playing, toggle, time, fill, rail, trackProps } = useMediaControls(audio, root);
  return (
    <div ref={root} className="audio-player" role="group" aria-label={label}>
      <audio ref={audio} src={src} preload="metadata" />
      <div className="audio-face">
        {kind && <div className="audio-kind">{kind}</div>}
        {text && <div className="audio-text">{text}</div>}
      </div>
      <div className="audio-controls">
        <button className="audio-play" type="button" aria-label={playing ? '暂停' : '播放'} onClick={toggle}>
          <IconSwap icons={['play', 'pause']} show={playing ? 'pause' : 'play'} />
        </button>
        <span ref={time} className="audio-time">
          0:00 / 0:00
        </span>
        <div className="audio-track" {...trackProps}>
          <div ref={rail} className="audio-rail">
            <div ref={fill} className="audio-fill" />
          </div>
        </div>
      </div>
    </div>
  );
}
