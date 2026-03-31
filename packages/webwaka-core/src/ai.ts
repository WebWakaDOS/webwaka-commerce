/**
 * @webwaka/core — OpenRouter AI Abstraction
 * Vendor-neutral AI client — routes to any LLM via OpenRouter.
 * Cloudflare Workers compatible (fetch only, no Node.js APIs).
 */

export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiCompletionOptions {
  model?: string;
  messages: AiMessage[];
  maxTokens?: number;
  temperature?: number;
}

export interface AiCompletionResult {
  content: string;
  model: string;
  tokensUsed: number;
  error?: string;
}

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = 'openai/gpt-4o-mini';

export class OpenRouterClient {
  private apiKey: string;
  private defaultModel: string;

  constructor(apiKey: string, defaultModel: string = DEFAULT_MODEL) {
    this.apiKey = apiKey;
    this.defaultModel = defaultModel;
  }

  async complete(opts: AiCompletionOptions): Promise<AiCompletionResult> {
    const model = opts.model ?? this.defaultModel;

    try {
      const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://webwaka.com',
          'X-Title': 'WebWaka Commerce',
        },
        body: JSON.stringify({
          model,
          messages: opts.messages,
          ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => 'unknown');
        return { content: '', model, tokensUsed: 0, error: `HTTP ${res.status}: ${text}` };
      }

      const body = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
        model?: string;
        usage?: { total_tokens?: number };
      };

      const content = body.choices?.[0]?.message?.content ?? '';
      const tokensUsed = body.usage?.total_tokens ?? 0;

      return { content, model: body.model ?? model, tokensUsed };
    } catch (err) {
      return {
        content: '',
        model,
        tokensUsed: 0,
        error: err instanceof Error ? err.message : 'Network error',
      };
    }
  }
}

export function createAiClient(apiKey: string, defaultModel?: string): OpenRouterClient {
  return new OpenRouterClient(apiKey, defaultModel);
}
