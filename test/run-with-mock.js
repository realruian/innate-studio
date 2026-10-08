// 用模拟接口启动一份独立的应用，方便调界面：不花钱，也不碰真实的 data/。
// 用法：npm run dev:mock
// 可选 MOCK_SAMPLE=/path/to/video.mp4、MOCK_IMAGE=/path/to/image.jpg、MOCK_AUDIO=/path/to/audio.mp3，让生成结果是能看能听的真实文件。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock, MOCK_KEY } from './mock-flatkey.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = path.join(root, 'test', '.tmp', 'dev-data');
const appPort = Number(process.env.PORT) || 5179;

fs.mkdirSync(dataDir, { recursive: true });
const configFile = path.join(dataDir, 'config.json');
if (!fs.existsSync(configFile)) fs.writeFileSync(configFile, JSON.stringify({ apiKey: MOCK_KEY }));

const mock = await startMock({ port: Number(process.env.MOCK_PORT) || 5999, sampleFile: process.env.MOCK_SAMPLE || '', imageFile: process.env.MOCK_IMAGE || '', audioFile: process.env.MOCK_AUDIO || '' });
console.log(`模拟 Flatkey：${mock.url}`);

const app = spawn(process.execPath, ['server.js'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, PORT: String(appPort), FLATKEY_BASE_URL: mock.url, SEEDANCE_DATA_DIR: dataDir, FLATKEY_API_KEY: '' },
});

const stop = () => {
  app.kill();
  mock.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
app.on('exit', (code) => mock.close().then(() => process.exit(code ?? 0)));
