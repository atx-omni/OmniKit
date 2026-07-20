function normalizePackageName(value) {
  return String(value).toLowerCase().replaceAll('_', '-');
}

export function pinnedRequirements(text) {
  return String(text).split(/\r?\n/).flatMap((line) => {
    const match = line.trim().match(/^([A-Za-z0-9_.-]+)==([^\s;]+)$/);
    return match ? [{ name: normalizePackageName(match[1]), version: match[2] }] : [];
  });
}

export function uvPackageRecords(text) {
  const records = new Map();
  for (const block of String(text).split(/\n(?=\[\[package\]\]\n)/)) {
    const name = block.match(/^name = "([^"]+)"/m)?.[1];
    const version = block.match(/^version = "([^"]+)"/m)?.[1];
    if (!name || !version) continue;
    const hashes = Array.from(block.matchAll(/hash = "sha256:([a-f0-9]{64})"/gi), (match) => match[1]);
    records.set(`${normalizePackageName(name)}==${version}`, Array.from(new Set(hashes)).sort());
  }
  return records;
}

export function hashedRequirements(requirementsText, uvLockText) {
  const records = uvPackageRecords(uvLockText);
  const requirements = pinnedRequirements(requirementsText);
  return requirements.map(({ name, version }) => {
    const hashes = records.get(`${name}==${version}`);
    if (!hashes?.length) {
      throw new Error(`uv.lock does not contain distribution hashes for ${name}==${version}.`);
    }
    return `${name}==${version} \\\n${hashes.map((hash) => `    --hash=sha256:${hash}`).join(' \\\n')}`;
  }).join('\n');
}
