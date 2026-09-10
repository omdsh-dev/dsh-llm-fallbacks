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
 *   2. read the original and refuse when it no longer matches the digest of the
 *      revision the CALLER decoded its rows from — compared BEFORE anything is
 *      staged, so a concurrent append can never be published as a verified
 *      successor;
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
 *      an existing successor is never overwritten with different bytes; the
 *      result records whether this call CREATED the target or ACCEPTED an
 *      already-identical one;
 *   6. remove the temporary and re-verify the original's digest. When the source
 *      moved after a publication this call CREATED, the successor is unlinked
 *      again (the store is left as found) and the failure says so. When it moved
 *      after ACCEPTING a pre-existing identical successor, that file is left
 *      alone, the failure names it, and it is raised as
 *      {@link PublishedFromStaleSourceError} so no caller can report "nothing was
 *      published".
 * A failure before step 5 writes nothing canonical; the temporary is removed on
 * every error path this process handles (a SIGKILL or a failing `rm` can still
 * strand it, which is why discovery reports such names).
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

/** What one successful publication did with the canonical target. */
export type PublicationOutcome = 'created' | 'accepted'

/** Result of one successful publication. */
export interface PublishedSuccessor {
  /** Generation the successor carries (the restored artifact header version). */
  generation: number
  /** Always `true`: the successor was read back through the catalog. */
  verified: true
  /** Canonical path of the published successor (actionable for rollback). */
  targetPath: string
  /** `created` when this call linked the target, `accepted` when identical bytes were already there. */
  outcome: PublicationOutcome
}

/**
 * A publication that HAPPENED but whose source generation moved afterwards: the
 * successor is on disk (and the host will prefer it) while the rows it was built
 * from are a stale snapshot. Raised instead of a plain error so no caller can
 * report "nothing was published" and so the message can name the file to delete.
 */
export class PublishedFromStaleSourceError extends Error {
  constructor(
    message: string,
    /** Canonical successor left on disk; deleting it rolls the publication back. */
    readonly successorPath: string,
    /** Whether this call created it or accepted an identical pre-existing one. */
    readonly outcome: PublicationOutcome,
  ) {
    super(message)
    this.name = 'PublishedFromStaleSourceError'
  }
}

/**
 * The largest plaintext this decoder will materialize for ONE Zstandard frame.
 *
 * The frame scanner already reads the declared content size, so a frame whose
 * declaration exceeds this ceiling is refused WITHOUT decompressing it, and the
 * decoder is capped at the declared size (or at this ceiling when the frame
 * declares none) so a lying frame cannot expand past what it promised.
 *
 * What the ceiling actually bounds is a session's TOTAL plaintext, not one event:
 * `encodeZstdFrames` batches every event of a generation into a SINGLE frame, so a
 * successor's event frame grows with the whole session. Measured on this machine:
 * 13.9 MB is the largest COMPRESSED log file (not a frame), while the largest frame
 * the host actually decodes is 21.73 MiB — this tool's own successor for that log —
 * so the ceiling carries ~23.6x headroom. A session whose total plaintext
 * legitimately exceeded it would be refused as `decompress-failed` with a coded
 * exit instead of exhausting memory.
 */
export const MAX_FRAME_PLAINTEXT_BYTES = 512 * 1024 * 1024

/** One structurally complete Zstandard frame inside a concatenated container. */
interface ZstdFrameRange {
  /** Inclusive frame start. */
  start: number
  /** Exclusive frame end. */
  end: number
  /** Content size the frame header declares, or `null` when it declares none. */
  declaredBytes: number | null
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
 * The event batch is folded one line at a time into a byte chunk list: each
 * event's JSON string is dropped as soon as its chunk exists, so those strings
 * never accumulate. The chunk list is then concatenated ONCE for the compressor,
 * so the batch's whole plaintext DOES exist at that moment — as that single
 * contiguous buffer, which is the batch's peak (the per-record chunks it was built
 * from are still referenced by the list while it lives). What the fold avoids is a
 * SECOND copy of the batch, not every copy: no `join('')` string is built beside
 * the chunks. The bytes are the same ones a `join('')` + encode would produce.
 *
 * @param headerRecord released current header record.
 * @param eventRecords released current event records, in log order.
 * @returns the complete container bytes.
 */
