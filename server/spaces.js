// 每个请求用哪一份数据：本机模式是数据目录本身，多人模式是登录的那个成员自己的目录。
// 一份数据第一次打开时，把上次留下的记录理一遍、给旧记录补上小图。

import { openSpace } from './store.js';
import { userDir } from './auth.js';
import { settleHistory } from './tasks.js';
import { backfillThumbs } from './thumbs.js';

const ready = new Set();

export function spaceOf(user) {
  const space = user ? openSpace(userDir(user.id)) : openSpace();
  if (!ready.has(space)) {
    ready.add(space);
    // 这份数据是谁的。积分记在这个账号上；本机模式是 null，没有积分。
    space.userId = user?.id || null;
    settleHistory(space);
    backfillThumbs(space);
  }
  return space;
}
