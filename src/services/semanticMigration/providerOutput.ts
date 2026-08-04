const MAX_STRUCTURED_OUTPUT_CHARACTERS = 4_000_000;

export type ProviderStructuredOutputParseMode = 'strict' | 'extracted' | 'repaired';
export type ProviderStructuredOutputRepair =
  | 'removed_utf8_bom'
  | 'escaped_control_characters'
  | 'removed_trailing_commas';

export interface ProviderStructuredOutputHandling {
  parseMode: ProviderStructuredOutputParseMode;
  extracted: boolean;
  repairs: ProviderStructuredOutputRepair[];
  providerAttempts?: number;
  automaticRetry?: boolean;
}

export class ProviderStructuredOutputError extends Error {
  readonly code = 'PROVIDER_STRUCTURED_OUTPUT_INVALID';
  readonly statusCode = 502;
  readonly retryable = true;
  readonly reason: 'empty' | 'too_large' | 'ambiguous' | 'malformed';

  constructor(reason: ProviderStructuredOutputError['reason']) {
    const message = reason === 'empty'
      ? 'The AI provider completed without structured JSON.'
      : reason === 'too_large'
        ? 'The AI provider response exceeded the structured-output safety limit.'
        : reason === 'ambiguous'
          ? 'The AI provider returned multiple JSON values, so OmniKit could not safely choose one.'
          : 'The AI provider did not return JSON that OmniKit could safely extract or repair.';
    super(message);
    this.name = 'ProviderStructuredOutputError';
    this.reason = reason;
  }
}

export interface ParsedProviderStructuredOutput {
  value: unknown;
  handling: ProviderStructuredOutputHandling;
}

interface JsonCandidate {
  text: string;
  extracted: boolean;
}

interface ParsedCandidate extends JsonCandidate {
  value: unknown;
}

function uniqueCandidates(candidates: JsonCandidate[]): JsonCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const text = trimJsonWhitespace(candidate.text);
    const identity = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    if (!identity || seen.has(identity)) return false;
    seen.add(identity);
    return true;
  }).map((candidate) => ({ ...candidate, text: trimJsonWhitespace(candidate.text) }));
}

