import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { get, post } from '../api';
import { Modal, useToast } from './ui';
import { errMsg } from '../util';

interface Template {
  id: string;
  name: string;
  description: string;
  audience: string;
}

export function TemplatePicker({ workspaceId, folderId, onClose }: { workspaceId: string; folderId: string | null; onClose: () => void }) {
  const { data = [] } = useQuery({ queryKey: ['templates'], queryFn: () => get<Template[]>('/api/templates') });
  const [selected, setSelected] = useState('blank');
  const [name, setName] = useState('');
  const navigate = useNavigate();
  const toast = useToast();
  const groups = ['general', 'engineering', 'data-science'];
  const labels: Record<string, string> = { general: 'General', engineering: 'Software engineering', 'data-science': 'Data science' };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const d = await post('/api/documents', { workspaceId, folderId, name: name.trim() || undefined, templateId: selected });
      onClose();
      navigate(`/d/${d.id}`);
    } catch (err) {
      toast(errMsg(err), 'error');
    }
  };

  return (
    <Modal title="New document from template" onClose={onClose} wide>
      <form onSubmit={create}>
        <label className="field">
          <span>Document name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Untitled" autoFocus data-testid="template-name" />
        </label>
        {groups.map((g) => (
          <div key={g}>
            <h4>{labels[g]}</h4>
            <div className="template-grid">
              {data
                .filter((t) => t.audience === g)
                .map((t) => (
                  <label key={t.id} className={`template-card ${selected === t.id ? 'selected' : ''}`}>
                    <input type="radio" name="template" value={t.id} checked={selected === t.id} onChange={() => setSelected(t.id)} />
                    <strong>{t.name}</strong>
                    <span className="muted small">{t.description}</span>
                  </label>
                ))}
            </div>
          </div>
        ))}
        <div className="row-end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" type="submit" data-testid="template-create">
            Create
          </button>
        </div>
      </form>
    </Modal>
  );
}
