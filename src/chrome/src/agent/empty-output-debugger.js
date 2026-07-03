/**
 * Empty Output Debugger — diagnostic + auto-remediation for "agent emitted no output" errors.
 *
 * When the LLM returns empty content with no tool calls, this module:
 * 1. Diagnoses the root cause (reasoning budget, prompt size, model capability, etc.)
 * 2. Reports detailed diagnostic info to the user
 * 3. Automatically remediates by:
 *    - Switching to a simpler prompt (compact tier)
 *    - Reducing maxTokens
 *    - Emergency context trimming
 *    - Switching to a stronger provider (if available)
 *    - Breaking the task into smaller parts
 */

// Diagnostic categories
const DIAGNOSTIC_CATEGORIES = {
  REASONING_BUDGET_EXHAUSTED: 'reasoning_budget_exhausted',
  PROMPT_TOO_LARGE: 'prompt_too_large',
  MODEL_TOO_SMALL: 'model_too_small',
  CONTEXT_OVERFLOW: 'context_overflow',
  TOOL_SCHEMA_COMPLEX: 'tool_schema_complex',
  TASK_TOO_COMPLEX: 'task_too_complex',
  NETWORK_ERROR: 'network_error',
  UNKNOWN: 'unknown',
};

// Remediation actions
const REMEDIATION_ACTIONS = {
  SWITCH_COMPACT_PROMPT: 'switch_compact_prompt',
  REDUCE_MAX_TOKENS: 'reduce_max_tokens',
  EMERGENCY_TRIM_CONTEXT: 'emergency_trim_context',
  SWITCH_PROVIDER: 'switch_provider',
  BREAK_TASK_INTO_STEPS: 'break_task_into_steps',
  REDUCE_TOOL_COUNT: 'reduce_tool_count',
  INCREASE_STEP_LIMIT: 'increase_step_limit',
};

/**
 * Analyze an empty-output failure to determine the most likely root cause.
 * @param {Object} context - Diagnostic context from the agent loop
 * @returns {Object} Diagnosis with category, confidence, and details
 */
