// 视频播放器。不用浏览器自带的播放控件（它的样式和菜单由浏览器决定，和界面不是一套）。
// 控制条：播放/暂停、时间、进度、静音、全屏，鼠标移到画面上才出现。下载在卡片的「更多」里，不放进播放器。
// clickToPlay 为 false 时点画面不播放：创作记录的卡片里，点画面是打开详情，播放只走播放键。

import { h, icon } from './dom.js';

const clock = (seconds) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
};

export function videoPlayer({ src, autoplay = false, label = '视频', clickToPlay = true }) {
  const video = h('video', { class: 'player-video', src, preload: 'metadata', playsinline: true, loop: true, autoplay, disablepictureinpicture: true });
  const playButton = h('button', { class: 'player-btn', type: 'button', 'aria-label': '播放', onClick: () => toggle() }, icon('play', 16));
  const muteButton = h('button', { class: 'player-btn', type: 'button', 'aria-label': '静音', onClick: () => setMuted(!video.muted) }, icon('volume', 16));
  const fullButton = h('button', { class: 'player-btn', type: 'button', 'aria-label': '全屏', onClick: () => toggleFullscreen() }, icon('expand', 16));
  const time = h('span', { class: 'player-time' }, '0:00 / 0:00');
  const fill = h('div', { class: 'player-fill' });
  const rail = h('div', { class: 'player-rail' }, fill);
  const track = h('div', { class: 'player-track', role: 'slider', tabindex: '0', 'aria-label': '播放进度', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, rail);
  const root = h(
    'div',
    { class: 'player', role: 'group', 'aria-label': label },
    video,
    h('div', { class: 'player-bar' }, playButton, time, track, muteButton, fullButton),
  );

  const duration = () => (Number.isFinite(video.duration) ? video.duration : 0);

  function paint() {
    const total = duration();
    const ratio = total ? Math.min(1, video.currentTime / total) : 0;
    fill.style.width = `${ratio * 100}%`;
    time.textContent = `${clock(video.currentTime)} / ${clock(total)}`;
    track.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  }

  function toggle() {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }

  function setMuted(muted) {
    video.muted = muted;
    muteButton.replaceChildren(icon(muted ? 'mute' : 'volume', 16));
    muteButton.setAttribute('aria-label', muted ? '取消静音' : '静音');
  }

  function toggleFullscreen() {
    if (document.fullscreenElement === root) document.exitFullscreen?.();
    else root.requestFullscreen?.().catch(() => {});
  }

  function seekTo(clientX) {
    const rect = rail.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    if (duration()) video.currentTime = ratio * duration();
    paint();
  }

  // 播放时逐帧刷新进度，暂停或被移出页面后停止。
  let frame = 0;
  const follow = () => {
    paint();
    if (root.isConnected && !video.paused) frame = requestAnimationFrame(follow);
  };
  video.addEventListener('play', () => {
    playButton.replaceChildren(icon('pause', 16));
    playButton.setAttribute('aria-label', '暂停');
    cancelAnimationFrame(frame);
    follow();
  });
  video.addEventListener('pause', () => {
    playButton.replaceChildren(icon('play', 16));
    playButton.setAttribute('aria-label', '播放');
    cancelAnimationFrame(frame);
    paint();
  });
  for (const name of ['loadedmetadata', 'durationchange', 'seeked', 'timeupdate']) video.addEventListener(name, paint);
  if (clickToPlay) video.addEventListener('click', toggle);

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
    video.currentTime = Math.min(duration(), Math.max(0, video.currentTime + (e.key === 'ArrowRight' ? step : -step)));
    paint();
  });

  return root;
}
