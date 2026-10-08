// 页面里来回传的几种数据的形状。接口返回的字段不全列，只写页面用到的。

export type Kind = 'image' | 'video' | 'audio';
export type CreateType = 'video' | 'image' | 'speech' | 'sfx' | 'music';
export type ViewId = 'create' | 'records' | 'library' | 'persons';
export type Tone = 'ok' | 'pending' | 'error';

// 一份参考素材：素材库里的、公网链接，或者只存在本机的文件。
export interface Ref {
  uid: string;
  kind: Kind;
  source: 'asset' | 'url' | 'local';
  assetId?: string;
  personId?: string | null;
  url: string;
  name: string;
  thumb: string | null;
  duration?: number;
}

export interface SuperResolution {
  enabled: boolean;
  by: 'resolution' | 'limit';
  resolution: string;
  limit: number | string;
  scene: string;
  tool: string;
  fps: number | string;
}

export interface VideoForm {
  mode: 'text' | 'frames' | 'reference';
  prompt: string;
  model: string;
  resolution: string;
  ratio: string;
  duration: number;
  durationAuto: boolean;
  generateAudio: boolean;
  watermark: boolean;
  seed: string;
  webSearch: boolean;
  inputType: string;
  sr: SuperResolution;
  frames: { first: Ref | null; last: Ref | null };
  refs: Record<Kind, Ref[]>;
}

export interface ImageForm {
  prompt: string;
  model: string;
  ratio: string;
  count: number;
}

export interface SpeechForm {
  prompt: string;
  voiceId: string;
  voiceName: string;
}

export interface SfxForm {
  prompt: string;
  duration: string | number;
  influence: string | number;
}

export interface MusicForm {
  video: Ref | null;
}

export interface Studio {
  type: CreateType;
  image: ImageForm;
  speech: SpeechForm;
  sfx: SfxForm;
  music: MusicForm;
}

export interface RefStatus {
  ready: boolean;
  tone: Tone;
  label?: string;
}

export interface BuiltRequest {
  payload?: Record<string, unknown>;
  body?: Record<string, unknown>;
  problems: string[];
}

export interface HistoryItem {
  id: string;
  kind: Kind;
  tool?: 'speech' | 'sfx' | 'music';
  status: 'queued' | 'in_progress' | 'completed' | 'failed';
  progress?: number;
  prompt?: string;
  model: string;
  mediaUrl?: string;
  videoUrl?: string;
  savedLocally?: boolean;
  fileSize?: number;
  downloadError?: string;
  pollError?: string;
  direct?: boolean;
  error?: { message: string; code?: string };
  // 提交时发给接口的内容和当时的表单，字段随类型不同。
  payload?: Record<string, any>;
  form?: Record<string, any>;
  createdAt?: number;
  completedAt?: number;
  usage?: { total_tokens?: number; cost_usd?: number };
}

export interface Asset {
  id: string;
  kind?: string;
  asset_type?: string;
  status?: string;
  name?: string;
  thumb?: string | null;
  asset_url?: string;
  available_models?: string[];
  personId?: string | null;
  created_at?: number;
  addedAt?: number;
  error?: string;
}

export interface Person {
  id: string;
  name?: string;
  status?: string;
  created_at?: number;
  verification_url?: string;
}

export interface Voice {
  id: string;
  name: string;
  gender: string;
  language: string;
  previewUrl?: string;
}

export interface AppInfo {
  hasKey: boolean;
  keyHint: string;
  keySource: string;
  baseUrl: string;
}
