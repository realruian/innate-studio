#!/usr/bin/env node

// 在命令行里管账号。第一个管理员只能在这里建：建了第一个账号，服务就进入多人模式，要登录才能用。
//   npm run user -- add <名称> [--admin] [--with-local-data]    建账号，密码随机生成，只在这里显示一次
//   npm run user -- reset <名称>                                重置密码
//   npm run user -- list                                        列出账号
// --with-local-data：把数据目录里原来本机模式的数据（生成记录、画布、角色、技能、工作流和文件）搬给这个账号。
// 运行前先停掉服务，改完再启动：服务运行时账号在它的内存里，这里改的会被它覆盖。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { allUsers, createUser, newPassword, updateUser, userDir } from './auth.js';

const [command, name, ...flags] = process.argv.slice(2);
const LOCAL_DATA = ['history.json', 'canvases.json', 'characters.json', 'skills.json', 'workflows.json', 'videos', 'images', 'audio', 'uploads', 'thumbs'];

function moveLocalData(id) {
  const target = userDir(id);
  fs.mkdirSync(target, { recursive: true });
  for (const entry of LOCAL_DATA) {
    const from = path.join(DATA_DIR, entry);
    if (fs.existsSync(from) && !fs.existsSync(path.join(target, entry))) fs.renameSync(from, path.join(target, entry));
  }
}

try {
  if (command === 'add' && name) {
    const password = newPassword();
    const user = createUser({ name, role: flags.includes('--admin') ? 'admin' : 'member', password });
    if (flags.includes('--with-local-data')) moveLocalData(user.id);
    console.log(`已创建${user.role === 'admin' ? '管理员' : '成员'}：${user.name}`);
    console.log(`初始密码：${password}`);
    console.log('密码只显示这一次。');
  } else if (command === 'reset' && name) {
    const user = allUsers().find((u) => u.name.toLowerCase() === name.toLowerCase());
    if (!user) throw new Error(`没有名为「${name}」的账号`);
    const password = newPassword();
    updateUser(user, { password });
    console.log(`${user.name} 的新密码：${password}`);
  } else if (command === 'list') {
    for (const user of allUsers()) console.log(`${user.role === 'admin' ? '管理员' : '成员  '}  ${user.name}${user.disabled ? '（已停用）' : ''}`);
    if (!allUsers().length) console.log('还没有账号，服务处于本机模式。');
  } else {
    console.log('用法：\n  npm run user -- add <名称> [--admin] [--with-local-data]\n  npm run user -- reset <名称>\n  npm run user -- list');
    process.exit(1);
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
