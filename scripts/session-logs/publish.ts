/**
 * publish.ts — publish a V3 successor generation beside a pre-V3 session log.
 *
 * A session log is a concatenated-Zstandard-frame container. This module owns
 * the physical framing of the successor, the fail-closed publication order, and
 * the read-back proof that makes `{ verified: true }` honest.
 *
 * FRAMING (SSOT: `@deepseek-ai/dsh-session-persistence-jsonl`, pinned checkout
 * `packages/session/session-persistence-jsonl/src/{zstd.ts,generation.ts,format.ts}`):
 *   - frame 1 decodes to EXACTLY ONE header line (the released reader asserts
 *     `plaintext.indexOf(0x0A) === plaintext.length - 1` for frame 1);
 *   - every following frame carries an event batch;
 *   - every frame is independently decodable and checksummed
 *     (`ZSTD_c_checksumFlag`), exactly like the released writer.
 * The successor's records come from the RELEASED encoder
 * (`encodeCurrentHeader` / `encodeCurrentEvent`), not from the input rows, so
 * the written generation is whatever the catalog considers current.
 *
 * COMPRESSION — Node's `node:zlib` zstd API, no `zstd` CLI (measured on
 * v24.18.0: `zstdCompress`/`zstdDecompress` exist and are used here):
 *   - writing uses `zstdCompressSync` with the checksum parameter, the same
 *     frame the released writer emits;
 *   - READ-BACK needs a frame splitter, because Node's public zstd API decodes
 *     only the FIRST frame of a concatenated stream and silently ignores the
 *     rest (verified in this environment; the released package hits the same
 *     limit and therefore ships its own `scanZstdFrames` + per-frame decoder).
 *   The superseded `scripts/repair-fallbacks-switch-logs.ts` shelled out to the
 *   `zstd` CLI for the same reason; that would put a host binary on the success
 *   path, so this module keeps the pure-Node scanner instead. Cost: the tool
 *   requires Node >= 22.15 (the release that added `node:zlib` zstd); the repo
 *   runtime floor is Node 22 and the pinned harness runs Node 24.
 *
 * FAIL-CLOSED PUBLICATION ORDER (`publishSuccessor`):
 *   1. refuse without a resolved catalog (no oracle -> no write);
 *   2. read the original and record its sha256 (never written to);
 *   3. take a defensive copy of the caller's rows — they alias `form` /
 *      `summary` / `sections` objects owned by the caller, and the released
 *      restore is documented as validating an artifact it may mutate in place;
 *   4. re-run the released restore under the STRICT recovery policy: a repaired
 *      log must not silently truncate at a swallowed refusal (the recoverable
 *      policy classification uses records the first issue and drops the rows
 *      after it until a `turn/end` row surfaces it);
 *   5. write to a noncanonical temporary name, verify it by reading the frames
 *      back through the same catalog with `validation: 'current'` (STRONGER than
 *      the host's own header restore, which runs `{ recovery: 'strict',
 *      validation: 'transformed' }`), then publish it exclusively with `link` so
 *      an existing successor is never overwritten with different bytes;
 *   6. remove the temporary and re-verify the original's sha256.
 * A failure at any step writes nothing canonical and removes the temporary.
 */
