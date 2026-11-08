import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cryptexPayloads, inspectDdiImage, inspectDdiManifest } from '../src/ddi-manifest.mjs';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../bin/prepare-device.mjs', import.meta.url));
const python = execFileSync('sh', ['-c', 'command -v python3']).toString().trim();
const panic = (line, detail) => `thread 'main' panicked at tools/src/cryptexd.rs:${line}:18:\n${detail}\nnote: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace`;

const payloadFiles = {
  'Cryptex1,GenericDmg': 'Image.dmg',
  'Cryptex1,GenericTrustCache': 'Image.dmg.trustcache',
  'Cryptex1,CryptexInfoPlist': 'Image.dmg.cryptex_info',
  'Cryptex1,GenericVolume': 'Image.dmg.root_hash',
};
const digest = { $data: 'AQID' };
const cryptexIdentity = (variant = 'iOS Developer Disk Image Cryptex', change = identity => identity) => change({
  'Cryptex1,ChipID': '0xFF10',
  'Cryptex1,ProductClass': '0xF2',
  'Cryptex1,Type': 3,
  'Cryptex1,SubType': 2,
  'Cryptex1,NonceDomain': 4,
  'Cryptex1,UseProductClass': true,
  'Cryptex1,Version': '39.999.999.0.0,0',
  'Cryptex1,PreauthorizationVersion': '39.999.999.0.0,0',
  Info: { Variant: variant },
  Manifest: Object.fromEntries(Object.entries(payloadFiles).map(([key, path]) => [key, { Digest: digest, Info: { Path: path, Personalize: key !== 'Cryptex1,GenericDmg' } }])),
});
const personalizedIdentity = { ApBoardID: '0x0C', ApChipID: '0x8110', Info: { Variant: 'DeveloperDiskImage' }, Manifest: { PersonalizedDMG: { Digest: digest, Info: { Path: 'Image.dmg' } } } };
const manifestOf = (...identities) => ({ ProductBuildVersion: 'FIXTURE', BuildIdentities: [personalizedIdentity, ...identities] });

async function writePlist(file, value, format = 'FMT_XML') {
  const source = 'import json,plistlib,sys,base64\n'
    + 'def conv(v):\n'
    + ' if isinstance(v,dict) and set(v)=={"$data"}: return base64.b64decode(v["$data"])\n'
    + ' if isinstance(v,dict): return {k:conv(x) for k,x in v.items()}\n'
    + ' if isinstance(v,list): return [conv(x) for x in v]\n'
    + ' return v\n'
    + `open(sys.argv[1],"wb").write(plistlib.dumps(conv(json.loads(sys.argv[2])),fmt=plistlib.${format}))`;
  await run(python, ['-c', source, file, JSON.stringify(value)]);
}

async function makeImage(t, manifest, { files = Object.values(payloadFiles), format } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'poki-ddi-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const image = join(dir, 'Restore');
  await mkdir(image);
  for (const file of files) await writeFile(join(image, file), 'payload');
  if (manifest !== undefined) await writePlist(join(image, 'BuildManifest.plist'), manifest, format);
  return { dir, image };
}

