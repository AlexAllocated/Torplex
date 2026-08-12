/**
 * @param {{ randomUUID?: () => string, getRandomValues?: (values: Uint32Array) => Uint32Array } | undefined} cryptoApi
 * @param {number} now
 */
export function createSearchId(cryptoApi = globalThis.crypto, now = Date.now()) {
  if (typeof cryptoApi?.randomUUID === 'function') {
    return `search-${cryptoApi.randomUUID()}`;
  }

  const random = new Uint32Array(4);
  if (typeof cryptoApi?.getRandomValues === 'function') {
    cryptoApi.getRandomValues(random);
  } else {
    for (let index = 0; index < random.length; index += 1) {
      random[index] = Math.floor(Math.random() * 0x100000000);
    }
  }
  const entropy = [...random].map((value) => value.toString(36).padStart(7, '0')).join('');
  return `search-${now.toString(36)}-${entropy}`;
}
