export default /* sql */ `
-- Where each document's readable copy currently lives in storage (library/ mirror).
-- No foreign key on purpose: when a document is deleted we still need the key to remove the file.
CREATE TABLE library_entries (
  document_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  key text NOT NULL,
  source_hash text NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX library_entries_ws ON library_entries(workspace_id);

ALTER TABLE workspaces ADD COLUMN library_synced_at timestamptz;
ALTER TABLE workspaces ADD COLUMN library_dir text;
`;
