# Seedance Studio

通过 Flatkey 调用 Seedance 生成视频的本地网页应用。

## 启动

需要 Node.js 18 以上，不用安装任何依赖。

```bash
node server.js
```

然后在浏览器打开 <http://127.0.0.1:5178>，第一次打开时在「设置」里填入 Flatkey API Key。

换端口：`PORT=5180 node server.js`。

## 功能

- 三种生成模式：文生视频、首尾帧、参考生成（图片最多 9 张，视频和音频各最多 3 段）
- 参数：模型、分辨率、画面比例、时长、同步音频、水印、随机种子、联网搜索、输入模式、画质超分
- 参考素材三种来源：本地上传、公网链接、素材库（含真人素材）
- 素材库：上传文件、用链接创建、按 ID 添加、查看可用模型、删除
- 真人档案：创建档案、生成认证链接、添加和删除真人素材
- 创作记录：进度、播放、下载、复用参数、详情、搜索和筛选

## 数据存在哪里

都在 `data/` 目录，只在本机：

| 文件 | 内容 |
| - | - |
| `data/config.json` | API Key |
| `data/history.json` | 创作记录 |
| `data/assets.json` | 素材库列表和缩略图 |
| `data/videos/` | 生成完成后自动保存的 MP4 |

也可以不把 Key 存进文件，改用环境变量：`FLATKEY_API_KEY=sk-fk-... node server.js`。

## 结构

- `server.js`：本地服务。托管页面、保管 Key、转发 Flatkey 请求、轮询任务、保存视频。只监听 `127.0.0.1`，并拒绝其他网站发来的跨站请求。
- `public/`：页面。原生 JavaScript 模块，没有构建步骤。
- `DESIGN.md`：界面的视觉规范（对标 Antigravity 与 Codex 的深色工作台），改界面前先看它。

接口文档：<https://docs.flatkey.ai/zh/guides/seedance>
