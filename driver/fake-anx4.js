// A fake ANX4, so the plugin has something to talk to in tests and on a CI
// runner with no hardware attached.
//
// It speaks the command-string protocol as the Shure document describes it:
// fixed-width zero-padded numbers, names padded to 31 characters inside
// braces, a REP for every GET and SET, unprompted REPs to every connection
// when something changes, `< REP ERR >` for anything it will not do, and
// SAMPLE metering at the rate each connection asked for.
//
// Run it by hand to point SoundBase (or `nc`) at something:
//
//   node driver/fake-anx4.js 2202

import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { MessageFramer, tokenize } from './protocol.js';

const SLOTS = 8;
const BAND_MIN_KHZ = 470_000;
const BAND_MAX_KHZ = 636_000;
const STEP_KHZ = 25;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const digits = (width) => (v) => String(v).padStart(width, '0');
const padded = (width) => (v) => `{${String(v).padEnd(width)}}`;
const raw = (v) => String(v);

// property -> how its value is written. Order is the order `GET x ALL` uses.
const DEVICE_FORMAT = {
  MODEL: padded(32),
  DEVICE_ID: padded(31),
  FW_VER: padded(24),
  NA_DEVICE_NAME: padded(31),
  TRANSMISSION_MODE: raw,
  AVAILABLE_CHANNELS: padded(62),
  NUMBER_CHANNELS_LICENSED: digits(2),
  FLASH: raw,
};

const CHANNEL_FORMAT = {
  CHAN_NAME: padded(31),
  NA_CHAN_NAME: padded(31),
  FLASH: raw,
  AUDIO_GAIN: digits(3),
  AUDIO_MUTE: raw,
  ENCRYPTION_MODE: raw,
  ENCRYPTION_STATUS: raw,
  RF_BAND: padded(8),
  ANTENNA_CONFIGURATION: raw,
  FD_MODE: raw,
  GROUP_CHANNEL: padded(10),
  FREQUENCY: digits(7),
  INTERFERENCE_STATUS: raw,
  UNREGISTERED_TX_STATUS: raw,
  METER_RATE: digits(5),
  TX_MODEL: raw,
  TX_FW_VER: padded(24),
  TX_DEVICE_ID: padded(31),
  TX_BATT_TYPE: raw,
  TX_BATT_BARS: digits(3),
  TX_BATT_MINS: digits(5),
  TX_BATT_CHARGE_PERCENT: digits(3),
  TX_BATT_CYCLE_COUNT: digits(5),
  TX_BATT_HEALTH_PERCENT: digits(3),
  TX_BATT_TEMP_C: digits(3),
  TX_BATT_TEMP_F: digits(3),
  TX_INPUT_PAD: digits(3),
  TX_OFFSET: digits(3),
  TX_LOCK: raw,
  TX_MUTE_MODE_STATUS: raw,
  TX_MUTE_BUTTON_STATUS: raw,
  TX_POLARITY: raw,
  TX_POWER_LEVEL: digits(3),
  TX_POWER_SOURCE: raw,
  TX_TALK_SWITCH: raw,
  TX_PHANTOM_POWER: digits(3),
  TX_HIGH_PASS_FILTER: digits(3),
};

// only present on a channel in FD-C mode
const FDC_FORMAT = {
  GROUP_CHANNEL2: padded(10),
  FREQUENCY2: digits(7),
  INTERFERENCE_STATUS2: raw,
  UNREGISTERED_TX_STATUS2: raw,
};

const SLOT_FORMAT = {
  SLOT_STATUS: raw,
  SLOT_TX_MODEL: raw,
  SLOT_TX_DEVICE_ID: padded(31),
  SLOT_BATT_BARS: digits(3),
  SLOT_BATT_MINS: digits(5),
  SLOT_BATT_CHARGE_PERCENT: digits(3),
  SLOT_BATT_HEALTH_PERCENT: digits(3),
  SLOT_BATT_CYCLE_COUNT: digits(5),
  SLOT_BATT_TYPE: raw,
  SLOT_INPUT_PAD: digits(3),
  SLOT_OFFSET: digits(3),
  SLOT_POLARITY: raw,
  SLOT_RF_OUTPUT: raw,
  SLOT_RF_POWER: digits(3),
  SLOT_RF_POWER_MODE: raw,
  SLOT_PHANTOM_POWER: digits(3),
  SLOT_HIGH_PASS_FILTER: digits(3),
  SLOT_SHOWLINK_STATUS: digits(3),
};

