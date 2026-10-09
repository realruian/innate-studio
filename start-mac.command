#!/bin/bash
# 双击启动 Innate Studio（macOS）。
# 这个窗口开着，服务就在运行；关掉窗口，服务就停了。

cd "$(dirname "$0")" || exit 1
PORT="${PORT:-5178}"
URL="http://127.0.0.1:${PORT}"

pause() { read -r -p "按回车关闭这个窗口…" _; }

if ! command -v node >/dev/null 2>&1; then
  echo "没有找到 Node.js。"
  echo "请先到 https://nodejs.org 下载安装（选 LTS 版本），装好后再双击这个文件。"
  pause
  exit 1
fi

if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 18) ? 0 : 1)'; then
  echo "Node.js 版本太旧（现在是 $(node -v)），需要 22.18 或更高。"
  echo "请到 https://nodejs.org 下载安装新的 LTS 版本。"
  pause
  exit 1
fi

# 已经在运行就不再启动第二份，直接打开页面。
if curl -s -o /dev/null --max-time 2 "$URL"; then
  echo "Innate Studio 已经在运行，正在打开页面：$URL"
  open "$URL"
  exit 0
fi

# 页面用到的依赖只在第一次启动时下载。
if [ ! -d node_modules ]; then
  echo "第一次启动，正在下载页面用到的依赖（需要联网，大约一分钟）…"
  if ! npm install; then
    echo "依赖没有装上，请检查网络后再双击这个文件。"
    pause
    exit 1
  fi
fi

echo "正在启动 Innate Studio…（要停止服务，关掉这个窗口即可）"
# 等服务起来之后再打开页面。
(
  for _ in $(seq 1 40); do
    if curl -s -o /dev/null --max-time 1 "$URL"; then
      open "$URL"
      exit 0
    fi
    sleep 0.25
  done
) &

# npm start 会先把页面构建一遍，再启动服务。
PORT="$PORT" npm start
echo
echo "服务已停止。"
pause
