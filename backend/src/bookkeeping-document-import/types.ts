export type CoverageType = "evidence" | "statement-coverage";
export type DocumentType =
  | "invoice"
  | "receipt"
  | "bank-statement"
  | "private-account-statement"
  | "other-evidence";

export type Manifest = {
  schemaVersion: 1;
  archives: { alias: string; year: number; sha256: string }[];
  documents: {
    sha256: string;
    sources: { archive: string; member: string }[];
    documentType: DocumentType;
    accountId?: string;
    statementMonth?: string;
    transactions: { sourceKey?: string; transactionId?: string; coverageType: CoverageType }[];
    unlinkedApproved?: boolean;
  }[];
  exclusions: {
    archive: string;
    member: string;
    reason: "unsupported-image" | "nested-packaging-archive";
  }[];
};

export type ArchiveInput = { alias: string; path: string };
export type InventoryLimits = {
  maxArchiveBytes: number;
  maxMembers: number;
  maxCompressedBytes: number;
  maxMemberBytes: number;
  maxTotalBytes: number;
  maxCompressionRatio: number;
};
export const DEFAULT_LIMITS: InventoryLimits = {
  maxArchiveBytes: 512 * 1024 * 1024,
  maxMembers: 2_000,
  maxCompressedBytes: 64 * 1024 * 1024,
  maxMemberBytes: 32 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
  maxCompressionRatio: 200,
};
export const MAX_INPUT_CARDINALITY = {
  archives: 16,
  documents: 5_000,
  sourcesPerDocument: 64,
  transactionsPerDocument: 1_000,
  totalLinks: 20_000,
  exclusions: 5_000,
} as const;
export const LIMIT_BOUNDS: Record<keyof InventoryLimits, { min: number; max: number }> = {
  maxArchiveBytes: { min: 1, max: 1024 * 1024 * 1024 },
  maxMembers: { min: 1, max: 5_000 },
  maxCompressedBytes: { min: 1, max: 128 * 1024 * 1024 },
  maxMemberBytes: { min: 1, max: 64 * 1024 * 1024 },
  maxTotalBytes: { min: 1, max: 2 * 1024 * 1024 * 1024 },
  maxCompressionRatio: { min: 1, max: 500 },
};

export function validateInventoryLimits(limits: InventoryLimits) {
  for (const [name, bounds] of Object.entries(LIMIT_BOUNDS) as [keyof InventoryLimits, { min: number; max: number }][]) {
    const value = limits[name];
    if (!Number.isSafeInteger(value) || value < bounds.min || value > bounds.max)
      throw new ImportFailure("invalid-inventory-limits");
  }
  if (
    limits.maxCompressedBytes > limits.maxArchiveBytes ||
    limits.maxMemberBytes > limits.maxTotalBytes
  )
    throw new ImportFailure("invalid-inventory-limits");
  return limits;
}

export class ImportFailure extends Error {
  constructor(
    readonly reason: string,
    readonly privateDetail?: string,
  ) {
    super(reason);
  }
}

export type InventoryDocument = {
  archive: string;
  member: string;
  sha256: string;
  byteSize: number;
};
export type Inventory = {
  archiveFingerprints: Record<string, string>;
  accepted: InventoryDocument[];
  excluded: { archive: string; member: string; reason: string }[];
  occurrenceCount: number;
  uniqueCount: number;
  duplicateCount: number;
};
