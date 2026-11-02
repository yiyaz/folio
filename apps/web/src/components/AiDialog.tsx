import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { Author } from '@folio/markdown';
import { postEventStream } from '../api';
import { useNames } from '../hooks';
import { Preview } from '../render/Preview';
import { Modal, useToast } from './ui';
import { errMsg } from '../util';

type ContextChoice = 'none' | 'this' | 'pick' | 'folder' | 'workspace';

interface Omitted {
  id: string | null;
  name: string | null;
  reason: 'restricted' | 'no-access' | 'too-large' | 'limit';
}

const OMIT_REASON: Record<Omitted['reason'], string> = {
  restricted: 'restricted documents are never shared with AI',
  'no-access': 'you cannot read it',
  'too-large': 'it did not fit into the context budget',
  limit: 'too many documents',
};

/**
 * Ask the AI to write: either a new document, or text to insert into the open document.
 * Context documents are chosen explicitly; what was shared (and what was left out) is shown.
 */
export function AiDialog({
  workspaceId,
  mode,
  documentId,
  documentName,
  folderId,
  onInsert,
  onClose,
}: {
  workspaceId: string;
  mode: 'new' | 'insert';
  documentId?: string;
  documentName?: string;
  folderId?: string | null;
  onInsert?: (text: string, author: Author) => void;
  onClose: () => void;
}) {
  const { data: names = [] } = useNames(workspaceId);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [prompt, setPrompt] = useState('');
  const [choice, setChoice] = useState<ContextChoice>(mode === 'insert' ? 'this' : 'none');
  const [picked, setPicked] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [output, setOutput] = useState('');
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [info, setInfo] = useState<{ used: { id: string; name: string }[]; omitted: Omitted[] } | null>(null);
  const [result, setResult] = useState<{ generationId: string; model: string; text: string; documentId?: string } | null>(null);
  const abort = useRef<AbortController | null>(null);

  const candidates = useMemo(
    () => names.filter((n) => n.id !== documentId && n.name.toLowerCase().includes(filter.toLowerCase())).slice(0, 200),
    [names, filter, documentId],
  );

  const context = () => {
    if (choice === 'this' && documentId) return { documentIds: [documentId] };
    if (choice === 'pick') return { documentIds: picked };
    if (choice === 'folder' && folderId) return { folderId };
    if (choice === 'workspace') return { workspace: true };
    return {};
  };

  const run = async () => {
    if (!prompt.trim()) return;
    setOutput('');
    setInfo(null);
    setResult(null);
    setState('running');
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      await postEventStream(
        '/api/ai/generate',
        {
          prompt,
          workspaceId,
          context: context(),
          target: mode === 'new' ? { type: 'new', folderId: folderId ?? null } : { type: 'text', documentId },
          stream: true,
        },
        (event, data) => {
          if (event === 'start') setInfo(data.context);
          else if (event === 'delta') setOutput((o) => o + data.text);
          else if (event === 'done') {
            setResult({ generationId: data.generationId, model: data.model, text: data.text, documentId: data.document?.id });
            setOutput(data.text);
            setState('done');
          } else if (event === 'error') {
            setState('error');
            toast(data.message, 'error');
          }
        },
        ctrl.signal,
      );
      if (ctrl.signal.aborted) setState('idle');
    } catch (e) {
      setState('error');
      toast(errMsg(e), 'error');
    }
  };

  const finish = () => {
    if (!result) return;
    if (mode === 'new' && result.documentId) {
      void qc.invalidateQueries({ queryKey: ['tree', workspaceId] });
      void qc.invalidateQueries({ queryKey: ['names', workspaceId] });
      onClose();
      navigate(`/d/${result.documentId}`);
    } else if (mode === 'insert') {
      onInsert?.(result.text, { kind: 'ai', generationId: result.generationId, model: result.model, requestedBy: '' });
      onClose();
    }
  };

  return (
    <Modal title={mode === 'new' ? '✨ Write a new document with AI' : `✨ Write with AI${documentName ? ` — ${documentName}` : ''}`} onClose={onClose} wide>
      <div className="ai-dialog">
        <label className="field">
          <span>What should the AI write?</span>
          <textarea
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={
              mode === 'new' ? 'e.g. An onboarding guide for new data scientists, based on our pipeline docs' : 'e.g. A risks section for this design'
            }
            autoFocus
            data-testid="ai-prompt"
            onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && run()}
          />
        </label>

        <fieldset className="ai-context">
          <legend>Documents the AI may read</legend>
          {(
            [
              ['none', 'None'],
              ...(documentId ? ([['this', 'This document']] as const) : []),
              ['pick', 'Choose documents…'],
              ...(folderId ? ([['folder', 'This folder']] as const) : []),
              ['workspace', 'Whole workspace'],
            ] as [ContextChoice, string][]
          ).map(([v, label]) => (
            <label key={v} className="check">
              <input type="radio" name="ctx" value={v} checked={choice === v} onChange={() => setChoice(v)} data-testid={`ai-ctx-${v}`} /> {label}
            </label>
          ))}
          {choice === 'pick' && (
            <div className="ai-pick">
              <input placeholder="Filter documents…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter documents" />
              <ul>
                {candidates.map((n) => (
                  <li
                    key={n.id}
                    className={n.restricted ? 'disabled' : undefined}
                    title={n.restricted ? 'Restricted documents are never shared with AI' : undefined}
                  >
                    <label className="check">
                      <input
                        type="checkbox"
                        disabled={n.restricted}
                        checked={picked.includes(n.id)}
                        onChange={(e) => setPicked((p) => (e.target.checked ? [...p, n.id] : p.filter((x) => x !== n.id)))}
                        data-testid={`ai-pick-${n.name}`}
                      />{' '}
                      {n.restricted ? '🔒 ' : ''}
                      {n.name}
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="muted small">Restricted documents are never shared. Only documents you can read are used.</p>
        </fieldset>

        {info && (
          <p className="small muted" data-testid="ai-context-report">
            Shared {info.used.length} document{info.used.length === 1 ? '' : 's'}
            {info.used.length ? `: ${info.used.map((d) => d.name).join(', ')}` : ''}.
            {info.omitted.length > 0 && (
              <span className="ai-omitted">
                {' '}
                Not shared:{' '}
                {info.omitted.map((o, i) => (
                  <span key={i}>
                    {o.name ?? 'a document'} ({OMIT_REASON[o.reason]}){i < info.omitted.length - 1 ? '; ' : ''}
                  </span>
                ))}
              </span>
            )}
          </p>
        )}

        {(output || state === 'running') && (
          <div className="ai-output" data-testid="ai-output" aria-live="polite">
            {output ? <Preview source={output} names={names} /> : <p className="muted">Thinking…</p>}
          </div>
        )}

        <div className="row-end">
          {state === 'running' ? (
            <button className="btn" onClick={() => abort.current?.abort()} data-testid="ai-stop">
              Stop
            </button>
          ) : (
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
          )}
          {state === 'done' && result ? (
            <>
              <button className="btn" onClick={run}>
                Try again
              </button>
              <button className="btn btn-primary" onClick={finish} data-testid="ai-accept">
                {mode === 'new' ? 'Open document' : 'Insert at cursor'}
              </button>
            </>
          ) : (
            <button className="btn btn-primary" onClick={run} disabled={state === 'running' || !prompt.trim()} data-testid="ai-generate">
              {state === 'running' ? 'Writing…' : 'Generate'}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
