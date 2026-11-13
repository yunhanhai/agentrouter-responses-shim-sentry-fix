// Only protocol-level input items are edited. User text, tool arguments,
// nested IDs, call_id, and assistant phase must survive unchanged.
export class ShimError extends Error {
  constructor(status, code, message, param = null) {
    super(message);
    this.name = 'ShimError';
    this.status = status;
    this.code = code;
    this.param = param;
  }
}

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (value, key) => Object.hasOwn(value, key);
const string = (value) => typeof value === 'string';
const inlineItems = {
  message: (item) => string(item.role) && has(item, 'content'),
  function_call: (item) => string(item.call_id) && string(item.name) && string(item.arguments),
  function_call_output: (item) => string(item.call_id) && has(item, 'output'),
  custom_tool_call: (item) => string(item.call_id) && string(item.name) && string(item.input),
  custom_tool_call_output: (item) => string(item.call_id) && has(item, 'output'),
};

const compactionError = (param) => new ShimError(400, 'encrypted_compaction_unsupported',
  'Encrypted compaction cannot be made portable by deleting it: it contains conversation history. '
  + 'Replay explicit history or a text summary, or use resource-affine upstream routing. '
  + 'Strict mode rejects this state instead of silently removing it.', param);

// Local patch 2026-10-26 (sentry-fix-v1): nested encrypted_content blocks
// (e.g. inside agent_message.content[] or tool output arrays) are also bound
// to the upstream resource that created them; replaying them to a different
// resource fails with invalid_encrypted_content. Remove them wherever found.
function hasNestedEncrypted(root) {
  if (Array.isArray(root)) return root.some((value) => hasNestedEncrypted(value));
  if (record(root)) {
    if (string(root.encrypted_content)) return true;
    return Object.values(root).some((value) => hasNestedEncrypted(value));
  }
  return false;
}
function removeNestedEncrypted(root) {
  let removed = 0;
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) {
        const value = node[i];
        if (record(value) && value.type === 'encrypted_content' && string(value.encrypted_content)) {
          node.splice(i, 1);
          removed++;
        } else {
          visit(value);
        }
      }
      return;
    }
    if (record(node)) {
      for (const key of Object.keys(node)) {
        if (key === 'encrypted_content' && string(node[key])) {
          delete node[key];
          removed++;
        } else {
          visit(node[key]);
        }
      }
    }
  };
  visit(root);
  return removed;
}

// image-limit extension (local patch 2026-11-13): gateways cap the number of
// images per request (e.g. "Exceeded maximum number of images (50)"). Codex
// replays every screenshot a long session ever produced, so trim older image
// blocks and leave a text placeholder; tool pairings stay intact because only
// content parts are replaced. Copy-on-write: no trim -> original input kept.
const IMAGE_TYPES = new Set(['input_image', 'image', 'computer_screenshot']);
const IMAGE_PLACEHOLDER = '[older image omitted to respect the upstream image limit]';
const isImageBlock = (value) => record(value)
  && (IMAGE_TYPES.has(value.type) || string(value.image_url))
  && (string(value.image_url) || string(value.file_id) || string(value.image_base64));

function trimExcessImages(body, maxImages, stats) {
  if (!Array.isArray(body.input)) return;
  // Pass 1: collect image-block references in document order (no mutation).
  const slots = [];
  const collect = (container) => {
    if (!Array.isArray(container)) return;
    for (let i = 0; i < container.length; i++) {
      const value = container[i];
      if (isImageBlock(value)) slots.push({ container, index: i });
      else if (record(value)) {
        for (const key of ['content', 'output']) collect(value[key]);
      }
    }
  };
  for (let i = 0; i < body.input.length; i++) {
    const item = body.input[i];
    if (isImageBlock(item)) slots.push({ container: body.input, index: i, topLevel: true });
    else if (record(item)) for (const key of ['content', 'output']) collect(item[key]);
  }
  const excess = slots.length - maxImages;
  if (excess <= 0) return;
  // Pass 2: clone input, then replace the oldest `excess` blocks with text.
  body.input = structuredClone(body.input);
  const cloneSlots = [];
  const collectClone = (container) => {
    if (!Array.isArray(container)) return;
    for (let i = 0; i < container.length; i++) {
      const value = container[i];
      if (isImageBlock(value)) cloneSlots.push({ container, index: i });
      else if (record(value)) {
        for (const key of ['content', 'output']) collectClone(value[key]);
      }
    }
  };
  for (let i = 0; i < body.input.length; i++) {
    const item = body.input[i];
    if (isImageBlock(item)) cloneSlots.push({ container: body.input, index: i, topLevel: true });
    else if (record(item)) for (const key of ['content', 'output']) collectClone(item[key]);
  }
  for (const slot of cloneSlots.slice(0, excess)) {
    if (slot.topLevel) {
      slot.container[slot.index] = { type: 'message', role: 'user', content: [{ type: 'input_text', text: IMAGE_PLACEHOLDER }] };
    } else {
      slot.container[slot.index] = { type: 'input_text', text: IMAGE_PLACEHOLDER };
    }
  }
  stats.images_removed = (stats.images_removed || 0) + excess;
  stats.images_kept = maxImages;
}