async function prepare(t, { manifest = manifestOf(cryptexIdentity()), version = '"27.3"', display = false, install = 'installed com.apple.MobileAsset.DDI 1', installFails, args } = {}) {
  const { dir, image } = await makeImage(t, manifest);
  const calls = join(dir, 'calls');
  await mkdir(join(dir, 'bin'));
  await writeFile(join(dir, 'bin/python3'), `#!/bin/sh\ncase "$1" in\n  *devices.py) echo '[{"id":"fixture-phone","connection":"USB"}]' ;;\n  *) exec "${python}" "$@" ;;\nesac\n`, { mode: 0o755 });
  await writeFile(join(dir, 'bin/idevice'), `#!/bin/sh\necho "$3 $4 $5" >> "${calls}"\ncase "$3" in\n  remotexpc) echo com.apple.dt.testmanagerd.remote; if [ -n "$DISPLAY_NOW" ] || [ -e "${dir}/installed" ]; then echo com.apple.coredevice.displayservice; fi ;;\n  lockdown) [ -n "$VERSION_ERROR" ] && { echo "$VERSION_ERROR" >&2; exit 1; }; echo "$IOS_VERSION" ;;\n  cryptexd) if [ -n "$INSTALL_ERROR" ]; then printf '%s\\n' "$INSTALL_ERROR" >&2; exit 101; fi; touch "${dir}/installed"; echo "$INSTALL_OUTPUT" ;;\nesac\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, IDEVICE_TOOLS: join(dir, 'bin/idevice'), IOS_VERSION: version ?? '', INSTALL_OUTPUT: install, INSTALL_ERROR: installFails ?? '', DISPLAY_NOW: display ? '1' : '', VERSION_ERROR: version === null ? 'lockdown get failed: PasswordProtected' : '' };
  const outcome = await run(process.execPath, [script, ...(args ?? ['fixture-phone', '--image', image])], { env }).then(result => ({ code: 0, ...result }), error => error);
  const invoked = await readFile(calls, 'utf8').catch(() => '');
  return { ...outcome, image, invoked };
}

const installerFailures = [
  ['an image the installer cannot read', panic(159, 'failed to load the DDI assets: BadBuildManifest'), /Developer Disk Image Cryptex/],
  ['Apple declining to sign the image', panic(186, `install failed: UnexpectedResponse("TSS server responded with non-success status (STATUS=94&MESSAGE=This device isn't eligible for the requested build.)")`), /declined.*STATUS=94&MESSAGE=This device isn't eligible for the requested build\./],
  ['another image mounted at /System/Developer', panic(186, 'install failed: UnexpectedResponse("com.apple.MobileAsset.DDI: mkdir custom mount path: /System/Developer [17: File exists] (com.apple.security.cryptex.posix: 17)")'), /restart the iPhone/],
];

for (const [name, output, explanation] of installerFailures) {
  test(`prepare-device explains ${name} instead of printing the installer panic`, async t => {
    const failed = await prepare(t, { installFails: output });
    assert.equal(failed.code, 1);
    assert.match(failed.invoked, /cryptexd install-ddi/);
    assert.match(failed.stderr, explanation);
    assert.match(failed.stderr, new RegExp(failed.image.replaceAll('/', '\\/')));
    assert.doesNotMatch(failed.stderr, /panicked|at file:/);
  });
}

test('prepare-device installs a complete recognized Cryptex image on iOS 27 and confirms displayservice', async t => {
  const result = await prepare(t);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /device now exposes displayservice/);
  assert.match(result.invoked, /lockdown get ProductVersion/);
  assert.match(result.invoked, /cryptexd install-ddi/);
});

test('prepare-device leaves a phone that already has displayservice untouched', async t => {
  const result = await prepare(t, { display: true });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /already available/);
  assert.doesNotMatch(result.invoked, /cryptexd|lockdown/);
});

for (const version of ['26.6', '26.4.1', '17.0']) {
  test(`prepare-device installs nothing on iOS ${version} and names the supported iOS 27 route`, async t => {
    const failed = await prepare(t, { version: `"${version}"` });
    assert.equal(failed.code, 1);
    assert.doesNotMatch(failed.invoked, /cryptexd/);
    assert.match(failed.stderr, new RegExp(`iOS ${version.replaceAll('.', '\\.')}\\.`));
    assert.match(failed.stderr, /nothing was installed/);
    assert.match(failed.stderr, /Settings > General > Software Update to iOS 27 or later/);
    assert.match(failed.stderr, /Xcode 27 or later/);
  });
}

for (const [name, version] of [['an unreadable', null], ['a malformed', '"twenty-seven"'], ['a non-string', '27']]) {
  test(`prepare-device fails closed on ${name} iOS version`, async t => {
    const failed = await prepare(t, { version });
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /Could not read the iPhone's iOS version, so nothing was installed/);
    assert.doesNotMatch(failed.invoked, /cryptexd/);
  });
}

test('prepare-device does not install the Xcode 26.6 "Cryptex Developer Disk Image" identity even when its assets are complete', async t => {
  const failed = await prepare(t, { manifest: manifestOf(cryptexIdentity('iOS Cryptex Developer Disk Image')) });
  assert.equal(failed.code, 1);
  assert.doesNotMatch(failed.invoked, /cryptexd/);
  assert.match(failed.stderr, /no build identity whose variant ends with "Developer Disk Image Cryptex"/);
  assert.match(failed.stderr, /"iOS Cryptex Developer Disk Image" \(Cryptex1 fields and payload files present\), which the installer does not select/);
  assert.match(failed.stderr, /does not install a different identity or edit Apple's manifest/);
});

test('prepare-device refuses an incomplete recognized identity before contacting the installer', async t => {
  const failed = await prepare(t, { manifest: manifestOf(cryptexIdentity(undefined, identity => { delete identity.Manifest['Cryptex1,GenericVolume']; return identity; })) });
  assert.equal(failed.code, 1);
  assert.doesNotMatch(failed.invoked, /cryptexd/);
  assert.match(failed.stderr, /nothing was sent to the iPhone/);
  assert.match(failed.stderr, /Cryptex1,GenericVolume is missing from Manifest/);
});

test('prepare-device --inspect reports the manifest without reaching a device', async t => {
  for (const [manifest, code, status] of [[manifestOf(cryptexIdentity()), 0, 'installable'], [manifestOf(cryptexIdentity('Cryptex Developer Disk Image')), 1, 'unrecognized']]) {
    const { image } = await makeImage(t, manifest);
    const result = await run(process.execPath, [script, '--inspect', '--image', image], { env: { ...process.env, IDEVICE_TOOLS: '/nonexistent/idevice' } }).then(r => ({ code: 0, ...r }), error => error);
    assert.equal(result.code, code, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, status);
    assert.equal(report.personalizedIdentities, 1);
    assert.equal(report.build, 'FIXTURE');
  }
});

test('prepare-device sends the user to Finder when usbmuxd answers with no device', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'poki-prepare-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'bin'));
  await writeFile(join(dir, 'bin/python3'), `#!/bin/sh\necho '[]'\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, IDEVICE_TOOLS: join(dir, 'bin/idevice') };
  const failed = await run(process.execPath, [script], { env }).then(() => assert.fail('preparation succeeded'), error => error);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /Finder sidebar/);
  assert.match(failed.stderr, /devicectl reaches only over the network/);
});

