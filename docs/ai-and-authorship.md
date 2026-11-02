# AI writing and authorship

Folio can draft documents with a large language model, grounded in documents you choose, and it
records **who wrote every part of every document**: each person, and each AI generation (with
its prompt, model and context). Authorship is shown subtly while you read and write.

## 1. Generating with AI

**In the app:** sidebar → _✨ Write with AI_ (new document), or the _✨ AI_ toolbar button in a
document (insert at the cursor). The command palette has both too.

**Over the API** (session cookie or a personal API token):

```http
POST /api/ai/generate
{
  "prompt": "An onboarding guide for new data scientists",
  "workspaceId": "…",
  "context": { "documentIds": ["…", "…"] },        // or { "folderId": "…" } or { "workspace": true }
  "target": { "type": "new", "name": "Onboarding", "folderId": null },
            // or { "type": "append", "documentId": "…" }   add to the end of a document
            // or { "type": "text", "documentId": "…" }     just return text (the editor inserts it)
  "stream": false                                   // true = server-sent events: start, delta…, done | error
}
```

The response carries `generationId`, `text`, the created or updated `document`, and
`context.used` / `context.omitted`.

**From scripts / CI:**

```bash
folio generate <workspace-id> "Weekly status from the incident notes" --context-folder <folder-id> --name "Status $(date +%F)"
folio generate <workspace-id> "Summarize the design docs" --context-workspace --print
```

### Context: what the model sees

| Choice           | Documents shared                             |
| ---------------- | -------------------------------------------- |
| None             | Only the prompt                              |
| This document    | The open document                            |
| Choose documents | The ones you tick                            |
| This folder      | Everything in the folder and its sub-folders |
| Whole workspace  | Every document of the workspace you can read |

- Only documents the **requester can read** are ever used, and **restricted documents never are**
  (they are listed as not shared). Restricted documents also can't be the target of AI writing.
- Context is capped at `AI_CONTEXT_MAX_CHARS` (default 400,000 characters, about 100k tokens).
  Documents that don't fit are **reported, never silently truncated**.
- Documents are sent as reference data. The system prompt tells the model to treat them as
  data, not instructions (a prompt-injection guard), to cite them with `[[wiki links]]`, and not to
  invent facts.
- The context block is marked cacheable, so repeated generations over the same documents are
  cheaper and faster.

### Model and provider

Folio uses the Anthropic API (`ANTHROPIC_API_KEY`). The model is set by `AI_MODEL` (default
`claude-opus-5-5`) and `AI_EFFORT` (default `medium`). Output is streamed. If the primary model
declines a request, Anthropic's server-side fallback continues the answer on another model. A
request that is ultimately declined is reported as such and never saved. `AI_PROVIDER=fake`
gives a deterministic stand-in for tests and demos; it is refused in production.

## 2. Authorship

### What is recorded

Every document stores its **attribution**: which person or AI generation wrote each character
of the current text (`documents.authorship`), and the same for every revision.

- On every save, the server compares the new text with the previous version. Text that survives
  keeps its author, and new text belongs to whoever saved it. Typical edits are cheap: the common
  prefix and suffix are skipped before a character diff.
- **AI text** is attributed to the generation that produced it. When AI text is inserted in the
  editor, the browser sends _claims_ with the save. The server accepts a claim only if:
  1. the generation exists, finished, and was requested by **the same person**, and
  2. the claimed text **actually appears in that generation's output**.

  Otherwise the text counts as the saver's own. Nobody can attribute text to a coworker or
  pass off their own writing as AI.

- Edits inside AI text are split at character level, so changing one word of an AI sentence
  makes that word the editor's.
- Restoring a revision restores its attribution too, and duplicates keep attribution. Documents
  created before this feature are attributed to their creator.
- Each AI generation's prompt, model, context documents, requester, time and token usage are
  kept in `ai_generations` as provenance. When a document is restricted, the prompts and outputs
  of its generations are scrubbed, because they would be plaintext copies of its content.

### How it is shown

A toggle next to the document info (and a default under _Settings → Editor_):

| Mode             | What you see                                                                                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AI** (default) | AI-written text has a faint violet wash. A person's edits _inside_ an AI-written sentence are underlined in that person's colour, so even a one-word change is visible. |
| **Everyone**     | Additionally, every person's text has a faint underline in their colour.                                                                                                |
| Hidden           | No highlighting                                                                                                                                                         |

- Hovering shows who wrote it, for example "Written by AI (claude-opus-5-5) for Alice · 2 Nov"
  or "Written by Bob Martinez (edited AI text)".
- The **Authors** panel (👥) shows each contributor's share, the overall AI/people split, and for
  every AI passage the prompt, requester and context documents.
- The read view uses the same marking: the renderer tags text with its source offsets and the
  page aligns them, even where rendering drops indentation or escapes.
- **Public links** show AI-written text (with a one-line legend) but not which coworker wrote
  what.

## 3. API reference

| Endpoint                            | Purpose                                                                       |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| `POST /api/ai/generate`             | Generate (see above)                                                          |
| `GET /api/ai/status`                | Whether AI is configured; model; context budget                               |
| `GET /api/ai/generations/:id`       | Provenance of one generation (requester, or anyone who can read its document) |
| `GET /api/documents/:id/authorship` | Attribution, contributors' shares, people and generations                     |
| `PUT /api/documents/:id/content`    | Accepts `aiClaims: [{from, to, generationId}]`; returns the new `authorship`  |

The attribution format is defined in `packages/markdown/src/authorship.ts`:
`{ v: 1, authors: [...], runs: [[length, authorIndex], ...] }`, counted in UTF-16 code units.