const noTransmitter = () => ({
  TX_MODEL: 'UNKNOWN',
  TX_FW_VER: '',
  TX_DEVICE_ID: '',
  TX_BATT_TYPE: 'UNKN',
  TX_BATT_BARS: 255,
  TX_BATT_MINS: 65535,
  TX_BATT_CHARGE_PERCENT: 255,
  TX_BATT_CYCLE_COUNT: 65535,
  TX_BATT_HEALTH_PERCENT: 255,
  TX_BATT_TEMP_C: 255,
  TX_BATT_TEMP_F: 255,
  TX_INPUT_PAD: 255,
  TX_OFFSET: 255,
  TX_LOCK: 'UNKNOWN',
  TX_MUTE_MODE_STATUS: 'UNKNOWN',
  TX_MUTE_BUTTON_STATUS: 'UNKN',
  TX_POLARITY: 'UNKNOWN',
  TX_POWER_LEVEL: 255,
  TX_POWER_SOURCE: 'UNKNOWN',
  TX_TALK_SWITCH: 'UNKNOWN',
  TX_PHANTOM_POWER: 255,
  TX_HIGH_PASS_FILTER: 255,
});

const emptySlot = () => ({
  SLOT_STATUS: 'EMPTY',
  SLOT_TX_MODEL: 'UNKNOWN',
  SLOT_TX_DEVICE_ID: '',
  SLOT_BATT_BARS: 255,
  SLOT_BATT_MINS: 65535,
  SLOT_BATT_CHARGE_PERCENT: 255,
  SLOT_BATT_HEALTH_PERCENT: 255,
  SLOT_BATT_CYCLE_COUNT: 65535,
  SLOT_BATT_TYPE: 'UNKN',
  SLOT_INPUT_PAD: 255,
  SLOT_OFFSET: 255,
  SLOT_POLARITY: 'UNKNOWN',
  SLOT_RF_OUTPUT: 'UNKNOWN',
  SLOT_RF_POWER: 255,
  SLOT_RF_POWER_MODE: 'UNKNOWN',
  SLOT_PHANTOM_POWER: 255,
  SLOT_HIGH_PASS_FILTER: 255,
  SLOT_SHOWLINK_STATUS: 255,
});

function buildChannel(n) {
  const channel = {
    CHAN_NAME: `CH ${n}`,
    NA_CHAN_NAME: `ANX4-ch${n}`,
    FLASH: 'OFF',
    AUDIO_GAIN: 30, // +12 dB
    AUDIO_MUTE: 'OFF',
    ENCRYPTION_MODE: 'OFF',
    ENCRYPTION_STATUS: 'OK',
    RF_BAND: 'G57+',
    ANTENNA_CONFIGURATION: 'AB',
    FD_MODE: 'OFF',
    GROUP_CHANNEL: '--,--',
    FREQUENCY: 470_125 + (n - 1) * 1_000,
    INTERFERENCE_STATUS: 'NONE',
    UNREGISTERED_TX_STATUS: 'OK',
    METER_RATE: 0,
    ...noTransmitter(),
    slots: Array.from({ length: SLOTS }, emptySlot),
  };
  return channel;
}

