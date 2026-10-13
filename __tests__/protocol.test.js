// The wire codec on its own: framing, decoding and name sanitising, checked
// against the examples in Shure's ANX4 command-string document.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MessageFramer,
  braced,
  command,
  decode,
  sanitizeName,
  tokenize,
} from '../driver/protocol.js';

test('framing survives a message split across TCP chunks', () => {
  const framer = new MessageFramer();
  assert.deepEqual(framer.push('< REP 1 AUDIO_GA'), []);
  assert.deepEqual(framer.push('IN 030 >< REP 2 AUDIO_MUTE ON >< REP'), [
    'REP 1 AUDIO_GAIN 030',
    'REP 2 AUDIO_MUTE ON',
  ]);
  assert.deepEqual(framer.push(' FLASH OFF >'), ['REP FLASH OFF']);
});

// `<` and `>` are both legal in a channel name, so a bracket inside braces
// must not end the message
test('a name containing brackets does not break the framing', () => {
  const framer = new MessageFramer();
  const [body, next] = framer.push(
    '< REP 1 CHAN_NAME {A>B<C                          } >< REP 1 AUDIO_MUTE OFF >',
  );
  assert.deepEqual(tokenize(body), ['REP', '1', 'CHAN_NAME', 'A>B<C']);
  assert.equal(next, 'REP 1 AUDIO_MUTE OFF');
});

test('a brace that never closes cannot wedge the stream', () => {
  const framer = new MessageFramer();
  assert.deepEqual(framer.push(`< REP 1 CHAN_NAME {${'x'.repeat(5000)}`), []);
  assert.deepEqual(framer.push('< REP 1 AUDIO_MUTE ON >'), [
    'REP 1 AUDIO_MUTE ON',
  ]);
});

test('commands are framed the way the document writes them', () => {
  assert.equal(command('GET', 1, 'CHAN_NAME'), '< GET 1 CHAN_NAME >');
  assert.equal(
    command('SET', 1, 'CHAN_NAME', braced('Lead Vox')),
    '< SET 1 CHAN_NAME {Lead Vox} >',
  );
});

test('offsets are applied and units converted', () => {
  // "There is an offset of 18 so the actual value = 30 - 18 = 12 dB"
  assert.deepEqual(decode('REP 1 AUDIO_GAIN 030'), {
    kind: 'channel',
    channel: 1,
    field: 'gain',
    value: 12,
  });
  assert.equal(decode('REP 3 FREQUENCY 0578350').value, 578.35);
  assert.equal(decode('REP 1 AUDIO_LEVEL_PEAK 102').value, -18);
  assert.equal(decode('REP 1 TX_OFFSET 012').value, 0);
  assert.equal(decode('REP 1 TX_INPUT_PAD 000').value, -12);
  assert.equal(decode('REP 1 TX_BATT_TEMP_C 062').value, 22);
  assert.equal(decode('REP 1 AUDIO_MUTE ON').value, true);
  assert.equal(
    decode('REP 1 CHAN_NAME {Lead Vox               }').value,
    'Lead Vox',
  );
});

test('the wire sentinels for "unknown" all decode to null', () => {
  for (const body of [
    'REP 1 TX_MODEL UNKNOWN',
    'REP 1 TX_BATT_TYPE UNKN',
    'REP 1 TX_BATT_BARS 255',
    'REP 1 TX_BATT_MINS 65535',
    'REP 1 TX_BATT_CHARGE_PERCENT 255',
    'REP 1 TX_OFFSET 255',
    'REP 1 TX_POWER_LEVEL 255',
    'REP 1 TX_POWER_LEVEL UNKNOWN',
    'REP 1 TX_DEVICE_ID {                               }',
    'REP 1 GROUP_CHANNEL {--,--     }',
    'REP 1 CHAN_QUALITY 255',
  ]) {
    assert.equal(decode(body).value, null, body);
  }
  // the two battery states above 65532 stay distinguishable from "unknown"
  assert.equal(decode('REP 1 TX_BATT_MINS 65534').value, 65534);
});

