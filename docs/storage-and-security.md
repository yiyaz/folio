# Storage layout and restricted documents

This document describes **where Folio keeps files** (and how to get them back without the
application) and the **security concept for documents that only certain people may see**.

## 1. Where files are stored

All files live in one storage location: a directory (`STORAGE_DRIVER=fs`, `STORAGE_FS_ROOT`)
or an S3-compatible bucket (`STORAGE_DRIVER=s3`, `S3_BUCKET`). An optional `STORAGE_PREFIX`
(e.g. `folio/prod`) puts everything under a sub-path, so several deployments can share a bucket.
Admins see the exact paths under **Workspace → Where your files are stored** (or
`GET /api/workspaces/:id/storage`).

```
<STORAGE_PREFIX>/
├── library/                                  ← human-readable copy, for people and backups
│   └── ML Platform (3f2a9c1e)/                  one folder per workspace: "<name> (<id prefix>)"
│       ├── _manifest.json                       index: id, name, path, restricted flag of every file
│       ├── Notes.md                             latest content, plain Markdown, id in front matter
│       └── Design docs/
│           ├── Feature Store.md
│           └── Salaries.md.folio-encrypted      restricted document (encrypted, see §2)
├── workspaces/<workspace id>/
│   ├── blobs/<document id>/<blob id>.md         every saved version; never modified (source of truth)
│   └── attachments/<attachment id>[.<n>]        uploaded images and files
└── avatars/<user id>
```

**`library/`** mirrors each workspace as ordinary folders and `.md` files, named after the
workspace, folders and documents. Each file starts with the document's stable id in YAML front
matter:

```markdown
---
id: 1b0c3e9e-6f6c-4d51-9d40-0f2a8b7c5a11
---

# Feature Store

…
```

