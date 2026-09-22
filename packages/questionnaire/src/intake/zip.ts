import { inflateRawSync } from 'node:zlib';

/**
 * A ZIP reader that reads exactly enough of the format to open a spreadsheet,
 * and refuses everything else.
 *
 * WHY THIS EXISTS RATHER THAN A DEPENDENCY
 *
 * An XLSX file is a ZIP of XML, and a questionnaire arrives as a file somebody
 * we have never met emailed to our customer. It is the least trusted input the
 * product accepts — more so than a webhook, which at least carries a signature.
 *
 * The general-purpose libraries are built to open anything, because that is what
 * their users want. This is built to open one narrow thing and to refuse the
 * rest: no writing to disk, no entry it was not asked for, no archive that
 * expands beyond a stated budget, and a hard cap on the compression ratio. A
 * library that parses more than you need is attack surface you did not choose.
 *
 * It also keeps the dependency tree honest. Adericel ships an SBOM and claims
 * sovereignty over where a customer's documents go; adding a transitive tree to
 * read two XML files inside a zip would undercut both for convenience.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * No ZIP64, no encryption, no multi-disk archives, no streaming. A spreadsheet
 * that needs any of those is not a questionnaire, and the refusal says so
 * rather than attempting a partial read.
 */

/** Signatures, little-endian as stored. */
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/** The most an EOCD comment may be, and therefore how far back to search. */
const MAX_COMMENT_BYTES = 0xffff;

export interface ZipLimits {
  /** The archive as it arrives. */
  readonly maxArchiveBytes: number;
  /** Total expanded bytes across every entry read. */
  readonly maxTotalUncompressedBytes: number;
  /** Expanded bytes for any single entry. */
  readonly maxEntryUncompressedBytes: number;
  readonly maxEntries: number;
  /**
   * Expanded-to-stored ratio at which an entry is refused.
   *
   * The classic zip bomb is a few kilobytes that becomes gigabytes. XML
   * compresses extremely well — a large sheet legitimately reaches 50:1 — so
   * the cap is generous and still finite. A ratio check alone is not enough,
   * which is why the byte budgets above exist too: the two together mean an
   * attacker must choose between exceeding the ratio and exceeding the budget.
   */
  readonly maxCompressionRatio: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxArchiveBytes: 25 * 1024 * 1024,
  maxTotalUncompressedBytes: 200 * 1024 * 1024,
  maxEntryUncompressedBytes: 100 * 1024 * 1024,
  maxEntries: 512,
  maxCompressionRatio: 200,
};

export class ZipRefusal extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = 'ZipRefusal';
  }
}

interface CentralEntry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

/**
 * An opened archive: the entry index, and a reader for one entry at a time.
 *
 * Entries are inflated on demand rather than all at once, so an archive whose
 * declared sizes are within budget but whose useful content is two files does
 * not pay for the rest.
 */
export interface OpenZip {
  readonly names: readonly string[];
  readonly entryCount: number;
  /** Read and inflate one entry. Throws `ZipRefusal` if it is not present. */
  read(name: string): Buffer;
  has(name: string): boolean;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  // The EOCD sits at the end, possibly followed by a comment of up to 64 KiB.
  // Searched backwards, because a forward scan can match the signature inside
  // compressed data and produce a wrong answer on a valid file.
  const minimum = Math.max(0, buffer.length - MAX_COMMENT_BYTES - 22);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new ZipRefusal(
    'This file is not a readable spreadsheet: no ZIP end-of-central-directory record was ' +
      'found. A .xlsx is a ZIP archive; a file renamed to .xlsx is not.',
    'NOT_A_ZIP',
  );
}