/** Pure, copy-on-write sanitizer; also usable directly in an SDK transport. */
export function sanitizeResponsesRequest(request, { strict = false, maxImages = 0 } = {}) {
  if (!record(request)) {
    throw new ShimError(400, 'invalid_json_object', 'The request body must be a JSON object.');
  }
  const body = { ...request };
  const stats = { reasoning_items_removed: 0, item_ids_removed: 0, opaque_state_items: 0 };
  if (maxImages > 0) trimExcessImages(body, maxImages, stats);

  for (const key of ['previous_response_id', 'conversation']) {
    if (body[key] != null) {
      stats.opaque_state_items++;
      if (strict) {
        throw new ShimError(400, 'stateful_reference_unsupported',
          `${key} requires the original upstream resource. Replay complete explicit input history without this field, or use resource-affine routing.`, key);
      }
    }
  }
  const contextManagement = Array.isArray(body.context_management) ? body.context_management : [body.context_management];
  if (contextManagement.some((entry) => record(entry) && (entry.type === 'compaction' || has(entry, 'compact_threshold')))) {
    stats.opaque_state_items++;
    if (strict) throw compactionError('context_management');
  }

  if (has(body, 'input') && !string(body.input) && !Array.isArray(body.input)) {
    throw new ShimError(400, 'invalid_input', 'input must be a string or an array of input items.', 'input');
  }
  if (Array.isArray(body.input)) {
    body.input = body.input.flatMap((item, index) => {
      if (!record(item)) return [item];
      const param = `input[${index}]`;
      if (hasNestedEncrypted(item)) {
        const cleaned = structuredClone(item);
        const nestedRemoved = removeNestedEncrypted(cleaned);
        if (nestedRemoved > 0) {
          stats.nested_encrypted_blocks_removed = (stats.nested_encrypted_blocks_removed || 0) + nestedRemoved;
          item = cleaned;
        }
      }
      if (item.type === 'reasoning') {
        // Removing just encrypted_content leaves a resource-bound reasoning ID.
        stats.reasoning_items_removed++;
        return [];
      }
      if (item.type === 'compaction' || item.type === 'compaction_trigger') {
        stats.opaque_state_items++;
        if (strict) throw compactionError(param);
        return [item];
      }
      if (item.type === 'item_reference'
        || (item.type == null && has(item, 'id') && !has(item, 'role') && !has(item, 'content'))) {
        stats.opaque_state_items++;
        if (strict) {
          throw new ShimError(400, 'item_reference_unsupported',
            'An item reference cannot be reconstructed from its ID. Send the complete item content or use the original upstream resource.', param);
        }
        return [item];
      }
      if (item.encrypted_content != null) {
        stats.opaque_state_items++;
        if (strict) {
          throw new ShimError(400, 'unknown_encrypted_item',
            'This non-reasoning encrypted input item is not portable. Strict mode rejects it instead of silently deleting conversation state.', param);
        }
        return [item];
      }

      const type = item.type ?? (has(item, 'role') ? 'message' : undefined);
      const canInline = has(inlineItems, type) ? inlineItems[type] : undefined;
      if (canInline && has(item, 'id')) {
        if (!canInline(item)) {
          stats.opaque_state_items++;
          if (strict) {
            throw new ShimError(400, 'incomplete_inline_item',
              'This item contains an ID but lacks the fields needed to replay it without stored state.', param);
          }
          return [item];
        }
        const copy = { ...item };
        delete copy.id;
        stats.item_ids_removed++;
        return [copy];
      }
      // Hosted-tool items can have required IDs. Do not corrupt their schemas;
      // their resource affinity is outside this shim's reasoning-only repair.
      return [item];
    });
  }
  // Preserve cache keys/options, tools, reasoning settings, store, include,
  // and all unrelated request fields. This adapter is not a state manager.
  return { body, stats };
}
