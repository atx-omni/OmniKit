export const AI_PROMPT_MAX_CHARACTERS = 96_000;
export const AI_REQUEST_BODY_MAX_CHARACTERS = 110_000;

const SENSITIVE_KEY = String.raw`(?:api[_-]?(?:key|token)|oauth[_-]?token|authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passphrase|private[_-]?key|aws[_-]?secret[_-]?access[_-]?key|secret[_-]?access[_-]?key|auth[_-]?token|secret[_-]?key|token|credential|secret)`;
const PROVIDER_TOKEN = String.raw`(?:sk(?:-|_)(?:(?:proj|live|test)(?:-|_))?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|AIza[A-Za-z0-9_-]{20,}|ya29\.[A-Za-z0-9._-]{20,}|dapi[a-f0-9]{32}|omni_(?:live|test|prod)_[A-Za-z0-9._~+/=-]{16,}|omni_[A-Za-z0-9]{24,}|npm_[A-Za-z0-9]{20,}|pypi-[A-Za-z0-9_-]{20,})`;
const REDACTION_SENTINEL = String.raw`(?:redacted|redacted-private-key|redacted-incomplete-private-key|redacted-jwt|redacted-credential-uri|redacted-cloud-key|redacted-provider-token|redacted-credential-field|redacted-credential-block)`;

const secretProbes: Array<[string, RegExp]> = [
  ['private key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i],
  ['bearer token', /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/i],
  ['JSON Web Token', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['credential-bearing connection URI', /\b(?:postgres(?:ql)?|mysql|snowflake|redshift|mongodb(?:\+srv)?):\/\/[^/\s:@]+:[^@\s/]+@/i],
  ['cloud access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['provider token', new RegExp(String.raw`\b${PROVIDER_TOKEN}(?=$|[^A-Za-z0-9._~+/=-])`, 'i')],
  ['credential assignment', new RegExp(String.raw`\b${SENSITIVE_KEY}\b\s*[=:]\s*(?:["'][^"'\r\n]+["']|[^\s,}\]\r\n]+)`, 'i')],
  ['credential block scalar', new RegExp(String.raw`^\s*${SENSITIVE_KEY}\s*:\s*[>|][+-]?\s*\r?\n(?:[ \t]+\S.*(?:\r?\n|$))+`, 'im')],
];

const redactedAssignmentPattern = new RegExp(
  String.raw`\b${SENSITIVE_KEY}\b\s*[=:]\s*(?:"\[${REDACTION_SENTINEL}\]"|'\[${REDACTION_SENTINEL}\]'|\[${REDACTION_SENTINEL}\])(?=\s*(?:$|[,}\]\r\n]))`,
  'gim',
);
const redactedBlockPattern = new RegExp(
  String.raw`^(\s*${SENSITIVE_KEY}\s*:\s*[>|][+-]?\s*\r?\n)(?:(?:[ \t]+\[redacted\][ \t]*(?:\r?\n|(?![\s\S])))+)(?![ \t]+\S)`,
  'gim',
);
const credentialBlockPattern = new RegExp(
  String.raw`^(\s*${SENSITIVE_KEY}\s*:\s*[>|][+-]?\s*\r?\n)(?:(?:[ \t]+.*(?:\r?\n|$))*)`,
  'gim',
);
const credentialAssignmentPattern = new RegExp(
  String.raw`(\b${SENSITIVE_KEY}\b\s*[=:]\s*)(?:["'][^"'\r\n]*["']|[^\s,}\]\r\n]+)`,
  'gi',
);
const providerTokenPattern = new RegExp(String.raw`\b${PROVIDER_TOKEN}(?=$|[^A-Za-z0-9._~+/=-])`, 'gi');

export function aiPromptSecretFindingsShared(value: string): string[] {
  const inspectable = value
    .replace(redactedBlockPattern, '[redacted-credential-block]\n')
    .replace(redactedAssignmentPattern, '[redacted-credential-field]');
  return [...new Set(secretProbes
    .filter(([, pattern]) => new RegExp(pattern.source, pattern.flags).test(inspectable))
    .map(([label]) => label))];
}

export function redactAiPromptSecrets(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi, '[redacted-private-key]')
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*$/gi, '[redacted-incomplete-private-key]')
    .replace(credentialBlockPattern, '$1  [redacted]\n')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(credentialAssignmentPattern, '$1[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted-jwt]')
    .replace(/\b(?:postgres(?:ql)?|mysql|snowflake|redshift|mongodb(?:\+srv)?):\/\/[^/\s:@]+:[^@\s/]+@/gi, '[redacted-credential-uri]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[redacted-cloud-key]')
    .replace(providerTokenPattern, '[redacted-provider-token]');
}
