// 素材文件的处理：缩略图、上传、把素材或生成记录变成一份参考素材。不碰界面。

import { api, ApiError, KINDS, rememberAsset } from './store.ts';
import { fmtBytes } from './format.ts';
import type { Asset, HistoryItem, Kind, Ref } from './types.ts';

// ---------- 缩略图 ----------

function drawThumb(source: CanvasImageSource, width: number, height: number) {
  const scale = Math.min(1, 320 / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.72);
}

async function imageThumb(file: File) {
  const bitmap = await createImageBitmap(file);
  const url = drawThumb(bitmap, bitmap.width, bitmap.height);
  bitmap.close();
  return url;
}

// 读一段视频的缩略图和时长。source 可以是刚选的文件，也可以是本机已有视频的地址。
export function readVideo(source: File | string) {
  return new Promise<{ thumb: string; duration: number }>((resolve, reject) => {
    const url = typeof source === 'string' ? source : URL.createObjectURL(source);
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    const finish = (fn: () => void) => {
      clearTimeout(timer);
      if (typeof source !== 'string') URL.revokeObjectURL(url);
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error('timeout'))), 6000);
    video.onloadeddata = () => {
      video.currentTime = Math.min(0.2, (video.duration || 1) / 2);
    };
    video.onseeked = () => finish(() => resolve({ thumb: drawThumb(video, video.videoWidth, video.videoHeight), duration: Number.isFinite(video.duration) ? video.duration : 0 }));
    video.onerror = () => finish(() => reject(new Error('decode')));
    video.src = url;
  });
}

// 给一个已经在本机的图片或视频地址缩一张小图。缩不出来就返回 null。
export async function thumbOf(url: string, kind: Kind) {
  try {
    if (kind === 'video') return (await readVideo(url)).thumb;
    if (kind !== 'image') return null;
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    const thumb = drawThumb(bitmap, bitmap.width, bitmap.height);
    bitmap.close();
    return thumb;
  } catch {
    return null;
  }
}

export async function makeThumb(file: File, kind: Kind) {
  try {
    if (kind === 'image') return await imageThumb(file);
    if (kind === 'video') return (await readVideo(file)).thumb;
  } catch {
    /* 生成不了缩略图就用图标代替 */
  }
  return null;
}

export const kindOfFile = (file: File): Kind | null => (['image', 'video', 'audio'] as Kind[]).find((k) => file.type.startsWith(`${k}/`)) || null;

// ---------- 上传 ----------

export type Progress = (ratio: number) => void;

export function xhrUpload<T = any>(url: string, body: FormData | File, headers: Record<string, string>, onProgress?: Progress) {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* 按空响应处理 */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, data?.error?.code || '', data?.error?.message || `上传失败（${xhr.status}）`));
    };
    xhr.onerror = () => reject(new ApiError(0, 'network', '连不上本地服务，请确认终端里的 node server.js 还在运行。'));
    xhr.send(body);
  });
}

// 接口对每类素材有大小上限。超了的文件不发出去，直接说明原因。
export function checkFileSize(file: File, kind: Kind) {
  const { label, maxBytes } = KINDS[kind];
  if (file.size > maxBytes) throw new Error(`文件太大：${label}最大 ${Math.round(maxBytes / 1024 / 1024)} MB，这个文件有 ${fmtBytes(file.size)}。请先裁剪或压缩。`);
}

export async function uploadVirtualAsset(file: File, kind: Kind, onProgress?: Progress): Promise<Asset> {
  checkFileSize(file, kind);
  const thumb = await makeThumb(file, kind);
  const form = new FormData();
  form.append('file', file);
  form.append('asset_type', KINDS[kind].type);
  const asset = await xhrUpload<Asset>('/api/assets/upload', form, { 'X-Asset-Name': encodeURIComponent(file.name), 'X-Asset-Type': KINDS[kind].type }, onProgress);
  const saved = thumb ? await api<Asset>('PATCH', `/api/assets/${asset.id}`, { thumb }).catch(() => asset) : asset;
  rememberAsset(saved);
  return saved;
}

export function refFromAsset(asset: Asset, kind: Kind): Ref {
  return {
    uid: crypto.randomUUID(),
    kind,
    source: 'asset',
    assetId: asset.id,
    personId: asset.personId || null,
    url: asset.asset_url || `asset://${asset.id}`,
    name: asset.name || asset.id,
    thumb: asset.thumb || null,
  };
}

// ---------- 只存在本机的素材 ----------
// Grok 的首帧、要配乐的视频不经过 Flatkey 的素材库：文件存在本地服务的 data/uploads 里，
// 或者直接用生成记录里已经存到本机的结果。这类素材的 source 是 local，地址是 /media/ 开头的本机地址。

export async function uploadLocalFile(file: File, kind: Kind, onProgress?: Progress): Promise<Ref> {
  checkFileSize(file, kind);
  const video = kind === 'video' ? await readVideo(file).catch(() => null) : null;
  const thumb = video ? video.thumb : await makeThumb(file, kind);
  const saved = await xhrUpload<{ url: string }>('/api/uploads', file, { 'Content-Type': file.type }, onProgress);
  return { uid: crypto.randomUUID(), kind, source: 'local', url: saved.url, name: file.name, thumb, duration: video?.duration };
}

export const recordName = (item: HistoryItem) => (item.prompt || '').trim().slice(0, 40) || item.id;

// 把一条已经存到本机的生成记录当素材用。
export async function refFromRecord(item: HistoryItem): Promise<Ref> {
  const ref: Ref = { uid: crypto.randomUUID(), kind: item.kind, source: 'local', url: item.mediaUrl!, name: recordName(item), thumb: item.kind === 'image' ? item.mediaUrl! : null };
  if (item.kind !== 'video') return ref;
  const video = await readVideo(item.mediaUrl!).catch(() => null);
  return { ...ref, thumb: video?.thumb || null, duration: video?.duration || 0 };
}

// Seedance 只认素材库里的素材：把生成记录里的文件取出来，传进 Flatkey 的素材库。
export async function assetFromRecord(item: HistoryItem) {
  const res = await fetch(item.mediaUrl!);
  if (!res.ok) throw new Error('这条记录的文件已经不在本机了');
  const blob = await res.blob();
  const file = new File([blob], `${recordName(item)}.${item.mediaUrl!.split('.').pop()}`, { type: blob.type });
  return uploadVirtualAsset(file, item.kind);
}