export function diagnoseEmptyOutput(context) {
  const {
    provider = null,
    promptSize = 0,
    contextWindow = 0,
    promptTier = 'mid',
    maxTokens = 4096,
    steps = 0,
    maxSteps = 130,
    lastContent = '',
    hasToolCalls = false,
    usage = null,
    messages = [],
    error = null,
  } = context;

  const diagnosis = {
    category: DIAGNOSTIC_CATEGORIES.UNKNOWN,
    confidence: 0,
    details: {},
    remediations: [],
  };

  // Check 1: Reasoning budget exhaustion (internal reasoning_tokens consuming output budget)
  if (usage) {
    const reasoningTokens = usage?.reasoning_tokens || 0;
    const outputTokens = usage?.completion_tokens || usage?.outputTokens || 0;
    const totalTokens = usage?.total_tokens || (reasoningTokens + outputTokens);

    if (reasoningTokens > 0 && totalTokens > 0) {
      const reasoningRatio = reasoningTokens / totalTokens;
      if (reasoningRatio > 0.7) {
        diagnosis.category = DIAGNOSTIC_CATEGORIES.REASONING_BUDGET_EXHAUSTED;
        diagnosis.confidence = 0.9;
        diagnosis.details = {
          reasoningTokens,
          outputTokens,
          totalTokens,
          reasoningRatio: parseFloat(reasoningRatio.toFixed(3)),
          explanation: `Model spent ${Math.round(reasoningRatio * 100)}% of output budget on internal reasoning, leaving insufficient space for tool calls or text output.`,
        };
        diagnosis.remediations.push(
          { action: REMEDIATION_ACTIONS.REDUCE_MAX_TOKENS, priority: 1, params: { reason: 'Reduce maxTokens to leave more room for reasoning + output' } },
          { action: REMEDIATION_ACTIONS.SWITCH_COMPACT_PROMPT, priority: 2, params: { reason: 'Compact prompt frees up output budget' } },
        );
        return diagnosis;
      }
    }
  }

  // Check 2: Prompt too large for context window
  if (promptSize > 0 && contextWindow > 0) {
    const promptRatio = promptSize / contextWindow;
    if (promptRatio > 0.6) {
      diagnosis.category = DIAGNOSTIC_CATEGORIES.PROMPT_TOO_LARGE;
      diagnosis.confidence = 0.85;
      diagnosis.details = {
        promptSize,
        contextWindow,
        promptRatio: parseFloat(promptRatio.toFixed(3)),
        explanation: `System prompt is ${Math.round(promptRatio * 100)}% of the model's context window, leaving insufficient room for conversation history and output.`,
      };
      diagnosis.remediations.push(
        { action: REMEDIATION_ACTIONS.EMERGENCY_TRIM_CONTEXT, priority: 1, params: { reason: 'Trim conversation history to make room' } },
        { action: REMEDIATION_ACTIONS.SWITCH_COMPACT_PROMPT, priority: 2, params: { reason: 'Compact prompt reduces overhead' } },
      );
      return diagnosis;
    }
  }

  // Check 3: Model too small for task complexity
  if (provider) {
    const model = provider.model || '';
    const isSmallModel = /(?:7b|13b|14b|8b|11b)/i.test(model);
    const isLocalModel = ['lmstudio', 'ollama', 'jan', 'vllm', 'sglang', 'llamacpp']
      .includes(String(provider.config?.providerName || provider.name).toLowerCase());

    if (isSmallModel && isLocalModel) {
      diagnosis.category = DIAGNOSTIC_CATEGORIES.MODEL_TOO_SMALL;
      diagnosis.confidence = 0.75;
      diagnosis.details = {
        model,
        provider: provider.config?.providerName || provider.name,
        explanation: `Small local model (${model}) may lack capacity for this task. Small models (7B-13B) need simpler prompts and shorter tasks.`,
      };
      diagnosis.remediations.push(
        { action: REMEDIATION_ACTIONS.SWITCH_COMPACT_PROMPT, priority: 1, params: { reason: 'Compact prompt is designed for small models' } },
        { action: REMEDIATION_ACTIONS.REDUCE_TOOL_COUNT, priority: 2, params: { reason: 'Fewer tools reduce prompt complexity' } },
        { action: REMEDIATION_ACTIONS.BREAK_TASK_INTO_STEPS, priority: 3, params: { reason: 'Smaller tasks are easier for small models' } },
      );
      return diagnosis;
    }
  }

  // Check 4: Context overflow (already handled by existing code, but log it)
  if (error && /context|overflow|too long/i.test(error)) {
    diagnosis.category = DIAGNOSTIC_CATEGORIES.CONTEXT_OVERFLOW;
    diagnosis.confidence = 0.95;
    diagnosis.details = {
      explanation: 'Conversation exceeded the model\'s context window.',
    };
    diagnosis.remediations.push(
      { action: REMEDIATION_ACTIONS.EMERGENCY_TRIM_CONTEXT, priority: 1, params: { reason: 'Emergency trim to fit within context window' } },
    );
    return diagnosis;
  }

  // Check 5: Task complexity vs step limit
  if (steps > 0 && maxSteps > 0) {
    const stepRatio = steps / maxSteps;
    if (stepRatio > 0.8) {
      diagnosis.category = DIAGNOSTIC_CATEGORIES.TASK_TOO_COMPLEX;
      diagnosis.confidence = 0.7;
      diagnosis.details = {
        steps,
        maxSteps,
        stepRatio: parseFloat(stepRatio.toFixed(3)),
        explanation: `Task consumed ${Math.round(stepRatio * 100)}% of step budget without producing output, suggesting task complexity exceeds model capacity.`,
      };
      diagnosis.remediations.push(
        { action: REMEDIATION_ACTIONS.BREAK_TASK_INTO_STEPS, priority: 1, params: { reason: 'Break the task into smaller subtasks' } },
        { action: REMEDIATION_ACTIONS.INCREASE_STEP_LIMIT, priority: 2, params: { reason: 'Increase step limit for complex tasks' } },
        { action: REMEDIATION_ACTIONS.SWITCH_COMPACT_PROMPT, priority: 3, params: { reason: 'Simpler prompt may help small models' } },
      );
      return diagnosis;
    }
  }

  // Check 6: Network errors
  if (error && /network|timeout|connection|rate.limit/i.test(error)) {
    diagnosis.category = DIAGNOSTIC_CATEGORIES.NETWORK_ERROR;
    diagnosis.confidence = 0.9;
    diagnosis.details = {
      explanation: 'Network or API error prevented the model from producing output.',
    };
    return diagnosis;
  }

  // Default: unknown cause
  diagnosis.category = DIAGNOSTIC_CATEGORIES.UNKNOWN;
  diagnosis.confidence = 0.3;
  diagnosis.details = {
    explanation: 'Unable to determine root cause. The model may have simply failed to produce structured output.',
  };
  diagnosis.remediations.push(
    { action: REMEDIATION_ACTIONS.SWITCH_COMPACT_PROMPT, priority: 1, params: { reason: 'Try compact prompt as fallback' } },
    { action: REMEDIATION_ACTIONS.BREAK_TASK_INTO_STEPS, priority: 2, params: { reason: 'Try breaking task into smaller parts' } },
  );

  return diagnosis;
}

