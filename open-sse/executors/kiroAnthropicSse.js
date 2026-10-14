// Kiro → Anthropic Native SSE Assembler
// Deployed by ACS patch system to: open-sse/executors/kiroAnthropicSse.js
// Transforms AWS EventStream binary from Kiro into native Anthropic Messages SSE protocol.

import { v4 as uuidv4 } from "uuid";

/**
 * Assembles Kiro binary events into native Anthropic Messages SSE events.
 * Protocol: message_start → (content_block_start/delta*/stop)* → message_delta → message_stop
 */
export class KiroAnthropicAssembler {
  constructor(model) {
    this.messageId = `msg_${uuidv4().replace(/-/g, '')}`;
    this.model = model;
    this.started = false;
    this.stopped = false;
    this.blockIndex = -1;
    this.current = null; // 'thinking' | 'text' | 'tool_use'
    this.hasToolCalls = false;
    this.seenToolIds = new Map();
    this.usage = null;
    this.totalContentLength = 0;
    this.contextUsagePercentage = 0;
    this.hasMetering = false;
    this.hasContextUsage = false;
  }

  ensureStart(out) {
    if (this.started) return;
    this.started = true;
    out.push({
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: this.messageId, type: 'message', role: 'assistant',
          model: this.model, content: [],
          stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      }
    });
  }

  closeBlock(out) {
    if (this.current === null) return;
    out.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: this.blockIndex } });
    this.current = null;
  }

  openBlock(out, type, contentBlock) {
    this.closeBlock(out);
    this.blockIndex++;
    this.current = type;
    out.push({ event: 'content_block_start', data: { type: 'content_block_start', index: this.blockIndex, content_block: contentBlock } });
  }

  process(event) {
    const out = [];
    const payload = event.payload || {};
    const eventType = event.eventType || '';

    // Text content (assistantResponseEvent or codeEvent)
    if ((eventType === 'assistantResponseEvent' || eventType === 'codeEvent') && typeof payload.content === 'string') {
      this.ensureStart(out);
      if (this.current !== 'text') this.openBlock(out, 'text', { type: 'text', text: '' });
      this.totalContentLength += payload.content.length;
      out.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: this.blockIndex, delta: { type: 'text_delta', text: payload.content } } });
    }

    // Reasoning/thinking content
    if (eventType === 'reasoningContentEvent') {
      const r = payload.reasoningContentEvent ?? payload;
      const text = typeof r === 'string' ? r : (r.text || r.content || '');
      if (text) {
        this.ensureStart(out);
        if (this.current !== 'thinking') this.openBlock(out, 'thinking', { type: 'thinking', thinking: '' });
        this.totalContentLength += text.length;
        out.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: this.blockIndex, delta: { type: 'thinking_delta', thinking: text } } });
      }
    }

    // Tool use
    if (eventType === 'toolUseEvent' && payload) {
      this.hasToolCalls = true;
      const list = Array.isArray(payload) ? payload : [payload];
      for (const tu of list) {
        const toolCallId = tu.toolUseId || `toolu_${uuidv4().replace(/-/g, '')}`;
        const isNew = !this.seenToolIds.has(toolCallId);
        this.ensureStart(out);
        if (isNew) {
          this.seenToolIds.set(toolCallId, this.blockIndex + 1);
          this.openBlock(out, 'tool_use', { type: 'tool_use', id: toolCallId, name: tu.name || '', input: {} });
        }
        if (tu.input !== undefined) {
          const partial = typeof tu.input === 'string' ? tu.input : JSON.stringify(tu.input);
          out.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: this.blockIndex, delta: { type: 'input_json_delta', partial_json: partial } } });
        }
      }
    }

    // Metadata events
    if (eventType === 'contextUsageEvent') {
      const pct = payload.contextUsagePercentage;
      if (pct) { this.contextUsagePercentage = pct; this.hasContextUsage = true; }
    }
    if (eventType === 'meteringEvent') this.hasMetering = true;
    if (eventType === 'metricsEvent') {
      const metrics = payload.metricsEvent ?? payload;
      const inp = metrics.inputTokens || 0;
      const outTok = metrics.outputTokens || 0;
      if (inp > 0 || outTok > 0) this.usage = { prompt_tokens: inp, completion_tokens: outTok, total_tokens: inp + outTok };
    }

    if (eventType === 'messageStopEvent') out.push(...this.finalize());
    return out;
  }

  finalize() {
    if (this.stopped) return [];
    this.stopped = true;
    const out = [];
    this.ensureStart(out);
    this.closeBlock(out);
    if (!this.usage) {
      const outTok = this.totalContentLength > 0 ? Math.max(1, Math.floor(this.totalContentLength / 4)) : 0;
      const inp = this.contextUsagePercentage > 0 ? Math.floor(this.contextUsagePercentage * 200000 / 100) : 0;
      this.usage = { prompt_tokens: inp, completion_tokens: outTok, total_tokens: inp + outTok };
    }
    out.push({ event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: this.hasToolCalls ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { input_tokens: this.usage.prompt_tokens, output_tokens: this.usage.completion_tokens } } });
    out.push({ event: 'message_stop', data: { type: 'message_stop' } });
    return out;
  }
}

