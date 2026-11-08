import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
import { root } from './config.mjs';

// The pinned idevice installer (tools/src/cryptexd.rs, Cryptex1Assets::load) installs the first build
// identity whose Info.Variant ends with this suffix and reads these four payloads from it. The checks
// below mirror that selection and the fields its Cryptex1 TSS request and install properties require,
// so an image the installer would reject or mis-read is refused before anything reaches the device.
export const cryptexVariantSuffix = 'Developer Disk Image Cryptex';
export const cryptexPayloads = ['Cryptex1,GenericDmg', 'Cryptex1,GenericTrustCache', 'Cryptex1,CryptexInfoPlist', 'Cryptex1,GenericVolume'];
const numericFields = ['Cryptex1,ChipID', 'Cryptex1,ProductClass'];
const unsignedFields = ['Cryptex1,SubType', 'Cryptex1,NonceDomain'];
const requiredFields = ['Cryptex1,Type', 'Cryptex1,UseProductClass', 'Cryptex1,Version', 'Cryptex1,PreauthorizationVersion'];

const execute = promisify(execFile);
const isDict = value => value !== null && typeof value === 'object' && !Array.isArray(value) && !('$data' in value);
const isUnsigned = value => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const isNumeric = value => isUnsigned(value) || (typeof value === 'string' && /^(0x[0-9a-f]+|[0-9]+)$/i.test(value));
const variantOf = identity => typeof identity.Info?.Variant === 'string' ? identity.Info.Variant : '';

export async function readPlist(file) {
  const { stdout } = await execute('python3', [join(root, 'native/plist_json.py'), file], { timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(stdout);
}

async function payloadProblem(key, entry, imageRoot) {
  if (!isDict(entry)) return `${key} is missing from Manifest`;
  if (entry.Info?.Personalize === true && !(entry.Digest?.$data > 0)) return `${key} is personalized but has no Digest`;
  const path = entry.Info?.Path;
  if (typeof path !== 'string' || !path) return `${key} has no Info.Path`;
  if (isAbsolute(path)) return `${key} path ${path} is absolute`;
  const lexical = normalize(path);
  if (lexical === '..' || lexical.startsWith(`..${sep}`)) return `${key} path ${path} leaves the image directory`;
  let file;
  try { file = await realpath(join(imageRoot, path)); } catch { return `${key} file ${path} is missing`; }
  const inside = relative(imageRoot, file);
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return `${key} path ${path} leaves the image directory`;
  if (!(await stat(file)).isFile()) return `${key} path ${path} is not a file`;
  return undefined;
}

export async function cryptexIdentityProblems(identity, imageDir) {
  const problems = [];
  for (const key of numericFields) if (!isNumeric(identity[key])) problems.push(`${key} is missing or not a number`);
  for (const key of unsignedFields) if (!isUnsigned(identity[key])) problems.push(`${key} is missing or not an unsigned integer`);
  for (const key of requiredFields) if (identity[key] === undefined || identity[key] === null) problems.push(`${key} is missing`);
  const manifest = identity.Manifest;
  if (!isDict(manifest)) return [...problems, 'Manifest is missing'];
  const imageRoot = await realpath(imageDir);
  for (const key of cryptexPayloads) {
    const problem = await payloadProblem(key, manifest[key], imageRoot);
    if (problem) problems.push(problem);
  }
  if (!cryptexPayloads.some(key => manifest[key]?.Info?.Personalize === true)) problems.push('no Cryptex1 payload is marked for personalization');
  return problems;
}

export async function inspectDdiManifest(manifest, imageDir) {
  if (!isDict(manifest) || !Array.isArray(manifest.BuildIdentities)) return { status: 'invalid', problems: ['BuildManifest.plist has no BuildIdentities array'] };
  const identities = manifest.BuildIdentities.filter(isDict);
  const report = {
    build: typeof manifest.ProductBuildVersion === 'string' ? manifest.ProductBuildVersion : undefined,
    identities: identities.length,
    personalizedIdentities: identities.filter(identity => isDict(identity.Manifest?.PersonalizedDMG)).length,
  };
  const selected = identities.find(identity => variantOf(identity).endsWith(cryptexVariantSuffix));
  if (selected) {
    const problems = await cryptexIdentityProblems(selected, imageDir);
    return { ...report, status: problems.length ? 'incomplete' : 'installable', variant: variantOf(selected), problems };
  }
  const candidates = await Promise.all(identities.filter(identity => /cryptex/i.test(variantOf(identity)))
    .map(async identity => ({ variant: variantOf(identity), problems: await cryptexIdentityProblems(identity, imageDir) })));
  return { ...report, status: 'unrecognized', candidates };
}

export async function inspectDdiImage(imageDir) {
  let manifest;
  try { manifest = await readPlist(join(imageDir, 'BuildManifest.plist')); }
  catch (error) { return { status: 'invalid', problems: [`BuildManifest.plist is not a readable property list: ${(error.stderr || error.message).trim().split('\n').at(-1)}`] }; }
  return inspectDdiManifest(manifest, imageDir);
}

export function describeDdiReport(report) {
  if (report.status === 'invalid') return `Its ${report.problems.join('; ')}.`;
  if (report.status === 'incomplete') return `Its "${report.variant}" build identity, the one the installer would use, is incomplete: ${report.problems.join('; ')}.`;
  if (report.status !== 'unrecognized') return '';
  const found = report.candidates.length
    ? ` It has ${report.candidates.map(({ variant, problems }) => `"${variant}" (${problems.length ? `incomplete: ${problems.join('; ')}` : 'Cryptex1 fields and payload files present'})`).join(', ')}, which the installer does not select. Poki does not install a different identity or edit Apple's manifest.`
    : '';
  return `Its BuildManifest.plist has no build identity whose variant ends with "${cryptexVariantSuffix}", the only identity the installer uses.${found}`;
}
