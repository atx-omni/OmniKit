import JSZip from 'jszip';
import { artifactFromText } from './adapters';
import type { MigrationArtifact } from './types';

export const POWER_BI_PROJECT_LIMITS = {
  archiveBytes: 12 * 1024 * 1024,
  fileBytes: 5 * 1024 * 1024,
  totalBytes: 18 * 1024 * 1024,
  files: 1_000,
} as const;

const ALLOWED_EXTENSIONS = new Set([
  '.bim', '.csv', '.json', '.m', '.md', '.pbip', '.pbir', '.pbism', '.sql', '.tmdl', '.txt', '.yaml', '.yml',
]);

const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP64_UINT16 = 0xffff;
const ZIP64_UINT32 = 0xffffffff;

interface PowerBiZipEntryMetadata {
  path: string;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  directory: boolean;
}

interface BoundedZipStream {
  on(event: 'data', listener: (value: Uint8Array) => void): BoundedZipStream;
  on(event: 'error', listener: (error: unknown) => void): BoundedZipStream;
  on(event: 'end', listener: () => void): BoundedZipStream;
  pause(): BoundedZipStream;
  resume(): BoundedZipStream;
}

type StreamableZipObject = JSZip.JSZipObject & {
  internalStream(type: 'uint8array'): BoundedZipStream;
};

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function extension(path: string) {
  const fileName = path.split('/').pop() || path;
  const index = fileName.lastIndexOf('.');
  return index >= 0 ? fileName.slice(index).toLowerCase() : '';
}

function isIgnoredPath(path: string) {
  return path.startsWith('__MACOSX/') || path.split('/').some((part) => part === '.DS_Store' || part.startsWith('._'));
}

function findZipEnd(bytes: Uint8Array): number {
  const minimum = Math.max(0, bytes.byteLength - 65_557);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_END_SIGNATURE) return offset;
  }
  throw new Error('The Power BI project archive is corrupt or missing its ZIP directory.');
}

function decodeZipPath(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('A Power BI project ZIP entry name is not valid UTF-8. Rename the source file and export the project again.');
  }
}

function inspectPowerBiZip(bytes: Uint8Array, archiveName: string): PowerBiZipEntryMetadata[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOffset = findZipEnd(bytes);
  const diskNumber = view.getUint16(endOffset + 4, true);
  const centralDisk = view.getUint16(endOffset + 6, true);
  const entriesOnDisk = view.getUint16(endOffset + 8, true);
  const entryCount = view.getUint16(endOffset + 10, true);
  const centralSize = view.getUint32(endOffset + 12, true);
  const centralOffset = view.getUint32(endOffset + 16, true);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) throw new Error(`${archiveName} uses a multi-disk ZIP format that OmniKit does not accept.`);
  if (entryCount === ZIP64_UINT16 || centralSize === ZIP64_UINT32 || centralOffset === ZIP64_UINT32) throw new Error(`${archiveName} uses ZIP64 metadata. Export a smaller Power BI project archive.`);
  if (entryCount > POWER_BI_PROJECT_LIMITS.files) throw new Error(`${archiveName} contains more than ${POWER_BI_PROJECT_LIMITS.files.toLocaleString()} files.`);
  if (centralOffset + centralSize > endOffset || centralOffset < 0) throw new Error(`${archiveName} has an invalid ZIP directory range.`);

  const entries: PowerBiZipEntryMetadata[] = [];
  const seen = new Set<string>();
  let declaredTotal = 0;
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > endOffset || view.getUint32(offset, true) !== ZIP_CENTRAL_SIGNATURE) throw new Error(`${archiveName} has a corrupt ZIP directory entry.`);
    const flags = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const nextOffset = offset + 46 + fileNameLength + extraLength + commentLength;
    if (nextOffset > endOffset) throw new Error(`${archiveName} has a truncated ZIP directory entry.`);
    if ((flags & 0x1) !== 0) throw new Error(`${archiveName} contains encrypted files. Export the Power BI project without ZIP encryption.`);
    if (compressedSize === ZIP64_UINT32 || uncompressedSize === ZIP64_UINT32) throw new Error(`${archiveName} contains a ZIP64 entry. Export a smaller Power BI project archive.`);
    const rawPath = decodeZipPath(bytes.subarray(offset + 46, offset + 46 + fileNameLength));
    const directory = rawPath.endsWith('/');
    const path = normalizePowerBiProjectPath(directory ? rawPath.replace(/\/+$/, '') : rawPath);
    if (!directory) {
      const duplicateKey = path.toLowerCase();
      if (seen.has(duplicateKey)) throw new Error(`Duplicate Power BI project path: ${path}`);
      seen.add(duplicateKey);
      if (!isIgnoredPath(path) && ALLOWED_EXTENSIONS.has(extension(path))) {
        if (uncompressedSize > POWER_BI_PROJECT_LIMITS.fileBytes) {
          throw new Error(`${path} declared expanded size exceeds the ${(POWER_BI_PROJECT_LIMITS.fileBytes / 1024 / 1024).toFixed(0)} MB Power BI project file limit.`);
        }
        declaredTotal += uncompressedSize;
        if (declaredTotal > POWER_BI_PROJECT_LIMITS.totalBytes) {
          throw new Error(`${archiveName} declared expanded text exceeds the ${(POWER_BI_PROJECT_LIMITS.totalBytes / 1024 / 1024).toFixed(0)} MB total limit.`);
        }
      }
    }
    entries.push({ path, compressedSize, uncompressedSize, crc32: view.getUint32(offset + 16, true), directory });
    offset = nextOffset;
  }
  if (offset !== centralOffset + centralSize) throw new Error(`${archiveName} has inconsistent ZIP directory metadata.`);
  return entries;
}