// Inline EventStream frame parser (self-contained patch)
function parseEventFrame(data) {
  try {
    const view = new DataView(data.buffer, data.byteOffset);
    const totalLength = view.getUint32(0, false);
    const headersLength = view.getUint32(4, false);
    const headers = {};
    let offset = 12;
    const headerEnd = 12 + headersLength;
    while (offset < headerEnd && offset < data.length) {
      const nameLen = data[offset]; offset++;
      if (offset + nameLen > data.length) break;
      const name = new TextDecoder().decode(data.slice(offset, offset + nameLen));
      offset += nameLen;
      const headerType = data[offset]; offset++;
      if (headerType === 7) {
        const valueLen = (data[offset] << 8) | data[offset + 1]; offset += 2;
        if (offset + valueLen > data.length) break;
        const value = new TextDecoder().decode(data.slice(offset, offset + valueLen));
        offset += valueLen;
        headers[name] = value;
      } else break;
    }
    const payloadStart = 12 + headersLength;
    const payloadEnd = data.length - 4;
    let payload = null;
    if (payloadEnd > payloadStart) {
      const payloadStr = new TextDecoder().decode(data.slice(payloadStart, payloadEnd));
      if (payloadStr && payloadStr.trim()) {
        try { payload = JSON.parse(payloadStr); } catch { payload = { raw: payloadStr }; }
      }
    }
    return { headers, payload, eventType: headers[':event-type'] || '' };
  } catch { return null; }
}

/** Wrap a Kiro binary response body as an Anthropic Messages SSE Response. */
export function kiroResponseToAnthropicSSE(response, model) {
  const assembler = new KiroAnthropicAssembler(model);
  let buffer = new Uint8Array(0);
  const encoder = new TextEncoder();

  function serialize(ev) {
    return encoder.encode(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
  }

  const transformStream = new TransformStream({
    transform(chunk, controller) {
      const newBuffer = new Uint8Array(buffer.length + chunk.length);
      newBuffer.set(buffer);
      newBuffer.set(chunk, buffer.length);
      buffer = newBuffer;

      let iterations = 0;
      while (buffer.length >= 16 && iterations < 1000) {
        iterations++;
        const view = new DataView(buffer.buffer, buffer.byteOffset);
        const totalLength = view.getUint32(0, false);
        if (totalLength < 16 || totalLength > buffer.length) break;

        const eventData = buffer.slice(0, totalLength);
        buffer = buffer.slice(totalLength);

        const event = parseEventFrame(eventData);
        if (!event) continue;

        for (const ev of assembler.process(event)) {
          controller.enqueue(serialize(ev));
        }
      }
    },
    flush(controller) {
      for (const ev of assembler.finalize()) {
        controller.enqueue(serialize(ev));
      }
    }
  });

  if (!response.body) {
    const out = [];
    for (const ev of assembler.finalize()) out.push(serialize(ev));
    const totalLen = out.reduce((n, b) => n + b.length, 0);
    const merged = new Uint8Array(totalLen);
    let off = 0;
    for (const b of out) { merged.set(b, off); off += b.length; }
    return new Response(merged, { status: response.status, headers: { 'Content-Type': 'text/event-stream' } });
  }

  return new Response(response.body.pipeThrough(transformStream), {
    status: response.status, statusText: response.statusText,
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }
  });
}
