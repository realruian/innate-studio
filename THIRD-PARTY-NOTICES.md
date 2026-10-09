# 第三方内容

## Hugeicons 免费图标

界面里的图标取自 [Hugeicons](https://hugeicons.com) 的免费图标（Stroke Rounded 风格，`@hugeicons/core-free-icons` 4.3.5），路径数据在 `web/src/ui/icons.ts` 的 `ICONS` 里。播放、暂停和喇叭的轮廓填成了实心，其余没有改动。

这里只用了免费图标。Hugeicons Pro 的图标不能随源码公开分发，不要加进这个仓库。

免费图标按 MIT 许可发布，原文如下：

```
MIT License

Copyright (c) 2025 Hugeicons

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

```

## React Flow

画布页用的是 [React Flow](https://reactflow.dev)（`@xyflow/react`，MIT 许可，版权归 webkid GmbH），通过 npm 安装，没有改动它的源码。许可全文在 `node_modules/@xyflow/react/LICENSE`。画布右下角保留了它的署名。