Names are made safe for every operating system (`Q3: goals?` → `Q3_ goals_.md`). The library is
updated after every save, rename, move, trash or restore. A reconcile pass runs with the hourly
maintenance (one replica at a time), after folder and workspace changes, and on demand ("Check &
repair library now" or `node dist/admin-cli.js library:rebuild`). It rewrites missing or outdated
files and removes strays, so the library heals itself after crashes or manual tampering.
Set `LIBRARY_ENABLED=false` to turn the mirror off.

**`workspaces/*/blobs/`** is what the application reads. Every save writes a _new_ immutable
object, and the database switches to it in the same transaction that bumps the version, so a
crash can never leave half-written content. Version history is kept here.

### Getting files back

| Situation                      | What to do                                                                                                                                                                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Folio is up                    | Workspace → _Download .zip_, or `folio pull <workspace-id> ./backup` (CLI).                                                                                                                                                         |
| Folio is down, storage is fine | Copy the library folder: `aws s3 sync s3://<bucket>/<prefix>/library/ ./restore` (S3) or `cp -r <STORAGE_FS_ROOT>/library ./restore` (disk). It is plain Markdown.                                                                  |
| Database lost, storage fine    | Create a workspace and import the library folder (Workspace → _Import files_, or `folio push ./restore/<workspace> --workspace <id>`). Front-matter ids keep documents stable. Version history and comments are not in the library. |
| Restricted files               | `node dist/admin-cli.js decrypt "<file>.md.folio-encrypted" --out file.md`. Needs only the deployment's key configuration (§2.4), not the database.                                                                                 |

Back up the bucket or disk with versioning enabled, and the database with the usual tools.
Bucket versioning plus the library means a deleted or overwritten document can always be found.

## 2. Restricted documents: security concept

### 2.1 Goal and threat model

Some documents (HR, salaries, legal, security incidents, unreleased results) must be readable only
by named people, even inside a workspace whose admins could otherwise read everything.

| Threat                                                            | Control                                                                                                                                                                              |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Workspace members, admins and even the workspace owner reading it | **Deny-by-default access**: workspace roles and folder shares grant nothing; only the document's owner and explicitly listed people can open it (§2.2).                              |
| Someone with access to the bucket, disk, library or backups       | **Envelope encryption at rest** (§2.3): content, every version, attachments and the library copy are encrypted; database fields that would leak content are encrypted or not stored. |
| A database dump or backup leaking                                 | No plaintext title or search index; comment bodies and quoted text are encrypted; data keys are stored only wrapped by a key the database never sees.                                |
| Content leaving through side channels                             | Excluded from zip exports, Git sync, public links, notification/e-mail excerpts and AI assist.                                                                                       |
| Re-sharing by recipients                                          | Only the owner can share, copy (duplicate) or lift the restriction.                                                                                                                  |
| Tampering or swapping ciphertext between documents                | AES-GCM authentication with the document id bound as associated data; failures return an integrity error and are logged.                                                             |
| Unnoticed access                                                  | **Audit log** of every view, revision view, attachment view, single-document export, share change and classification change, visible to the owner (§2.5).                            |
| A compromised application server or a malicious operator          | **Not covered** by server-side encryption: the server must hold keys to render, index and serve. See §2.7 (end-to-end tier).                                                         |

### 2.2 Access rules

- Any editor can **restrict** a document (making it stricter is always allowed). The person who
  restricts keeps access (they are added as an editor if they aren't the owner).
- Effective access to a restricted document = the **owner** (its creator) + **direct document
  permissions**. Workspace membership (any role, including owner/admin) and folder shares are
  ignored. The document disappears from their tree, search, tags, recents and backlinks; its URL
  returns 404.
- Only the owner can **share** it, **duplicate** it, see the **access log**, or **lift** the
  restriction. Lifting decrypts everything and restores normal workspace access.
- Restricted documents keep their wiki links and backlinks for people who can see both ends.

### 2.3 Encryption design (envelope encryption)

```
 Key-encryption key (KEK)  ── lives in FOLIO_KEYS or HashiCorp Vault, never in DB or storage
        │ wraps (AES-256-GCM)
        ▼
 Data-encryption key (DEK) ── random 256-bit key per document; stored only wrapped
        │ encrypts (AES-256-GCM, 96-bit random IV, AAD = "folio:v1:<kind>:<document id>")
        ▼
 Content: every version · attachments · comment bodies and quoted text · library copy
```

- **Per-document keys** limit the blast radius and make classification changes and key
  rotation cheap.
- **Self-contained file format.** Each encrypted file is a small JSON envelope carrying the
  wrapped DEK, the KEK id, IV, tag and ciphertext. It can therefore be decrypted from a backup
  with only the KEK; no database is needed:
  ```json
  {
    "folio": "encrypted",
    "v": 1,
    "alg": "AES-256-GCM",
    "doc": "<id>",
    "kind": "document",
    "kek": "k2027",
    "dek": "<wrapped>",
    "iv": "…",
    "tag": "…",
    "ct": "…"
  }
  ```
- **Classification changes are atomic.** All versions, attachments and comments are
  re-written encrypted (or decrypted) and switched over in one transaction; the old copies are
  deleted afterwards. Saves that race with a classification change are detected under the row
  lock and retried, so no plaintext version can slip in.
- Unwrapped DEKs are cached in memory for up to 5 minutes (max 1,000) to avoid a key-service
  round trip on every autosave.

### 2.4 Key management

| `KEY_PROVIDER`               | KEK location                                                                                       | Use for                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `local` with `FOLIO_KEYS`    | Kubernetes Secret / environment: `id:base64key[,id:base64key…]`; first entry is active             | Most deployments                                                                 |
| `local` without `FOLIO_KEYS` | Derived from `APP_SECRET` (HKDF)                                                                   | Evaluation only. **Changing `APP_SECRET` makes restricted documents unreadable** |
| `vault`                      | HashiCorp Vault Transit key (`VAULT_ADDR`, `VAULT_TOKEN`, `VAULT_TRANSIT_KEY`); never leaves Vault | Regulated environments, HSM-backed keys, central audit of key use                |

- **Generate a key:** `node dist/admin-cli.js keys:generate`.
- **Rotate:** put the new key first in `FOLIO_KEYS` (keep the old one after it), restart, then
  run `node dist/admin-cli.js keys:rotate`. This re-wraps every DEK and rewrites file headers;
  the ciphertext is unchanged. Remove the old key once rotation reports no errors. With Vault,
  rotate the transit key in Vault.
- **Back up the keys separately from the data.** Losing every copy of the KEK means losing the
  restricted documents. That is the point of the design, and also the risk.

### 2.5 Audit log

Recorded in the append-only `audit_log` table with actor, time, IP and user agent:
`document.view`, `document.revision_view`, `document.export`, `attachment.view`,
`permission.granted`, `permission.revoked`, `document.classified`, `document.declassified`.
Owners see it in the Share dialog (_View access log_). Ship the table to your SIEM for
retention and alerting.

### 2.6 What is still visible (metadata)

Encryption protects **content**. To keep the product usable, these stay in plaintext in the
database: document **name**, folder, owner, timestamps, sizes, who has access, outgoing
link targets and tags (used for backlinks and tag pages, shown only to people with access), and
the audit log. Pick names accordingly ("HR-2027-07" instead of "Layoffs Q3"). Copies made
_before_ a document was restricted can remain in storage-versioning history and backups until
they expire.

### 2.7 Roadmap: stronger tiers

| Capability                                                                                                                                                   | Why                                                                                      | Trade-off                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **End-to-end encryption ("Confidential")** for selected documents: WebCrypto in the browser, per-user key pairs, DEK wrapped for each recipient's public key | Protects against a compromised server or operator (zero knowledge)                       | No server-side search, previews, library plaintext, Git sync or AI; key recovery needs user key escrow or recovery codes |
| Per-document KMS keys (AWS KMS / GCP KMS / Vault)                                                                                                            | **Crypto-shredding**: destroying one key makes every copy, including backups, unreadable | Key-service cost and quota per document                                                                                  |
| Step-up authentication (re-enter password / MFA) before opening restricted documents                                                                         | Stolen-session protection                                                                | Friction                                                                                                                 |
| Restricted folders (new documents inherit the classification)                                                                                                | Convenience for whole areas like HR                                                      | More rules to explain                                                                                                    |
| Admin break-glass with dual approval and alerting                                                                                                            | Legal hold / owner leaves the company                                                    | Must be tightly governed                                                                                                 |
| Viewer watermarking and copy/print/download controls                                                                                                         | Deters leaks via screenshots                                                             | Not a hard control                                                                                                       |
| AWS KMS / GCP KMS providers                                                                                                                                  | Native cloud key management                                                              | Implement behind the existing `KeyProvider` interface                                                                    |