const inspect = async (t, manifest, options) => { const { image } = await makeImage(t, manifest, options); return { image, report: await inspectDdiImage(image) }; };

test('variant recognition mirrors the installer: the suffix selects, other Cryptex variants are only reported', async t => {
  for (const variant of ['Developer Disk Image Cryptex', 'iOS Developer Disk Image Cryptex']) {
    const { report } = await inspect(t, manifestOf(cryptexIdentity(variant)));
    assert.deepEqual([report.status, report.variant, report.problems], ['installable', variant, []]);
  }
  for (const variant of ['Cryptex Developer Disk Image', 'iOS Cryptex Developer Disk Image', 'Developer Disk Image Cryptex (Internal) x', 'developer disk image cryptex']) {
    const { report } = await inspect(t, manifestOf(cryptexIdentity(variant)));
    assert.equal(report.status, 'unrecognized', variant);
    assert.deepEqual(report.candidates.map(c => c.variant), /cryptex/i.test(variant) ? [variant] : []);
  }
  const { report } = await inspect(t, manifestOf());
  assert.deepEqual([report.status, report.candidates], ['unrecognized', []]);
});

test('the first recognized identity is the one judged, as the installer would install it', async t => {
  const broken = cryptexIdentity(undefined, identity => { delete identity['Cryptex1,NonceDomain']; return identity; });
  const { report } = await inspect(t, manifestOf(broken, cryptexIdentity('Second Developer Disk Image Cryptex')));
  assert.equal(report.status, 'incomplete');
  assert.equal(report.variant, 'iOS Developer Disk Image Cryptex');
  assert.deepEqual(report.problems, ['Cryptex1,NonceDomain is missing or not an unsigned integer']);
});

test('binary property lists are read like XML ones', async t => {
  const { report } = await inspect(t, manifestOf(cryptexIdentity()), { format: 'FMT_BINARY' });
  assert.equal(report.status, 'installable');
});