/**
 * Generate a human-readable diagnostic report from the diagnosis.
 * @param {Object} diagnosis - Result from diagnoseEmptyOutput
 * @param {Object} context - Original diagnostic context
 * @returns {string} Human-readable diagnostic report
 */
export function formatDiagnosticReport(diagnosis, context) {
  const {
    provider = null,
    promptSize = 0,
    contextWindow = 0,
    promptTier = 'mid',
    maxTokens = 4096,
    steps = 0,
    maxSteps = 130,
  } = context;

  const lines = [
    `=== EMPTY OUTPUT DIAGNOSTIC REPORT ===`,
    ``,
    `Status: FAIL`,
    `Category: ${diagnosis.category}`,
    `Confidence: ${Math.round(diagnosis.confidence * 100)}%`,
    ``,
  ];

  if (diagnosis.details.explanation) {
    lines.push(`Cause: ${diagnosis.details.explanation}`);
    lines.push('');
  }

  // Add context details
  lines.push(`Context:`);
  lines.push(`  Provider: ${provider?.name || provider?.config?.providerName || 'unknown'}`);
  lines.push(`  Model: ${provider?.model || 'unknown'}`);
  lines.push(`  Prompt tier: ${promptTier}`);
  lines.push(`  Max output tokens: ${maxTokens}`);
  lines.push(`  Steps used: ${steps}/${maxSteps}`);
  if (promptSize > 0 && contextWindow > 0) {
    lines.push(`  Prompt size: ${promptSize} / ${contextWindow} (${Math.round((promptSize / contextWindow) * 100)}% of window)`);
  }
  if (context.usage) {
    const { reasoning_tokens, completion_tokens, total_tokens } = context.usage;
    if (reasoning_tokens) {
      lines.push(`  Reasoning tokens: ${reasoning_tokens}`);
    }
    if (completion_tokens) {
      lines.push(`  Output tokens: ${completion_tokens}`);
    }
    if (total_tokens) {
      lines.push(`  Total tokens: ${total_tokens}`);
    }
  }
  lines.push('');

  // Add remediations
  if (diagnosis.remediations.length > 0) {
    lines.push(`Recommended Actions:`);
    diagnosis.remediations.forEach((rem, i) => {
      lines.push(`  ${i + 1}. [${rem.action}] ${rem.params?.reason || 'No reason provided'}`);
    });
    lines.push('');
  }

  lines.push(`======================================`);

  return lines.join('\n');
}

/**
 * Execute the highest-priority remediation action.
 * @param {Object} remediation - Remediation from diagnosis
 * @param {Object} agent - The Agent instance
 * @param {number} tabId - The tab ID
 * @returns {Object} Result of the remediation
 */
