import Anthropic from '@anthropic-ai/sdk';
import type { Config } from '../config.js';

export interface ContextDocument {
  id: string;
  name: string;
  content: string;
}

export interface GenerateRequest {
  system: string;
  prompt: string;
  context: ContextDocument[];
  signal?: AbortSignal;
}

export interface GenerateResult {
  text: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /** True when the output was cut off by the token limit. */
  truncated: boolean;
}

/** The model declined (e.g. safety classifiers) and no fallback model completed it. */
export class AiRefusedError extends Error {}

/** A language model that writes Markdown, streaming text as it is produced. */
export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  generate(req: GenerateRequest, onText: (delta: string) => void): Promise<GenerateResult>;
}

/** Context documents as one user content block (cacheable: it precedes the varying prompt). */
export function contextBlock(docs: ContextDocument[]): string {
  const esc = (s: string) => s.replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c]!);
  return `<documents>\n${docs.map((d) => `<document name="${esc(d.name)}" id="${d.id}">\n${d.content}\n</document>`).join('\n')}\n</documents>`;
}

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  private client: Anthropic;
  constructor(
    apiKey: string,
    readonly model: string,
    private effort: Config['AI_EFFORT'],
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async generate(req: GenerateRequest, onText: (delta: string) => void): Promise<GenerateResult> {
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    if (req.context.length) content.push({ type: 'text', text: contextBlock(req.context), cache_control: { type: 'ephemeral' } });
    content.push({ type: 'text', text: req.prompt });
    const stream = this.client.beta.messages.stream(
      {
        model: this.model,
        max_tokens: 64000,
        betas: ['server-side-fallback-2026-07-01'],
        // if the primary model declines, the API continues on a fallback model in the same stream
        fallbacks: 'default',
        output_config: { effort: this.effort },
        system: req.system,
        messages: [{ role: 'user', content }],
      } as unknown as Anthropic.Beta.MessageCreateParamsStreaming,
      { signal: req.signal },
    );
    let text = '';
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        text += event.delta.text;
        onText(event.delta.text);
      }
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') throw new AiRefusedError('The AI declined this request');
    return {
      text,
      model: final.model,
      inputTokens: final.usage?.input_tokens ?? null,
      outputTokens: final.usage?.output_tokens ?? null,
      truncated: final.stop_reason === 'max_tokens',
    };
  }
}

/**
 * Deterministic stand-in used by tests and local demos (AI_PROVIDER=fake). It streams a short
 * Markdown document that mentions the prompt and links every context document.
 */
export class FakeProvider implements LlmProvider {
  readonly name = 'fake';
  readonly model = 'fake-model';
  readonly requests: GenerateRequest[] = [];
  constructor(private delayMs = 2) {}

  async generate(req: GenerateRequest, onText: (delta: string) => void): Promise<GenerateResult> {
    this.requests.push(req);
    if (/\brefuse\b/i.test(req.prompt)) throw new AiRefusedError('The AI declined this request');
    const topic = req.prompt.replace(/\s+/g, ' ').trim().slice(0, 60);
    const links = req.context.map((d) => `[[${d.name}]]`).join(', ');
    const text =
      (/new document/.test(req.system) ? `# ${topic.charAt(0).toUpperCase()}${topic.slice(1)}\n\n` : '') +
      `This draft covers ${topic}. It was written by the assistant.\n\n` +
      (links ? `It draws on ${links}.\n\n` : '') +
      `- First key point about ${topic}.\n- Second key point.\n`;
    for (let i = 0; i < text.length; i += 12) {
      if (req.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      onText(text.slice(i, i + 12));
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    }
    return { text, model: this.model, inputTokens: 100, outputTokens: Math.ceil(text.length / 4), truncated: false };
  }
}

export function createProvider(cfg: Config): LlmProvider | null {
  if (cfg.AI_PROVIDER === 'fake') {
    if (cfg.NODE_ENV === 'production') throw new Error('AI_PROVIDER=fake is not allowed in production');
    return new FakeProvider(20);
  }
  if (cfg.ANTHROPIC_API_KEY) return new AnthropicProvider(cfg.ANTHROPIC_API_KEY, cfg.AI_MODEL, cfg.AI_EFFORT);
  return null;
}
