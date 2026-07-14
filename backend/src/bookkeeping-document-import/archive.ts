import { createHash } from "crypto";
import { createReadStream, promises as fs } from "fs";
import { Transform } from "stream";
import path from "path";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import {
  DEFAULT_LIMITS,
  ImportFailure,
  MAX_INPUT_CARDINALITY,
  validateInventoryLimits,
  type ArchiveInput,
  type Inventory,
  type InventoryLimits,
  type Manifest,
} from "./types";

const IMAGE = /\.(?:png|jpe?g|gif|webp)$/i;
const NESTED = /\.(?:zip|7z|rar|tar|tgz|gz)$/i;

async function hashFile(file: string) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk as Buffer);
  return digest.digest("hex");
}

function openZip(file: string): Promise<ZipFile> {
  return new Promise((resolve, reject) =>
    yauzl.open(file, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true, autoClose: false }, (error, zip) =>
      error || !zip ? reject(new ImportFailure("malformed-archive")) : resolve(zip),
    ),
  );
}

async function entries(zip: ZipFile, maxMembers: number) {
  const result: Entry[] = [];
  return await new Promise<Entry[]>((resolve, reject) => {
    zip.on("entry", (entry: Entry) => {
      if (result.length >= maxMembers) {
        reject(new ImportFailure("member-count-limit"));
        zip.close();
        return;
      }
      result.push(entry);
      zip.readEntry();
    });
    zip.once("end", () => resolve(result));
    zip.once("error", (error) =>
      reject(
        new ImportFailure(
          /invalid relative path|absolute path/i.test(String(error))
            ? "unsafe-member-path"
            : "malformed-archive",
        ),
      ),
    );
    zip.readEntry();
  });
}

function normalizedMember(name: string) {
  if (/\0|[\x01-\x1f\x7f]/.test(name)) throw new ImportFailure("unsafe-member-path");
  const slash = name.replace(/\\/g, "/");
  if (slash.startsWith("/") || /^[a-zA-Z]:\//.test(slash))
    throw new ImportFailure("unsafe-member-path");
  const normalized = path.posix.normalize(slash).normalize("NFC");
  if (normalized === ".." || normalized.startsWith("../"))
    throw new ImportFailure("unsafe-member-path");
  return normalized;
}

function validateEntry(entry: Entry, limits: InventoryLimits) {
  const normalized = normalizedMember(entry.fileName);
  if ((entry.generalPurposeBitFlag & 1) !== 0) throw new ImportFailure("encrypted-member");
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const type = mode & 0o170000;
  const directory = entry.fileName.endsWith("/");
  if (type === 0o120000 || (type !== 0 && type !== 0o100000 && !(directory && type === 0o040000)))
    throw new ImportFailure("non-regular-member");
  if (entry.compressedSize > limits.maxCompressedBytes || entry.uncompressedSize > limits.maxMemberBytes)
    throw new ImportFailure("member-size-limit");
  const ratio = entry.compressedSize === 0 ? (entry.uncompressedSize ? Infinity : 0) : entry.uncompressedSize / entry.compressedSize;
  if (ratio > limits.maxCompressionRatio) throw new ImportFailure("compression-ratio-limit");
  return { normalized, directory };
}

function streamEntry(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) =>
    zip.openReadStream(entry, (error, stream) =>
      error || !stream ? reject(new ImportFailure("malformed-member")) : resolve(stream),
    ),
  );
}