export function encodeZstdFrames(
  headerRecord: Record<string, unknown>,
  eventRecords: Iterable<Record<string, unknown>>,
): Buffer {
  const frames = [compressFrame(recordLine(headerRecord, 'session header'))]
  const batch: Buffer[] = []
  let index = 0
  for (const record of eventRecords) {
    batch.push(Buffer.from(recordLine(record, `session event ${index}`), 'utf8'))
    index += 1
  }
  if (batch.length > 0) frames.push(compressFrame(Buffer.concat(batch)))
  return Buffer.concat(frames)
}

/**
 * Decode every frame of one concatenated container, in file order, ONE FRAME AT A
 * TIME: the consumer receives frame N's plaintext and decides when to ask for frame
 * N+1, so this generator holds ONE frame's plaintext at a time and never two. That
 * bounds the FRAME, not the session: the event batch is a single frame, so it IS the
 * session's whole event plaintext (see {@link MAX_FRAME_PLAINTEXT_BYTES}). The frame
 * STRUCTURE (the scanner) is still walked before the first frame's plaintext is
 * produced, so a torn or corrupt container is refused up front.
 *
 * Bounded: the scanner reports each frame's DECLARED content size, a declaration
 * above {@link MAX_FRAME_PLAINTEXT_BYTES} is refused before any decompression, and
 * the decompressor itself is capped so a frame that lies about its size cannot
 * expand past its own promise. A refusal here is a `decompress-failed` log (a
 * coded exit), never an out-of-memory crash.
 *
 * @param bytes container bytes (an original log or a published generation).
 * @yields the plaintext of each frame, in file order.
 */
export function* decodeZstdFrameTexts(bytes: Buffer): Generator<string> {
  for (const [index, { start, end, declaredBytes }] of scanZstdFrames(bytes).entries()) {
    if (declaredBytes !== null && declaredBytes > MAX_FRAME_PLAINTEXT_BYTES) {
      throw new Error(
        `refusing to decompress Zstandard frame ${index} at byte ${start}: it declares ${declaredBytes} bytes of `
        + `plaintext, above this tool's ${MAX_FRAME_PLAINTEXT_BYTES}-byte frame ceiling`,
      )
    }
    let plaintext: Buffer
    try {
      plaintext = zstdDecompressSync(bytes.subarray(start, end), {
        // A frame may legitimately declare zero bytes (an empty batch), and
        // `maxOutputLength` must be at least 1.
        maxOutputLength: Math.max(declaredBytes ?? MAX_FRAME_PLAINTEXT_BYTES, 1),
      })
    } catch (error) {
      throw new Error(`corrupt Zstandard session log: frame ${index} at byte ${start} failed to decode`, { cause: error })
    }
    if (declaredBytes !== null && plaintext.length !== declaredBytes) {
      throw new Error(
        `corrupt Zstandard session log: frame ${index} at byte ${start} declares ${declaredBytes} bytes but decoded `
        + `${plaintext.length}`,
      )
    }
    yield plaintext.toString('utf8')
  }
}

/**
 * Materializing convenience over {@link decodeZstdFrameTexts}: every frame's
 * plaintext as one array. Specification code uses it as the independent read-back
 * oracle; nothing on the tool's own path needs the whole container in memory, so
 * production code consumes the generator instead.
 *
 * @param bytes container bytes.
 * @returns the plaintext of each frame, in file order.
 */
export function decodeZstdFrames(bytes: Buffer): string[] {
  return [...decodeZstdFrameTexts(bytes)]
}

