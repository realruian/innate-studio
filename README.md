# Seedance Studio

通过 Flatkey 调用 Seedance 生成视频的本地网页应用。

## 第一次使用

1. **安装 Node.js**（18 或更高）。到 <https://nodejs.org> 下载 LTS 版本，一路下一步装好。除此之外不用安装任何东西。
2. **双击启动**。Mac 双击 `start-mac.command`，Windows 双击 `start-windows.bat`。会弹出一个黑色窗口，并自动在浏览器里打开页面。
3. **填 API Key**。第一次打开会弹出「设置」，把自己的 Flatkey API Key 粘贴进去保存。Key 在 [Flatkey 控制台](https://console.flatkey.ai/keys?lng=zh)创建。

之后每次要用，双击启动文件就行。**那个黑色窗口开着，服务就在运行；关掉它，页面就打不开了。**

Mac 第一次双击可能被系统拦住，提示"无法验证开发者"。这时在文件上点右键，选「打开」，再点一次「打开」；如果还不行，到「系统设置 → 隐私与安全性」里点「仍要打开」。只需要做一次。

### 用命令行启动

不想用启动文件的话，在终端里进入这个文件夹，运行：

```bash
node server.js
```

然后在浏览器打开 <http://127.0.0.1:5178>。换端口：`PORT=5180 node server.js`。

### 把这个项目发给别人

不要直接压缩整个文件夹：里面的 `data/` 存着你的 API Key、创作记录和视频。在这个文件夹里运行下面的命令，会生成一个不含 `data/` 的干净压缩包 `dist/seedance-studio.zip`，发这个：

```bash
mkdir -p dist && git archive --format=zip --prefix=seedance-studio/ -o dist/seedance-studio.zip HEAD
```

对方解压后按上面"第一次使用"的三步走，用他自己的 Key。

## 功能

- 三种生成模式：文生视频、首尾帧、参考生成（图片最多 9 张，视频和音频各最多 3 段）
- 参数：模型、分辨率、画面比例、时长、同步音频、水印、随机种子、联网搜索、输入模式、画质超分
- 参考素材三种来源：本地上传、公网链接、素材库（含真人素材）
- 素材库：上传文件、用链接创建、按 ID 添加、查看可用模型、删除
- 真人档案：创建档案、生成认证链接、添加和删除真人素材
- 创作记录：单独一页，进度、播放、下载、复用参数、详情、搜索和筛选；创作页下方只列最近 6 条
- 上传前检查文件大小（图片 30 MB、视频 50 MB、音频 15 MB），超过会直接说明

## 数据存在哪里

都在 `data/` 目录，只在本机：

| 文件 | 内容 |
| - | - |
| `data/config.json` | API Key |
| `data/history.json` | 创作记录 |
| `data/assets.json` | 素材库列表和缩略图 |
| `data/videos/` | 生成完成后自动保存的 MP4 |

也可以不把 Key 存进文件，改用环境变量：`FLATKEY_API_KEY=sk-fk-... node server.js`。

## 测试

```bash
npm test
```

用模拟的 Flatkey 接口跑一遍主要流程（创建、轮询、保存视频、素材、真人档案），不花钱，也不会用到真实的 Key 和 `data/`。

调界面时可以用 `npm run dev:mock` 另起一份接模拟接口的应用（<http://127.0.0.1:5179>）。

改完界面要做整体走查（深色、浅色各一遍），命令和检查项见 `DESIGN.md` 第 11 节。

## 结构

- `server.js`：本地服务。托管页面、保管 Key、转发 Flatkey 请求、轮询任务、保存视频。只监听 `127.0.0.1`，并拒绝其他网站发来的跨站请求。
- `public/`：页面。原生 JavaScript 模块，没有构建步骤。
- `test/`：模拟接口和自动化测试。
- `DESIGN.md`：界面的视觉规范（对标 Antigravity 与 Codex 的深色工作台），改界面前先看它。

接口文档：<https://docs.flatkey.ai/zh/guides/seedance>
