export const DEFAULT_LOCAL_CONTEXT_WINDOW = 16384;
export const DEFAULT_CLOUD_CONTEXT_WINDOW = 128000;

const K128 = 131072;
const K256 = 262144;
const M1 = 1000000;

function clean(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * Best-effort context-window metadata for cloud/router models. Local models
 * are runtime-configured by the user/server, so they intentionally stay on
 * the conservative 16k default unless Settings supplies config.contextWindow.
 */
export function inferContextWindow(config = {}) {
  const category = clean(config.category);
  if (category === 'local') return DEFAULT_LOCAL_CONTEXT_WINDOW;

  const provider = clean(config.providerName || config.type || config.label);
  const model = clean(config.model);

  if (!model) return DEFAULT_CLOUD_CONTEXT_WINDOW;

  // OpenAI
  if (model.includes('gpt-5.5-pro')) return 1050000;
  if (/^gpt-5(?:[.\-]|$)/.test(model) || model.includes('/gpt-5')) return 400000;

  // Anthropic Claude
  if (/claude-(?:fable-5|mythos-5|mythos|opus-4-[6-8]|sonnet-4-6)/.test(model)) return M1;
  if (model.includes('claude-')) return 200000;

  // Google Gemini
  if (/gemini-(?:3|3\.|2\.5)/.test(model)) return M1;

  // Cloudflare Workers AI
  if (provider === 'cloudflare' && model.includes('@cf/zai-org/glm-5.2')) return K256;

  // Mistral
  if (/mistral-medium-(?:3\.5|2604)/.test(model)) return K256;

  // DeepSeek
  if (model.includes('deepseek-v4')) return M1;

  // xAI
  if (model.includes('grok-4.3')) return M1;

  // Groq-hosted common models and OpenAI open-weight GPT-OSS models.
  if (model.includes('gpt-oss')) return K128;
  if (provider === 'groq' && /(?:llama-3\.[13]|compound)/.test(model)) return K128;

  // NVIDIA NIM defaults in WebBrain.
  if (/(?:nemotron.*49b|llama-3[._-]3-nemotron|llama-3\.1-8b)/.test(model)) return K128;

  // MiniMax direct and OpenRouter slugs.
  if (/minimax.*m3/.test(model)) return M1;
  if (/minimax.*(?:m2\.7|m2\.5|m2\.1|m2)(?:-|$|\/|\.)/.test(model) || model.includes('minimax-01')) {
    return 204800;
  }

  // Alibaba / Qwen direct models and OpenRouter Qwen slugs.
  if (model.includes('qwen3.7-plus')) return M1;
  if (model.includes('qwen3.7-max')) return K256;
  if (model.includes('qwen3-max')) return K256;
  if (/qwen(?:3\.5)?-(?:plus|turbo)/.test(model)) return M1;
  if (model.includes('qwen-max')) return 32768;
  if (/qwen3-(?:235b|30b|32b|next)/.test(model)) return K128;

  return DEFAULT_CLOUD_CONTEXT_WINDOW;
}
