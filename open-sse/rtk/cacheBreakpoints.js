// Cache Breakpoints — Anthropic prompt caching via cache_control injection
// Deployed by ACS patch system to: open-sse/rtk/cacheBreakpoints.js

/**
 * Inject dual cache breakpoints into an Anthropic-format request body.
 * Strategy: mark last system block + last assistant tool_use/text block.
 * 
 * @param {object} body - Translated request body (Anthropic format)
 * @param {object} options - { enabled: true, respectCallerMarkers: true }
 * @returns {boolean} - true if any breakpoints were injected
 */
export function injectCacheBreakpoints(body, options = {}) {
  const { enabled = true, respectCallerMarkers = true } = options;
  if (!enabled) return false;
  if (body.system === undefined) return false;
  
  let injected = false;

  // Breakpoint 1: Last system block
  if (Array.isArray(body.system) && body.system.length > 0) {
    const last = body.system[body.system.length - 1];
    if (!last.cache_control && (!respectCallerMarkers || !hasAnyCacheControl(body.system))) {
      last.cache_control = { type: 'ephemeral' };
      injected = true;
    }
  } else if (typeof body.system === 'string' && body.system.length > 0) {
    body.system = [{ type: 'text', text: body.system, cache_control: { type: 'ephemeral' } }];
    injected = true;
  }

  // Breakpoint 2: Last assistant message's last tool_use/text block
  if (Array.isArray(body.messages)) {
    for (let i = body.messages.length - 1; i >= 0; i--) {
      const msg = body.messages[i];
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (let j = msg.content.length - 1; j >= 0; j--) {
          const block = msg.content[j];
          if (block.type === 'tool_use' || block.type === 'text') {
            if (!block.cache_control) {
              block.cache_control = { type: 'ephemeral' };
              injected = true;
            }
            return injected;
          }
        }
      }
    }
  }
  return injected;
}

function hasAnyCacheControl(arr) {
  for (const block of arr) {
    if (block?.cache_control) return true;
    if (Array.isArray(block?.content)) {
      for (const part of block.content) {
        if (part?.cache_control) return true;
      }
    }
  }
  return false;
}
