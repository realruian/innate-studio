// 多人模式下才有的界面：登录页，和设置里的「账号」。成员的管理在 admin.tsx。

import { useRef, useState } from 'react';
import { api, state } from './store.ts';
import { FormRow } from './ui/controls.tsx';
import { toast, openModal } from './ui/layers.tsx';

const message = (err: unknown) => (err as Error).message;

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
