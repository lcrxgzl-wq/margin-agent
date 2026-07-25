export const MAX_RUN_STATES = 100;

export function setBoundedMap<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  limit = MAX_RUN_STATES,
): void {
  if (!map.has(key) && map.size >= limit) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
  map.set(key, value);
}
