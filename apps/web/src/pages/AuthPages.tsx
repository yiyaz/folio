import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ApiError, get, post } from '../api';
import { useAuth } from '../auth';
import { errMsg } from '../util';

function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  useEffect(() => {
    document.title = `${title} · Folio`;
  }, [title]);
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <img src="/favicon.svg" alt="" width={36} height={36} />
          <span>Folio</span>
        </div>
        <h1>{title}</h1>
        {children}
      </div>
    </div>
  );
}

function useAuthConfig() {
  return useQuery({ queryKey: ['auth-config'], queryFn: () => get<{ signupMode: string; oidc: { name: string } | null }>('/api/auth/config') }).data;
}

const OIDC_ERRORS: Record<string, string> = {
  oidc: 'Single sign-on failed. Please try again.',
  oidc_state: 'Your sign-in session expired. Please try again.',
  oidc_signup: 'No account exists for this identity and sign-up is closed.',
  oidc_domain: 'Your e-mail domain is not allowed to sign up.',
};

export function LoginPage() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const cfg = useAuthConfig();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(OIDC_ERRORS[params.get('error') ?? ''] ?? null);
  const [unverified, setUnverified] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/api/auth/login', { login, password });
      await refresh();
      navigate(params.get('next') ?? '/');
    } catch (err) {
      setUnverified(err instanceof ApiError && err.code === 'email_unverified');
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Sign in">
      <form onSubmit={submit} className="stack">
        {error && <div className="alert alert-error">{error}</div>}
        {unverified && (
          <button
            type="button"
            className="link-btn"
            onClick={() => post('/api/auth/resend-verification', { email: login }).then(() => setError('Verification e-mail sent (if the account exists).'))}
          >
            Resend verification e-mail
          </button>
        )}
        <label className="field">
          <span>E-mail or username</span>
          <input value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" required autoFocus name="login" />
        </label>
        <label className="field">
          <span>Password</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required name="password" />
        </label>
        <button className="btn btn-primary btn-block" disabled={busy} type="submit">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {cfg?.oidc && (
          <a className="btn btn-block" href="/api/auth/oidc/start">
            Continue with {cfg.oidc.name}
          </a>
        )}
        <div className="row-between small">
          <Link to="/forgot">Forgot password?</Link>
          {cfg && cfg.signupMode !== 'closed' && cfg.signupMode !== 'invite' && <Link to="/signup">Create an account</Link>}
        </div>
      </form>
    </AuthCard>
  );
}

export function SignupPage() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const cfg = useAuthConfig();
  const invite = params.get('invite') ?? undefined;
  const [form, setForm] = useState({ email: params.get('email') ?? '', username: '', displayName: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ verificationRequired: boolean }>('/api/auth/signup', { ...form, inviteToken: invite });
      if (r.verificationRequired) setDone(true);
      else {
        await refresh();
        navigate('/');
      }
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  if (done)
    return (
      <AuthCard title="Check your inbox">
        <p>
          We sent a verification link to <strong>{form.email}</strong>. Open it to activate your account.
        </p>
        <Link to="/login">Back to sign in</Link>
      </AuthCard>
    );

  const closed = !invite && cfg && (cfg.signupMode === 'closed' || cfg.signupMode === 'invite');
  return (
    <AuthCard title="Create your account">
      {closed ? (
        <p>Sign-up is by invitation only. Ask an administrator for an invite.</p>
      ) : (
        <form onSubmit={submit} className="stack">
          {error && <div className="alert alert-error">{error}</div>}
          {invite && <div className="alert">You were invited — complete your account below.</div>}
          <label className="field">
            <span>Full name</span>
            <input value={form.displayName} onChange={set('displayName')} required autoFocus name="displayName" />
          </label>
          <label className="field">
            <span>Username</span>
            <input
              value={form.username}
              onChange={set('username')}
              required
              pattern="[a-zA-Z0-9_][a-zA-Z0-9_.\-]*[a-zA-Z0-9_]"
              minLength={3}
              maxLength={32}
              name="username"
              title="3-32 letters, numbers, . - _"
            />
          </label>
          <label className="field">
            <span>E-mail</span>
            <input type="email" value={form.email} onChange={set('email')} required readOnly={!!invite} name="email" autoComplete="email" />
          </label>
          <label className="field">
            <span>Password</span>
            <input type="password" value={form.password} onChange={set('password')} required minLength={10} name="password" autoComplete="new-password" />
            <small className="muted">At least 10 characters.</small>
          </label>
          <button className="btn btn-primary btn-block" disabled={busy} type="submit">
            {busy ? 'Creating…' : 'Create account'}
          </button>
          <p className="small">
            Already have an account? <Link to="/login">Sign in</Link>
          </p>
        </form>
      )}
    </AuthCard>
  );
}

export function VerifyPage() {
  const [params] = useSearchParams();
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [state, setState] = useState<'working' | 'error'>('working');
  const [msg, setMsg] = useState('');
  useEffect(() => {
    post('/api/auth/verify', { token: params.get('token') ?? '' })
      .then(async () => {
        await refresh();
        navigate('/');
      })
      .catch((e) => {
        setState('error');
        setMsg(errMsg(e));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <AuthCard title="Verifying e-mail">
      {state === 'working' ? <p>One moment…</p> : <div className="alert alert-error">{msg}</div>}
      <Link to="/login">Back to sign in</Link>
    </AuthCard>
  );
}

export function ForgotPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  return (
    <AuthCard title="Reset your password">
      {sent ? (
        <p>If an account exists for {email}, we sent a reset link. It is valid for one hour.</p>
      ) : (
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            await post('/api/auth/forgot', { email }).catch(() => {});
            setSent(true);
          }}
        >
          <label className="field">
            <span>E-mail</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </label>
          <button className="btn btn-primary btn-block" type="submit">
            Send reset link
          </button>
        </form>
      )}
      <Link to="/login">Back to sign in</Link>
    </AuthCard>
  );
}

export function ResetPage() {
  const [params] = useSearchParams();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  return (
    <AuthCard title="Choose a new password">
      {done ? (
        <p>
          Password updated. <Link to="/login">Sign in</Link>
        </p>
      ) : (
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await post('/api/auth/reset', { token: params.get('token') ?? '', password });
              setDone(true);
            } catch (err) {
              setError(errMsg(err));
            }
          }}
        >
          {error && <div className="alert alert-error">{error}</div>}
          <label className="field">
            <span>New password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={10}
              required
              autoFocus
              autoComplete="new-password"
            />
          </label>
          <button className="btn btn-primary btn-block" type="submit">
            Update password
          </button>
        </form>
      )}
    </AuthCard>
  );
}
