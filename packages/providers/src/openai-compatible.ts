import {
  LiwenError,
  mapHttpStatus,
  type Capabilities,
  type ContentBlock,
  type Message,
  type ModelRequest,
  type ModelStreamEvent,
  type Provider,
  type Runtime,
} from '@liwencode/core';
import { sseEvents } from './sse';

/**
 * OpenAI Chat Completions adapter (FR-012) — also serves DeepSeek and other
 * compatible endpoints via `baseUrl`. Wire format translation only; no
 * vendor SDK dependency.
 */

export interface OpenAICompatibleOptions {
  runtime: Runtime;
  baseUrl: string;
  apiKey: string;
  /** Provider id, e.g. 'deepseek' / 'openai-compatible'. */
  id?: string;
  models?: Record<string, Partial<Capabilities>>;
  requestTimeoutMs?: number;
}

interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

export function createOpenAICompatibleProvider(opts: OpenAICompatibleOptions): Provider {
  const id = opts.id ?? 'openai-compatible';
  return {
    id,
    capabilities(model: string): Capabilities {
      const overrides = opts.models?.[model] ?? {};
      return {
        contextWindow: 128_000,
        maxOutputTokens: 8_192,
        parallelToolCalls: true,
        thinking: 'none',
        promptCache: 'automatic',
        vision: false,
        structuredOutput: true,
        ...overrides,
      };
    },
    async *stream(req, { signal }): AsyncGenerator<ModelStreamEvent> {
      const body = JSON.stringify(toWire(req));
      let res;
      try {
        res = await opts.runtime.http.fetch(`${opts.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${opts.apiKey}`,
          },
          body,
          signal,
        });
      } catch (e) {
        throw mapNetworkError(e);
      }
      if (res.status !== 200) {
        const text = await res.text();
        throw mapHttpStatus(res.status, text);
      }

      // Assemble normalized events from the wire stream.
      const blocks: ContentBlock[] = [];
      const toolCalls = new Map<number, { id: string; name: string; args: string }>();
      const usage = { inputTokens: 0, outputTokens: 0 };
      let finishReason = 'stop';
      let emittedAny = false;

      for await (const data of sseEvents(res)) {
        if (data === '[DONE]') break;
        let chunk: {
      choices?: { delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        try {
          chunk = JSON.parse(data);
        } catch {
          throw new LiwenError({ code: 'LW-PRV-008', message: 'unparsable SSE chunk', details: { data: data.slice(0, 200) } });
        }
        if (chunk.usage !== undefined) {
          usage.inputTokens = chunk.usage.prompt_tokens ?? usage.inputTokens;
          usage.outputTokens = chunk.usage.completion_tokens ?? usage.outputTokens;
        }
        const choice = chunk.choices?.[0];
        if (choice === undefined) continue;
        if (choice.finish_reason !== null && choice.finish_reason !== undefined) finishReason = choice.finish_reason;
        const delta = choice.delta ?? {};

        if (delta.reasoning_content !== null && delta.reasoning_content !== undefined) {
          if (blocks[blocks.length - 1]?.type !== 'thinking') {
            blocks.push({ type: 'thinking', text: '' });
          }
          const last = blocks[blocks.length - 1]!;
          if (last.type === 'thinking') last.text += delta.reasoning_content;
          yield { type: 'block_delta', index: blocks.length - 1, delta: delta.reasoning_content };
          emittedAny = true;
        }
        if (delta.content !== null && delta.content !== undefined) {
          if (blocks[blocks.length - 1]?.type !== 'text') {
            blocks.push({ type: 'text', text: '' });
          }
          const last = blocks[blocks.length - 1]!;
          if (last.type === 'text') last.text += delta.content;
          yield { type: 'block_delta', index: blocks.length - 1, delta: delta.content };
          emittedAny = true;
        }
        for (const tc of delta.tool_calls ?? []) {
          const existing = toolCalls.get(tc.index);
          if (existing === undefined) {
            toolCalls.set(tc.index, {
              id: tc.id ?? `call_${tc.index}`,
              name: tc.function?.name ?? '',
              args: tc.function?.arguments ?? '',
            });
          } else {
            if (tc.function?.arguments !== undefined) existing.args += tc.function.arguments;
            if (tc.function?.name !== undefined && tc.function.name !== '') existing.name = tc.function.name;
          }
        }
      }

      for (const [index, tc] of [...toolCalls.entries()].sort(([a], [b]) => a - b)) {
        let input: unknown = {};
        try {
          input = tc.args === '' ? {} : JSON.parse(tc.args);
        } catch {
          input = { _raw: tc.args };
        }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
        void index;
      }

      if (!emittedAny && blocks.length === 0 && toolCalls.size === 0) {
        throw new LiwenError({ code: 'LW-PRV-007', message: 'stream ended without content' });
      }

      const messageId = `msg_${Date.now().toString(36)}`;
      const message: Message = {
        id: messageId,
        role: 'assistant',
        content: blocks,
        meta: { createdAt: Date.now() },
      };
      yield { type: 'usage', usage };
      yield {
        type: 'message_stop',
        stopReason: finishReason === 'tool_calls' ? 'tool_use' : finishReason === 'length' ? 'max_tokens' : 'end_turn',
        message,
      };
    },
  };
}

function toWire(req: ModelRequest): Record<string, unknown> {
  const messages: ChatMessage[] = [];
  if (req.system !== undefined) messages.push({ role: 'system', content: req.system });

  for (const m of req.messages) {
    if (m.role === 'assistant') {
      const text = m.content
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const toolUses = m.content.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
      messages.push({
        role: 'assistant',
        content: text === '' && toolUses.length > 0 ? null : text,
        ...(toolUses.length > 0
          ? {
              tool_calls: toolUses.map((b) => ({
                id: b.id,
                type: 'function' as const,
                function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
              })),
            }
          : {}),
      });
    } else {
      // user: text blocks merge; tool_result blocks become separate tool messages.
      const text = m.content
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (text !== '') messages.push({ role: 'user', content: text });
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          messages.push({
            role: 'tool',
            content: b.content
              .filter((c): c is Extract<ContentBlock, { type: 'text' }> => c.type === 'text')
              .map((c) => c.text)
              .join(''),
            tool_call_id: b.toolUseId,
          });
        }
      }
    }
  }

  return {
    model: req.model,
    messages,
    ...(req.tools !== undefined && req.tools.length > 0
      ? {
          tools: req.tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.inputSchema },
          })),
        }
      : {}),
    ...(req.maxOutputTokens !== undefined ? { max_tokens: req.maxOutputTokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    stream: true,
    stream_options: { include_usage: true },
  };
}

function mapNetworkError(e: unknown): LiwenError {
  const msg = e instanceof Error ? e.message : String(e);
  return new LiwenError({ code: 'LW-PRV-003', message: msg, cause: e });
}