// Four channels that between them exercise every SAMPLE shape and every
// transmitter state the document describes.
function buildChannels(count) {
  const channels = {};
  for (let n = 1; n <= count; n += 1) channels[n] = buildChannel(n);

  if (channels[1]) {
    // a linked, online ADX1 on a standard two-antenna channel
    Object.assign(channels[1], {
      CHAN_NAME: 'Lead Vox',
      TX_MODEL: 'ADX1',
      TX_FW_VER: '1.4.7.0',
      TX_DEVICE_ID: 'LeadVox',
      TX_BATT_TYPE: 'LION',
      TX_BATT_BARS: 4,
      TX_BATT_MINS: 325,
      TX_BATT_CHARGE_PERCENT: 88,
      TX_BATT_CYCLE_COUNT: 19,
      TX_BATT_HEALTH_PERCENT: 97,
      TX_BATT_TEMP_C: 62, // 22 °C
      TX_BATT_TEMP_F: 112, // 72 °F
      TX_INPUT_PAD: 12, // pad off
      TX_OFFSET: 12, // 0 dB
      TX_LOCK: 'NONE',
      TX_MUTE_MODE_STATUS: 'ON',
      TX_POLARITY: 'POSITIVE',
      TX_POWER_LEVEL: 10,
      TX_POWER_SOURCE: 'BATTERY',
      TX_TALK_SWITCH: 'OFF',
    });
    Object.assign(channels[1].slots[0], {
      SLOT_STATUS: 'LINKED.ACTIVE',
      SLOT_TX_MODEL: 'ADX1',
      SLOT_TX_DEVICE_ID: 'LeadVox',
      SLOT_BATT_BARS: 4,
      SLOT_BATT_MINS: 325,
      SLOT_BATT_CHARGE_PERCENT: 88,
      SLOT_BATT_HEALTH_PERCENT: 97,
      SLOT_BATT_CYCLE_COUNT: 19,
      SLOT_BATT_TYPE: 'LION',
      SLOT_INPUT_PAD: 12,
      SLOT_OFFSET: 12,
      SLOT_POLARITY: 'POSITIVE',
      SLOT_RF_OUTPUT: 'RF_ON',
      SLOT_RF_POWER: 10,
      SLOT_RF_POWER_MODE: 'NORMAL',
      SLOT_SHOWLINK_STATUS: 5,
    });
    // a spare registered to the same channel, linked but switched off
    Object.assign(channels[1].slots[1], {
      SLOT_STATUS: 'LINKED.INACTIVE',
      SLOT_TX_MODEL: 'ADX1',
      SLOT_TX_DEVICE_ID: 'Spare',
    });
  }
  if (channels[2]) {
    // a standard AD2 handheld on a Quadversity channel, on alkalines
    Object.assign(channels[2], {
      CHAN_NAME: 'Host',
      ANTENNA_CONFIGURATION: 'QUADVERSITY',
      ENCRYPTION_MODE: 'ON',
      TX_MODEL: 'AD2',
      TX_FW_VER: '1.4.7.0',
      TX_DEVICE_ID: 'Host HH',
      TX_BATT_TYPE: 'ALKA',
      TX_BATT_BARS: 3,
      TX_LOCK: 'MENU',
      TX_MUTE_MODE_STATUS: 'ON',
      TX_POWER_LEVEL: 20,
      TX_POWER_SOURCE: 'BATTERY',
    });
    Object.assign(channels[2].slots[0], {
      SLOT_STATUS: 'STANDARD',
      SLOT_TX_MODEL: 'AD2',
      SLOT_TX_DEVICE_ID: 'Host HH',
    });
  }
  if (channels[3]) {
    // frequency diversity, combining: a second carrier and its own status
    Object.assign(channels[3], {
      CHAN_NAME: 'Guitar',
      FD_MODE: 'FD-C',
      GROUP_CHANNEL2: '--,--',
      FREQUENCY2: 480_625,
      INTERFERENCE_STATUS2: 'NONE',
      UNREGISTERED_TX_STATUS2: 'OK',
    });
  }
  return channels;
}

/**
 * Start a fake ANX4 on loopback.
 *
 * @param {object} [options]
 * @param {number} [options.port] 0 picks a free one
 * @param {number} [options.channels] how many channels are licensed
 * @param {boolean} [options.silent] accept connections and never answer, like
 *   a port that belongs to something that is not an ANX4
 */
