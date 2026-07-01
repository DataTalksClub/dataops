/**
 * A minimal Python `marshal` reader — only the opcodes that the Python
 * `zerosearch` library's `Index.dumps()` emits.
 *
 * `zerosearch` serializes a plain dict of JSON-like values plus raw
 * `array.tobytes()` byte blobs (Python `bytes`). That uses these marshal
 * opcodes and nothing else (no code objects, no pickle): dict, list, tuple,
 * int, long, float, str (ascii / short-ascii / unicode, interned variants),
 * bytes, bool, None, and the FLAG_REF / TYPE_REF back-reference mechanism.
 *
 * Anything outside that set throws, so a surprising artifact fails loudly
 * instead of decoding wrong. Integers and the marshal framing are little-endian
 * (marshal always writes little-endian); the byte blobs are decoded by the
 * caller using the recorded array item sizes.
 */
/** Python `bytes` map to a Uint8Array; everything else to native JS types. */
export type MarshalValue = null | boolean | number | string | Uint8Array | MarshalValue[] | {
    [key: string]: MarshalValue;
};
/** Decode a single top-level marshal object from `buf`. */
export declare function readMarshal(buf: Uint8Array): MarshalValue;
