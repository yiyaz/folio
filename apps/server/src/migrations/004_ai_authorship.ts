export default /* sql */ `
-- Character-level authorship of the current content and of every revision (see @folio/markdown authorship).
ALTER TABLE documents ADD COLUMN authorship jsonb;
ALTER TABLE revisions ADD COLUMN authorship jsonb;

-- Every AI generation: provenance for attribution (prompt, model, context) and the output used to
-- verify that text a client attributes to the AI really came from it.
CREATE TABLE ai_generations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
  model text NOT NULL,
  prompt text NOT NULL,
  context jsonb NOT NULL DEFAULT '[]'::jsonb,
  omitted jsonb NOT NULL DEFAULT '[]'::jsonb,
  output text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed', 'refused', 'cancelled')),
  input_tokens integer,
  output_tokens integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX ai_generations_user ON ai_generations (user_id, created_at DESC);
CREATE INDEX ai_generations_document ON ai_generations (document_id);
`;
