import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import { Modal } from './ui';

interface PromptOpts {
  title: string;
  label?: string;
  initial?: string;
  confirmText?: string;
}
interface ConfirmOpts {
  title: string;
  message: string;
  confirmText?: string;
  danger?: boolean;
}

interface DialogApi {
  prompt: (o: PromptOpts) => Promise<string | null>;
  confirm: (o: ConfirmOpts) => Promise<boolean>;
}

const Ctx = createContext<DialogApi>({ prompt: async () => null, confirm: async () => false });

type Pending =
  { kind: 'prompt'; opts: PromptOpts; resolve: (v: string | null) => void } | { kind: 'confirm'; opts: ConfirmOpts; resolve: (v: boolean) => void };

export function DialogProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [value, setValue] = useState('');
  const prompt = useCallback(
    (opts: PromptOpts) =>
      new Promise<string | null>((resolve) => {
        setValue(opts.initial ?? '');
        setPending({ kind: 'prompt', opts, resolve });
      }),
    [],
  );
  const confirm = useCallback((opts: ConfirmOpts) => new Promise<boolean>((resolve) => setPending({ kind: 'confirm', opts, resolve })), []);
  const close = (v: any) => {
    (pending?.resolve as ((x: unknown) => void) | undefined)?.(v);
    setPending(null);
  };
  return (
    <Ctx.Provider value={{ prompt, confirm }}>
      {children}
      {pending?.kind === 'prompt' && (
        <Modal title={pending.opts.title} onClose={() => close(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              close(value.trim() || null);
            }}
          >
            <label className="field">
              <span>{pending.opts.label ?? 'Name'}</span>
              <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} onFocus={(e) => e.target.select()} data-testid="prompt-input" />
            </label>
            <div className="row-end">
              <button type="button" className="btn" onClick={() => close(null)}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" data-testid="prompt-ok">
                {pending.opts.confirmText ?? 'OK'}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {pending?.kind === 'confirm' && (
        <Modal title={pending.opts.title} onClose={() => close(false)}>
          <p>{pending.opts.message}</p>
          <div className="row-end">
            <button className="btn" onClick={() => close(false)}>
              Cancel
            </button>
            <button className={pending.opts.danger ? 'btn btn-danger' : 'btn btn-primary'} onClick={() => close(true)} autoFocus data-testid="confirm-ok">
              {pending.opts.confirmText ?? 'Confirm'}
            </button>
          </div>
        </Modal>
      )}
    </Ctx.Provider>
  );
}

export const useDialogs = () => useContext(Ctx);
