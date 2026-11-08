#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { parseArgs, promisify } from 'node:util';
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { root, idevice, noUsbDevice } from '../src/config.mjs';
import { cryptexVariantSuffix, describeDdiReport, inspectDdiImage } from '../src/ddi-manifest.mjs';

const fail = message => { console.error(message); process.exit(1); };
const execute = promisify(execFile);
const { values: options, positionals } = parseArgs({ allowPositionals: true, options: { image: { type: 'string' }, inspect: { type: 'boolean' } } });
const image = resolve(options.image ?? '/Library/Developer/DeveloperDiskImages/iOS_DDI/Restore');
const missingManifest = () => fail(options.image
  ? `${image} has no BuildManifest.plist. Pass the directory that holds the image's BuildManifest.plist and its payloads.`
  : 'Apple DeveloperDiskImages are missing. Install the compatible Apple developer support files before running this command.');

if (options.inspect) {
  await access(join(image, 'BuildManifest.plist')).catch(missingManifest);
  const report = await inspectDdiImage(image);
  console.log(JSON.stringify({ image, ...report }, null, 2));
  process.exit(report.status === 'installable' ? 0 : 1);
}

const { stdout } = await execute('python3', [join(root, 'native/devices.py')], { timeout: 8000 });
const ids = [...new Set(JSON.parse(stdout).map(d => d.id).filter(Boolean))];
if (!ids.length) fail(noUsbDevice);
const selected = positionals[0] ?? (ids.length === 1 ? ids[0] : undefined);
if (!selected || !ids.includes(selected)) fail('Connect one unlocked, trusted iPhone, or pass a connected device id.');
const call = async args => execute(idevice, ['--udid', selected, ...args], { timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
const display = 'com.apple.coredevice.displayservice';
const hasDisplay = async () => (await call(['remotexpc'])).stdout.includes(display);
const newerImage = `Use the developer disk image of an Xcode release that supports this iOS version, or pass a newer Apple-signed Cryptex image: node bin/prepare-device.mjs ${selected} --image DIR.`;
const restart = 'Quit Xcode, restart the iPhone, reconnect it over USB, unlock it, and run this command again with Xcode closed.';
const installFailures = [
  [/BadBuildManifest/, () => `Its BuildManifest.plist has no build identity whose variant ends with "${cryptexVariantSuffix}", the only identity the installer uses. ${newerImage}`],
  [/TSS server responded with non-success status \(([^)]*)\)/, detail => `Apple's signing server declined to personalize this image for this iPhone (${detail}). The image may be older than the builds Apple currently signs for this device. ${newerImage}`],
  [/\/System\/Developer \[17: File exists\]/, () => `Another developer disk image is already mounted at /System/Developer on the iPhone. ${restart}`],
];
// The DDI's remote display service arrived with Xcode 27's Device Hub, and does not offer remote
// control on production iPhones running iOS earlier than 27, so no image can enable input there.
const minimumInputMajor = 27;
const readVersion = async () => {
  const result = await call(['lockdown', 'get', 'ProductVersion']).catch(error => fail(`Could not read the iPhone's iOS version, so nothing was installed: ${String(error.stderr || error.message).trim().split('\n').at(-1)}`));
  const version = (() => { try { return JSON.parse(result.stdout); } catch { return undefined; } })();
  if (typeof version !== 'string' || !/^\d+(\.\d+)*$/.test(version)) fail('Could not read the iPhone\'s iOS version, so nothing was installed.');
  return version;
};

if (await hasDisplay()) {
  console.log('Device display service is already available.');
} else {
  console.log(`The iPhone does not provide ${display}, which touch and text input need. Screenshots and accessibility work without it.`);
  const version = await readVersion();
  if (Number(version.split('.')[0]) < minimumInputMajor) fail(`This iPhone runs iOS ${version}. Touch and text input need iOS ${minimumInputMajor} or later: ${display} comes from the developer disk image's remote display service, which Xcode ${minimumInputMajor}'s Device Hub introduced and which does not offer remote control on production iPhones running earlier iOS versions. Installing a developer disk image cannot add input on this iOS version, so nothing was installed. Screenshots, accessibility reads, and app launch do not need it. To use input, update the iPhone in Settings > General > Software Update to iOS ${minimumInputMajor} or later, install Xcode ${minimumInputMajor} or later (it requires macOS Tahoe 26.6 or later) from the Mac App Store or developer.apple.com and open it once, then run this command again.`);
  await access(join(image, 'BuildManifest.plist')).catch(missingManifest);
  const report = await inspectDdiImage(image);
  if (report.status !== 'installable') fail(`${image} cannot be installed, so nothing was sent to the iPhone. ${describeDdiReport(report)} ${newerImage}`);
  console.log(`Installing the Apple-signed developer disk image from ${image} on the selected device…`);
  const result = await call(['cryptexd', 'install-ddi', image]).catch(error => {
    const output = `${error.stderr ?? ''}\n${error.stdout ?? ''}`;
    for (const [pattern, explain] of installFailures) {
      const match = output.match(pattern);
      if (match) fail(`Installing ${image} failed. ${explain(match[1])}`);
    }
    fail(`Installing ${image} failed: ${output.trim().split('\n').slice(-3).join(' ')}`);
  });
  if (!/installed com\.apple\.MobileAsset\.DDI|is already installed/.test(result.stdout)) fail('The device did not confirm installation.');
  if (!(await hasDisplay())) fail(`A developer disk image is installed, but it does not provide ${display}. The installed image may be older than this iOS version needs. ${newerImage} ${restart}`);
  console.log('Developer disk image installed; the device now exposes displayservice.');
}
