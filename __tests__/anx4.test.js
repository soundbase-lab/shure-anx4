// The plugin, booted under the real shell against a fake ANX4.
//
// These drive the whole stack — shell, adapter, driver, socket — with nothing
// plugged in, so they run on a CI runner. Nothing here hardcodes the plugin's
// id: product ids come from the manifest and the adapter, and `npm run
// rename` rewrites the extension-key namespace spelled out below.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HANDSHAKE_PREFIX, SSE_EVENTS } from '@soundbase/plugin-contract';
import { PRODUCT, discoverDevices } from '../adapter.js';
import { startFakeAnx4 } from '../driver/fake-anx4.js';

const manifest = JSON.parse(
  readFileSync(new URL('../soundbase-plugin.json', import.meta.url), 'utf8'),
);

const CHANNEL = 'x.shure-anx4.channel';
const TX = 'x.shure-anx4.tx';
const DEVICE = 'x.shure-anx4.device';
const NETWORK = 'x.shure-anx4.network';

const anx4 = await startFakeAnx4();
const ADDRESS = `127.0.0.1:${anx4.port}`;
const DEVICE_ID = `net:${ADDRESS}`;
const DEVICE_PATH = `/devices/${encodeURIComponent(DEVICE_ID)}`;

// boots under the real shell, exactly as the host spawns it
const handle = await (await import('../main.js')).default;

const request = async (method, path, body) => {
  const res = await fetch(`${handle.url}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `read()` returns something truthy; fail with `what` if it never does. */
async function until(read, what, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await delay(20);
  }
}

const deviceRow = async (id = DEVICE_ID) =>
  (await request('GET', '/devices')).body.devices.find((d) => d.id === id);

// a minimal SSE reader: collects { event, data } records until closed
async function openEvents() {
  const controller = new AbortController();
  const res = await fetch(`${handle.url}/events`, {
    signal: controller.signal,
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const records = [];
  let buffer = '';
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (frame.startsWith(':')) continue;
          const event = /^event: (.*)$/m.exec(frame)?.[1];
          const data = /^data: (.*)$/m.exec(frame)?.[1];
          records.push({ event, data: data ? JSON.parse(data) : null });
        }
      }
    } catch {
      // aborted by the test
    }
  })();

  const patches = (key, deviceId = DEVICE_ID) =>
    records
      .filter(
        (r) =>
          r.event === SSE_EVENTS.DEVICE_STATE && r.data.deviceId === deviceId,
      )
      .flatMap((r) => r.data.patches)
      .filter((p) => p.key === key);
  return {
    patches,
    /** the most recent value reported for one channel under a channel-scoped key */
    channel(key, n) {
      return patches(key)
        .map((p) => p.value.channels?.[n])
        .filter((v) => v !== undefined)
        .at(-1);
    },
    close: () => controller.abort(),
  };
}

const send = (command) => request('POST', `${DEVICE_PATH}/commands`, command);

// the host's first PUT /config is what brings a plugin up; here it is also
// where the addresses discovery probes come from
await request('PUT', '/config', { values: { addresses: ADDRESS } });

test.after(async () => {
  await handle.close();
  await anx4.close();
});

test('the manifest is valid and the handshake reports a real port', () => {
  assert.equal(handle.manifest.id, manifest.id);
  assert.ok(handle.port > 0);
  assert.equal(HANDSHAKE_PREFIX, 'SB_PLUGIN_READY ');
});

// The rename trap: an adapter that announces a product the manifest does not
// declare produces a device the host silently ignores, and the only clue is
// one warning line in the plugin log. Catch it here instead.
test('the product the adapter announces is declared in the manifest', () => {
  const declared = manifest.products.map((p) => p.deviceTypeId);
  assert.ok(
    declared.includes(PRODUCT),
    `adapter.js announces ${PRODUCT}, but soundbase-plugin.json declares only ` +
      `${declared.join(', ')}. Run \`npm run rename <id>\` to change both at once.`,
  );
  assert.ok(PRODUCT.startsWith(`plugin:${manifest.id}/`));
});