export function openZip(archive: Buffer, limits: ZipLimits = DEFAULT_ZIP_LIMITS): OpenZip {
  if (archive.length > limits.maxArchiveBytes) {
    throw new ZipRefusal(
      `This file is ${Math.round(archive.length / 1024 / 1024)} MB, over the ` +
        `${Math.round(limits.maxArchiveBytes / 1024 / 1024)} MB limit for a questionnaire. ` +
        'A questionnaire this large is usually a workbook with embedded images or data ' +
        'sheets; send the question sheet on its own.',
      'ARCHIVE_TOO_LARGE',
    );
  }
  if (archive.length < 22) {
    throw new ZipRefusal('This file is too small to be a spreadsheet.', 'NOT_A_ZIP');
  }

  const eocd = findEndOfCentralDirectory(archive);

  const disk = archive.readUInt16LE(eocd + 4);
  const startDisk = archive.readUInt16LE(eocd + 6);
  if (disk !== 0 || startDisk !== 0) {
    throw new ZipRefusal(
      'This archive spans multiple disks, which a questionnaire never does.',
      'MULTI_DISK',
    );
  }

  const declaredEntries = archive.readUInt16LE(eocd + 10);
  const centralSize = archive.readUInt32LE(eocd + 12);
  const centralOffset = archive.readUInt32LE(eocd + 16);

  if (declaredEntries === 0xffff || centralOffset === 0xffffffff) {
    throw new ZipRefusal(
      'This archive uses the ZIP64 extension. Adericel reads ordinary spreadsheets only.',
      'ZIP64_UNSUPPORTED',
    );
  }
  if (declaredEntries > limits.maxEntries) {
    throw new ZipRefusal(
      `This archive declares ${declaredEntries} entries, over the ${limits.maxEntries} limit.`,
      'TOO_MANY_ENTRIES',
    );
  }
  if (centralOffset + centralSize > archive.length) {
    throw new ZipRefusal(
      'This archive is truncated or its central directory is corrupt.',
      'TRUNCATED',
    );
  }

  const entries = new Map<string, CentralEntry>();
  let cursor = centralOffset;

  for (let index = 0; index < declaredEntries; index += 1) {
    if (cursor + 46 > archive.length) {
      throw new ZipRefusal('This archive is truncated inside its index.', 'TRUNCATED');
    }
    if (archive.readUInt32LE(cursor) !== CENTRAL_HEADER_SIGNATURE) {
      throw new ZipRefusal('This archive has a corrupt index entry.', 'CORRUPT_INDEX');
    }

    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localHeaderOffset = archive.readUInt32LE(cursor + 42);

    // Bit 0 is the encryption flag. An encrypted questionnaire cannot be read,
    // and saying so is more useful than failing inside the inflater.
    if ((flags & 0x1) !== 0) {
      throw new ZipRefusal(
        'This spreadsheet is password-protected. Adericel cannot open it — send an ' +
          'unprotected copy, or the password separately to a person rather than to the system.',
        'ENCRYPTED',
      );
    }

    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');

    /**
     * Path traversal, refused even though nothing here writes to disk.
     *
     * The reader returns buffers and never touches the filesystem, so `../` is
     * currently harmless. It is refused anyway: the next person to add caching
     * or a debug dump will not re-derive this, and a name like
     * `../../etc/passwd` in a questionnaire is not a mistake.
     */
    if (name.includes('..') || name.startsWith('/') || name.includes('\\')) {
      throw new ZipRefusal(
        `This archive contains an entry named "${name}", which is not a shape a spreadsheet ` +
          'uses. Refusing to read it.',
        'SUSPICIOUS_ENTRY_NAME',
      );
    }

    entries.set(name, {
      name,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  let spent = 0;

  const read = (name: string): Buffer => {
    const entry = entries.get(name);
    if (!entry) {
      throw new ZipRefusal(`This spreadsheet has no "${name}" part.`, 'MISSING_PART');
    }
    if (entry.uncompressedSize > limits.maxEntryUncompressedBytes) {
      throw new ZipRefusal(
        `"${name}" expands to ${entry.uncompressedSize} bytes, over the per-part limit.`,
        'ENTRY_TOO_LARGE',
      );
    }
    if (
      entry.compressedSize > 0 &&
      entry.uncompressedSize / entry.compressedSize > limits.maxCompressionRatio
    ) {
      throw new ZipRefusal(
        `"${name}" expands ${Math.round(entry.uncompressedSize / entry.compressedSize)}:1, ` +
          `over the ${limits.maxCompressionRatio}:1 limit. An archive that expands this far ` +
          'is a compression bomb rather than a document.',
        'COMPRESSION_BOMB',
      );
    }

    const header = entry.localHeaderOffset;
    if (header + 30 > archive.length || archive.readUInt32LE(header) !== LOCAL_HEADER_SIGNATURE) {
      throw new ZipRefusal(`"${name}" has a corrupt local header.`, 'CORRUPT_ENTRY');
    }
    const nameLength = archive.readUInt16LE(header + 26);
    const extraLength = archive.readUInt16LE(header + 28);
    const start = header + 30 + nameLength + extraLength;
    const end = start + entry.compressedSize;
    if (end > archive.length) {
      throw new ZipRefusal(`"${name}" is truncated.`, 'TRUNCATED');
    }

    const stored = archive.subarray(start, end);
    let inflated: Buffer;
    if (entry.method === METHOD_STORED) {
      inflated = Buffer.from(stored);
    } else if (entry.method === METHOD_DEFLATE) {
      /**
       * `maxOutputLength` is the belt to the declared-size braces, and it
       * matters that it refuses DURING inflation rather than after.
       *
       * The uncompressed size in the index is a claim by whoever built the
       * archive. Checking it and then inflating without a cap would mean a
       * lying header expands unbounded in memory first and is refused second —
       * the check would be theatre, and the refusal would arrive after the
       * damage. zlib enforces this one itself, before the allocation.
       *
       * The error it raises is a zlib error, so it is translated: a caller of
       * this module expects a `ZipRefusal` and should not have to know that
       * the failure came from a compression library.
       */
      const budget = Math.max(
        1,
        Math.min(limits.maxEntryUncompressedBytes, limits.maxTotalUncompressedBytes - spent),
      );
      try {
        inflated = inflateRawSync(stored, { maxOutputLength: budget });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ERR_BUFFER_TOO_LARGE' || /buffer/i.test(String((error as Error).message))) {
          throw new ZipRefusal(
            `"${name}" kept expanding past the ${budget}-byte budget while being read. Its ` +
              'index claimed a smaller size, so the file is lying about its own contents.',
            'INFLATION_CAPPED',
          );
        }
        throw new ZipRefusal(
          `"${name}" could not be decompressed; the file is corrupt.`,
          'CORRUPT_ENTRY',
        );
      }
    } else {
      throw new ZipRefusal(
        `"${name}" uses compression method ${entry.method}, which Adericel does not read. ` +
          'Ordinary spreadsheets use deflate.',
        'UNSUPPORTED_COMPRESSION',
      );
    }

    spent += inflated.length;
    if (spent > limits.maxTotalUncompressedBytes) {
      throw new ZipRefusal(
        'This spreadsheet expands beyond the total budget for one questionnaire.',
        'BUDGET_EXHAUSTED',
      );
    }
    return inflated;
  };

  return {
    names: [...entries.keys()],
    entryCount: entries.size,
    read,
    has: (name: string) => entries.has(name),
  };
}