export async function inspectArchives(
  archives: ArchiveInput[],
  manifest: Manifest,
  limits: InventoryLimits = DEFAULT_LIMITS,
): Promise<Inventory> {
  validateInventoryLimits(limits);
  if (
    !archives.length ||
    archives.length > MAX_INPUT_CARDINALITY.archives ||
    new Set(archives.map((item) => item.alias)).size !== archives.length
  )
    throw new ImportFailure("duplicate-archive-alias");
  if (
    manifest.archives.length !== archives.length ||
    new Set(manifest.archives.map((item) => item.alias)).size !== manifest.archives.length ||
    archives.some((input) => !manifest.archives.some((item) => item.alias === input.alias))
  )
    throw new ImportFailure("archive-manifest-mismatch");
  const exclusionKeys = manifest.exclusions.map(
    (item) => `${item.archive}\0${normalizedMember(item.member)}`,
  );
  if (new Set(exclusionKeys).size !== exclusionKeys.length)
    throw new ImportFailure("duplicate-exclusion");
  const documentHashes = manifest.documents.map((item) => item.sha256.replace(/^sha256:/, ""));
  if (
    documentHashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash)) ||
    new Set(documentHashes).size !== documentHashes.length
  )
    throw new ImportFailure("duplicate-or-invalid-document-hash");
  const sourceKeys = manifest.documents.flatMap((document) =>
    document.sources.map((source) => `${source.archive}\0${normalizedMember(source.member)}`),
  );
  if (new Set(sourceKeys).size !== sourceKeys.length)
    throw new ImportFailure("duplicate-document-source");
  const archiveFingerprints: Record<string, string> = {};
  const accepted: Inventory["accepted"] = [];
  const excluded: Inventory["excluded"] = [];
  const exclusionMap = new Map(
    manifest.exclusions.map((item) => [`${item.archive}\0${normalizedMember(item.member)}`, item]),
  );
  for (const archive of archives) {
    const stat = await fs.stat(archive.path).catch(() => null);
    if (!stat?.isFile() || stat.size > limits.maxArchiveBytes)
      throw new ImportFailure("archive-size-limit", archive.alias);
    archiveFingerprints[archive.alias] = await hashFile(archive.path);
    const declared = manifest.archives.find((item) => item.alias === archive.alias)!;
    if (declared.sha256.replace(/^sha256:/, "") !== archiveFingerprints[archive.alias])
      throw new ImportFailure("archive-fingerprint-mismatch", archive.alias);
    const zip = await openZip(archive.path);
    try {
      const central = await entries(zip, limits.maxMembers);
      let total = 0;
      const names = new Set<string>();
      const validated = central.map((entry) => {
        const info = validateEntry(entry, limits);
        const collision = info.normalized.toLocaleLowerCase("en-US");
        if (names.has(collision)) throw new ImportFailure("normalized-path-collision");
        names.add(collision);
        total += entry.uncompressedSize;
        if (total > limits.maxTotalBytes) throw new ImportFailure("total-size-limit");
        return { entry, ...info };
      });
      const byName = new Map(validated.map((item) => [item.normalized, item]));
      for (const item of validated) {
        if (item.directory) continue;
        const exclusion = exclusionMap.get(`${archive.alias}\0${item.normalized}`);
        if (exclusion) {
          if (
            (exclusion.reason === "unsupported-image" && !IMAGE.test(item.normalized)) ||
            (exclusion.reason === "nested-packaging-archive" && !NESTED.test(item.normalized)) ||
            item.normalized.toLowerCase().endsWith(".pdf")
          )
            throw new ImportFailure("invalid-exclusion", `${archive.alias}:${item.normalized}`);
          excluded.push({ archive: archive.alias, member: item.normalized, reason: exclusion.reason });
          continue;
        }
        if (!item.normalized.toLowerCase().endsWith(".pdf"))
          throw new ImportFailure(NESTED.test(item.normalized) ? "unexcluded-nested-archive" : "unsupported-member");
        const digest = createHash("sha256");
        let prefix = Buffer.alloc(0);
        let byteSize = 0;
        const stream = await streamEntry(zip, item.entry);
        for await (const chunk of stream as AsyncIterable<Uint8Array>) {
          const bytes = Buffer.from(chunk);
          if (prefix.length < 5) prefix = Buffer.concat([prefix, bytes.subarray(0, 5 - prefix.length)]);
          byteSize += bytes.length;
          digest.update(bytes);
        }
        if (prefix.toString("ascii") !== "%PDF-") throw new ImportFailure("invalid-pdf-magic");
        accepted.push({ archive: archive.alias, member: item.normalized, sha256: digest.digest("hex"), byteSize });
      }
      for (const exclusion of manifest.exclusions.filter((item) => item.archive === archive.alias))
        if (!byName.has(normalizedMember(exclusion.member)))
          throw new ImportFailure("unknown-exclusion", archive.alias);
    } finally {
      zip.close();
    }
  }
  const uniqueCount = new Set(accepted.map((item) => item.sha256)).size;
  const acceptedBySource = new Map(
    accepted.map((item) => [`${item.archive}\0${item.member}`, item]),
  );
  if (acceptedBySource.size !== sourceKeys.length)
    throw new ImportFailure("manifest-source-coverage-mismatch");
  for (const [index, document] of manifest.documents.entries()) {
    const hash = documentHashes[index];
    if (!document.sources.length)
      throw new ImportFailure("manifest-source-coverage-mismatch");
    for (const source of document.sources) {
      const acceptedSource = acceptedBySource.get(
        `${source.archive}\0${normalizedMember(source.member)}`,
      );
      if (!acceptedSource || acceptedSource.sha256 !== hash)
        throw new ImportFailure("manifest-content-mismatch");
    }
  }
  return {
    archiveFingerprints,
    accepted,
    excluded,
    occurrenceCount: accepted.length,
    uniqueCount,
    duplicateCount: accepted.length - uniqueCount,
  };
}

