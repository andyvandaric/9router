/**
 * Helpers for the OpenCode Zen free-tier client fingerprint.
 *
 * Live upstream probes show that free-tier requests must include the lowercase
 * file-search quartet (bash/glob/grep/read). Agent clients such as Claude Code
 * may declare the same tools with different casing, so those case variants must
 * be renamed instead of duplicated. The response side restores the caller's
 * original spelling so downstream clients still recognise their own tool calls.
 */

/** Canonical names required by the upstream free-tier gate. */
export const OPENCODE_FINGERPRINT_TOOLS = ["read", "shell"];

export const OPENCODE_CANONICAL_TOOL_DEFINITIONS = {
  read: {
    description: "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or directory to read" },
      },
      required: ["path"],
    },
  },
  shell: {
    description: "Execute a shell command and return its output. Commands run on Windows using pwsh. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command string to execute" },
      },
      required: ["command"],
    },
  },
};
const renamedToolNames = new WeakMap();

/** Canonical lowercase name when `name` is a fingerprint member; "" otherwise. */
export function fingerprintToolKey(name) {
  const lower = String(name ?? "").trim().toLowerCase();
  if (lower === "bash" || lower === "shell") return "shell";
  if (lower === "read") return "read";
  return "";
}

/** Read a tool name from either flat ({name}) or chat ({function:{name}}) shape. */
function toolNameOf(tool) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return "";
  if (typeof tool.name === "string" && tool.name.trim()) return tool.name.trim();
  const fn = tool.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn) && typeof fn.name === "string") {
    return fn.name.trim();
  }
  return "";
}

/**
 * Canonicalise only the fingerprint quartet and remove duplicate quartet
 * variants. Non-fingerprint tools are preserved verbatim, including tools whose
 * names differ only by case; they are outside OpenCode's fingerprint contract.
 *
 * @param {Array} tools
 * @returns {{ tools: Array, map: Map<string,string> }} map: sent name -> original name
 */
export function concealFingerprintToolNames(tools) {
  const map = new Map();
  if (!Array.isArray(tools) || tools.length === 0) return { tools, map };

  const seenQuartet = new Set();
  const out = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
      out.push(tool);
      continue;
    }

    const current = toolNameOf(tool);
    const key = fingerprintToolKey(current);
    if (!key) {
      out.push(tool);
      continue;
    }

    // `Bash` + `bash` is rejected upstream as a duplicate. Keep exactly one
    // declaration for each quartet member.
    if (seenQuartet.has(key)) continue;
    seenQuartet.add(key);

    const def = OPENCODE_CANONICAL_TOOL_DEFINITIONS[key];
    if (current !== key) {
      map.set(key, current);
      const fn = tool.function && typeof tool.function === "object" && !Array.isArray(tool.function)
        ? tool.function
        : null;
      out.push(fn ? {
        ...tool,
        function: {
          ...fn,
          name: key,
          description: def?.description || fn.description,
          parameters: def?.parameters || fn.parameters,
        },
      } : {
        ...tool,
        name: key,
        description: def?.description || tool.description,
        parameters: def?.parameters || tool.parameters,
      });
    } else {
      out.push(tool);
    }
  }
  return { tools: out, map };
}

/** Append only genuinely missing fingerprint declarations. */
export function appendMissingFingerprintTools(tools, flat) {
  const list = Array.isArray(tools) ? tools : [];
  for (const name of OPENCODE_FINGERPRINT_TOOLS) {
    if (list.some((tool) => fingerprintToolKey(toolNameOf(tool)) === name)) continue;
    const def = OPENCODE_CANONICAL_TOOL_DEFINITIONS[name];
    list.push(flat ? {
      type: "function",
      name,
      description: def.description,
      parameters: def.parameters,
    } : {
      type: "function",
      function: {
        name,
        description: def.description,
        parameters: def.parameters,
      },
    });
  }
  return list;
}