import { createHash, randomBytes } from 'node:crypto'
import { link, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import type { CatalogHandle, ReleasedArtifact, ReleasedCatalog } from './catalog.ts'
import { restoreRows } from './catalog.ts'
import type { ParsedRow } from './rules.ts'

/** Zstandard frame magic (little-endian `0xFD2FB528`). */
const ZSTD_MAGIC = 0xFD2FB528

/** The released writer's checksummed frame options (`ZSTD_c_checksumFlag`). */
const ZSTD_CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

/** Result of one successful publication. */
export interface PublishedSuccessor {
  /** Generation the successor carries (the restored artifact header version). */
  generation: number
  /** Always `true`: the successor was read back through the catalog. */
  verified: true
}

/** One structurally complete Zstandard frame inside a concatenated container. */
interface ZstdFrameRange {
  /** Inclusive frame start. */
  start: number
  /** Exclusive frame end. */
  end: number
}

/* ------------------------------------------------------------------ */
/* physical framing                                                    */
/* ------------------------------------------------------------------ */

/** Serialize one record as one JSONL line, refusing a non-JSON value. */
function recordLine(record: Record<string, unknown>, subject: string): string {
  const text: unknown = JSON.stringify(record)
  if (typeof text !== 'string') throw new Error(`${subject} is not lossless JSON`)
  return `${text}\n`
}

/**
 * Encode one successor generation as a concatenated-frame container: the first
 * frame holds EXACTLY the header line, the second (when the log has events)
 * holds the event batch.
 *
 * @param headerRecord released current header record.
 * @param eventRecords released current event records, in log order.
 * @returns the complete container bytes.
 */
export function encodeZstdFrames(
  headerRecord: Record<string, unknown>,
  eventRecords: readonly Record<string, unknown>[],
): Buffer {
  const frames = [compressFrame(recordLine(headerRecord, 'session header'))]
  if (eventRecords.length > 0) {
    const batch = eventRecords.map((record, index) => recordLine(record, `session event ${index}`)).join('')
    frames.push(compressFrame(batch))
  }
  return Buffer.concat(frames)
}

/**
 * Decode every frame of one concatenated container, in file order.
 *
 * @param bytes container bytes (an original log or a published generation).
 * @returns the plaintext of each frame.
 */
export function decodeZstdFrames(bytes: Buffer): string[] {
  return scanZstdFrames(bytes).map(({ start, end }, index) => {
    try {
      return zstdDecompressSync(bytes.subarray(start, end)).toString('utf8')
    } catch (error) {
      throw new Error(`corrupt Zstandard session log: frame ${index} at byte ${start} failed to decode`, { cause: error })
    }
  })
}

/** Compress one frame with the released writer's checksummed options. */
function compressFrame(text: string): Buffer {
  return zstdCompressSync(Buffer.from(text, 'utf8'), ZSTD_CHECKSUM_OPTIONS)
}

/**
 * Locate every complete frame without decompressing its blocks, so a torn or
 * corrupt container is refused before any row is trusted. Adapted from the
 * released `scanZstdFrames` (see the module docblock); unlike the released
 * metadata scanner this one has no torn-tail mode: a published generation must
 * be complete.
 */
function scanZstdFrames(buffer: Buffer): ZstdFrameRange[] {
  if (buffer.length === 0) throw new Error('empty session log: no Zstandard frame')
  const frames: ZstdFrameRange[] = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4 || buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) throw new Error(`torn Zstandard session log: truncated frame at byte ${start}`)
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (offset > buffer.length) throw new Error(`torn Zstandard session log: truncated frame header at byte ${start}`)
    for (;;) {
      if (buffer.length - offset < 3) throw new Error(`torn Zstandard session log: truncated frame at byte ${start}`)
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) {
        throw new Error(`torn Zstandard session log: truncated frame at byte ${start}`)
      }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) throw new Error(`torn Zstandard session log: truncated frame at byte ${start}`)
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

/**
 * Canonical successor filename for one generation (SSOT:
 * `generationLogFilename` in `@deepseek-ai/dsh-session-persistence-jsonl`):
 * version 0 keeps the suffix-only name, later generations carry `v<N>`.
 */
function successorFilename(version: number): string {
  return version === 0 ? 'session.jsonl.zstd' : `session.v${version}.jsonl.zstd`
}

/* ------------------------------------------------------------------ */
/* publication                                                         */
/* ------------------------------------------------------------------ */

/**
 * Require a resolved catalog: the fail-closed guard every `--apply` path must
 * pass before it touches a log. Exported so the CLI can refuse with the same
 * message the publisher would raise.
 *
 * @param catalog handle from `resolveCatalog`, or its absence.
 * @returns the handle, when present.
 */
export function assertCatalog(catalog: CatalogHandle | null | undefined): CatalogHandle {
  if (catalog === null || catalog === undefined) {
    throw new Error(
      'no released session-format catalog resolved: refusing to write a successor generation. '
      + 'Pass --catalog <path> or set DSH_SESSION_FORMAT_CATALOG to the @deepseek-ai/dsh-session-format-catalog package.',
    )
  }
  return catalog
}

/**
 * Publish the successor generation of a pre-V3 log, verified by reading it back
 * through the released catalog.
 *
 * @param logPath the ORIGINAL log file (never modified; only read).
 * @param normalizedRows the log's rows after the rule registry normalized them.
 * @param catalog resolved released catalog, or `null` — an absent oracle refuses.
 * @returns the published generation and its verification.
 */