function fencedJsonCandidates(value: string): JsonCandidate[] {
  const candidates: JsonCandidate[] = [];
  const pattern = /```(?:json)?[ \t]*\r?\n?([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    if (match[1] && trimJsonWhitespace(match[1])) candidates.push({ text: match[1], extracted: true });
  }
  return candidates;
}

function balancedJsonCandidates(value: string): { candidates: JsonCandidate[]; malformedRoot: boolean } {
  const candidates: JsonCandidate[] = [];
  let malformedRoot = false;
  let start = -1;
  let stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (start < 0) {
      if (character !== '{' && character !== '[') continue;
      start = index;
      stack = [character];
      inString = false;
      escaped = false;
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{' || character === '[') {
      stack.push(character);
      continue;
    }
    if (character !== '}' && character !== ']') continue;

    const expectedOpen = character === '}' ? '{' : '[';
    if (stack.at(-1) !== expectedOpen) {
      malformedRoot = true;
      start = -1;
      stack = [];
      inString = false;
      escaped = false;
      continue;
    }
    stack.pop();
    if (stack.length === 0) {
      candidates.push({ text: value.slice(start, index + 1), extracted: true });
      start = -1;
    }
  }
  if (start >= 0) malformedRoot = true;
  return { candidates, malformedRoot };
}

function deterministicJsonRepair(value: string): { text: string; repairs: ProviderStructuredOutputRepair[] } {
  const repairs = new Set<ProviderStructuredOutputRepair>();
  let source = value;
  if (source.charCodeAt(0) === 0xfeff) {
    source = source.slice(1);
    repairs.add('removed_utf8_bom');
  }

  let escapedControls = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (!inString) {
      escapedControls += character;
      if (character === '"') inString = true;
      continue;
    }
    if (escaped) {
      escapedControls += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escapedControls += character;
      escaped = true;
      continue;
    }
    if (character === '"') {
      escapedControls += character;
      inString = false;
      continue;
    }

    const code = character.charCodeAt(0);
    if (code > 0x1f) {
      escapedControls += character;
      continue;
    }
    repairs.add('escaped_control_characters');
    if (character === '\b') escapedControls += '\\b';
    else if (character === '\f') escapedControls += '\\f';
    else if (character === '\n') escapedControls += '\\n';
    else if (character === '\r') escapedControls += '\\r';
    else if (character === '\t') escapedControls += '\\t';
    else escapedControls += `\\u${code.toString(16).padStart(4, '0')}`;
  }

  let withoutTrailingCommas = '';
  inString = false;
  escaped = false;
  for (let index = 0; index < escapedControls.length; index += 1) {
    const character = escapedControls[index]!;
    if (inString) {
      withoutTrailingCommas += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      withoutTrailingCommas += character;
      inString = true;
      continue;
    }
    if (character === ',') {
      let lookahead = index + 1;
      while (lookahead < escapedControls.length && /\s/.test(escapedControls[lookahead]!)) lookahead += 1;
      if (escapedControls[lookahead] === '}' || escapedControls[lookahead] === ']') {
        repairs.add('removed_trailing_commas');
        continue;
      }
    }
    withoutTrailingCommas += character;
  }

  return { text: withoutTrailingCommas, repairs: [...repairs] };
}

function parseCandidates(candidates: JsonCandidate[]): ParsedCandidate[] {
  return candidates.flatMap((candidate) => {
    try {
      return [{ ...candidate, value: JSON.parse(candidate.text) as unknown }];
    } catch {
      return [];
    }
  });
}

function singleParsedCandidate(candidates: ParsedCandidate[]): ParsedCandidate | undefined {
  if (candidates.length > 1) throw new ProviderStructuredOutputError('ambiguous');
  return candidates[0];
}

function isJsonWhitespace(character: string): boolean {
  const code = character.charCodeAt(0);
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function trimJsonWhitespace(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isJsonWhitespace(value[start]!)) start += 1;
  while (end > start && isJsonWhitespace(value[end - 1]!)) end -= 1;
  return value.slice(start, end);
}

export function parseProviderStructuredOutput(rawText: string): ParsedProviderStructuredOutput {
  const trimmed = trimJsonWhitespace(rawText);
  if (!trimmed) throw new ProviderStructuredOutputError('empty');
  if (trimmed.length > MAX_STRUCTURED_OUTPUT_CHARACTERS) throw new ProviderStructuredOutputError('too_large');

  try {
    return {
      value: JSON.parse(trimmed) as unknown,
      handling: { parseMode: 'strict', extracted: false, repairs: [] },
    };
  } catch {
    // Continue through bounded extraction and syntax-only repair.
  }

  const directRepair = deterministicJsonRepair(trimmed);
  if (directRepair.repairs.length > 0) {
    try {
      return {
        value: JSON.parse(directRepair.text) as unknown,
        handling: {
          parseMode: 'repaired',
          extracted: false,
          repairs: directRepair.repairs,
        },
      };
    } catch {
      // A syntax-only repair was insufficient; continue to bounded extraction.
    }
  }

  const balancedCandidates = balancedJsonCandidates(trimmed);
  const extractedCandidates = uniqueCandidates([
    ...fencedJsonCandidates(trimmed),
    ...balancedCandidates.candidates,
  ]);
  if (balancedCandidates.malformedRoot && extractedCandidates.length > 0) {
    throw new ProviderStructuredOutputError('ambiguous');
  }
  if (extractedCandidates.length > 1) throw new ProviderStructuredOutputError('ambiguous');
  const extracted = singleParsedCandidate(parseCandidates(extractedCandidates));
  if (extracted) {
    return {
      value: extracted.value,
      handling: { parseMode: 'extracted', extracted: true, repairs: [] },
    };
  }

  const repairCandidates = extractedCandidates.flatMap((candidate) => {
    const repaired = deterministicJsonRepair(candidate.text);
    if (repaired.repairs.length === 0) return [];
    try {
      return [{ ...candidate, value: JSON.parse(repaired.text) as unknown, repairs: repaired.repairs }];
    } catch {
      return [];
    }
  });
  if (repairCandidates.length > 1) throw new ProviderStructuredOutputError('ambiguous');
  const repaired = repairCandidates[0];
  if (repaired) {
    return {
      value: repaired.value,
      handling: {
        parseMode: 'repaired',
        extracted: repaired.extracted,
        repairs: repaired.repairs,
      },
    };
  }

  throw new ProviderStructuredOutputError('malformed');
}

export function providerStructuredOutputNotice(handling: ProviderStructuredOutputHandling | undefined): string | undefined {
  if (!handling || handling.parseMode === 'strict') {
    return handling?.automaticRetry
      ? `The provider returned a contract-valid response on automatic attempt ${handling.providerAttempts || 2}.`
      : undefined;
  }
  if (handling.parseMode === 'extracted') {
    return 'OmniKit safely extracted one unambiguous JSON value from the provider response and accepted it only after contract validation.';
  }
  return 'OmniKit repaired deterministic JSON syntax in the provider response and accepted it only after contract validation.';
}