/** Compress one frame with the released writer's checksummed options. */
function compressFrame(text: string | Buffer): Buffer {
  return zstdCompressSync(typeof text === 'string' ? Buffer.from(text, 'utf8') : text, ZSTD_CHECKSUM_OPTIONS)
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
    const contentSizeOffset = offset + (singleSegment ? 0 : 1) + dictionaryBytes
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (offset > buffer.length) throw new Error(`torn Zstandard session log: truncated frame header at byte ${start}`)
    // The declared content size is what bounds this frame's expansion; reading it
    // here (rather than discarding it) is what lets a lying frame be refused.
    // Spec quirk: a 2-byte field encodes `Frame_Content_Size - 256`.
    const declaredValue = contentSizeBytes === 0
      ? null
      : sizeToNumber(buffer, contentSizeOffset, contentSizeBytes)
    const declaredBytes = declaredValue === null
      ? null
      : contentSizeBytes === 2 ? declaredValue + 256 : declaredValue
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
    frames.push({ start, end: offset, declaredBytes })
  }
  return frames
}

/**
 * Read one frame header's content-size field (little-endian, 1/2/4/8 bytes) as a
 * number, or `null` when it is not representable as one.
 */
function sizeToNumber(buffer: Buffer, offset: number, width: number): number | null {
  let value = 0
  for (let index = 0; index < width; index += 1) value += buffer.readUInt8(offset + index) * 2 ** (8 * index)
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

/**
 * Canonical successor filename for one generation (SSOT:
 * `generationLogFilename` in `@deepseek-ai/dsh-session-persistence-jsonl`):
 * version 0 keeps the suffix-only name, later generations carry `v<N>`.
 *
 * Exported because this is the ONE implementation of the rule: the CLI's
 * report-mode existing-successor probe resolves the same name through this
 * function, which it receives from `runRepair`'s dynamic import of this module
 * (a static import would defeat the `node:zlib` zstd runtime probe that must run
 * first). `publishSuccessor` derives its target from the RESTORED header's
 * version, the CLI's probe from the resolved catalog's declared
 * `currentVersion` — see the probe's comment in `repair-session-logs.ts`.
 */
export function successorFilename(version: number): string {
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
 * @param sourceDigest sha256 of the bytes the CALLER decoded `normalizedRows`
 *   from. Compared with the file before anything is staged, so a revision the
 *   rows were not built from can never be published as verified.
 * @returns the published generation, its verification, its path and whether this
 *   call created the target or accepted an identical pre-existing one.
 */
export async function publishSuccessor(
  logPath: string,
  normalizedRows: readonly ParsedRow[],
  catalog: CatalogHandle | null,
  sourceDigest: string,
): Promise<PublishedSuccessor> {
  const handle = assertCatalog(catalog)
  const originalBytes = await readFile(logPath)
  const originalDigest = sha256(originalBytes)
  if (originalDigest !== sourceDigest) {
    throw new Error(
      `the source generation changed since it was read: ${logPath} is now ${originalDigest} but the rows to publish `
      + `came from ${sourceDigest}. Nothing was written; re-run so the successor is built from the current revision.`,
    )
  }

  // Defensive copy: the caller's rows alias `form` / `summary` / `sections`
  // objects, and the released restore may normalize the artifact in place.
  const rows = structuredClone(normalizedRows)
  const artifact = restoreRows(handle.catalog, rows, { recovery: 'strict', validation: 'transformed' })
  const generation = artifact.header.version
  const targetPath = join(dirname(logPath), successorFilename(generation))
  if (resolve(targetPath) === resolve(logPath)) {
    throw new Error(`refusing to publish the successor generation over its own source: ${logPath}`)
  }

  // The released encoder's records are handed to `encodeZstdFrames` one at a time
  // (lazily): materializing them all first would hold a second copy of the session
  // alongside the restored artifact it was built from.
  const encodedEvents = function* (): Generator<Record<string, unknown>> {
    for (const event of artifact.events) yield handle.catalog.encodeCurrentEvent(event)
  }
  const bytes = encodeZstdFrames(
    handle.catalog.encodeCurrentHeader(artifact.header, artifact.inheritedEventCount),
    encodedEvents(),
  )

  const temporaryPath = join(dirname(logPath), `session.repair.${randomBytes(6).toString('hex')}.jsonl.zstd.tmp`)
  let outcome: PublicationOutcome
  try {
    // Inside the guarded region: a failure MID-write (ENOSPC, quota) leaves a
    // truncated temporary behind, and the cleanup below is what removes it. The
    // cleanup covers every error path THIS PROCESS handles; a SIGKILL or a failing
    // `rm` can still strand the temporary, which is why discovery reports such
    // names instead of ignoring them.
    await writeFile(temporaryPath, bytes, { flag: 'wx', mode: 0o600 })
    // Read the staged generation back with the host's current-generation policy
    // BEFORE it becomes visible under its canonical name.
    verifyGeneration(handle.catalog, await readFile(temporaryPath), generation)
    outcome = await publishExclusive(temporaryPath, targetPath, sha256(bytes))
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
    await settleStalePublication(logPath, targetPath, outcome)
  }
  return { generation, verified: true, targetPath, outcome }
}

/**
 * Settle a publication whose source generation moved AFTER it landed.
 *
 * The publication HAPPENED, so reporting "nothing was published" would be a lie,
 * and leaving a successor this call CREATED would leave the store changed after a
 * failed run. A created target is therefore removed again (the store is as it
 * was) while an ACCEPTED pre-existing one is never touched; either way the failure
 * names the path so rollback is actionable. Two cases raise
 * {@link PublishedFromStaleSourceError} — an ACCEPTED pre-existing successor (not
 * this call's to delete) and a CREATED one whose own unlink failed — because in
 * both a successor IS on disk and no caller may describe it as "nothing was
 * published"; a created target that was successfully removed raises a plain error,
 * where that wording is true.
 *
 * Always throws. Exported because this is the decision table the fix round added,
 * and it is reachable in production only by an actual race.
 */
export async function settleStalePublication(
  logPath: string,
  targetPath: string,
  outcome: PublicationOutcome,
): Promise<never> {
  if (outcome === 'created') {
    try {
      await rm(targetPath, { force: true })
    } catch (error) {
      // The unlink itself failed, so the file this call created IS still on disk:
      // say that (and name it) instead of letting the raw fs error surface as
      // "nothing was published" while a successor exists.
      throw new PublishedFromStaleSourceError(
        `the source generation changed during publication: ${logPath}, and the successor this call created `
        + `(${targetPath}) could NOT be removed (${error instanceof Error ? error.message : String(error)}) — `
        + 'delete it manually to roll the publication back.',
        targetPath,
        outcome,
      )
    }
    throw new Error(
      `the source generation changed during publication: ${logPath}. The successor this call created `
      + `(${targetPath}) was removed; nothing was published.`,
    )
  }
  throw new PublishedFromStaleSourceError(
    `the source generation changed during publication: ${logPath}. The successor ${targetPath} was already `
    + 'published by an earlier run and now holds a stale snapshot of this session; it was left in place because '
    + 'this run did not create it — delete it to roll the publication back.',
    targetPath,
    outcome,
  )
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
  // The staged container is read back frame by frame: no array of every frame's
  // plaintext, no joined event batch and no split of it — each frame's lines are
  // decoded as that frame is decompressed.
  let restore: ReturnType<ReleasedCatalog['createRestore']> | null = null
  for (const frame of decodeZstdFrameTexts(bytes)) {
    if (restore === null) {
      if (frame.indexOf('\n') !== frame.length - 1) {
        throw new Error('published generation frame 1 is not exactly one header line')
      }
      restore = catalog.createRestore(JSON.parse(frame.slice(0, -1)), {
        recovery: 'strict',
        validation: 'current',
      })
      continue
    }
    for (const line of frame.split('\n')) {
      if (line.length === 0) continue
      restore.decodeRow(JSON.parse(line))
    }
  }
  if (restore === null) throw new Error('published generation carries no Zstandard frame')
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
 *
 * @returns `created` when this call linked the target, `accepted` when identical
 *   bytes were already published.
 */
async function publishExclusive(
  temporaryPath: string,
  targetPath: string,
  digest: string,
): Promise<PublicationOutcome> {
  try {
    await link(temporaryPath, targetPath)
    return 'created'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const existing = await readFile(targetPath)
  if (sha256(existing) !== digest) {
    throw new Error(
      `refusing to replace the existing successor generation ${targetPath}: it holds different bytes`,
    )
  }
  return 'accepted'
}

/** Hex sha256 of one byte buffer. */
function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}
