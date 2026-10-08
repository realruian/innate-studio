// 视频和音频的播放器。不用浏览器自带的播放控件（它的样式和菜单由浏览器决定，和界面不是一套）。
// 视频：控制条有播放/暂停、时间、进度、静音、全屏，鼠标移到画面上才出现。下载在卡片的「更多」里，不放进播放器。
// clickToPlay 为 false 时点画面不播放：创作记录的卡片里，点画面是打开详情，播放只走播放键。
// 音频：没有画面，所以是一块写着内容的面板，下面一行播放键、时间和进度，一直显示。

import { h, icon } from './dom.js';

const clock = (seconds) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
};

// 播放键、时间、进度条这一套的行为，视频和音频共用。root 是整个播放器，用来判断它还在不在页面上。
function wireControls(media, { root, playButton, time, fill, rail, track }) {
  const duration = () => (Number.isFinite(media.duration) ? media.duration : 0);

  function paint() {
    const total = duration();
    const ratio = total ? Math.min(1, media.currentTime / total) : 0;
    fill.style.width = `${ratio * 100}%`;
    time.textContent = `${clock(media.currentTime)} / ${clock(total)}`;
    track.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  }

  function toggle() {
    if (media.paused) media.play().catch(() => {});
    else media.pause();
  }

  function seekTo(clientX) {
    const rect = rail.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    if (duration()) media.currentTime = ratio * duration();
    paint();
  }

  // 播放时逐帧刷新进度，暂停或被移出页面后停止。
  let frame = 0;
  const follow = () => {
    paint();
    if (root.isConnected && !media.paused) frame = requestAnimationFrame(follow);
  };
  media.addEventListener('play', () => {
    playButton.replaceChildren(icon('pause', 16));
    playButton.setAttribute('aria-label', '暂停');
    cancelAnimationFrame(frame);
    follow();
  });
  media.addEventListener('pause', () => {
    playButton.replaceChildren(icon('play', 16));
    playButton.setAttribute('aria-label', '播放');
    cancelAnimationFrame(frame);
    paint();
  });
  for (const name of ['loadedmetadata', 'durationchange', 'seeked', 'timeupdate']) media.addEventListener(name, paint);
  playButton.addEventListener('click', toggle);

  let dragging = false;
  track.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    track.setPointerCapture(e.pointerId);
    dragging = true;
    seekTo(e.clientX);
  });
  track.addEventListener('pointermove', (e) => dragging && seekTo(e.clientX));
  const release = () => {
    dragging = false;
  };
  track.addEventListener('pointerup', release);
  track.addEventListener('pointercancel', release);
  track.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const step = Math.max(1, duration() / 20);
    media.currentTime = Math.min(duration(), Math.max(0, media.currentTime + (e.key === 'ArrowRight' ? step : -step)));
    paint();
  });

  return { toggle };
}

const sliderTrack = (rail, cls) => h('div', { class: cls, role: 'slider', tabindex: '0', 'aria-label': '播放进度', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, rail);

// soundtrack：给视频配的那段音乐的地址。传了它，视频自己的声音关掉，播放、暂停、拖动时这段音乐跟着画面走，静音键管的也是它。
export function videoPlayer({ src, autoplay = false, label = '视频', clickToPlay = true, frameRatio = null, soundtrack = null }) {
  const video = h('video', { class: 'player-video', src, preload: 'metadata', playsinline: true, loop: true, autoplay, muted: Boolean(soundtrack), disablepictureinpicture: true });
  const music = soundtrack ? h('audio', { src: soundtrack, preload: 'auto' }) : null;
  const sound = music || video;
  const playButton = h('button', { class: 'player-btn', type: 'button', 'aria-label': '播放' }, icon('play', 16));
  const muteButton = h('button', { class: 'player-btn', type: 'button', 'aria-label': '静音', onClick: () => setMuted(!sound.muted) }, icon('volume', 16));
  const fullButton = h('button', { class: 'player-btn', type: 'button', 'aria-label': '全屏', onClick: () => toggleFullscreen() }, icon('expand', 16));
  const time = h('span', { class: 'player-time' }, '0:00 / 0:00');
  const fill = h('div', { class: 'player-fill' });
  const rail = h('div', { class: 'player-rail' }, fill);
  const track = sliderTrack(rail, 'player-track');
  const root = h('div', { class: 'player', role: 'group', 'aria-label': label }, video, music, h('div', { class: 'player-bar' }, playButton, time, track, muteButton, fullButton));

  const { toggle } = wireControls(video, { root, playButton, time, fill, rail, track });

  function setMuted(muted) {
    sound.muted = muted;
    muteButton.replaceChildren(icon(muted ? 'mute' : 'volume', 16));
    muteButton.setAttribute('aria-label', muted ? '取消静音' : '静音');
  }

  function toggleFullscreen() {
    if (document.fullscreenElement === root) document.exitFullscreen?.();
    else root.requestFullscreen?.().catch(() => {});
  }

  if (music) {
    const align = () => {
      if (Math.abs(music.currentTime - video.currentTime) > 0.25) music.currentTime = video.currentTime;
    };
    video.addEventListener('play', () => {
      align();
      music.play().catch(() => {});
    });
    video.addEventListener('pause', () => music.pause());
    // 画面循环回到开头、或者被拖动时，音乐跟过去。
    video.addEventListener('seeked', align);
  }

  if (clickToPlay) video.addEventListener('click', toggle);
  // 画框是固定比例时（记录卡片是 16:9）：视频比例和它差不多就铺满画框，不然边上会露出一线黑底；
  // 差得多（比如竖屏视频）就完整显示、两边留黑，不去裁画面。
  if (frameRatio) {
    video.addEventListener('loadedmetadata', () => {
      const own = video.videoWidth / video.videoHeight;
      video.classList.toggle('cover', Math.abs(own / frameRatio - 1) < 0.03);
    });
  }

  return root;
}

// kind 是这段声音的来历（比如"语音 · Anson"），text 是它的内容（朗读的文字、音效的描述）。
export function audioPlayer({ src, kind, text, label = '音频' }) {
  const audio = h('audio', { src, preload: 'metadata' });
  const playButton = h('button', { class: 'audio-play', type: 'button', 'aria-label': '播放' }, icon('play', 16));
  const time = h('span', { class: 'audio-time' }, '0:00 / 0:00');
  const fill = h('div', { class: 'audio-fill' });
  const rail = h('div', { class: 'audio-rail' }, fill);
  const track = sliderTrack(rail, 'audio-track');
  const root = h(
    'div',
    { class: 'audio-player', role: 'group', 'aria-label': label },
    audio,
    h('div', { class: 'audio-face' }, kind && h('div', { class: 'audio-kind' }, kind), text && h('div', { class: 'audio-text' }, text)),
    h('div', { class: 'audio-controls' }, playButton, time, track),
  );
  wireControls(audio, { root, playButton, time, fill, rail, track });
  return root;
}
