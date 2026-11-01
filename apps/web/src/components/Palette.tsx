import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from './ui';
import { cx } from '../util';

export interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

/** Generic fuzzy-filter list used by the quick switcher and the command palette. */
export function Palette({
  title,
  placeholder,
  items,
  onClose,
  onQuery,
  emptyText,
}: {
  title: string;
  placeholder: string;
  items: PaletteItem[];
  onClose: () => void;
  onQuery?: (q: string) => void;
  emptyText?: string;
}) {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return items.slice(0, 50);
    return items
      .map((it) => ({ it, score: fuzzy(it.label.toLowerCase(), s) + (it.hint ? fuzzy(it.hint.toLowerCase(), s) * 0.3 : 0) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)
      .map((x) => x.it);
  }, [items, q]);
  useEffect(() => setIdx(0), [q]);
  useEffect(() => onQuery?.(q), [q, onQuery]);
  useEffect(() => {
    list.current?.children[idx]?.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  const choose = (it: PaletteItem | undefined) => {
    if (!it) return;
    onClose();
    it.run();
  };

  return (
    <Modal title={title} onClose={onClose}>
      <input
        className="palette-input"
        autoFocus
        placeholder={placeholder}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        data-testid="palette-input"
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setIdx((i) => Math.min(filtered.length - 1, i + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setIdx((i) => Math.max(0, i - 1));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            choose(filtered[idx]);
          }
        }}
      />
      <ul className="palette-list" ref={list} role="listbox">
        {filtered.map((it, i) => (
          <li
            key={it.id}
            role="option"
            aria-selected={i === idx}
            className={cx(i === idx && 'active')}
            onMouseEnter={() => setIdx(i)}
            onClick={() => choose(it)}
          >
            <span>{it.label}</span>
            {it.hint && <span className="muted small">{it.hint}</span>}
          </li>
        ))}
        {!filtered.length && <li className="muted">{emptyText ?? 'No matches'}</li>}
      </ul>
    </Modal>
  );
}

/** Subsequence match score: consecutive and early matches score higher. 0 = no match. */
export function fuzzy(text: string, q: string): number {
  if (text.includes(q)) return 100 - text.indexOf(q);
  let ti = 0;
  let score = 0;
  let streak = 0;
  for (const ch of q) {
    const found = text.indexOf(ch, ti);
    if (found < 0) return 0;
    streak = found === ti ? streak + 1 : 0;
    score += 1 + streak;
    ti = found + 1;
  }
  return score;
}