test('discovery probes the configured addresses and names a stable device', async () => {
  const device = await until(deviceRow, 'the fake ANX4 to be discovered');
  assert.equal(device.product, PRODUCT);
  assert.equal(device.discovered, true);
  assert.equal(device.name, 'ANX4-Stage (127.0.0.1)');
  assert.deepEqual(device.transport, {
    kind: 'network',
    host: '127.0.0.1',
    port: anx4.port,
  });
  const again = await discoverDevices({ addresses: ADDRESS });
  assert.equal(again[0].id, DEVICE_ID, 'the id is the same on every poll');
});

test('an address with nothing on it is a normal empty result, not an error', async () => {
  // port 1 on loopback refuses instantly, which is the common case for a
  // user who typed an address that is not an ANX4
  assert.deepEqual(await discoverDevices({ addresses: '127.0.0.1:1' }), []);
  assert.deepEqual(await discoverDevices({}), []);
});

test('owning the device opens it and reports its complete state', async (t) => {
  const stream = await openEvents();
  t.after(() => stream.close());

  const added = await request('POST', '/devices', {
    id: DEVICE_ID,
    product: PRODUCT,
  });
  assert.equal(added.status, 201);
  const device = await until(async () => {
    const row = await deviceRow();
    return row?.status.status === 'ok' ? row : null;
  }, 'the device to open');

  assert.equal(
    device.channelCount,
    4,
    'from AVAILABLE_CHANNELS, not the product',
  );
  assert.deepEqual(
    device.properties.map((p) => p.id),
    [
      'channelName',
      'frequency',
      'mute',
      'gain',
      'groupChannel',
      'identify',
      'deviceName',
      'deviceIdentify',
      'txName',
      'txOffset',
      'txInputPad',
      'txPolarity',
      'txRfMute',
      'txPowerMode',
    ],
  );
  // the manifest layout survived normalisation whole: nothing was dropped
  const product = manifest.products[0];
  assert.equal(device.layout.channel.length, product.layout.channel.length);
  assert.equal(device.layout.device.length, product.layout.device.length);
  assert.equal(
    device.layout.entities.receiver.length,
    product.layout.entities.receiver.length,
  );

  // core keys, in the shapes channel-monitoring.openapi.yaml gives them
  assert.deepEqual(stream.patches('channelName')[0], {
    key: 'channelName',
    scope: 'channel',
    operation: 'merge',
    value: { channels: { 1: 'Lead Vox', 2: 'Host', 3: 'Guitar', 4: 'CH 4' } },
  });
  assert.deepEqual(stream.patches('frequency')[0].value, {
    channels: { 1: 470.125, 2: 471.125, 3: 472.125, 4: 473.125 },
  });
  assert.deepEqual(stream.patches('mute')[0].value, {
    channels: { 1: false, 2: false, 3: false, 4: false },
  });
  assert.equal(stream.patches('deviceName')[0].value, 'ANX4-Stage');
  assert.equal(stream.patches('connection')[0].value.connected, true);
  // a lithium-ion pack reports percent and runtime; alkalines only bars
  assert.deepEqual(stream.patches('battery')[0].value, {
    channels: {
      1: { percent: 88, lifetimeInMinutes: 325 },
      2: { percent: 60 },
    },
  });

  // everything else, under the extension keys the manifest declares
  const lead = stream.channel(CHANNEL, 1);
  assert.equal(lead.gain, 12);
  assert.equal(lead.rfBand, 'G57+');
  assert.equal(lead.groupChannel, null, '--,-- is "none set"');
  assert.equal(lead.rfLayout, 'AB');
  assert.equal(stream.channel(CHANNEL, 2).rfLayout, 'QUAD');
  const guitar = stream.channel(CHANNEL, 3);
  assert.equal(guitar.rfLayout, 'AB_FDC');
  assert.equal(guitar.frequency2, 480.625);

  const tx = stream.channel(TX, 1);
  assert.equal(tx.present, true);
  assert.equal(tx.model, 'ADX1');
  assert.equal(tx.deviceId, 'LeadVox');
  assert.equal(tx.powerLevel, 10);
  assert.equal(tx.offset, 0);
  assert.equal(tx.batteryTempC, 22);
  assert.equal(tx.muted, false);
  const nobody = stream.channel(TX, 4);
  assert.equal(nobody.present, false);
  assert.equal(nobody.model, null);
  assert.equal(nobody.batteryPercent, null);

  const unit = stream.patches(DEVICE)[0];
  assert.equal(unit.scope, 'device');
  assert.equal(unit.value.model, 'ANX4');
  assert.equal(unit.value.firmware, '1.2.3.4');
  assert.equal(unit.value.selfTestPassed, true);
  assert.equal(unit.value.transmissionMode, 'AD_STANDARD');
  assert.deepEqual(unit.value.availableChannels, [1, 2, 3, 4]);
  const network = stream.patches(NETWORK).at(-1).value;
  assert.equal(network.control.ip, '192.168.1.25');
  assert.equal(network.control.gateway, null);
  assert.equal(network.dantePrimary.mode, 'MANUAL');
  assert.equal(network.danteSecondary, undefined, 'the unit has no D2');

  // registered transmitters: occupied slots only, each bound to its channel
  const slots = stream.patches('receivers')[0];
  assert.equal(slots.entityKind, 'receiver');
  assert.deepEqual(
    slots.value.added.map((s) => [s.id, s.channel, s.status]),
    [
      ['slot:1:1', 1, 'LINKED.ACTIVE'],
      ['slot:1:2', 1, 'LINKED.INACTIVE'],
      ['slot:2:1', 2, 'STANDARD'],
    ],
  );
  const linked = slots.value.added[0];
  assert.equal(linked.name, 'LeadVox');
  assert.deepEqual(linked.battery, { percent: 88, lifetimeInMinutes: 325 });
  assert.deepEqual(linked.meters, { lqi: 100 });
  assert.equal(linked.rfMuted, false);
  assert.equal(linked.active, true);
});