function updateCrc32(previous: number, bytes: Uint8Array): number {
  let crc = (previous ^ 0xffffffff) >>> 0;
  for (let index = 0; index < bytes.byteLength; index += 1) crc = CRC32_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function readBoundedZipEntry(
  entry: JSZip.JSZipObject,
  metadata: PowerBiZipEntryMetadata,
  archiveName: string,
  totalBeforeEntry: number,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    const stream = (entry as StreamableZipObject).internalStream('uint8array');
    let length = 0;
    let crc32 = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      stream.pause();
      chunks.length = 0;
      reject(error);
    };
    stream
      .on('data', (value: Uint8Array) => {
        if (settled) return;
        const chunk = value;
        length += chunk.byteLength;
        if (length > POWER_BI_PROJECT_LIMITS.fileBytes) {
          fail(new Error(`${metadata.path} expanded beyond the ${(POWER_BI_PROJECT_LIMITS.fileBytes / 1024 / 1024).toFixed(0)} MB Power BI project file limit.`));
          return;
        }
        if (totalBeforeEntry + length > POWER_BI_PROJECT_LIMITS.totalBytes) {
          fail(new Error(`${archiveName} expanded beyond the ${(POWER_BI_PROJECT_LIMITS.totalBytes / 1024 / 1024).toFixed(0)} MB total text limit.`));
          return;
        }
        crc32 = updateCrc32(crc32, chunk);
        chunks.push(chunk);
      })
      .on('error', (error: unknown) => fail(error instanceof Error ? error : new Error(String(error))))
      .on('end', () => {
        if (settled) return;
        if (length !== metadata.uncompressedSize) {
          fail(new Error(`${metadata.path} expanded to ${length.toLocaleString()} bytes but declared ${metadata.uncompressedSize.toLocaleString()}; the ZIP is corrupt.`));
          return;
        }
        if (crc32 !== metadata.crc32) {
          fail(new Error(`${metadata.path} failed its CRC integrity check; the ZIP is corrupt.`));
          return;
        }
        const output = new Uint8Array(length);
        let cursor = 0;
        chunks.forEach((chunk) => { output.set(chunk, cursor); cursor += chunk.byteLength; });
        settled = true;
        resolve(output);
      })
      .resume();
  });
}