const edit = change => manifestOf(cryptexIdentity(undefined, identity => { change(identity); return identity; }));
const invalidIdentities = [
  ['a missing payload file', null, /Cryptex1,GenericTrustCache file Image\.dmg\.trustcache is missing/, { files: Object.values(payloadFiles).filter(file => !file.endsWith('trustcache')) }],
  ['a payload without Info.Path', i => delete i.Manifest['Cryptex1,CryptexInfoPlist'].Info.Path, /Cryptex1,CryptexInfoPlist has no Info\.Path/],
  ['an absolute payload path', i => { i.Manifest['Cryptex1,GenericDmg'].Info.Path = '/etc/hosts'; }, /Cryptex1,GenericDmg path \/etc\/hosts is absolute/],
  ['a payload path leaving the image', i => { i.Manifest['Cryptex1,GenericDmg'].Info.Path = '../outside.dmg'; }, /Cryptex1,GenericDmg path \.\.\/outside\.dmg leaves the image directory/],
  ['a directory as payload', i => { i.Manifest['Cryptex1,GenericDmg'].Info.Path = '.'; }, /Cryptex1,GenericDmg path \. is not a file/],
  ['a personalized payload without a digest', i => delete i.Manifest['Cryptex1,GenericTrustCache'].Digest, /Cryptex1,GenericTrustCache is personalized but has no Digest/],
  ['a personalized payload with an empty digest', i => { i.Manifest['Cryptex1,GenericVolume'].Digest = { $data: '' }; }, /Cryptex1,GenericVolume is personalized but has no Digest/],
  ['a digest that is not data', i => { i.Manifest['Cryptex1,GenericVolume'].Digest = 'abc'; }, /Cryptex1,GenericVolume is personalized but has no Digest/],
  ['no personalized payload', i => { for (const key of cryptexPayloads) i.Manifest[key].Info.Personalize = false; }, /no Cryptex1 payload is marked for personalization/],
  ['a non-numeric chip ID', i => { i['Cryptex1,ChipID'] = 'chip'; }, /Cryptex1,ChipID is missing or not a number/],
  ['a nonce domain given as a string', i => { i['Cryptex1,NonceDomain'] = '4'; }, /Cryptex1,NonceDomain is missing or not an unsigned integer/],
  ['a negative subtype', i => { i['Cryptex1,SubType'] = -1; }, /Cryptex1,SubType is missing or not an unsigned integer/],
  ['a missing preauthorization version', i => delete i['Cryptex1,PreauthorizationVersion'], /Cryptex1,PreauthorizationVersion is missing/],
  ['a missing Manifest', i => delete i.Manifest, /Manifest is missing/],
];

for (const [name, change, problem, options] of invalidIdentities) {
  test(`a recognized identity with ${name} is refused`, async t => {
    const { report } = await inspect(t, change ? edit(change) : manifestOf(cryptexIdentity()), options);
    assert.equal(report.status, 'incomplete');
    assert.ok(report.problems.some(p => problem.test(p)), JSON.stringify(report.problems));
  });
}

test('a payload symlink that leaves the image directory is refused', async t => {
  const { dir, image } = await makeImage(t, manifestOf(cryptexIdentity()), { files: Object.values(payloadFiles).filter(file => file !== 'Image.dmg') });
  await writeFile(join(dir, 'outside.dmg'), 'payload');
  await symlink(join(dir, 'outside.dmg'), join(image, 'Image.dmg'));
  const report = await inspectDdiImage(image);
  assert.equal(report.status, 'incomplete');
  assert.deepEqual(report.problems, ['Cryptex1,GenericDmg path Image.dmg leaves the image directory']);
});

test('manifests without build identities, or that are not property lists, are invalid', async t => {
  for (const manifest of [{}, { BuildIdentities: 'none' }]) assert.equal((await inspect(t, manifest)).report.status, 'invalid');
  assert.deepEqual((await inspectDdiManifest(['not', 'a', 'dict'], tmpdir())).status, 'invalid');
  const { image } = await makeImage(t, undefined);
  await writeFile(join(image, 'BuildManifest.plist'), 'not a plist');
  const report = await inspectDdiImage(image);
  assert.equal(report.status, 'invalid');
  assert.match(report.problems[0], /not a readable property list/);
});
