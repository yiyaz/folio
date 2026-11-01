export interface DocTemplate {
  id: string;
  name: string;
  description: string;
  audience: 'engineering' | 'data-science' | 'general';
  /** `{{date}}` and `{{title}}` and `{{author}}` are substituted on creation. */
  body: string;
}

export const BUILTIN_TEMPLATES: DocTemplate[] = [
  {
    id: 'blank',
    name: 'Blank document',
    description: 'An empty Markdown document.',
    audience: 'general',
    body: '# {{title}}\n\n',
  },
  {
    id: 'meeting-notes',
    name: 'Meeting notes',
    description: 'Attendees, agenda, decisions and action items.',
    audience: 'general',
    body: `---
tags: [meeting]
---
# {{title}}

**Date:** {{date}}
**Attendees:** @{{author}}

## Agenda
-

## Notes

## Decisions
-

## Action items
- [ ] @owner — task
`,
  },
  {
    id: 'adr',
    name: 'Architecture Decision Record',
    description: 'Capture an architectural decision, its context and consequences.',
    audience: 'engineering',
    body: `---
tags: [adr]
status: proposed
date: {{date}}
deciders: [{{author}}]
---
# {{title}}

## Status
Proposed — supersedes: _none_

## Context
What is the issue that we're seeing that is motivating this decision or change?

## Decision
What is the change that we're proposing and/or doing?

## Options considered
| Option | Pros | Cons |
|---|---|---|
| A | | |
| B | | |

## Consequences
What becomes easier or more difficult to do because of this change?
`,
  },
  {
    id: 'rfc',
    name: 'RFC / design doc',
    description: 'Propose a technical design for review.',
    audience: 'engineering',
    body: `---
tags: [rfc]
status: draft
author: {{author}}
created: {{date}}
---
# {{title}}

## Summary
One paragraph explanation of the proposal.

## Motivation
Why are we doing this? What use cases does it support?

## Goals / Non-goals
- **Goal:**
- **Non-goal:**

## Detailed design

\`\`\`mermaid
flowchart LR
  Client --> API --> DB[(Database)]
\`\`\`

## Alternatives considered

## Rollout & migration

## Open questions
- [ ]
`,
  },
  {
    id: 'postmortem',
    name: 'Incident postmortem',
    description: 'Blameless incident review with timeline and action items.',
    audience: 'engineering',
    body: `---
tags: [postmortem, incident]
severity: SEV-2
date: {{date}}
---
# {{title}}

## Summary
_What happened, impact, duration._

## Impact
- Users affected:
- Duration:

## Timeline (UTC)
| Time | Event |
|---|---|
| 00:00 | Alert fired |

## Root cause

## What went well

## What went wrong

## Action items
- [ ] @owner — preventive fix #incident
`,
  },
  {
    id: 'experiment-log',
    name: 'Experiment log',
    description: 'Hypothesis, setup, results and conclusions for an ML/data experiment.',
    audience: 'data-science',
    body: `---
tags: [experiment]
date: {{date}}
owner: {{author}}
status: running
---
# {{title}}

## Hypothesis
We believe that ___ will result in ___, measured by ___.

## Setup
- **Dataset:**
- **Model / method:**
- **Metric:** $\\text{F1} = 2 \\cdot \\frac{P \\cdot R}{P + R}$

## Results

\`\`\`csv
run,learning_rate,f1
baseline,0.001,0.81
exp-1,0.003,0.84
\`\`\`

\`\`\`vega-lite
{
  "data": {"values": [{"run": "baseline", "f1": 0.81}, {"run": "exp-1", "f1": 0.84}]},
  "mark": "bar",
  "encoding": {"x": {"field": "run", "type": "nominal"}, "y": {"field": "f1", "type": "quantitative"}}
}
\`\`\`

## Analysis

\`\`\`python run
import statistics
scores = [0.81, 0.84]
print("mean f1:", statistics.mean(scores))
\`\`\`

## Conclusion & next steps
`,
  },
  {
    id: 'model-card',
    name: 'Model card',
    description: 'Document a trained model: intended use, data, metrics, limitations.',
    audience: 'data-science',
    body: `---
tags: [model-card]
model: {{title}}
version: 0.1.0
owner: {{author}}
updated: {{date}}
---
# Model card: {{title}}

## Model details
- **Type:**
- **Framework:**
- **Training date:** {{date}}

## Intended use
- **Primary use cases:**
- **Out-of-scope uses:**

## Training data

## Evaluation
| Metric | Value | Dataset |
|---|---|---|
| Accuracy | | |

## Ethical considerations & limitations

## Caveats and recommendations
`,
  },
];

export function applyTemplate(body: string, vars: { title: string; author: string; date?: string }): string {
  const date = vars.date ?? new Date().toISOString().slice(0, 10);
  return body.replaceAll('{{title}}', vars.title).replaceAll('{{author}}', vars.author).replaceAll('{{date}}', date);
}