test('metering arrives for every channel, in dBFS and dBm', async (t) => {
  const stream = await openEvents();
  t.after(() => stream.close());

  assert.ok(anx4.received.includes('SET 0 METER_RATE 100'));
  await until(
    () => [1, 2, 3, 4].every((n) => stream.channel('meters', n)),
    'meters from all four channels',
  );
  const before = stream.patches('meters').length;
  await delay(300);
  const count = stream.patches('meters').length - before;
  assert.ok(count >= 2 && count <= 8, `${count} meter patches in 300 ms`);

  const lead = stream.channel('meters', 1);
  assert.ok(lead.af <= -10 && lead.af >= -40, `audio at ${lead.af} dBFS`);
  assert.ok(lead.afPeakLevel >= lead.af);
  assert.equal(lead.afPeak, false);
  assert.ok(lead.rf1 <= -50 && lead.rf1 >= -60, `antenna A at ${lead.rf1} dBm`);
  assert.ok(lead.rf2 < lead.rf1);
  assert.equal(lead.rf3, undefined, 'a two-antenna channel has two RF meters');
  assert.equal(lead.lqi, 100);
  assert.equal(lead.div1, true);

  // Quadversity: four antennas. FD-C: two, then the second frequency's two.
  for (const n of [2, 3]) {
    const meters = stream.channel('meters', n);
    assert.ok(Number.isFinite(meters.rf3) && Number.isFinite(meters.rf4));
    assert.equal(meters.rf5, undefined);
  }
  // nothing received: a noise floor, and no link quality to report
  const idle = stream.channel('meters', 4);
  assert.ok(idle.rf1 < -100);
  assert.equal(idle.lqi, undefined);
});