export async function publishSuccessor(
  logPath: string,
  normalizedRows: readonly ParsedRow[],
  catalog: CatalogHandle | null,
): Promise<PublishedSuccessor> {
  const handle = assertCatalog(catalog)
  const originalBytes = await readFile(logPath)
  const originalDigest = sha256(originalBytes)

  // Defensive copy: the caller's rows alias `form` / `summary` / `sections`
  // objects, and the released restore may normalize the artifact in place.
  const rows = structuredClone(normalizedRows)
  const artifact = restoreRows(handle.catalog, rows, { recovery: 'strict', validation: 'transformed' })
  const generation = artifact.header.version
  const targetPath = join(dirname(logPath), successorFilename(generation))
  if (resolve(targetPath) === resolve(logPath)) {
    throw new Error(`refusing to publish the successor generation over its own source: ${logPath}`)
  }

  const bytes = encodeZstdFrames(
    handle.catalog.encodeCurrentHeader(artifact.header, artifact.inheritedEventCount),
    artifact.events.map((event) => handle.catalog.encodeCurrentEvent(event)),
  )

  const temporaryPath = join(dirname(logPath), `session.repair.${randomBytes(6).toString('hex')}.jsonl.zstd.tmp`)
  try {
    // Inside the guarded region: a failure MID-write (ENOSPC, quota, a killed
    // process) leaves a truncated temporary behind, and the cleanup below is what
    // guarantees no `.tmp` is ever stranded.
    await writeFile(temporaryPath, bytes, { flag: 'wx', mode: 0o600 })
    // Read the staged generation back with the host's current-generation policy
    // BEFORE it becomes visible under its canonical name.
    verifyGeneration(handle.catalog, await readFile(temporaryPath), generation)
    await publishExclusive(temporaryPath, targetPath, sha256(bytes))
  } catch (error) {
    try {
      await rm(temporaryPath, { force: true })
    } catch (cleanupFailure) {
      throw new AggregateError(
        [error, cleanupFailure],
        `failed to remove the staged generation ${temporaryPath} after an earlier failure`,
      )
    }
    throw error
  }
  // The target holds the verified bytes; a redundant temporary link cannot turn
  // a successful publication into a failure.
  try {
    await rm(temporaryPath, { force: true })
  } catch {
    // The canonical target is already published and verified.
  }

  if (sha256(await readFile(logPath)) !== originalDigest) {
    throw new Error(`the source generation changed during publication: ${logPath}`)
  }
  return { generation, verified: true }
}

/**
 * Read one complete published generation back through the catalog.
 *
 * `validation: 'current'` runs every installed current-format check, which is
 * STRICTER than the host's own header restore for a current generation: the host
 * restores with `{ recovery: 'strict', validation: 'transformed' }`, while this
 * read-back holds the staged bytes to the full current-format validation before
 * they become visible under a canonical name.
 *
 * @param catalog released catalog to read with.
 * @param bytes published container bytes.
 * @param expectedGeneration generation the filename promises.
 */
function verifyGeneration(
  catalog: ReleasedCatalog,
  bytes: Buffer,
  expectedGeneration: number,
): ReleasedArtifact {
  const [headerFrame, ...eventFrames] = decodeZstdFrames(bytes)
  if (headerFrame === undefined) throw new Error('published generation carries no Zstandard frame')
  if (headerFrame.indexOf('\n') !== headerFrame.length - 1) {
    throw new Error('published generation frame 1 is not exactly one header line')
  }
  const restore = catalog.createRestore(JSON.parse(headerFrame.slice(0, -1)), {
    recovery: 'strict',
    validation: 'current',
  })
  for (const line of eventFrames.join('').split('\n')) {
    if (line.length === 0) continue
    restore.decodeRow(JSON.parse(line))
  }
  const artifact = restore.finish()
  if (artifact.header.version !== expectedGeneration) {
    throw new Error(
      `published generation reads back as v${artifact.header.version}, expected v${expectedGeneration}`,
    )
  }
  return artifact
}

/**
 * Publish the staged bytes exclusively: `link` never replaces an existing
 * successor, and an existing target is accepted only when it already carries
 * exactly these bytes (a re-run of the same repair).
 */
async function publishExclusive(temporaryPath: string, targetPath: string, digest: string): Promise<void> {
  try {
    await link(temporaryPath, targetPath)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const existing = await readFile(targetPath)
  if (sha256(existing) !== digest) {
    throw new Error(
      `refusing to replace the existing successor generation ${targetPath}: it holds different bytes`,
    )
  }
}

/** Hex sha256 of one byte buffer. */
function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}
