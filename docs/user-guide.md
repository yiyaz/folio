# User guide

## Writing

Folio documents are Markdown. In **Live** mode, formatting is rendered as you type and the
Markdown marks reappear on the line you're editing. Use **Source** for raw text, **Split** for
source and preview side by side, and **Read** for the rendered page.

| Action | Shortcut |
|---|---|
| Bold / italic / inline code / strikethrough | `Ctrl/⌘+B`, `Ctrl/⌘+I`, `Ctrl/⌘+E`, `Ctrl/⌘+Shift+X` |
| Link | `Ctrl/⌘+K` |
| Heading 1–3 | `Ctrl/⌘+Alt+1..3` |
| Bulleted / numbered / task list | `Ctrl/⌘+Shift+8 / 7 / 9` |
| Block menu | type `/` at the start of a line |
| Quick open | `Ctrl/⌘+P` |
| Command palette | `Ctrl/⌘+K` (outside the editor) or the **Commands** button |

Paste or drop images and files into the editor to upload them. Notebooks (`.ipynb`) and data files
(`.csv`, `.parquet`) become live previews automatically.

## Linking ("pinpointing") between documents

| Syntax | Links to |
|---|---|
| `[[Design]]` | the document named *Design* |
| `[[Design\|our design]]` | the same, displayed as *our design* |
| `[[Design#Goals]]` | the *Goals* heading in *Design* |
| `[[Design#^key-fact]]` | a specific paragraph: put ` ^key-fact` at the end of that paragraph |
| `[[#Goals]]` | a heading in the current document |

Type `[[` for autocomplete. Every document lists its **backlinks** (with the linking sentence)
and any **broken links**. Renaming a document updates links to it in all other documents.
Ctrl/⌘-click a link on the line you're editing to follow it. Clicking a link to a document that
doesn't exist offers to create it.

## People, tags and sharing

- `@username` mentions someone. They get a notification (and an e-mail, unless they've turned
  it off). If they can't open the document, Folio offers to share it with them.
- `#tag` or front-matter `tags: [a, b]` tags a document. Nested tags such as `#ml/churn` are
  listed under `#ml`.
- **Share** gives individuals view, comment or edit access. Sharing a folder passes access to
  everything inside it. A **public link** gives read-only access without signing in.
- Workspace members (Workspace page) get a role on everything in the workspace. Inviting an
  e-mail address that has no account sends an invitation.
- Select text and click **💬 Comment** to start a thread anchored to that text.

## Blocks for engineers and data scientists

````markdown
$E = mc^2$ and $$\int_0^1 x\,dx$$             KaTeX math

```mermaid                                     diagrams (also: dot/graphviz, plantuml)
flowchart LR
  A --> B
```

```vega-lite                                   charts (data inline or from an attachment URL)
{"data": {"values": [{"x": "a", "y": 3}]}, "mark": "bar",
 "encoding": {"x": {"field": "x"}, "y": {"field": "y", "type": "quantitative"}}}
```

```csv                                         sortable, filterable table
name,score
a,1
```

```dataset                                     preview an uploaded CSV/Parquet file
src: /api/attachments/<id>
limit: 200
```

```notebook                                    embed (some) cells of an uploaded .ipynb
src: /api/attachments/<id>
cells: 2-4
```

```python run                                  runs in your browser (Pyodide)
import statistics; print(statistics.mean([1, 2, 3]))
```
````

A link on its own line to a GitHub PR, issue or code permalink (`…/blob/<sha>/file.py#L10-L20`),
or to a Jira issue, is shown as a rich card.

**Templates** (sidebar → *New from template*): ADR, RFC/design doc, incident postmortem,
experiment log, model card, meeting notes.

**Git sync** (Workspace page): push the workspace as Markdown files to a Git repository, or pull
changes made there.

**CLI**: create an API token under Settings, then:

```bash
folio login --url https://docs.example.com --token folio_…
folio pull <workspace-id> ./docs        # all documents as Markdown
folio push ./docs --workspace <id>      # create or update from local files
./run-benchmarks | folio new <workspace-id> "Benchmark $(date +%F)"   # e.g. from CI
```
