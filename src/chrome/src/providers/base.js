import { inferContextWindow } from './context-windows.js';

/**
 * Base LLM Provider — all providers implement this interface.
 */
export class BaseLLMProvider {
  constructor(config = {}) {
    this.config = config;
  }

  get name() {
    return 'base';
  }

  /**
   * Send a chat completion request.
   * @param {Array<{role: string, content: string}>} messages
   * @param {Object} options - { tools, temperature, maxTokens, stream }
   * @returns {Promise<{content: string, reasoningContent?: string, toolCalls: Array|null, usage: Object|null}>}
   */
  async chat(messages, options = {}) {
    throw new Error('chat() not implemented');
  }

  /**
   * Stream a chat completion request.
   * @param {Array<{role: string, content: string}>} messages
   * @param {Object} options
   * @yields {{type: 'text'|'tool_call'|'done', content: string}}
   */
  async *chatStream(messages, options = {}) {
    throw new Error('chatStream() not implemented');
  }

  /**
   * Check if this provider supports tool/function calling.
   */
  get supportsTools() {
    return false;
  }

  /**
   * Check if this provider supports image inputs (vision).
   */
  get supportsVision() {
    return false;
  }

  /**
   * Approximate context window (in tokens) for the active model. The agent
   * uses this to decide when to auto-compact the conversation ("Context
   * automatically compacted"): once the running input-token count crosses a
   * fraction of this window, older turns are summarized away.
   *
   * Providers can pass an exact value via `config.contextWindow` (e.g. a
   * 16k local model, or a 200k cloud model). Otherwise the default is
   * model-aware for known cloud/router models and category-aware otherwise.
   * Local backends default to a conservative 16k because the actual runtime
   * context depends on how the server/model was launched. Set
   * `config.contextWindow` in Settings to lift that cap for large-window local
   * models.
   */
  get contextWindow() {
    const n = Number(this.config.contextWindow);
    if (Number.isFinite(n) && n > 0) return n;
    return inferContextWindow(this.config);
  }

  /**
   * Whether this provider is running a small/local model that benefits from
   * a compact system prompt. When true, the agent uses SYSTEM_PROMPT_ACT_COMPACT
   * instead of the full SYSTEM_PROMPT_ACT to save context budget.
   */
  get useCompactPrompt() {
    return !!this.config.useCompactPrompt;
  }

  /**
   * Prompt tier for this provider: 'compact' | 'mid' | 'full'. Drives both
   * which ACT system prompt and which tool set the agent uses.
   *
   * Cloud providers are always 'full' — the tier knob is a small-model
   * concern, exposed only for local and OpenRouter providers. An explicit
   * config.promptTier always wins; failing that the legacy boolean
   * useCompactPrompt maps to 'compact'; failing that everything (including
   * local providers) defaults to 'full'.
   *
   * Local used to default to 'mid' on the theory that fewer tools helps a
   * smaller model. Measured against qwen3.6-35b-a3b via
   * test/llm/run-scenarios.mjs (100-scenario suite, tier=full vs
   * tier=compact): full scored 53/100 ideal with zero empty-output
   * failures; compact scored 44/100 with 6 genuine empty-output failures
   * (finish_reason:"stop", blank content, no tool call). Fewer tools did
   * not help this model — it did measurably worse. 'mid' also silently
   * dropped drag_drop/hover from the tool list with no user-visible
   * indication why those actions "didn't work". Users who want a smaller
   * prompt for a genuinely weak model can still set promptTier explicitly
   * in the provider's settings.
   */
  get promptTier() {
    if (this.config.category === 'cloud') return 'full';
    const t = this.config.promptTier;
    if (t === 'compact' || t === 'mid' || t === 'full') return t;
    if (this.config.useCompactPrompt) return 'compact';
    return 'full';
  }

  /**
   * Test the connection to this provider.
   * @returns {Promise<{ok: boolean, error?: string, model?: string}>}
   */
  async testConnection() {
    try {
      const res = await this.chat([{ role: 'user', content: 'Hi' }], { maxTokens: 5 });
      return { ok: true, model: this.config.model };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}
