// 多人模式下才有的界面：登录页，和设置里的「账号」「成员」两组。

import { useEffect, useRef, useState } from 'react';
import { api, state, useStore, isAdmin } from './store.ts';
import { fmtTime, fmtCost } from './format.ts';
import { FormRow } from './ui/controls.tsx';
import { toast, openMenu, openModal, confirmDialog, copyText } from './ui/layers.tsx';

const message = (err: unknown) => (err as Error).message;

interface Member {
  id: string;
  name: string;
  role: 'admin' | 'member';
  disabled: boolean;
  lastSeenAt: number | null;
  // 这个月大约花了多少元。
  monthSpend: number;
}

// ---------- 登录 ----------

export function Login() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const name = useRef<HTMLInputElement>(null);
  const password = useRef<HTMLInputElement>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('POST', '/api/login', { name: name.current!.value, password: password.current!.value });
      // 登录之后整个页面重新读一遍，比一块一块补状态可靠。
      location.reload();
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  }

  return (
    <form className="login" onSubmit={submit}>
      <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-word" role="img" aria-label="INNATE" />
      </div>
      <input ref={name} className="input" type="text" placeholder="名称" aria-label="名称" autoComplete="username" autoFocus required />
      <input ref={password} className="input" type="password" placeholder="密码" aria-label="密码" autoComplete="current-password" required />
      <button className="btn btn-primary" type="submit" disabled={busy}>
        登录
      </button>
      <p className="login-error" role="alert">
        {error}
      </p>
    </form>
  );
}

// ---------- 设置里的「账号」 ----------

function PasswordDialog({ close }: { close: () => void }) {
  const [busy, setBusy] = useState(false);
  const current = useRef<HTMLInputElement>(null);
  const next = useRef<HTMLInputElement>(null);
  async function submit() {
    setBusy(true);
    try {
      await api('PUT', '/api/me/password', { current: current.current!.value, next: next.current!.value });
      toast('密码已修改', 'success');
      close();
    } catch (err) {
      toast(message(err), 'error', 6000);
      setBusy(false);
    }
  }
  return (
    <>
      <label className="field-label">当前密码</label>
      <input ref={current} className="input" type="password" autoComplete="current-password" aria-label="当前密码" />
      <label className="field-label">新密码</label>
      <input ref={next} className="input" type="password" autoComplete="new-password" placeholder="至少 8 位" aria-label="新密码" onKeyDown={(e) => e.key === 'Enter' && submit()} />
      <div className="modal-actions">
        <button className="btn btn-primary" disabled={busy} onClick={submit}>
          保存
        </button>
      </div>
    </>
  );
}

async function signOut() {
  await api('POST', '/api/logout').catch(() => {});
  location.reload();
}

export function AccountSection() {
  const user = state.app.user!;
  return (
    <section className="settings-group">
      <h3>账号</h3>
      <div className="settings-card">
        <FormRow label={user.name} desc={user.role === 'admin' ? '管理员' : '成员'}>
          <button
            className="btn btn-sm"
            type="button"
            onClick={() => {
              const modal = openModal({ title: '修改密码', size: 'sm', content: <PasswordDialog close={() => modal.close()} /> });
            }}
          >
            修改密码
          </button>
          <button className="btn btn-sm" type="button" onClick={signOut}>
            退出登录
          </button>
        </FormRow>
      </div>
    </section>
  );
}

// ---------- 设置里的「成员」（管理员才有） ----------

// 新建账号、重置密码之后，密码只在这里出现一次。
function showPassword(name: string, password: string) {
  const modal = openModal({
    title: `${name} 的初始密码`,
    size: 'sm',
    content: (
      <>
        <p className="mono confirm-text">{password}</p>
        <p className="muted small">仅显示一次。成员登录后可在「设置」中修改。</p>
        <div className="modal-actions">
          <button
            className="btn btn-primary"
            onClick={() => {
              copyText(password, '已复制');
              modal.close();
            }}
          >
            复制并关闭
          </button>
        </div>
      </>
    ),
  });
}

export function MembersSection() {
  useStore('app');
  const [members, setMembers] = useState<Member[] | null>(null);
  const [adding, setAdding] = useState(false);
  const name = useRef<HTMLInputElement>(null);
  const me = state.app.user!;
  const load = () =>
    api<{ items: Member[] }>('GET', '/api/users')
      .then((data) => setMembers(data.items))
      .catch((err) => toast(message(err), 'error', 6000));
  useEffect(() => {
    load();
  }, []);
  if (!isAdmin()) return null;

  async function add() {
    const value = name.current!.value.trim();
    if (!value) return;
    setAdding(true);
    try {
      const { user, password } = await api('POST', '/api/users', { name: value });
      name.current!.value = '';
      showPassword(user.name, password);
      await load();
    } catch (err) {
      toast(message(err), 'error', 6000);
    } finally {
      setAdding(false);
    }
  }

  const change = async (member: Member, body: Record<string, unknown>, done?: string) => {
    try {
      const { password } = await api('PUT', `/api/users/${member.id}`, body);
      if (password) showPassword(member.name, password);
      else if (done) toast(done, 'success');
      await load();
    } catch (err) {
      toast(message(err), 'error', 6000);
    }
  };

  async function remove(member: Member) {
    const ok = await confirmDialog({ title: `删除成员「${member.name}」？`, message: '账号将无法登录。该成员的生成记录和文件保留在服务器上。', okText: '删除', danger: true });
    if (!ok) return;
    try {
      await api('DELETE', `/api/users/${member.id}`);
      await load();
    } catch (err) {
      toast(message(err), 'error', 6000);
    }
  }

  function more(button: HTMLElement, member: Member) {
    const acts: Record<string, () => void> = {
      reset: () => change(member, { resetPassword: true }),
      role: () => change(member, { role: member.role === 'admin' ? 'member' : 'admin' }, '已更新'),
      toggle: () => change(member, { disabled: !member.disabled }, member.disabled ? '已启用' : '已停用'),
      remove: () => remove(member),
    };
    openMenu(button, {
      label: '成员操作',
      align: 'end',
      items: [
        { value: 'reset', label: '重置密码' },
        { value: 'role', label: member.role === 'admin' ? '设为成员' : '设为管理员' },
        { value: 'toggle', label: member.disabled ? '启用' : '停用' },
        ...(member.id === me.id ? [] : [{ value: 'remove', label: '删除', danger: true }]),
      ],
      onSelect: (value) => acts[value](),
    });
  }

  return (
    <section className="settings-group">
      <h3>成员</h3>
      <div className="settings-card">
        {(members || []).map((member) => (
          <FormRow key={member.id} label={member.name} desc={[member.role === 'admin' ? '管理员' : '成员', member.disabled ? '已停用' : member.lastSeenAt ? `最近使用 ${fmtTime(member.lastSeenAt)}` : '尚未登录'].join(' · ')}>
            <span className="muted amount">{`本月 ${fmtCost(member.monthSpend)}`}</span>
            <button className="btn btn-sm" type="button" aria-haspopup="menu" aria-expanded="false" onClick={(e) => more(e.currentTarget, member)}>
              管理
            </button>
          </FormRow>
        ))}
        <div className="form-row">
          <div className="form-control key-edit">
            <input ref={name} className="input" type="text" placeholder="新成员的名称" maxLength={30} aria-label="新成员的名称" onKeyDown={(e) => e.key === 'Enter' && add()} />
            <button className="btn btn-primary" type="button" disabled={adding} onClick={add}>
              添加成员
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
