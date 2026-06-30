"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.readMarshal = readMarshal;
const FLAG_REF = 0x80;
// Marshal type codes (CPython Python/marshal.c), masked with ~FLAG_REF.
const TYPE_NULL = 0x30; // '0'
const TYPE_NONE = 0x4e; // 'N'
const TYPE_FALSE = 0x46; // 'F'
const TYPE_TRUE = 0x54; // 'T'
const TYPE_INT = 0x69; // 'i'  - 32-bit signed
const TYPE_INT64 = 0x49; // 'I'  - 64-bit signed (legacy)
const TYPE_FLOAT_BIN = 0x67; // 'g'  - 8-byte IEEE double
const TYPE_LONG = 0x6c; // 'l'  - arbitrary precision int
const TYPE_STRING = 0x73; // 's'  - bytes (length-prefixed, 4 bytes)
const TYPE_INTERNED = 0x74; // 't'  - interned str
const TYPE_REF = 0x72; // 'r'  - back-reference
const TYPE_TUPLE = 0x28; // '('  - 4-byte count
const TYPE_LIST = 0x5b; // '['  - 4-byte count
const TYPE_DICT = 0x7b; // '{'  - key/value pairs until a NULL key
const TYPE_ASCII = 0x61; // 'a'  - 4-byte length
const TYPE_ASCII_INTERNED = 0x41; // 'A'
const TYPE_SMALL_TUPLE = 0x29; // ')'  - 1-byte count
const TYPE_SHORT_ASCII = 0x7a; // 'z'  - 1-byte length
const TYPE_SHORT_ASCII_INTERNED = 0x5a; // 'Z'
const TYPE_UNICODE = 0x75; // 'u'  - 4-byte length, UTF-8
/** Sentinel returned for TYPE_NULL (used as the dict terminator). */
const NULL_SENTINEL = Symbol("marshal-null");
const utf8 = new TextDecoder("utf-8");
class MarshalReader {
    buf;
    pos = 0;
    refs = [];
    view;
    constructor(buf) {
        this.buf = buf;
        this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    }
    read() {
        const value = this.readObject();
        if (value === NULL_SENTINEL) {
            throw new Error("marshal: unexpected NULL at top level");
        }
        return value;
    }
    u8() {
        return this.buf[this.pos++];
    }
    i32() {
        const v = this.view.getInt32(this.pos, true);
        this.pos += 4;
        return v;
    }
    u32() {
        const v = this.view.getUint32(this.pos, true);
        this.pos += 4;
        return v;
    }
    take(n) {
        const slice = this.buf.subarray(this.pos, this.pos + n);
        this.pos += n;
        return slice;
    }
    /** Returns a MarshalValue, or NULL_SENTINEL for TYPE_NULL. */
    readObject() {
        const code = this.u8();
        if (code === undefined)
            throw new Error("marshal: unexpected end of input");
        const flag = (code & FLAG_REF) !== 0;
        const type = code & ~FLAG_REF;
        // Reserve the reference slot *before* reading contents, matching CPython,
        // so any back-reference inside a container resolves to the right index.
        let refIndex = -1;
        if (flag) {
            refIndex = this.refs.length;
            this.refs.push(null);
        }
        let value;
        switch (type) {
            case TYPE_NULL:
                return NULL_SENTINEL; // never reference-flagged
            case TYPE_NONE:
                value = null;
                break;
            case TYPE_FALSE:
                value = false;
                break;
            case TYPE_TRUE:
                value = true;
                break;
            case TYPE_INT:
                value = this.i32();
                break;
            case TYPE_INT64:
                value = this.readInt64();
                break;
            case TYPE_FLOAT_BIN: {
                value = this.view.getFloat64(this.pos, true);
                this.pos += 8;
                break;
            }
            case TYPE_LONG:
                value = this.readLong();
                break;
            case TYPE_STRING:
                value = this.take(this.u32()).slice(); // Python bytes -> Uint8Array copy
                break;
            case TYPE_UNICODE:
            case TYPE_INTERNED:
            case TYPE_ASCII:
            case TYPE_ASCII_INTERNED:
                value = utf8.decode(this.take(this.u32()));
                break;
            case TYPE_SHORT_ASCII:
            case TYPE_SHORT_ASCII_INTERNED:
                value = utf8.decode(this.take(this.u8()));
                break;
            case TYPE_TUPLE:
            case TYPE_LIST:
                value = this.readSequence(this.u32());
                break;
            case TYPE_SMALL_TUPLE:
                value = this.readSequence(this.u8());
                break;
            case TYPE_DICT:
                value = this.readDict();
                break;
            case TYPE_REF: {
                const index = this.i32();
                if (index < 0 || index >= this.refs.length) {
                    throw new Error(`marshal: reference ${index} out of range`);
                }
                value = this.refs[index];
                break;
            }
            default:
                throw new Error(`marshal: unsupported opcode 0x${type.toString(16)}`);
        }
        if (flag)
            this.refs[refIndex] = value;
        return value;
    }
    readSequence(n) {
        const out = [];
        for (let i = 0; i < n; i++) {
            const item = this.readObject();
            if (item === NULL_SENTINEL)
                throw new Error("marshal: NULL inside sequence");
            out.push(item);
        }
        return out;
    }
    readDict() {
        const out = {};
        for (;;) {
            const key = this.readObject();
            if (key === NULL_SENTINEL)
                break; // dict is terminated by a NULL key
            const val = this.readObject();
            if (val === NULL_SENTINEL)
                throw new Error("marshal: NULL dict value");
            out[String(key)] = val;
        }
        return out;
    }
    readInt64() {
        const lo = this.view.getUint32(this.pos, true);
        const hi = this.view.getInt32(this.pos + 4, true);
        this.pos += 8;
        return hi * 0x100000000 + lo;
    }
    readLong() {
        const n = this.i32();
        const size = Math.abs(n);
        let result = 0n;
        let shift = 0n;
        for (let i = 0; i < size; i++) {
            const digit = BigInt(this.view.getUint16(this.pos, true));
            this.pos += 2;
            result += digit << shift;
            shift += 15n; // marshal long digits are 15-bit
        }
        if (n < 0)
            result = -result;
        return Number(result);
    }
}
/** Decode a single top-level marshal object from `buf`. */
function readMarshal(buf) {
    return new MarshalReader(buf).read();
}