test('transmit power is mW from Axient Digital and a word from ULX-D', () => {
  assert.equal(decode('REP 1 TX_POWER_LEVEL 010').value, 10);
  assert.equal(decode('REP 1 TX_POWER_LEVEL NORMAL').value, 'NORMAL');
});

test('device, antenna and slot reports are told apart', () => {
  assert.deepEqual(decode('REP MODEL {ANX4                            }'), {
    kind: 'device',
    field: 'model',
    value: 'ANX4',
  });
  assert.deepEqual(
    decode('REP AVAILABLE_CHANNELS {1,2,3,4,5,6,7,9}').value,
    [1, 2, 3, 4, 5, 6, 7, 9],
  );
  assert.deepEqual(decode('REP 2 RSSI 2 064'), {
    kind: 'antenna',
    channel: 2,
    antenna: 2,
    field: 'rssi',
    value: -56,
  });
  assert.deepEqual(decode('REP 4 SLOT_STATUS 2 LINKED.ACTIVE'), {
    kind: 'slot',
    channel: 4,
    slot: 2,
    field: 'status',
    value: 'LINKED.ACTIVE',
  });
  assert.deepEqual(decode('REP 4 SLOT_OFFSET 2 000').value, -12);
  assert.deepEqual(decode('REP ERR'), { kind: 'error' });
});

test('network settings lose their zero padding', () => {
  const { value } = decode(
    'REP NET_SETTINGS SC AUTO 192.168.001.025 255.255.255.000 000.000.000.000 00:0E:DD:45:60:EB',
  );
  assert.deepEqual(value, {
    interface: 'SC',
    mode: 'AUTO',
    ip: '192.168.1.25',
    subnet: '255.255.255.0',
    gateway: null,
    mac: '00:0E:DD:45:60:EB',
  });
});

test('what the document does not list is ignored, not an error', () => {
  assert.equal(decode('REP 1 SOME_FUTURE_PROPERTY 12'), null);
  assert.equal(decode('REP 255'), null);
  assert.equal(decode('NOTHING'), null);
});

// the four shapes the document gives for SAMPLE, verbatim
test('a standard SAMPLE carries two antennas', () => {
  const sample = decode('SAMPLE 1 ALL 005 031 102 102 BB 31 086 31 065');
  assert.equal(sample.channel, 1);
  assert.equal(sample.quality, 5);
  assert.equal(sample.audioPeak, -18);
  assert.equal(sample.audioRms, -18);
  assert.deepEqual(sample.antennas, [
    { status: 'B', led: 31, rssi: -34 },
    { status: 'B', led: 31, rssi: -55 },
  ]);
});

test('a Quadversity SAMPLE carries four', () => {
  const sample = decode(
    'SAMPLE 1 ALL 005 031 102 102 BBBB 31 083 31 068 31 069 31 072',
  );
  assert.deepEqual(
    sample.antennas.map((a) => a.rssi),
    [-37, -52, -51, -48],
  );
});

test('an FD-C SAMPLE appends the second frequency', () => {
  const sample = decode(
    'SAMPLE 1 ALL 005 031 102 102 BB 31 082 31 060 BB 31 082 31 060',
  );
  assert.deepEqual(
    sample.antennas.map((a) => a.rssi),
    [-38, -60, -38, -60],
  );
});

test('a Quadversity FD-C SAMPLE carries eight', () => {
  const sample = decode(
    'SAMPLE 1 ALL 005 031 102 102 BBBB 31 084 31 065 31 070 31 070 BBBB 31 084 31 065 31 070 31 070',
  );
  assert.equal(sample.antennas.length, 8);
});

test('a truncated SAMPLE is dropped rather than half-read', () => {
  assert.equal(decode('SAMPLE 1 ALL 005 031 102 102 BB 31 086 31'), null);
});

test('names are cut to what SET accepts', () => {
  assert.equal(sanitizeName('Lead{Vocal}|Mix', 8), 'LeadVoca');
  assert.equal(sanitizeName('  Gtr <1>  ', 8), 'Gtr <1>');
  assert.equal(sanitizeName('{}', 8), '');
});