export async function openArchiveMember(
  archivePath: string,
  member: string,
  expected: { archiveSha256: string; sha256: string; byteSize: number },
  limits: InventoryLimits = DEFAULT_LIMITS,
): Promise<{ stream: NodeJS.ReadableStream; close: () => void }> {
  validateInventoryLimits(limits);
  const stat = await fs.stat(archivePath).catch(() => null);
  if (!stat?.isFile() || stat.size > limits.maxArchiveBytes)
    throw new ImportFailure("archive-size-limit");
  if ((await hashFile(archivePath)) !== expected.archiveSha256)
    throw new ImportFailure("archive-fingerprint-mismatch");
  const zip = await openZip(archivePath);
  const target = normalizedMember(member);
  let central: Entry[];
  try {
    central = await entries(zip, limits.maxMembers);
  } catch (error) {
    zip.close();
    throw error;
  }
  let total = 0;
  const names = new Set<string>();
  let selected: Entry | undefined;
  for (const entry of central) {
    let info: ReturnType<typeof validateEntry>;
    try {
      info = validateEntry(entry, limits);
    } catch (error) {
      zip.close();
      throw error;
    }
    const collision = info.normalized.toLocaleLowerCase("en-US");
    if (names.has(collision)) throw new ImportFailure("normalized-path-collision");
    names.add(collision);
    total += entry.uncompressedSize;
    if (total > limits.maxTotalBytes) throw new ImportFailure("total-size-limit");
    if (info.normalized === target) selected = entry;
  }
  if (!selected) throw new ImportFailure("manifest-source-missing");
  const source = await streamEntry(zip, selected);
  const hash = createHash("sha256");
  let size = 0;
  let prefix = Buffer.alloc(0);
  const verifier = new Transform({
    transform(chunk, _encoding, callback) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > limits.maxMemberBytes || size > expected.byteSize)
        return callback(new ImportFailure("member-size-limit"));
      if (prefix.length < 5)
        prefix = Buffer.concat([prefix, bytes.subarray(0, 5 - prefix.length)]);
      hash.update(bytes);
      callback(null, bytes);
    },
    flush(callback) {
      if (
        prefix.toString("ascii") !== "%PDF-" ||
        size !== expected.byteSize ||
        hash.digest("hex") !== expected.sha256
      )
        callback(new ImportFailure("archive-content-changed"));
      else callback();
    },
  });
  source.pipe(verifier);
  verifier.once("close", () => zip.close());
  verifier.once("error", () => zip.close());
  return { stream: verifier, close: () => zip.close() };
}