export async function executeRemediation(remediation, agent, tabId) {
  const { action, params = {} } = remediation;

  switch (action) {
    case REMEDIATION_ACTIONS.SWITCH_COMPACT_PROMPT: {
      // Switch provider to compact prompt tier
      const provider = agent.providerManager?.getActive();
      if (provider) {
        const originalTier = provider.promptTier;
        provider.promptTier = 'compact';
        return {
          success: true,
          action: REMEDIATION_ACTIONS.SWITCH_COMPACT_PROMPT,
          details: `Switched provider "${provider.name}" from tier "${originalTier}" to "compact"`,
        };
      }
      return { success: false, action, error: 'No active provider found' };
    }

    case REMEDIATION_ACTIONS.REDUCE_MAX_TOKENS: {
      // Reduce maxTokens for next LLM call
      const reducedMaxTokens = Math.floor(params.maxTokens || 4096 * 0.7);
      return {
        success: true,
        action: REMEDIATION_ACTIONS.REDUCE_MAX_TOKENS,
        details: `Reduced maxTokens from ${params.maxTokens || 4096} to ${reducedMaxTokens}`,
        params: { maxTokens: reducedMaxTokens },
      };
    }

    case REMEDIATION_ACTIONS.EMERGENCY_TRIM_CONTEXT: {
      // Trigger emergency context trim
      if (typeof agent._emergencyTrim === 'function') {
        const messages = agent.conversations.get(tabId);
        if (messages) {
          agent._emergencyTrim(messages);
          return {
            success: true,
            action: REMEDIATION_ACTIONS.EMERGENCY_TRIM_CONTEXT,
            details: `Emergency trim applied to conversation for tab ${tabId}`,
          };
        }
      }
      return { success: false, action, error: 'Could not trim context' };
    }

    case REMEDIATION_ACTIONS.SWITCH_PROVIDER: {
      // Switch to a stronger provider (if available)
      const currentProvider = agent.providerManager?.getActive();
      if (agent.providerManager?.getStrongestProvider) {
        const strongerProvider = agent.providerManager.getStrongestProvider();
        if (strongerProvider) {
          agent.providerManager.setActive(strongerProvider);
          return {
            success: true,
            action: REMEDIATION_ACTIONS.SWITCH_PROVIDER,
            details: `Switched from "${currentProvider?.name || 'unknown'}" to "${strongerProvider.name}"`,
          };
        }
      }
      return { success: false, action, error: 'No stronger provider available' };
    }

    case REMEDIATION_ACTIONS.BREAK_TASK_INTO_STEPS: {
      // Return a message telling the user to break the task into smaller parts
      return {
        success: true,
        action: REMEDIATION_ACTIONS.BREAK_TASK_INTO_STEPS,
        details: 'Task should be broken into smaller subtasks',
        message: 'Task complexity exceeds model capacity. Try breaking the task into smaller steps.',
      };
    }

    case REMEDIATION_ACTIONS.REDUCE_TOOL_COUNT: {
      // Switch to a tools list with fewer tools (Ask mode tools)
      return {
        success: true,
        action: REMEDIATION_ACTIONS.REDUCE_TOOL_COUNT,
        details: 'Switch to reduced tool set (Ask mode tools)',
        params: { reducedTools: true },
      };
    }

    case REMEDIATION_ACTIONS.INCREASE_STEP_LIMIT: {
      // Increase step limit for complex tasks
      const newMaxSteps = Math.min(params.maxSteps || 130, 200);
      return {
        success: true,
        action: REMEDIATION_ACTIONS.INCREASE_STEP_LIMIT,
        details: `Increased step limit from ${agent.maxSteps} to ${newMaxSteps}`,
        params: { maxSteps: newMaxSteps },
      };
    }

    default:
      return { success: false, action, error: `Unknown remediation action: ${action}` };
  }
}

/**
 * Run a chain of remediations until one succeeds or all are exhausted.
 * @param {Object} diagnosis - Result from diagnoseEmptyOutput
 * @param {Object} agent - The Agent instance
 * @param {number} tabId - The tab ID
 * @returns {Object} Result of the first successful remediation, or failure if all exhausted
 */
export async function runRemediationChain(diagnosis, agent, tabId) {
  const results = [];

  for (const remediation of diagnosis.remediations) {
    const result = await executeRemediation(remediation, agent, tabId);
    results.push(result);

    if (result.success) {
      return {
        success: true,
        results,
        applied: result,
      };
    }
  }

  return {
    success: false,
    results,
    error: 'All remediations failed',
  };
}

export { DIAGNOSTIC_CATEGORIES, REMEDIATION_ACTIONS };
