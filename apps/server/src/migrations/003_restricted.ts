export default /* sql */ `
-- Restricted documents: deny-by-default access and envelope encryption at rest.
ALTER TABLE documents ADD COLUMN classification text NOT NULL DEFAULT 'standard' CHECK (classification IN ('standard', 'restricted'));
-- per-document data key, wrapped (encrypted) by a key-encryption key from the key provider
ALTER TABLE documents ADD COLUMN dek_wrapped text;
ALTER TABLE documents ADD COLUMN kek_id text;
CREATE INDEX documents_restricted ON documents (workspace_id) WHERE classification = 'restricted';

-- comment bodies on restricted documents are encrypted too
ALTER TABLE comments ADD COLUMN encrypted boolean NOT NULL DEFAULT false;
ALTER TABLE attachments ADD COLUMN encrypted boolean NOT NULL DEFAULT false;

-- append-only audit trail for sensitive actions
CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid NOT NULL,
  workspace_id uuid,
  ip text,
  user_agent text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_log_resource ON audit_log (resource_id, at DESC);
CREATE INDEX audit_log_actor ON audit_log (actor_id, at DESC);
`;