export async function startFakeAnx4({
  port = 0,
  host = '127.0.0.1',
  channels: channelCount = 4,
  silent = false,
} = {}) {
  const device = {
    MODEL: 'ANX4',
    DEVICE_ID: 'ANX4-Stage',
    FW_VER: '1.2.3.4',
    NA_DEVICE_NAME: 'ANX4-Stage-0a1b2c',
    TRANSMISSION_MODE: 'AD_STANDARD',
    AVAILABLE_CHANNELS: Array.from(
      { length: channelCount },
      (_, i) => i + 1,
    ).join(','),
    NUMBER_CHANNELS_LICENSED: channelCount,
    FLASH: 'OFF',
  };
  const network = {
    SC: 'AUTO 192.168.001.025 255.255.255.000 000.000.000.000 00:0E:DD:45:60:EB',
    D1: 'MANUAL 010.010.001.015 255.255.255.000 010.010.001.001 00:0E:DD:FC:B9:6F',
  };
  const channels = buildChannels(channelCount);
  const received = [];
  const connections = new Set();
  let phase = 0;

  const broadcast = (line) => {
    for (const connection of connections) connection.write(line);
  };
  const channelNumbers = (x) =>
    x === 0 ? Object.keys(channels).map(Number) : channels[x] ? [x] : [];

  const channelLine = (n, property) => {
    const format = CHANNEL_FORMAT[property] ?? FDC_FORMAT[property];
    return `< REP ${n} ${property} ${format(channels[n][property])} >`;
  };
  const slotLine = (n, slot, property) =>
    `< REP ${n} ${property} ${slot} ${SLOT_FORMAT[property](
      channels[n].slots[slot - 1][property],
    )} >`;
  const deviceLine = (property) =>
    `< REP ${property} ${DEVICE_FORMAT[property](device[property])} >`;

  // one antenna's `bitmap rssi` pair, wandering a little around `dbm`
  const antenna = (dbm, seed) => {
    const rssi = clamp(
      Math.round(120 + dbm + 3 * Math.sin(phase + seed)),
      0,
      120,
    );
    return `31 ${digits(3)(rssi)}`;
  };
  const sampleLine = (n) => {
    const ch = channels[n];
    const present = ch.TX_MODEL !== 'UNKNOWN';
    const audio =
      present && ch.AUDIO_MUTE === 'OFF'
        ? Math.round(120 - 24 + 10 * Math.sin(phase * 2 + n))
        : 20;
    const count = ch.ANTENNA_CONFIGURATION === 'QUADVERSITY' ? 4 : 2;
    const group = (seed) =>
      `${'B'.repeat(count)} ${Array.from({ length: count }, (_, i) =>
        antenna(present ? -55 - 6 * i : -105, seed + i),
      ).join(' ')}`;
    const groups =
      ch.FD_MODE === 'FD-C' ? `${group(n)} ${group(n + 9)}` : group(n);
    const quality = present ? '005' : '255';
    const p = digits(3);
    return `< SAMPLE ${n} ALL ${quality} 031 ${p(clamp(audio + 6, 0, 120))} ${p(audio)} ${groups} >`;
  };

  function get(tokens) {
    const out = [];
    if (/^\d+$/.test(tokens[0] ?? '')) {
      const x = Number(tokens[0]);
      const property = tokens[1];
      const targets = channelNumbers(x);
      if (!targets.length) return ['< REP ERR >'];
      if (property === 'ALL') {
        for (const key of Object.keys(DEVICE_FORMAT)) out.push(deviceLine(key));
        for (const n of targets) {
          for (const key of Object.keys(CHANNEL_FORMAT))
            out.push(channelLine(n, key));
          for (const key of Object.keys(FDC_FORMAT))
            if (key in channels[n]) out.push(channelLine(n, key));
          for (let slot = 1; slot <= SLOTS; slot += 1)
            for (const key of Object.keys(SLOT_FORMAT))
              out.push(slotLine(n, slot, key));
        }
        return out;
      }
      if (SLOT_FORMAT[property]) {
        const z = Number(tokens[2] ?? 0);
        const slots = z === 0 ? [1, 2, 3, 4, 5, 6, 7, 8] : [z];
        if (z < 0 || z > SLOTS) return ['< REP ERR >'];
        for (const n of targets)
          for (const slot of slots) out.push(slotLine(n, slot, property));
        return out;
      }
      for (const n of targets) {
        if (!(property in channels[n])) return ['< REP ERR >'];
        out.push(channelLine(n, property));
      }
      return out;
    }
    const property = tokens[0];
    if (property === 'NET_SETTINGS') {
      const settings = network[tokens[1]];
      return [
        settings
          ? `< REP NET_SETTINGS ${tokens[1]} ${settings} >`
          : '< REP ERR >',
      ];
    }
    return [DEVICE_FORMAT[property] ? deviceLine(property) : '< REP ERR >'];
  }

  // `40`, `INC 5` or `DEC 2`, against the current wire value
  const stepped = (current, args, lo, hi) => {
    const [first, second] = args;
    let next;
    if (first === 'INC') next = current + Number(second);
    else if (first === 'DEC') next = current - Number(second);
    else next = Number(first);
    return Number.isFinite(next) && next >= lo && next <= hi ? next : null;
  };

  /** Returns the REP lines a SET produces; they go to every connection. */
  function set(tokens, connection) {
    if (!/^\d+$/.test(tokens[0] ?? '')) {
      const [property, value] = tokens;
      if (property === 'DEVICE_ID' && value)
        device.DEVICE_ID = value.slice(0, 31);
      else if (property === 'FLASH' && /^(ON|OFF)$/.test(value))
        device.FLASH = value;
      else return null;
      return [deviceLine(property)];
    }

    const x = Number(tokens[0]);
    const [, property, ...args] = tokens;
    const targets = channelNumbers(x);
    if (!targets.length) return null;
    const out = [];

    if (SLOT_FORMAT[property]) {
      const slotNumber = Number(args[0]);
      const value = args.slice(1);
      for (const n of targets) {
        const slot = channels[n].slots[slotNumber - 1];
        // only a linked, online transmitter can be adjusted from the rack
        if (!slot || slot.SLOT_STATUS !== 'LINKED.ACTIVE') return null;
        switch (property) {
          case 'SLOT_TX_DEVICE_ID':
            if (!value[0]) return null;
            slot.SLOT_TX_DEVICE_ID = value[0].slice(0, 8);
            break;
          case 'SLOT_INPUT_PAD':
            if (!['0', '12', '24'].includes(String(Number(value[0]))))
              return null;
            slot.SLOT_INPUT_PAD = Number(value[0]);
            break;
          case 'SLOT_OFFSET': {
            const next = stepped(slot.SLOT_OFFSET, value, 0, 33);
            if (next === null) return null;
            slot.SLOT_OFFSET = next;
            break;
          }
          case 'SLOT_POLARITY':
            if (!/^(POSITIVE|NEGATIVE)$/.test(value[0])) return null;
            slot.SLOT_POLARITY = value[0];
            break;
          case 'SLOT_RF_OUTPUT':
            if (!/^(RF_ON|RF_MUTE)$/.test(value[0])) return null;
            slot.SLOT_RF_OUTPUT = value[0];
            break;
          case 'SLOT_RF_POWER_MODE':
            if (!/^(LOW|NORMAL|HIGH)$/.test(value[0])) return null;
            slot.SLOT_RF_POWER_MODE = value[0];
            slot.SLOT_RF_POWER = { LOW: 2, NORMAL: 10, HIGH: 40 }[value[0]];
            out.push(slotLine(n, slotNumber, 'SLOT_RF_POWER'));
            break;
          default:
            return null; // SLOT_RF_POWER and the rest are read-only
        }
        out.push(slotLine(n, slotNumber, property));
      }
      return out;
    }

    for (const n of targets) {
      const ch = channels[n];
      switch (property) {
        case 'CHAN_NAME':
          if (args[0] === undefined) return null;
          ch.CHAN_NAME = args[0].slice(0, 8);
          break;
        case 'AUDIO_GAIN': {
          const next = stepped(ch.AUDIO_GAIN, args, 0, 60);
          if (next === null) return null;
          ch.AUDIO_GAIN = next;
          break;
        }
        case 'AUDIO_MUTE':
          if (args[0] === 'TOGGLE')
            ch.AUDIO_MUTE = ch.AUDIO_MUTE === 'ON' ? 'OFF' : 'ON';
          else if (/^(ON|OFF)$/.test(args[0])) ch.AUDIO_MUTE = args[0];
          else return null;
          break;
        case 'FLASH':
          if (!/^(ON|OFF)$/.test(args[0])) return null;
          ch.FLASH = args[0];
          break;
        case 'FREQUENCY': {
          const khz = Number(args[0]);
          const inBand =
            Number.isInteger(khz) &&
            khz >= BAND_MIN_KHZ &&
            khz <= BAND_MAX_KHZ &&
            khz % STEP_KHZ === 0;
          if (!inBand) return null;
          ch.FREQUENCY = khz;
          ch.GROUP_CHANNEL = '--,--';
          // setting a frequency reverts the group/channel, reported first
          out.push(channelLine(n, 'GROUP_CHANNEL'));
          break;
        }
        case 'GROUP_CHANNEL': {
          const match = /^(\d+),(\d+)$/.exec(args[0] ?? '');
          if (!match) return null;
          ch.GROUP_CHANNEL = `${match[1]},${match[2]}`;
          ch.FREQUENCY =
            BAND_MIN_KHZ + Number(match[1]) * 1_000 + Number(match[2]) * 125;
          out.push(channelLine(n, 'FREQUENCY'));
          break;
        }
        case 'METER_RATE': {
          const rate = Number(args[0]);
          const valid =
            Number.isInteger(rate) &&
            (rate === 0 || (rate >= 100 && rate <= 65_535));
          if (!valid) return null;
          connection.setMeterRate(n, rate);
          ch.METER_RATE = rate;
          break;
        }
        default:
          return null;
      }
      out.push(channelLine(n, property));
    }
    return out;
  }

  const server = net.createServer((socket) => {
    const framer = new MessageFramer();
    const meters = new Map(); // channel -> interval
    const connection = {
      write: (line) => {
        if (!socket.destroyed) socket.write(line);
      },
      setMeterRate(n, rate) {
        clearInterval(meters.get(n));
        meters.delete(n);
        if (rate > 0) {
          const timer = setInterval(() => {
            phase += 0.05;
            connection.write(sampleLine(n));
          }, rate);
          timer.unref?.();
          meters.set(n, timer);
        }
      },
    };
    connections.add(connection);
    socket.setEncoding('latin1');
    socket.on('error', () => {});
    socket.on('close', () => {
      for (const timer of meters.values()) clearInterval(timer);
      connections.delete(connection);
    });
    connection.destroy = () => socket.destroy();

    socket.on('data', (chunk) => {
      for (const body of framer.push(chunk)) {
        received.push(body);
        if (silent) continue;
        const [type, ...tokens] = tokenize(body);
        if (type === 'GET') {
          connection.write(get(tokens).join(''));
        } else if (type === 'SET') {
          const lines = set(tokens, connection);
          if (lines) broadcast(lines.join(''));
          else connection.write('< REP ERR >');
        } else {
          connection.write('< REP ERR >');
        }
      }
    });
  });

  await new Promise((resolve) => server.listen(port, host, resolve));

  return {
    port: server.address().port,
    device,
    channels,
    /** every message body received, in order: `SET 1 AUDIO_GAIN 60` */
    received,
    /**
     * Change a channel property as if someone did it at the front panel, and
     * send the unprompted REP every connected controller would get.
     */
    change(n, property, value) {
      channels[n][property] = value;
      broadcast(channelLine(n, property));
    },
    /** The same for one transmitter slot, e.g. a pack being switched off. */
    changeSlot(n, slot, property, value) {
      channels[n].slots[slot - 1][property] = value;
      broadcast(slotLine(n, slot, property));
    },
    /** drop every connection without closing the listener — a transport death */
    dropConnections() {
      for (const connection of connections) connection.destroy();
    },
    async close() {
      for (const connection of connections) connection.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// `node driver/fake-anx4.js [port]`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fake = await startFakeAnx4({ port: Number(process.argv[2]) || 2202 });
  process.stdout.write(`fake ANX4 listening on 127.0.0.1:${fake.port}\n`);
}
