// Cloudflare-KV-shaped namespace over a pluggable storage driver. Implements
// the slice of the KV API the worker actually uses (see worker/src/index.js):
// get(key) / get(key, 'json'), getWithMetadata(key, { type: 'arrayBuffer' }),
// put(key, value, { expirationTtl }), delete(key), and
// list({ prefix, limit, cursor }) with byte-lexicographic key order — the
// ordering the indexer depends on for zero-padded (height, tx_index) keys.
//
// Driver contract (driver-mem.mjs, driver-pg.mjs):
//   get(ns, key)                    -> { value: Buffer, metadata, expiresAt } | null
//   put(ns, key, buf, { metadata, expiresAt })
//   delete(ns, key)
//   list(ns, { prefix, limit, after }) -> { entries: [{ name, metadata, expiresAt }], complete }
//   sweepExpired(), close()
// Drivers exclude expired entries from get/list; sweepExpired reclaims rows.

const LIST_LIMIT_MAX = 1000;

function normalizeType(typeOpt) {
  if (typeof typeOpt === 'string') return typeOpt;
  if (typeOpt && typeof typeOpt === 'object' && typeof typeOpt.type === 'string') return typeOpt.type;
  return 'text';
}

function decodeValue(buf, type) {
  if (type === 'arrayBuffer') {
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }
  const text = buf.toString('utf8');
  if (type === 'json') return JSON.parse(text);
  return text;
}

function encodeValue(value) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('KV put: unsupported value type (expected string, ArrayBuffer, or TypedArray)');
}

function expiresAtFrom(opts = {}) {
  if (opts.expiration != null) return Number(opts.expiration) * 1000; // absolute epoch seconds (import path)
  if (opts.expirationTtl != null) return Date.now() + Number(opts.expirationTtl) * 1000;
  return null;
}

const cursorEncode = (key) => Buffer.from(key, 'utf8').toString('base64url');
const cursorDecode = (cursor) => Buffer.from(cursor, 'base64url').toString('utf8');

export function createKVNamespace(driver, ns) {
  return {
    async get(key, typeOpt) {
      const row = await driver.get(ns, key);
      if (!row) return null;
      return decodeValue(row.value, normalizeType(typeOpt));
    },

    async getWithMetadata(key, typeOpt) {
      const row = await driver.get(ns, key);
      if (!row) return { value: null, metadata: null };
      return {
        value: decodeValue(row.value, normalizeType(typeOpt)),
        metadata: row.metadata ?? null,
      };
    },

    async put(key, value, opts = {}) {
      await driver.put(ns, key, encodeValue(value), {
        metadata: opts.metadata ?? null,
        expiresAt: expiresAtFrom(opts),
      });
    },

    async delete(key) {
      await driver.delete(ns, key);
    },

    async list({ prefix = '', limit = LIST_LIMIT_MAX, cursor = null } = {}) {
      const capped = Math.max(1, Math.min(Number(limit) || LIST_LIMIT_MAX, LIST_LIMIT_MAX));
      const after = cursor ? cursorDecode(cursor) : null;
      const { entries, complete } = await driver.list(ns, { prefix, limit: capped, after });
      const keys = entries.map((e) => {
        const k = { name: e.name };
        if (e.expiresAt != null) k.expiration = Math.floor(e.expiresAt / 1000);
        if (e.metadata != null) k.metadata = e.metadata;
        return k;
      });
      return {
        keys,
        list_complete: complete,
        cursor: complete || keys.length === 0 ? null : cursorEncode(keys[keys.length - 1].name),
      };
    },
  };
}