export function normalizePowerBiProjectPath(input: string): string {
  const normalized = input.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) throw new Error('Power BI project files must use safe relative paths.');
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error(`Unsafe Power BI project path: ${input}`);
  if (normalized.length > 800) throw new Error(`Power BI project path is too long: ${input.slice(0, 120)}`);
  return normalized;
}

function decodeUtf8(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${path} is not valid UTF-8 text. Export the Power BI project using its source-control format.`);
  }
}

function artifactFromBytes(path: string, bytes: Uint8Array): MigrationArtifact {
  if (bytes.byteLength > POWER_BI_PROJECT_LIMITS.fileBytes) {
    throw new Error(`${path} exceeds the ${(POWER_BI_PROJECT_LIMITS.fileBytes / 1024 / 1024).toFixed(0)} MB Power BI project file limit.`);
  }
  const artifact = artifactFromText('power_bi', decodeUtf8(bytes, path), path);
  if (!artifact) throw new Error(`${path} has no readable content.`);
  artifact.sizeBytes = bytes.byteLength;
  return artifact;
}

function appendWarnings(artifacts: MigrationArtifact[], warnings: string[]) {
  if (warnings.length > 0 && artifacts[0]) artifacts[0].parseWarnings.push(...warnings.slice(0, 30));
  return artifacts;
}

function validateBundle(artifacts: MigrationArtifact[]) {
  if (artifacts.length === 0) throw new Error('No supported Power BI project files were found.');
  if (artifacts.length > POWER_BI_PROJECT_LIMITS.files) throw new Error(`Power BI projects may contain at most ${POWER_BI_PROJECT_LIMITS.files.toLocaleString()} readable files.`);
  const totalBytes = artifacts.reduce((total, artifact) => total + artifact.sizeBytes, 0);
  if (totalBytes > POWER_BI_PROJECT_LIMITS.totalBytes) {
    throw new Error(`Power BI project text exceeds the ${(POWER_BI_PROJECT_LIMITS.totalBytes / 1024 / 1024).toFixed(0)} MB total limit.`);
  }
  const seen = new Set<string>();
  artifacts.forEach((artifact) => {
    const key = artifact.name.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate Power BI project path: ${artifact.name}`);
    seen.add(key);
  });
  return artifacts;
}

export async function artifactsFromPowerBiZip(
  bytes: Uint8Array,
  archiveName = 'power-bi-project.zip',
  remaining: { files: number; bytes: number } = { files: POWER_BI_PROJECT_LIMITS.files, bytes: POWER_BI_PROJECT_LIMITS.totalBytes },
): Promise<MigrationArtifact[]> {
  if (bytes.byteLength > POWER_BI_PROJECT_LIMITS.archiveBytes) {
    throw new Error(`${archiveName} exceeds the ${(POWER_BI_PROJECT_LIMITS.archiveBytes / 1024 / 1024).toFixed(0)} MB archive limit.`);
  }
  const metadata = inspectPowerBiZip(bytes, archiveName);
  const supportedMetadata = metadata.filter((entry) => !entry.directory && !isIgnoredPath(entry.path) && ALLOWED_EXTENSIONS.has(extension(entry.path)));
  if (supportedMetadata.length > remaining.files) {
    throw new Error(`${archiveName} would exceed the remaining Power BI project file limit before extraction.`);
  }
  const declaredSupportedBytes = supportedMetadata.reduce((total, entry) => total + entry.uncompressedSize, 0);
  if (declaredSupportedBytes > remaining.bytes) {
    throw new Error(`${archiveName} would exceed the remaining Power BI project text limit before extraction.`);
  }
  const metadataByPath = new Map(metadata.filter((entry) => !entry.directory).map((entry) => [entry.path.toLowerCase(), entry]));
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: false, createFolders: false });
  const artifacts: MigrationArtifact[] = [];
  const warnings: string[] = [];
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (entries.length > POWER_BI_PROJECT_LIMITS.files) throw new Error(`${archiveName} contains more than ${POWER_BI_PROJECT_LIMITS.files.toLocaleString()} files.`);

  for (const entry of entries) {
    const unsafeName = String((entry as JSZip.JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName || entry.name);
    const safePath = normalizePowerBiProjectPath(unsafeName);
    const entryMetadata = metadataByPath.get(safePath.toLowerCase());
    if (!entryMetadata) throw new Error(`${archiveName} contains an entry that was not present in its validated ZIP directory: ${safePath}`);
    if (isIgnoredPath(safePath)) continue;
    if (!ALLOWED_EXTENSIONS.has(extension(safePath))) {
      warnings.push(`Skipped unsupported project file ${safePath}.`);
      continue;
    }
    const totalBeforeEntry = artifacts.reduce((total, artifact) => total + artifact.sizeBytes, 0);
    artifacts.push(artifactFromBytes(safePath, await readBoundedZipEntry(entry, entryMetadata, archiveName, totalBeforeEntry)));
    validateBundle(artifacts);
  }
  return appendWarnings(validateBundle(artifacts), warnings);
}

