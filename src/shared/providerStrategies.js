/**
 * Merge a per-provider strategy override WITHOUT dropping the field groups
 * this writer does not own.
 *
 * The override carries independent groups (fallback strategy vs no-auth proxy
 * pool). A writer that rebuilds the entry from scratch deletes the group it
 * did not touch — that is how the opencode pool binding was lost.
 *
 * A key whose value is `undefined` in `ownedOverride` is REMOVED; every other
 * key of the existing entry is preserved.
 *
 * @param {Record<string, object>} current - the full `providerStrategies` map
 * @param {string} providerId - provider the override belongs to
 * @param {Record<string, unknown>} [ownedOverride] - fields this writer owns
 * @returns {Record<string, object>} a NEW map; `current` is never mutated
 */
export function mergeProviderStrategy(current, providerId, ownedOverride = {}) {
  const existing = current?.[providerId] || {};
  const merged = { ...existing };

  for (const [key, value] of Object.entries(ownedOverride ?? {})) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }

  const updated = { ...(current || {}) };
  if (Object.keys(merged).length === 0) delete updated[providerId];
  else updated[providerId] = merged;

  return updated;
}