test('a command becomes a SET and the device echoes the result as state', async (t) => {
  const stream = await openEvents();
  t.after(() => stream.close());

  // +99 dB is beyond the +42 dB the receiver has: clamped, not rejected
  const accepted = await send({
    requestId: 'gain-1',
    propertyId: 'gain',
    channelIndex: 1,
    value: 99,
  });
  assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
  assert.deepEqual(accepted.body, { requestId: 'gain-1' });
  await until(() => stream.channel(CHANNEL, 1)?.gain === 42, 'the gain echo');
  assert.ok(anx4.received.includes('SET 1 AUDIO_GAIN 60'), 'offset by 18');

  await send({ propertyId: 'gain', channelIndex: 1, value: -3 });
  await until(() => stream.channel(CHANNEL, 1)?.gain === -3, 'gain of -3 dB');
  // a request carrying only the gain left the rest of the channel in force
  assert.equal(stream.channel(CHANNEL, 1).rfBand, 'G57+');

  // braces are the wire's string delimiters, so they cannot be in a name
  await send({
    propertyId: 'channelName',
    channelIndex: 1,
    value: 'Lead{Vocal}Mix',
  });
  await until(
    () => stream.channel('channelName', 1) === 'LeadVoca',
    'the rename echo',
  );
  assert.ok(anx4.received.includes('SET 1 CHAN_NAME {LeadVoca}'));

  await send({ propertyId: 'mute', channelIndex: 2, value: true });
  await until(() => stream.channel('mute', 2) === true, 'the mute echo');

  // MHz in, kHz on the wire, and the group/channel the unit reverts with it
  await send({ propertyId: 'frequency', channelIndex: 2, value: 500.125 });
  await until(() => stream.channel('frequency', 2) === 500.125, 'the retune');
  assert.ok(anx4.received.includes('SET 2 FREQUENCY 500125'));

  await send({ propertyId: 'groupChannel', channelIndex: 3, value: '6, 100' });
  await until(
    () => stream.channel(CHANNEL, 3)?.groupChannel === '6,100',
    'the group/channel echo',
  );
  assert.ok(anx4.received.includes('SET 3 GROUP_CHANNEL {6,100}'));
  assert.equal(
    stream.channel('frequency', 3),
    488.5,
    'and the frequency it implies',
  );

  // identify on a channel flashes the channel; with no channel, the unit
  await send({ propertyId: 'identify', channelIndex: 4, value: true });
  await until(
    () => stream.channel(CHANNEL, 4)?.identify === true,
    'channel flash',
  );
  await send({ propertyId: 'identify', value: true });
  await until(
    () => stream.patches(DEVICE).at(-1)?.value.identify === true,
    'device flash',
  );
  assert.ok(anx4.received.includes('SET 4 FLASH ON'));
  assert.ok(anx4.received.includes('SET FLASH ON'));

  await send({ propertyId: 'deviceName', value: 'Monitor World' });
  await until(
    () => stream.patches('deviceName').at(-1)?.value === 'Monitor World',
    'the device rename',
  );
});

test('a registered transmitter is controlled through its slot', async (t) => {
  const stream = await openEvents();
  t.after(() => stream.close());
  const changes = (id) =>
    Object.assign(
      {},
      ...stream
        .patches('receivers')
        .flatMap((p) => p.value.updated)
        .filter((u) => u.id === id)
        .map((u) => u.changes),
    );

  // +99 dB is beyond the transmitter's +21 dB offset
  await send({ propertyId: 'txOffset', entityId: 'slot:1:1', value: 99 });
  await until(() => changes('slot:1:1').offset === 21, 'the offset echo');
  assert.ok(anx4.received.includes('SET 1 SLOT_OFFSET 1 33'), 'offset by 12');

  await send({ propertyId: 'txRfMute', entityId: 'slot:1:1', value: true });
  await until(() => changes('slot:1:1').rfMuted === true, 'the RF mute echo');

  // the unit reports the power it actually moved to alongside the mode
  await send({
    propertyId: 'txPowerMode',
    entityId: 'slot:1:1',
    value: 'high',
  });
  await until(() => changes('slot:1:1').rfPower === 40, 'the power echo');
  assert.equal(changes('slot:1:1').rfPowerMode, 'HIGH');

  await send({ propertyId: 'txInputPad', entityId: 'slot:1:1', value: -10 });
  await until(() => changes('slot:1:1').inputPad === -12, 'the pad echo');

  await send({ propertyId: 'txName', entityId: 'slot:1:1', value: 'Vox A' });
  await until(() => changes('slot:1:1').name === 'Vox A', 'the rename echo');
});

