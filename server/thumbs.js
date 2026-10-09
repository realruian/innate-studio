// 缩略图：给存到本机的图片和视频各做一张小图，列表里显示它，不用把原图、原视频拉下来。
// 用的是系统里的 ffmpeg（可以用环境变量 FFMPEG_PATH 指定在哪）。机器上没有 ffmpeg 就不做，页面照旧显示原文件。

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
// 小图最长的一边。记录卡片最宽三百多像素，两倍屏下 640 够用。
const THUMB_SIZE = 640;
// 同时最多跑几个 ffmpeg：服务启动时可能要给一大批旧记录补小图。
const MAX_JOBS = 2;

const run = (args) =>
  new Promise((resolve, reject) => {
    execFile(FFMPEG, args, { timeout: 60000, maxBuffer: 4 * 1024 * 1024 }, (err, _stdout, stderr) => (err ? reject(err) : resolve(String(stderr))));
  });

let available = null;
const hasFfmpeg = () => (available ??= run(['-version']).then(() => true, () => false));

const queue = [];
let running = 0;
function next() {
  while (running < MAX_JOBS && queue.length) {
    const job = queue.shift();
    running += 1;
    job().finally(() => {
      running -= 1;
      next();
    });
  }
}

// ffmpeg 读文件时会把时长和画面大小打在日志里：「Duration: 00:00:05.04」「Video: h264 …, 1280x720」。
function readSize(log) {
  const size = /Video:.*?\b(\d{2,5})x(\d{2,5})\b/.exec(log);
  const time = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(log);
  const media = {};
  if (size) Object.assign(media, { width: Number(size[1]), height: Number(size[2]) });
  if (time) media.duration = Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3]);
  return media;
}

// 给一条已经存到本机的记录做小图，做完记在记录上：thumbFile 是小图的文件名，media 是原文件的宽高和时长。
// 做不出来（没有 ffmpeg、文件坏了）就记一下试过了，不再反复试。
export function makeThumb(space, item) {
  if (!item.localFile || item.thumbFile || item.thumbTried || (item.kind !== 'image' && item.kind !== 'video')) return;
  item.thumbTried = true;
  queue.push(async () => {
    if (!(await hasFfmpeg())) return;
    const source = path.join(space.resultDir(item), item.localFile);
    const file = `${item.id.replace(/[^\w.-]/g, '_')}.jpg`;
    const target = path.join(space.dir('thumbs'), file);
    const scale = `scale=${THUMB_SIZE}:${THUMB_SIZE}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
    try {
      // 视频取开头那一帧。
      const log = await run(['-y', '-hide_banner', '-i', source, '-frames:v', '1', '-vf', scale, '-q:v', '4', target]);
      if (!space.history.includes(item)) return fs.rmSync(target, { force: true });
      item.thumbFile = file;
      if (item.kind === 'video') item.media = readSize(log);
      space.save('history');
    } catch {
      fs.rmSync(target, { force: true });
    }
  });
  next();
}

// 服务启动时给还没有小图的旧记录补上。
export function backfillThumbs(space) {
  for (const item of space.history) {
    // 上次没做成的，换了机器或装上 ffmpeg 之后再试一次。
    item.thumbTried = false;
    if (item.status === 'completed') makeThumb(space, item);
  }
}

export function removeThumb(space, item) {
  if (item.thumbFile) fs.rmSync(path.join(space.dir('thumbs'), path.basename(item.thumbFile)), { force: true });
}
