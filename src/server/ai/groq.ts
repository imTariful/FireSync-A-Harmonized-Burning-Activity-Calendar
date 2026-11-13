/**
 * Groq API transport + bounded function-calling loop.
 *
 * The Groq API is Groq-compatible: POST {base}/chat/completions with Bearer auth,
 * `tools` in function-declaration format and `tool` role responses. This is the only place the
 * API key is used. `createGroqClient` is the real transport; `runModelChat` takes an injected
 * `generate` function so tests can exercise tool calling, limits and malformed responses
 * without a network call or a key.
 */

import { AI_LIMITS, DEFAULT_GROQ_MODEL } from './config';

export interface ModelPart {
  text?: string;
  functionCall?: { callId?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; toolCallId?: string; response: Record<string, unknown> };
}

export interface ModelContent {
  role: 'user' | 'model';
  parts: ModelPart[];
}

export interface ModelGenerateParams {
  model: string;
  contents: ModelContent[];
  config: Record<string, unknown>;
  timeoutMs: number;
}

export interface ModelFunctionCall {
  /** Provider-assigned tool call id; required to pair tool responses on Groq-compatible APIs. */
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ModelGenerateResult {
  text: string;
  functionCalls: ModelFunctionCall[];
  /**
   * Raw model content parts to echo back verbatim on the next turn. Echoing the model's own
   * parts preserves call ids and any provider-specific fields across the round trip.
   */
  parts?: ModelPart[];
}

export type ModelGenerateFn = (params: ModelGenerateParams) => Promise<ModelGenerateResult>;

export type ProviderErrorCode = 'NOT_CONFIGURED' | 'TIMEOUT' | 'PROVIDER_ERROR' | 'BAD_RESPONSE' | 'RATE_LIMITED';

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: ProviderErrorCode,
    readonly status = 502
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface GroqConfig {
  apiKey: string | null;
  apiBase?: string;
}

export const GROQ_DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';
/** Reasoning models spend tokens thinking before answering; leave headroom above the text cap. */
const GROQ_MAX_TOKENS = 4096;

interface OpenAiToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAiMessage {
  role: string;
  content?: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
  name?: string;
}

/** Translate the internal content model into Groq-compatible chat messages. */
function toChatMessages(contents: ModelContent[], systemInstruction: unknown): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  if (typeof systemInstruction === 'string' && systemInstruction) {
    messages.push({ role: 'system', content: systemInstruction });
  }
  for (const content of contents) {
    if (content.role === 'model') {
      const text = content.parts.map((p) => p.text ?? '').join('');
      const toolCalls = content.parts
        .filter((p) => p.functionCall?.name)
        .map((p) => ({
          id: p.functionCall?.callId ?? '',
          type: 'function',
          function: { name: p.functionCall?.name, arguments: JSON.stringify(p.functionCall?.args ?? {}) },
        }));
      messages.push({
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    // user turn: text parts become user content; functionResponse parts become tool messages.
    const text = content.parts.map((p) => p.text ?? '').join('');
    if (text) messages.push({ role: 'user', content: text });
    for (const part of content.parts) {
      if (part.functionResponse) {
        messages.push({
          role: 'tool',
          tool_call_id: part.functionResponse.toolCallId ?? '',
          content: JSON.stringify(part.functionResponse.response ?? {}),
        });
      }
    }
  }
  return messages;
}

function toOpenAiTools(tools: unknown): Array<Record<string, unknown>> | undefined {
  const declarations = (tools as Array<{ functionDeclarations?: Array<Record<string, unknown>> }> | undefined)?.[0]
    ?.functionDeclarations;
  if (!Array.isArray(declarations) || declarations.length === 0) return undefined;
  return declarations.map((d) => ({
    type: 'function',
    function: {
      name: d.name,
      description: d.description,
      parameters: d.parameters,
    },
  }));
}

function safeProviderMessage(body: unknown, fallback: string): string {
  // The OpenAI-compatible endpoint normally returns { error: { message } }, but the
  // Groq backend sometimes wraps it as [ { error: { message } } ].
  const candidate = Array.isArray(body) ? body[0] : body;
  const message =
    candidate && typeof candidate === 'object' && 'error' in candidate
      ? String((candidate as { error?: { message?: unknown } }).error?.message ?? '')
      : '';
  return (message || fallback).slice(0, 400);
}

/**
 * Real transport. Uses fetch directly (no SDK dependency) against the Groq-compatible
 * Groq API. The key travels only in the Authorization header and is never logged.
 */
export function createGroqClient(config: GroqConfig): { generate: ModelGenerateFn } {
  const generate: ModelGenerateFn = async ({ model, contents, config: generationConfig, timeoutMs }) => {
      if (!config.apiKey) throw new ProviderError('No Groq API key is configured.', 'NOT_CONFIGURED', 503);
      const base = (config.apiBase ?? GROQ_DEFAULT_BASE_URL).replace(/\/+$/, '');

      // Providers retire model ids; if the configured one is gone, retry once on the
      // known-good default instead of failing the user's request.
      const candidates = model === DEFAULT_GROQ_MODEL ? [model] : [model, DEFAULT_GROQ_MODEL];
      let lastError: ProviderError | null = null;

      for (const candidate of candidates) {
        const body: Record<string, unknown> = {
          model: candidate,
          messages: toChatMessages(contents, generationConfig.systemInstruction),
          temperature: generationConfig.temperature ?? 0.2,
          max_tokens: GROQ_MAX_TOKENS,
        };
        const tools = toOpenAiTools(generationConfig.tools);
        if (tools) body.tools = tools;

        let response: Response;
        try {
          response = await fetch(`${base}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (err) {
          const name = err instanceof Error ? err.name : '';
          if (name === 'TimeoutError' || name === 'AbortError') {
            throw new ProviderError('The Groq request timed out.', 'TIMEOUT', 504);
          }
          throw new ProviderError(
            `Groq request failed: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`,
            'PROVIDER_ERROR',
            502
          );
        }

        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          const message = safeProviderMessage(payload, `HTTP ${response.status}`);
          const error =
            response.status === 429 || /rate limit|quota|resource exhausted/i.test(message)
              ? new ProviderError(`The Groq API rate limit or quota was reached: ${message}`, 'RATE_LIMITED', 429)
              : response.status === 401 || response.status === 403
                ? new ProviderError(`The Groq API rejected the request: ${message}`, 'PROVIDER_ERROR', 502)
                : new ProviderError(`Groq request failed: ${message}`, 'PROVIDER_ERROR', 502);
          // Only a missing-model error justifies trying the fallback; everything else is final.
          if (/does not exist|do not have access|invalid model/i.test(message) && candidate !== DEFAULT_GROQ_MODEL) {
            lastError = error;
            continue;
          }
          throw error;
        }

        const message = (payload as { choices?: Array<{ message?: OpenAiMessage }> })?.choices?.[0]?.message;
      const rawContent = message?.content;
      const text = (typeof rawContent === 'string' ? rawContent : '')
        .trim();
      const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
      const functionCalls: ModelFunctionCall[] = toolCalls
        .filter((call) => call?.function?.name)
        .map((call) => {
          let args: Record<string, unknown> = {};
          try {
            const parsed = JSON.parse(call.function?.arguments ?? '{}');
            if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>;
          } catch {
            args = {};
          }
          return { id: call.id, name: String(call.function?.name), args };
        });

      // Echo parts so call ids survive the round trip into the next request.
      const parts: ModelPart[] = [];
      if (text) parts.push({ text });
      for (const call of functionCalls) {
        parts.push({ functionCall: { callId: call.id, name: call.name, args: call.args } });
      }

      if (!text && functionCalls.length === 0) {
        throw new ProviderError('Groq returned no text and no tool calls.', 'BAD_RESPONSE', 502);
      }
      return { text, functionCalls, parts };
      }

      throw lastError ?? new ProviderError('Groq request failed.', 'PROVIDER_ERROR', 502);
  };

  return { generate: enqueueGroqCall(generate) };
}

// Groq's free tier is ~8k TPM shared across all requests; serialize calls so
// concurrent chat turns and tool-loop rounds do not trip the limit at once.
let groqQueue: Promise<unknown> = Promise.resolve();

function enqueueGroqCall(generate: ModelGenerateFn): ModelGenerateFn {
  return (args) => {
    const run = groqQueue.then(
      () => generate(args),
      () => generate(args)
    );
    groqQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };
}

export interface RunModelChatOptions {
  generate: ModelGenerateFn;
  model: string;
  systemInstruction: string;
  turns: ModelContent[];
  toolDeclarations?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  executeTool?: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  timeoutMs?: number;
}

export interface RunModelChatResult {
  text: string;
  rounds: number;
  toolCalls: Array<{ name: string; ok: boolean }>;
}

/** Provider-side transient failures worth one retry; client errors are never retried. */
function isTransientProviderError(err: unknown): boolean {
  return (
    err instanceof ProviderError &&
    err.code === 'PROVIDER_ERROR' &&
    /deadline|504|503|overloaded|unavailable|internal|try again|resource exhausted/i.test(err.message)
  );
}

// Must stay below the 60s request timeout so a waited-out retry can still finish.
const MAX_RATE_LIMIT_WAIT_MS = 45_000;

/**
 * Groq TPM limits report "Please try again in N.NNs" or "N.NNms". Return that wait
 * in ms when it is short enough to hold the request open; null means do not retry.
 */
function rateLimitRetryMs(err: unknown): number | null {
  if (!(err instanceof ProviderError) || err.code !== 'RATE_LIMITED') return null;
  const match = /try again in ([\d.]+)\s*(ms|s)\b/i.exec(err.message);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const ms = match[2].toLowerCase() === 'ms' ? value : value * 1000;
  return ms <= MAX_RATE_LIMIT_WAIT_MS ? Math.ceil(ms) + 250 : null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ask the model, execute any tool calls it requests, feed the results back, and stop after a
 * bounded number of rounds. Every failure mode (timeout, empty answer, too many rounds) is
 * explicit. Tool call ids are synthesised when a provider omits them so tool responses always
 * pair correctly on Groq-compatible APIs.
 */
export async function runModelChat(options: RunModelChatOptions): Promise<RunModelChatResult> {
  const { generate, model, systemInstruction, executeTool } = options;
  const timeoutMs = options.timeoutMs ?? AI_LIMITS.requestTimeoutMs;
  const contents: ModelContent[] = [...options.turns];
  const toolCalls: Array<{ name: string; ok: boolean }> = [];
  let executed = 0;
  let syntheticId = 0;

  const generationConfig: Record<string, unknown> = {
    systemInstruction,
    temperature: 0.2,
    maxOutputTokens: AI_LIMITS.maxOutputTokens,
  };
  if (options.toolDeclarations?.length && executeTool) {
    generationConfig.tools = [{ functionDeclarations: options.toolDeclarations }];
  }

  // F62 fix: establish one absolute request deadline covering provider calls, retries and tool executions.
  const overallTimeoutMs = options.timeoutMs ?? AI_LIMITS.requestTimeoutMs;
  const deadline = Date.now() + overallTimeoutMs;
  const remainingBudget = (): number => {
    const left = deadline - Date.now();
    if (left <= 0) {
      throw new ProviderError('The model request exceeded the overall time limit.', 'TIMEOUT', 504);
    }
    return left;
  };

  for (let round = 1; round <= AI_LIMITS.maxToolRounds; round += 1) {
    const callGenerate = () => {
      const ms = remainingBudget();
      return withTimeout(
        generate({ model, contents, config: generationConfig, timeoutMs: ms }),
        ms,
        () => new ProviderError('The model request exceeded the time limit.', 'TIMEOUT', 504)
      );
    };
    let result: ModelGenerateResult;
    try {
      result = await callGenerate();
    } catch (err) {
      // TPM rate limits carry an explicit "try again in N s" hint; wait it out once when
      // short, so back-to-back user questions do not surface a raw 429.
      const waitMs = rateLimitRetryMs(err);
      if (waitMs !== null) {
        if (Date.now() + waitMs >= deadline) {
          throw new ProviderError('The model request exceeded the time limit while waiting for rate limit reset.', 'TIMEOUT', 504);
        }
        await sleep(waitMs);
        result = await callGenerate();
      } else if (isTransientProviderError(err)) {
        // One retry for transient provider failures (deadline exceeded, overload, 5xx). A second
        // failure propagates unchanged so the route still answers with a truthful error.
        result = await callGenerate();
      } else {
        throw err;
      }
    }

    if (result.functionCalls.length === 0) {
      if (!result.text) throw new ProviderError('The model returned an empty answer.', 'BAD_RESPONSE', 502);
      return { text: result.text, rounds: round, toolCalls };
    }
    if (!executeTool) {
      throw new ProviderError('The model requested a tool but tools are not enabled here.', 'BAD_RESPONSE', 502);
    }

    // Normalise ids once so the echoed model turn and the tool responses always pair up.
    const calls = result.functionCalls.map((call) => ({
      ...call,
      id: call.id ?? `call_${syntheticId++}`,
    }));

    const responses: ModelPart[] = [];
    for (const call of calls) {
      remainingBudget();
      executed += 1;
      if (executed > AI_LIMITS.maxToolCalls) {
        throw new ProviderError('The model requested too many tool calls for one question.', 'BAD_RESPONSE', 502);
      }
      let toolResult: Record<string, unknown>;
      try {
        toolResult = await executeTool(call.name, call.args ?? {});
        const ok = toolResult.ok !== false;
        toolCalls.push({ name: call.name, ok });
        responses.push({
          functionResponse: { name: call.name, toolCallId: call.id, response: toolResult },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Tool execution failed.';
        toolCalls.push({ name: call.name, ok: false });
        responses.push({
          functionResponse: {
            name: call.name,
            toolCallId: call.id,
            response: { ok: false, error: message.slice(0, 300) },
          },
        });
      }
    }

    contents.push({
      role: 'model',
      // Echo the model's own parts so call ids (and any provider fields) survive the round
      // trip; fall back to reconstructing bare calls for older test doubles.
      parts:
        result.parts && result.parts.length > 0
          ? result.parts
          : calls.map((call) => ({
              functionCall: { callId: call.id, name: call.name, args: call.args },
            })),
    });
    contents.push({ role: 'user', parts: responses });
  }

  throw new ProviderError('The model did not finish within the tool-call budget.', 'BAD_RESPONSE', 502);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(onTimeout()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
