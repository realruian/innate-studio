// 登录、退出，和管理员管成员的那几个接口。只有多人模式用得上。

import { HttpError, readJsonBody, route } from '../http.js';
import { allUsers, changeOwnPassword, clearedCookie, createUser, findUser, isHosted, login, logout, newPassword, removeUser, sessionCookie, updateUser, userView } from '../auth.js';
import { spaceOf } from '../spaces.js';
import { estimateCost } from '../../shared/models.ts';

route('POST', /^\/api\/login$/, async ({ req, res }) => {
  if (!isHosted()) throw new HttpError(400, 'invalid_request', '当前不需要登录');
  const { name, password } = await readJsonBody(req);
  const { user, token } = login(name, password);
  res.setHeader('Set-Cookie', sessionCookie(req, token));
  return { user: userView(user) };
}, 'open');

route('POST', /^\/api\/logout$/, async ({ req, res }) => {
  logout(req);
  res.setHeader('Set-Cookie', clearedCookie(req));
  return null;
}, 'open');

route('PUT', /^\/api\/me\/password$/, async ({ req, user }) => {
  if (!user) throw new HttpError(400, 'invalid_request', '当前不需要登录');
  const { current, next } = await readJsonBody(req);
  changeOwnPassword(user, current, next, req);
  return null;
});

// 一个成员这个月大约花了多少元：把他这个月提交的记录按用量估一遍（估法在 shared/models.ts）。
function monthSpend(user) {
  const now = new Date();
  const since = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  let total = 0;
  for (const item of spaceOf(user).history) if ((item.createdAt || 0) >= since) total += estimateCost(item) || 0;
  return Math.round(total * 100) / 100;
}

route('GET', /^\/api\/users$/, async () => ({ items: allUsers().map((user) => ({ ...userView(user), monthSpend: monthSpend(user) })) }), 'admin');

// 建账号、重置密码时，密码由这里随机生成，在返回里给管理员看这一次，之后查不到。
route('POST', /^\/api\/users$/, async ({ req }) => {
  const { name, role } = await readJsonBody(req);
  const password = newPassword();
  return { user: userView(createUser({ name, role, password })), password };
}, 'admin');

route('PUT', /^\/api\/users\/([\w-]+)$/, async ({ req, params }) => {
  const user = findUser(params[0]);
  const { role, disabled, resetPassword } = await readJsonBody(req);
  const password = resetPassword ? newPassword() : undefined;
  updateUser(user, { role, disabled, password });
  return { user: userView(user), ...(password ? { password } : {}) };
}, 'admin');

route('DELETE', /^\/api\/users\/([\w-]+)$/, async ({ params, user: me }) => {
  const user = findUser(params[0]);
  if (user === me) throw new HttpError(400, 'invalid_request', '不能删除自己的账号');
  removeUser(user);
  return null;
}, 'admin');
