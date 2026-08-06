import { migrationSourceDocumentation } from './sourceDocumentation';
import type {
  MigrationArtifact,
  MigrationBiSourceTool,
  MigrationSourceEvidenceContract,
  MigrationSourceTool,
} from './types';

const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, shift: number): number {
  return (value >>> shift) | (value << (32 - shift));
}

// Browser-compatible SHA-256 keeps manual evidence fingerprints synchronous with inventory construction.
export function sha256Text(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const bitLength = bytes.length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const state = new Uint32Array([
    0x6a09e667,
    0xbb67ae85,
    0x3c6ef372,
    0xa54ff53a,
    0x510e527f,
    0x9b05688c,
    0x1f83d9ab,
    0x5be0cd19,
  ]);
  const schedule = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      schedule[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const left = schedule[index - 15]!;
      const right = schedule[index - 2]!;
      const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
      const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
      schedule[index] = (schedule[index - 16]! + sigma0 + schedule[index - 7]! + sigma1) >>> 0;
    }

    let a = state[0]!;
    let b = state[1]!;
    let c = state[2]!;
    let d = state[3]!;
    let e = state[4]!;
    let f = state[5]!;
    let g = state[6]!;
    let h = state[7]!;

    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 = (h + sum1 + choice + SHA256_CONSTANTS[index]! + schedule[index]!) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }

    state[0] = (state[0]! + a) >>> 0;
    state[1] = (state[1]! + b) >>> 0;
    state[2] = (state[2]! + c) >>> 0;
    state[3] = (state[3]! + d) >>> 0;
    state[4] = (state[4]! + e) >>> 0;
    state[5] = (state[5]! + f) >>> 0;
    state[6] = (state[6]! + g) >>> 0;
    state[7] = (state[7]! + h) >>> 0;
  }

  return Array.from(state).map((part) => part.toString(16).padStart(8, '0')).join('');
}

export function migrationArtifactSha256(artifact: MigrationArtifact): string {
  return sha256Text(artifact.content);
}

export function migrationArtifactIsTruncated(artifact: MigrationArtifact): boolean {
  return artifact.parseWarnings.some((warning) => /truncat/i.test(warning));
}

export function migrationArtifactFingerprintSha256(artifact: MigrationArtifact): string | undefined {
  return migrationArtifactIsTruncated(artifact) ? undefined : migrationArtifactSha256(artifact);
}

interface ManualSourceEvidenceOptions {
  parser?: MigrationSourceEvidenceContract['parser'];
  selectedScopeIds?: string[];
  collectionComplete?: boolean;
  collectionTruncated?: boolean;
  permissionGaps?: string[];
  dependencyClosure?: MigrationSourceEvidenceContract['dependencyClosure'];
  documentationIds?: string[];
  diagnostics?: string[];
}

function officialDocumentationUrls(sourceTool: MigrationSourceTool): string[] {
  return sourceTool === 'dbt'
    ? []
    : migrationSourceDocumentation(sourceTool as MigrationBiSourceTool).map((reference) => reference.url);
}

export function buildManualSourceEvidence(
  sourceTool: MigrationSourceTool,
  artifacts: MigrationArtifact[],
  options: ManualSourceEvidenceOptions = {},
): MigrationSourceEvidenceContract {
  const truncated = options.collectionTruncated ?? artifacts.some(migrationArtifactIsTruncated);
  const fingerprints = artifacts.map((artifact) => ({
    name: artifact.name,
    sha256: migrationArtifactFingerprintSha256(artifact),
    sizeBytes: artifact.sizeBytes,
  }));
  const selectedScopeIds = options.selectedScopeIds || artifacts.map((artifact, index) => {
    const sha256 = fingerprints[index]!.sha256;
    return `manual:${encodeURIComponent(artifact.name)}${sha256 ? `:${sha256.slice(0, 16)}` : ''}`;
  });

  return {
    schemaVersion: 'omnikit.source-evidence.v2',
    sourceTool,
    parser: options.parser || { name: 'OmniKit local parser', version: '2' },
    acquisition: {
      mode: 'manual',
      selectedScopeIds: Array.from(new Set(selectedScopeIds.filter(Boolean))).sort(),
    },
    collection: {
      observedArtifactCount: artifacts.length,
      complete: Boolean(options.collectionComplete) && !truncated,
      truncated,
      permissionGaps: Array.from(new Set(options.permissionGaps || [])).sort(),
    },
    dependencyClosure: options.dependencyClosure || {
      status: 'not_evaluated',
      resolvedCount: 0,
      missingCount: 0,
      reviewCount: 0,
    },
    artifactFingerprints: fingerprints,
    documentationIds: Array.from(new Set(options.documentationIds || officialDocumentationUrls(sourceTool))).sort(),
    diagnostics: Array.from(new Set([
      ...(options.diagnostics || ['Manual upload completeness and dependency closure require explicit review.']),
      ...(truncated ? ['A complete-file SHA-256 fingerprint is unavailable for truncated source evidence.'] : []),
    ])).sort(),
  };
}
