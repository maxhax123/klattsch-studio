// Phoneme bank registry, layering, and resolved-bank lookup.

import { bundled } from './bundled.js';

const DEFAULT_BANK = 'klatt1980-en';

const registry = new Map();
const resolvedCache = new Map();

for (const [name, bank] of Object.entries(bundled)) {
  registry.set(name, bank);
}

function resolveInternal(name, visiting) {
  if (visiting.has(name)) {
    const path = [...visiting, name].join(' -> ');
    throw new Error(`bank extends cycle detected: ${path}`);
  }
  const bank = registry.get(name);
  if (!bank) {
    throw new Error(`unknown bank: ${name}`);
  }

  let phonemes = {};
  if (bank.extends) {
    const parent = resolveInternal(bank.extends, new Set([...visiting, name]));
    phonemes = { ...parent.phonemes };
  }

  for (const [code, entry] of Object.entries(bank.phonemes || {})) {
    if (entry === null) {
      delete phonemes[code];
    } else {
      phonemes[code] = entry;
    }
  }

  return {
    schemaVersion: bank.schemaVersion,
    name: bank.name,
    displayName: bank.displayName ?? bank.name,
    language: bank.language ?? null,
    license: bank.license ?? null,
    source: bank.source ?? null,
    extends: null,
    phonemes,
  };
}

function get(name) {
  if (resolvedCache.has(name)) return resolvedCache.get(name);
  if (!registry.has(name)) return undefined;
  const resolved = resolveInternal(name, new Set());
  resolvedCache.set(name, resolved);
  return resolved;
}

function list() {
  return [...registry.keys()];
}

export const banks = { list, get, defaultName: DEFAULT_BANK };

export function registerBank(bank) {
  if (!bank || typeof bank !== 'object') {
    throw new Error('registerBank: bank must be an object');
  }
  if (!bank.name || typeof bank.name !== 'string') {
    throw new Error('registerBank: bank.name is required');
  }
  if (bank.schemaVersion !== 1) {
    throw new Error(
      `registerBank: unsupported schemaVersion ${bank.schemaVersion} (expected 1)`,
    );
  }
  registry.set(bank.name, bank);
  resolvedCache.clear();
}

// Accepts a name string, a ResolvedBank, a raw bank object, or null (default).
export function resolveBank(bank, reg = banks) {
  if (bank == null) {
    return reg.get(DEFAULT_BANK);
  }
  if (typeof bank === 'string') {
    const resolved = reg.get(bank);
    if (!resolved) throw new Error(`unknown bank: ${bank}`);
    return resolved;
  }
  if (typeof bank === 'object') {
    if (bank.extends == null && bank.phonemes) {
      return bank;
    }
    if (bank.name && registry.has(bank.name)) {
      return banks.get(bank.name);
    }
    if (bank.name) {
      registerBank(bank);
      return banks.get(bank.name);
    }
  }
  throw new Error('resolveBank: unsupported bank value');
}