test('a change the ANX4 refuses is reported, and the state stays as the device has it', async (t) => {
  const stream = await openEvents();
  t.after(() => stream.close());
  const rejected = async () =>
    (await deviceRow()).status.warnings?.find(
      (w) => w.id === 'change-rejected',
    );

  // 900 MHz is outside the band this unit tunes; it answers REP ERR
  const before = stream.channel('frequency', 1);
  const accepted = await send({
    propertyId: 'frequency',
    channelIndex: 1,
    value: 900,
  });
  assert.equal(accepted.status, 202, 'accepted is not applied');
  const warning = await until(rejected, 'the rejection warning');
  assert.equal(warning.severity, 'info');
  assert.match(warning.message, /frequency on channel 1/);
  assert.equal(stream.channel('frequency', 1), before);
  assert.equal(
    (await deviceRow()).status.status,
    'ok',
    'a warning is not a failure',
  );
});

test('a command that is wrong on its face is a 400 with a reason', async () => {
  const unknown = await send({
    propertyId: 'colour',
    channelIndex: 1,
    value: 'red',
  });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error, 'unknown_property');

  const noChannel = await send({ propertyId: 'gain', value: 10 });
  assert.equal(noChannel.status, 400);
  assert.equal(noChannel.body.error, 'unknown_channel');

  const unlicensed = await send({
    propertyId: 'gain',
    channelIndex: 9,
    value: 10,
  });
  assert.equal(unlicensed.body.error, 'unknown_channel');

  const wrongType = await send({
    propertyId: 'gain',
    channelIndex: 1,
    value: 'loud',
  });
  assert.equal(wrongType.status, 400);
  assert.equal(wrongType.body.error, 'bad_value');

  const emptySlot = await send({
    propertyId: 'txOffset',
    entityId: 'slot:4:1',
    value: 0,
  });
  assert.equal(emptySlot.status, 400);
  assert.equal(emptySlot.body.error, 'unknown_entity');
});

test('what happens at the receiver arrives unprompted', async (t) => {
  const stream = await openEvents();
  t.after(() => stream.close());
  const warningIds = async () =>
    ((await deviceRow()).status.warnings ?? []).map((w) => w.id);

  anx4.change(2, 'INTERFERENCE_STATUS', 'DETECTED');
  await until(
    () => stream.channel(CHANNEL, 2)?.interference === true,
    'the interference flag',
  );
  await until(
    async () => (await warningIds()).includes('interference-ch2'),
    'the interference warning',
  );
  anx4.change(2, 'INTERFERENCE_STATUS', 'NONE');
  await until(
    async () => !(await warningIds()).includes('interference-ch2'),
    'the warning to clear',
  );

  // a transmitter is muted at its own switch
  anx4.change(1, 'TX_MUTE_MODE_STATUS', 'MUTE');
  await until(() => stream.channel(TX, 1)?.muted === true, 'the TX mute');

  // the pack is switched off: everything about it becomes unknown
  anx4.change(1, 'TX_BATT_CHARGE_PERCENT', 255);
  anx4.change(1, 'TX_BATT_BARS', 255);
  anx4.change(1, 'TX_BATT_MINS', 65535);
  anx4.change(1, 'TX_MODEL', 'UNKNOWN');
  await until(() => stream.channel(TX, 1)?.present === false, 'the TX to go');
  assert.deepEqual(
    Object.keys(stream.patches('battery').at(-1).value.channels),
    ['2'],
    'only the channel that still has a battery is listed',
  );

  // and the spare is unregistered from its slot
  anx4.changeSlot(1, 2, 'SLOT_STATUS', 'EMPTY');
  await until(
    () =>
      stream
        .patches('receivers')
        .some((p) => p.value.removed.includes('slot:1:2')),
    'the slot to be removed',
  );
});

