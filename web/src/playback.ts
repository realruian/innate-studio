// 同一时间只放一个：新的一个开始播放时，上一个停下并回到开头。自己按了暂停的不算，留在原处。
// 页面上所有会出声的都要用 exclusive() 登记，包括不走播放器组件的（比如音色试听）。

let current: HTMLMediaElement | null = null;

export function stopPlaying() {
  if (!current) return;
  current.pause();
  current.currentTime = 0;
  current = null;
}

// 返回取消登记的函数。
export function exclusive(media: HTMLMediaElement) {
  const onPlay = () => {
    if (current !== media) stopPlaying();
    current = media;
  };
  const onPause = () => {
    if (current === media) current = null;
  };
  media.addEventListener('play', onPlay);
  media.addEventListener('pause', onPause);
  return () => {
    media.removeEventListener('play', onPlay);
    media.removeEventListener('pause', onPause);
    if (current === media) current = null;
  };
}
