function randomHex(size) {
  const alphabet = '0123456789abcdef';
  let output = '';
  for (let index = 0; index < size; index += 1) {
    output += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return output;
}

export function makeId(prefix = 'id') {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}-${globalThis.crypto.randomUUID().slice(0, 8)}`;
  }

  const timestamp = Date.now().toString(16).slice(-8);
  return `${prefix}-${timestamp}${randomHex(6)}`;
}