test('a device added by hand takes its address from its configuration', async (t) => {
  const id = 'manual:1';
  t.after(() => request('DELETE', `/devices/${encodeURIComponent(id)}`));
  const added = await request('POST', '/devices', {
    id,
    product: PRODUCT,
    config: { host: '127.0.0.1', port: anx4.port },
  });
  assert.equal(added.status, 201);
  const device = await until(async () => {
    const row = await deviceRow(id);
    return row?.status.status === 'ok' ? row : null;
  }, 'the hand-added device to open');
  assert.equal(device.channelCount, 4);
  assert.equal(
    device.name,
    'Monitor World',
    "named by the unit's own Device ID",
  );
});

test('channels that appear or disappear while connected are followed', async (t) => {
  const stream = await openEvents();
  t.after(() => stream.close());
  const count = () => stream.patches('channelCount').at(-1)?.value;

  // a licence adds two channels
  anx4.setAvailableChannels([1, 2, 3, 4, 5, 6]);
  await until(() => count() === 6, 'the new channel count');
  assert.equal(stream.patches('channelCount').at(-1).scope, 'device');
  await until(
    () => stream.channel('channelName', 6) === 'CH 6',
    "the new channel's state",
  );
  await until(() => stream.channel('meters', 6), "the new channel's meters");
  const accepted = await send({
    propertyId: 'gain',
    channelIndex: 6,
    value: 0,
  });
  assert.equal(accepted.status, 202, 'and it takes commands');

  // channels 2 and 4 to 6 go away; 3 is still the highest
  anx4.setAvailableChannels([1, 3]);
  await until(() => count() === 3, 'the reduced channel count');
  // the channel that went away is blanked, along with its registered transmitter
  await until(
    () => stream.channel(TX, 2)?.present === false,
    'the removed channel to be cleared',
  );
  assert.equal(stream.channel('channelName', 2), '');
  assert.ok(
    stream
      .patches('receivers')
      .some((p) => p.value.removed.includes('slot:2:1')),
  );
  const refused = await send({ propertyId: 'gain', channelIndex: 2, value: 0 });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, 'unknown_channel');
  const before = stream.patches('meters').length;
  await delay(250);
  assert.ok(
    stream
      .patches('meters')
      .slice(before)
      .every((p) => !('2' in p.value.channels)),
    'no meters for a channel that no longer exists',
  );
});

test('something that is not an ANX4 fails to open with a message that says what to check', async (t) => {
  const mute = await startFakeAnx4({ silent: true });
  const id = 'manual:silent';
  t.after(async () => {
    await request('DELETE', `/devices/${encodeURIComponent(id)}`);
    await mute.close();
  });
  await request('POST', '/devices', {
    id,
    product: PRODUCT,
    config: { host: '127.0.0.1', port: mute.port },
  });
  const status = await until(
    async () => {
      const row = await deviceRow(id);
      return row?.status.status === 'failed' ? row.status : null;
    },
    'the open to fail',
    6_000,
  );
  assert.match(status.message, /command strings are turned on/);
});

// last: it takes the connection down
test('a transport that dies marks the device failed, not healthy', async () => {
  anx4.dropConnections();
  const status = await until(async () => {
    const row = await deviceRow();
    return row?.status.status === 'failed' ? row.status : null;
  }, 'onFatal to reach the shell');
  assert.match(status.message, /closed the connection/);
});