/** Point an explicit tool_choice at a quartet member after canonicalisation. */
export function retargetToolChoice(body, map) {
  if (!body || typeof body !== "object" || !map?.size) return;
  const choice = body.tool_choice;
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) return;

  if (typeof choice.name === "string") {
    const key = fingerprintToolKey(choice.name);
    if (key && map.has(key)) body.tool_choice = { ...choice, name: key };
    return;
  }

  const fn = choice.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn) && typeof fn.name === "string") {
    const key = fingerprintToolKey(fn.name);
    if (key && map.has(key)) {
      body.tool_choice = { ...choice, function: { ...fn, name: key } };
    }
  }
}

/**
 * Full request-side pass: canonicalise quartet case variants, remove duplicate
 * quartet declarations, append missing members and preserve the legacy
 * tool_choice defaults used by the OpenCode executor.
 *
 * @param {object} body
 * @param {boolean} flat - true for Responses tools ({name}), false for chat tools
 * @returns {Map<string,string>} map: sent name -> original name
 */
export function applyFingerprintTools(body, flat) {
  if (!body || typeof body !== "object") return new Map();

  const hadClientTools = Array.isArray(body.tools) && body.tools.length > 0;
  const { tools, map } = concealFingerprintToolNames(body.tools);
  body.tools = appendMissingFingerprintTools(tools, flat);
  retargetToolChoice(body, map);

  // Preserve the existing executor semantics. Responses uses auto when the
  // Free-tier responses API requires tool_choice to be auto when tools are declared.
  // Upstream rejects tool_choice: "none" with FreeTierError (403), so omit tool_choice
  // for chat completions when the client provided no tools.
  if (!body.tool_choice && flat) {
    body.tool_choice = "auto";
  }
  recordRenamedToolNames(body, map);
  return map;
}

/** Store the rename map for `body`. */
export function recordRenamedToolNames(body, map) {
  if (!body || typeof body !== "object" || !map?.size) return;
  renamedToolNames.set(body, map);
}

/** Retrieve the rename map for `body`. */
export function takeRenamedToolNames(body) {
  if (!body || typeof body !== "object") return null;
  return renamedToolNames.get(body) || null;
}

// Response side -------------------------------------------------------------

/** Restore caller tool spellings in supported response/event shapes. */
export function restoreToolNames(payload, map) {
  if (!map?.size || !payload) return payload;
  if (Array.isArray(payload)) return payload.map((item) => restoreToolNames(item, map));
  if (typeof payload !== "object") return payload;

  let out = payload;
  const put = (key, value) => {
    if (out === payload) out = { ...payload };
    out[key] = value;
  };

  // Claude streaming content_block_start event.
  if (payload.type === "content_block_start") {
    const block = payload.content_block;
    if (block?.type === "tool_use" && typeof block.name === "string" && map.has(block.name)) {
      put("content_block", { ...block, name: map.get(block.name) });
    }
  }

  // Claude non-streaming message body.
  if (Array.isArray(payload.content)) {
    put("content", payload.content.map((block) =>
      block?.type === "tool_use" && typeof block.name === "string" && map.has(block.name)
        ? { ...block, name: map.get(block.name) }
        : block));
  }

  // OpenAI Chat Completions, both streaming delta and JSON message shapes.
  if (Array.isArray(payload.choices)) {
    put("choices", payload.choices.map((choice) => {
      let changed = false;
      const next = { ...choice };
      for (const holder of ["delta", "message"]) {
        const value = choice?.[holder];
        if (!value || !Array.isArray(value.tool_calls) || value.tool_calls.length === 0) continue;
        const calls = value.tool_calls.map((call) => {
          const name = call?.function?.name;
          if (typeof name === "string" && map.has(name)) {
            changed = true;
            return { ...call, function: { ...call.function, name: map.get(name) } };
          }
          return call;
        });
        next[holder] = { ...value, tool_calls: calls };
      }
      return changed ? next : choice;
    }));
  }

  // OpenAI Responses final JSON body.
  if (Array.isArray(payload.output)) {
    put("output", payload.output.map((item) =>
      item?.type === "function_call" && typeof item.name === "string" && map.has(item.name)
        ? { ...item, name: map.get(item.name) }
        : item));
  }

  // OpenAI Responses SSE events such as response.output_item.added/done.
  const item = payload.item;
  if (item?.type === "function_call" && typeof item.name === "string" && map.has(item.name)) {
    put("item", { ...item, name: map.get(item.name) });
  }

  return out;
}