function fileProjectPath(file: File) {
  const relative = 'webkitRelativePath' in file ? String(file.webkitRelativePath || '') : '';
  return normalizePowerBiProjectPath(relative || file.name);
}

export async function artifactsFromPowerBiProjectFiles(files: FileList | File[]): Promise<MigrationArtifact[]> {
  const artifacts: MigrationArtifact[] = [];
  const warnings: string[] = [];
  const selectedFiles = Array.from(files);
  if (selectedFiles.length > POWER_BI_PROJECT_LIMITS.files) {
    throw new Error(`Select no more than ${POWER_BI_PROJECT_LIMITS.files.toLocaleString()} Power BI project files at a time.`);
  }
  const prepared = selectedFiles.map((file) => ({ file, path: fileProjectPath(file) }));
  let selectedBytes = 0;
  prepared.forEach(({ file, path }) => {
    if (isIgnoredPath(path) || (!ALLOWED_EXTENSIONS.has(extension(path)) && extension(path) !== '.zip')) return;
    const maximum = extension(path) === '.zip' ? POWER_BI_PROJECT_LIMITS.archiveBytes : POWER_BI_PROJECT_LIMITS.fileBytes;
    if (file.size > maximum) {
      throw new Error(`${path} exceeds the ${(maximum / 1024 / 1024).toFixed(0)} MB ${extension(path) === '.zip' ? 'archive' : 'Power BI project file'} limit.`);
    }
    selectedBytes += file.size;
    if (selectedBytes > POWER_BI_PROJECT_LIMITS.totalBytes) {
      throw new Error(`The selected Power BI files exceed the ${(POWER_BI_PROJECT_LIMITS.totalBytes / 1024 / 1024).toFixed(0)} MB pre-read limit. Split the project into smaller focused uploads.`);
    }
  });

  for (const { file, path } of prepared) {
    if (extension(path) === '.zip') {
      artifacts.push(...await artifactsFromPowerBiZip(new Uint8Array(await file.arrayBuffer()), path, {
        files: POWER_BI_PROJECT_LIMITS.files - artifacts.length,
        bytes: POWER_BI_PROJECT_LIMITS.totalBytes - artifacts.reduce((total, artifact) => total + artifact.sizeBytes, 0),
      }));
      continue;
    }
    if (isIgnoredPath(path)) continue;
    if (!ALLOWED_EXTENSIONS.has(extension(path))) {
      warnings.push(`Skipped unsupported project file ${path}.`);
      continue;
    }
    artifacts.push(artifactFromBytes(path, new Uint8Array(await file.arrayBuffer())));
  }
  return appendWarnings(validateBundle(artifacts), warnings);
}
