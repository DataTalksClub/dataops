/**
 * Minimal zero-dependency reader for GitHub branch archives (tar.gz).
 *
 * Hydration only streams regular files out of a codeload tarball, so this
 * understands just enough ustar/pax to do that safely: pax (`x`) and GNU (`L`)
 * long-name records for paths beyond the ustar field widths, with content of
 * non-included entries discarded without buffering. Anything exotic (sparse
 * files, base-256 sizes, hard links) fails loudly instead of mis-extracting.
 */

import { Buffer } from 'node:buffer';
import { Readable, Writable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

const BLOCK_SIZE = 512;

/** What to extract from a tar.gz byte stream. */
export interface TarGzExtraction {
  /**
   * Keep a regular-file entry only when this returns true. Called with the
   * entry path after root stripping; rejected entries' data is discarded
   * without buffering.
   */
  include?: (path: string) => boolean;
  /** Called once per kept regular file with its full bytes. */
  onFile: (path: string, bytes: Buffer) => void;
}

/** A web ReadableStream (fetch body) or a Node Readable. */
export type TarGzSource = NodeReadableStream<Uint8Array> | Readable;

interface OpenEntry {
  path: string;
  /** File bytes still expected before the entry is complete. */
  remaining: number;
  /** Zero padding after the content, up to the next block boundary. */
  padding: number;
  /** Content chunks; null while a non-file or rejected entry is discarded. */
  chunks: Buffer[] | null;
  /** How the completed content configures the parser, if it is a record. */
  meta: 'pax' | 'gnu-name' | null;
}

class TarParser extends Writable {
  private pending: Buffer = Buffer.alloc(0);
  private entry: OpenEntry | null = null;
  private paxPath: string | null = null;
  private paxSize: number | null = null;
  private gnuName: string | null = null;
  private archiveComplete = false;

  constructor(private readonly extraction: TarGzExtraction) {
    super();
  }

  override _write(chunk: unknown, _encoding: string, callback: (error?: Error | null) => void): void {
    const bytes = chunk as Buffer;
    this.pending = this.pending.length === 0 ? bytes : Buffer.concat([this.pending, bytes]);
    try {
      this.drain();
      callback();
    } catch (err) {
      callback(err as Error);
    }
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (this.entry || (!this.archiveComplete && this.pending.length > 0)) {
      callback(new Error('Truncated tar archive'));
      return;
    }
    callback();
  }

  private drain(): void {
    while (!this.archiveComplete) {
      if (this.entry) {
        if (!this.consumeEntryData()) return;
        continue;
      }
      if (this.pending.length < BLOCK_SIZE) return;
      this.readHeader(this.pending.subarray(0, BLOCK_SIZE));
      this.pending = this.pending.subarray(BLOCK_SIZE);
    }
    this.pending = Buffer.alloc(0);
  }

  /** Returns false while more bytes are needed to finish the open entry. */
  private consumeEntryData(): boolean {
    const entry = this.entry!;
    const take = (want: number): Buffer => {
      const bytes = this.pending.subarray(0, Math.min(want, this.pending.length));
      this.pending = this.pending.subarray(bytes.length);
      return bytes;
    };
    if (entry.remaining > 0) {
      const content = take(entry.remaining);
      entry.chunks?.push(content);
      entry.remaining -= content.length;
      if (entry.remaining > 0) return false;
    }
    if (entry.padding > 0) {
      entry.padding -= take(entry.padding).length;
      if (entry.padding > 0) return false;
    }
    this.entry = null;
    this.completeEntry(entry);
    return true;
  }

  private completeEntry(entry: OpenEntry): void {
    if (entry.meta === 'pax') {
      this.applyPaxRecord(Buffer.concat(entry.chunks || []));
      return;
    }
    if (entry.meta === 'gnu-name') {
      this.gnuName = Buffer.concat(entry.chunks || []).toString('utf8').replace(/\0+$/, '');
      return;
    }
    if (entry.chunks) this.extraction.onFile(entry.path, Buffer.concat(entry.chunks));
  }

  private readHeader(block: Buffer): void {
    if (block.every((byte) => byte === 0)) {
      this.archiveComplete = true;
      return;
    }
    const name = headerText(block, 0, 100);
    const type = String.fromCharCode(block[156] || 0x30);
    const prefix = headerText(block, 345, 155);

    if (type === 'x' || type === 'g') {
      const size = headerSize(block);
      this.entry = {
        path: '',
        remaining: size,
        padding: blockPadding(size),
        chunks: type === 'x' ? [] : null,
        meta: type === 'x' ? 'pax' : null,
      };
      return;
    }
    if (type === 'L' || type === 'K') {
      const size = headerSize(block);
      this.entry = { path: '', remaining: size, padding: blockPadding(size), chunks: [], meta: 'gnu-name' };
      return;
    }

    // A pax `path` or GNU long name overrides the fixed-width header fields of
    // this entry; a pax `size` overrides the octal size field.
    const size = this.paxSize ?? headerSize(block);
    const rawPath = this.paxPath ?? this.gnuName ?? (prefix ? `${prefix}/${name}` : name);
    this.paxPath = null;
    this.paxSize = null;
    this.gnuName = null;

    const repoPath = stripRootSegment(rawPath);
    const isRegularFile = type === '0' || type === '\0';
    const keep = isRegularFile && repoPath.length > 0 && (this.extraction.include?.(repoPath) ?? true);
    this.entry = {
      path: repoPath,
      remaining: size,
      padding: blockPadding(size),
      chunks: keep ? [] : null,
      meta: null,
    };
  }

  /** Apply a pax extended-header record: `<len> <key>=<value>\n` repeated. */
  private applyPaxRecord(record: Buffer): void {
    let offset = 0;
    while (offset < record.length) {
      const space = record.indexOf(0x20, offset);
      if (space < 0) break;
      const length = Number.parseInt(record.subarray(offset, space).toString('ascii'), 10);
      if (!Number.isFinite(length) || length <= 0 || offset + length > record.length) break;
      const field = record.subarray(space + 1, offset + length).toString('utf8').replace(/\n$/, '');
      const separator = field.indexOf('=');
      if (separator > 0) {
        const key = field.slice(0, separator);
        const value = field.slice(separator + 1);
        if (key === 'path') this.paxPath = value;
        if (key === 'size') this.paxSize = Number.parseInt(value, 10);
      }
      offset += length;
    }
  }
}

function headerText(block: Buffer, offset: number, length: number): string {
  return block.subarray(offset, offset + length).toString('utf8').split('\0')[0].trim();
}

function headerSize(block: Buffer): number {
  const raw = block.subarray(124, 136).toString('ascii').replace(/[\0 ]+$/, '').trim();
  const size = Number.parseInt(raw, 8);
  if (!Number.isFinite(size) || size < 0) throw new Error('Unsupported tar size encoding');
  return size;
}

function blockPadding(size: number): number {
  return (BLOCK_SIZE - (size % BLOCK_SIZE)) % BLOCK_SIZE;
}

function stripRootSegment(path: string): string {
  const separator = path.indexOf('/');
  return separator < 0 ? '' : path.slice(separator + 1);
}

/**
 * Extract a tar.gz byte stream, calling {@link TarGzExtraction.onFile} for
 * every kept regular file. Only the current entry is buffered, so memory
 * stays bounded by the largest included file, not the archive size.
 */
export async function extractTarGz(body: TarGzSource, extraction: TarGzExtraction): Promise<void> {
  // Production passes the fetch body (a web stream); plain Node streams,
  // as used by tests, pipeline consumes directly.
  const source = typeof (body as Readable).pipe === 'function'
    ? (body as Readable)
    : Readable.fromWeb(body as NodeReadableStream<Uint8Array>);
  await pipeline(source, createGunzip(), new TarParser(extraction));
}
