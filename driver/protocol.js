// The Shure ANX4 command-string protocol: framing, encoding and decoding.
//
// Everything here is about the *wire* and nothing here knows what SoundBase
// is. Messages are ASCII, framed by `< ` and ` >`, over TCP port 2202:
//
//   < GET 1 CHAN_NAME >                      ask for one property
//   < SET 1 AUDIO_GAIN 40 >                  change one
//   < REP 1 AUDIO_GAIN 040 >                 the device's answer, and also what
//                                            it sends unprompted on any change
//   < SAMPLE 1 ALL 005 031 102 102 BB … >    one metering sample
//
// Source: https://www.shure.com/en-US/docs/commandstrings/ANX4 — see
// protocol.md beside this file for the parts that are easy to get wrong.

export const DEFAULT_PORT = 2202;
export const MAX_CHANNELS = 24;
export const SLOTS_PER_CHANNEL = 8;
export const NAME_MAX = 8; // what SET accepts; REP pads to 31
export const DEVICE_ID_MAX = 31;

// AUDIO_GAIN travels offset by 18: 000–060 on the wire is -18…+42 dB
export const GAIN_MIN_DB = -18;
export const GAIN_MAX_DB = 42;
// TX_OFFSET / SLOT_OFFSET travel offset by 12: 000–033 is -12…+21 dB
export const OFFSET_MIN_DB = -12;
export const OFFSET_MAX_DB = 21;
// SLOT_INPUT_PAD travels offset by 12: pad on, pad off, boost on
export const INPUT_PAD_DB = [-12, 0, 12];
export const METER_RATE_MIN_MS = 100;
export const METER_RATE_MAX_MS = 65_535;

const MAX_MESSAGE_CHARS = 4096;

// ---------------------------------------------------------------------------
// framing
// ---------------------------------------------------------------------------

/**
 * Splits a TCP byte stream into message bodies (the text between `<` and
 * `>`). Names travel inside `{…}` and may themselves contain `<` and `>`, so
 * a `>` only ends a message outside braces.
 */
export class MessageFramer {
  #buffered = '';

  push(chunk) {
    this.#buffered += chunk;
    const bodies = [];
    for (;;) {
      const start = this.#buffered.indexOf('<');
      if (start < 0) {
        this.#buffered = '';
        break;
      }
      const end = endOfMessage(this.#buffered, start);
      if (end < 0) {
        // an unterminated message that long is a brace that never closed;
        // drop its opening bracket and resynchronise on the next one
        const runaway = this.#buffered.length - start > MAX_MESSAGE_CHARS;
        this.#buffered = this.#buffered.slice(runaway ? start + 1 : start);
        if (runaway) continue;
        break;
      }
      bodies.push(this.#buffered.slice(start + 1, end).trim());
      this.#buffered = this.#buffered.slice(end + 1);
    }
    return bodies;
  }
}

function endOfMessage(text, start) {
  let inBraces = false;
  for (let i = start + 1; i < text.length; i += 1) {
    const c = text[i];
    if (c === '{') inBraces = true;
    else if (c === '}') inBraces = false;
    else if (c === '>' && !inBraces) return i;
  }
  return -1;
}

/** `1 CHAN_NAME {Lead Vox   }` -> ['1', 'CHAN_NAME', 'Lead Vox'] */
export function tokenize(body) {
  const tokens = [];
  for (const match of body.matchAll(/\{([^}]*)\}|(\S+)/g)) {
    tokens.push(match[1] !== undefined ? match[1].trim() : match[2]);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// encoding
// ---------------------------------------------------------------------------

/** `command('SET', 1, 'AUDIO_GAIN', 40)` -> `< SET 1 AUDIO_GAIN 40 >` */
export const command = (...parts) => `< ${parts.join(' ')} >`;

/** A string argument: `{Lead Vox}`. */
export const braced = (text) => `{${text}}`;

// A-Z, a-z, 0-9, the punctuation the device accepts, and space. Braces and
// the pipe are not in the set, which is what makes brace framing safe.
const NOT_NAME_CHARS = /[^A-Za-z0-9!"#$%&'()*+,\-./:;<=>?@[\\\]^_`~ ]/g;

/** A name as the device will take it: its character set, at most `max` long. */
export function sanitizeName(value, max) {
  return String(value).replace(NOT_NAME_CHARS, '').trim().slice(0, max);
}

// ---------------------------------------------------------------------------
// decoding
// ---------------------------------------------------------------------------
//
// Every decoder turns the wire's "unknown" sentinel (255, 65535, UNKNOWN,
// UNKN, a blank string) into null, and applies the documented offset, so
// nothing above this file ever sees a wire value.

const text = (raw) => (raw === undefined ? null : raw.trim() || null);
const word =
  (...unknown) =>
  (raw) =>
    raw === undefined || unknown.includes(raw) ? null : raw;
const number =
  ({ offset = 0, unknown = [] } = {}) =>
  (raw) => {
    if (raw === undefined || !/^\d+$/.test(raw)) return null;
    const value = Number(raw);
    return unknown.includes(value) ? null : value + offset;
  };
const flag = (on) => (raw) => raw === on;
const megahertz = (raw) => {
  const khz = number()(raw);
  return khz === null || khz === 0 ? null : khz / 1000;
};
const groupChannel = (raw) => {
  const value = text(raw);
  return !value || value.startsWith('--') ? null : value.replace(/\s+/g, '');
};
const channelList = (raw) =>
  (raw ?? '')
    .split(',')
    .map((entry) => Number.parseInt(entry, 10))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= MAX_CHANNELS);
// AD transmitters report mW (002, 010, 020 …); ULX-D ones LOW/NORMAL/HIGH
const powerLevel = (raw) =>
  /^\d+$/.test(raw ?? '')
    ? number({ unknown: [255] })(raw)
    : word('UNKNOWN')(raw);

const byte = number({ unknown: [255] });
const short = number({ unknown: [65535] });
const level = number({ offset: -120 }); // dBFS and dBm both travel as 000–120

const DEVICE_FIELDS = {
  MODEL: ['model', text],
  DEVICE_ID: ['deviceId', text],
  FW_VER: ['firmware', text],
  NA_DEVICE_NAME: ['danteDeviceName', text],
  TRANSMISSION_MODE: ['transmissionMode', word()],
  AVAILABLE_CHANNELS: ['availableChannels', channelList],
  NUMBER_CHANNELS_LICENSED: ['licensedChannels', number()],
  FLASH: ['flash', flag('ON')],
};

const CHANNEL_FIELDS = {
  CHAN_NAME: ['name', (raw) => text(raw) ?? ''],
  NA_CHAN_NAME: ['danteChannelName', text],
  FLASH: ['flash', flag('ON')],
  AUDIO_GAIN: ['gain', number({ offset: GAIN_MIN_DB })],
  AUDIO_MUTE: ['muted', flag('ON')],
  ENCRYPTION_MODE: ['encryptionMode', word()],
  ENCRYPTION_STATUS: ['encryptionError', flag('ERROR')],
  RF_BAND: ['rfBand', text],
  ANTENNA_CONFIGURATION: ['antennaConfig', word()],
  FD_MODE: ['fdMode', word()],
  FREQUENCY: ['frequency', megahertz],
  FREQUENCY2: ['frequency2', megahertz],
  GROUP_CHANNEL: ['groupChannel', groupChannel],
  GROUP_CHANNEL2: ['groupChannel2', groupChannel],
  INTERFERENCE_STATUS: ['interference', flag('DETECTED')],
  INTERFERENCE_STATUS2: ['interference2', flag('DETECTED')],
  UNREGISTERED_TX_STATUS: ['unregisteredTx', flag('ERROR')],
  UNREGISTERED_TX_STATUS2: ['unregisteredTx2', flag('ERROR')],
  METER_RATE: ['meterRate', number()],
  // metered: these never REPort on change, only on GET and in SAMPLE
  CHAN_QUALITY: ['quality', byte],
  AUDIO_LED_BITMAP: ['audioLedBitmap', number()],
  AUDIO_LEVEL_PEAK: ['audioPeak', level],
  AUDIO_LEVEL_RMS: ['audioRms', level],
  ANTENNA_STATUS: ['antennaStatus', word()],
  // the transmitter the channel is receiving ("side channel")
  TX_MODEL: ['txModel', word('UNKNOWN')],
  TX_FW_VER: ['txFirmware', text],
  TX_DEVICE_ID: ['txDeviceId', text],
  TX_BATT_TYPE: ['txBatteryType', word('UNKN')],
  TX_BATT_BARS: ['txBatteryBars', byte],
  TX_BATT_MINS: ['txBatteryMinutes', short],
  TX_BATT_CHARGE_PERCENT: ['txBatteryPercent', byte],
  TX_BATT_CYCLE_COUNT: ['txBatteryCycles', short],
  TX_BATT_HEALTH_PERCENT: ['txBatteryHealth', byte],
  TX_BATT_TEMP_C: ['txBatteryTempC', number({ offset: -40, unknown: [255] })],
  TX_BATT_TEMP_F: ['txBatteryTempF', number({ offset: -40, unknown: [255] })],
  TX_INPUT_PAD: ['txInputPad', number({ offset: -12, unknown: [255] })],
  TX_OFFSET: ['txOffset', number({ offset: OFFSET_MIN_DB, unknown: [255] })],
  TX_LOCK: ['txLock', word('UNKNOWN')],
  TX_MUTE_MODE_STATUS: ['txMuteMode', word('UNKNOWN')],
  TX_MUTE_BUTTON_STATUS: ['txMuteButton', word('UNKN', 'UNKNOWN')],
  TX_POLARITY: ['txPolarity', word('UNKNOWN')],
  TX_POWER_LEVEL: ['txPowerLevel', powerLevel],
  TX_POWER_SOURCE: ['txPowerSource', word('UNKNOWN')],
  TX_TALK_SWITCH: ['txTalkSwitch', word('UNKNOWN')],
  TX_PHANTOM_POWER: ['txPhantomPower', byte],
  TX_HIGH_PASS_FILTER: ['txHighPassFilter', byte],
};

// one value per antenna: `< REP x RSSI 2 064 >` is antenna B
const ANTENNA_FIELDS = {
  RSSI: ['rssi', level],
  RSSI_LED_BITMAP: ['led', number()],
};

const SLOT_FIELDS = {
  SLOT_STATUS: ['status', word()],
  SLOT_TX_MODEL: ['model', word('UNKNOWN')],
  SLOT_TX_DEVICE_ID: ['deviceId', text],
  SLOT_BATT_BARS: ['batteryBars', byte],
  SLOT_BATT_MINS: ['batteryMinutes', short],
  SLOT_BATT_CHARGE_PERCENT: ['batteryPercent', byte],
  SLOT_BATT_HEALTH_PERCENT: ['batteryHealth', byte],
  SLOT_BATT_CYCLE_COUNT: ['batteryCycles', short],
  SLOT_BATT_TYPE: ['batteryType', word('UNKN')],
  SLOT_INPUT_PAD: ['inputPad', number({ offset: -12, unknown: [255] })],
  SLOT_OFFSET: ['offset', number({ offset: OFFSET_MIN_DB, unknown: [255] })],
  SLOT_POLARITY: ['polarity', word('UNKNOWN', 'UNKN')],
  SLOT_RF_OUTPUT: ['rfOutput', word('UNKNOWN')],
  SLOT_RF_POWER: ['rfPower', byte],
  SLOT_RF_POWER_MODE: ['rfPowerMode', word('UNKNOWN')],
  SLOT_PHANTOM_POWER: ['phantomPower', byte],
  SLOT_HIGH_PASS_FILTER: ['highPassFilter', byte],
  SLOT_SHOWLINK_STATUS: ['showLink', byte],
};

/** Every per-slot property, for asking a channel about all eight slots. */
export const SLOT_PROPERTIES = Object.keys(SLOT_FIELDS);

const isIndex = (token) => /^\d+$/.test(token ?? '');
// `192.168.001.025` -> `192.168.1.25`; the device zero-pads every octet
const address = (raw) =>
  /^\d+\.\d+\.\d+\.\d+$/.test(raw ?? '')
    ? raw.split('.').map(Number).join('.')
    : null;

/**
 * One message body, decoded:
 *
 *   { kind: 'device',  field, value }
 *   { kind: 'network', value: { interface, mode, ip, subnet, gateway, mac } }
 *   { kind: 'channel', channel, field, value }
 *   { kind: 'antenna', channel, antenna, field, value }      antenna is 1-based
 *   { kind: 'slot',    channel, slot, field, value }
 *   { kind: 'sample',  channel, quality, audioLedBitmap, audioPeak, audioRms, antennas }
 *   { kind: 'error' }                                        `< REP ERR >`
 *
 * or null for anything this plugin has no use for. A property the document
 * does not list is not an error: firmware adds them.
 */
export function decode(body) {
  const [type, ...args] = tokenize(body);
  if (type === 'SAMPLE') return decodeSample(args);
  if (type !== 'REP') return null;
  if (args[0] === 'ERR') return { kind: 'error' };

  if (!isIndex(args[0])) {
    const [property, ...values] = args;
    if (property === 'NET_SETTINGS') return decodeNetwork(values);
    const entry = DEVICE_FIELDS[property];
    if (!entry) return null;
    return { kind: 'device', field: entry[0], value: entry[1](values[0]) };
  }

  const channel = Number(args[0]);
  const [, property, ...values] = args;
  if (channel < 1 || channel > MAX_CHANNELS) return null;

  if (CHANNEL_FIELDS[property]) {
    const [field, read] = CHANNEL_FIELDS[property];
    return { kind: 'channel', channel, field, value: read(values[0]) };
  }
  if (ANTENNA_FIELDS[property] && isIndex(values[0])) {
    const [field, read] = ANTENNA_FIELDS[property];
    const antenna = Number(values[0]);
    if (antenna < 1) return null;
    return { kind: 'antenna', channel, antenna, field, value: read(values[1]) };
  }
  if (SLOT_FIELDS[property] && isIndex(values[0])) {
    const [field, read] = SLOT_FIELDS[property];
    const slot = Number(values[0]);
    if (slot < 1 || slot > SLOTS_PER_CHANNEL) return null;
    return { kind: 'slot', channel, slot, field, value: read(values[1]) };
  }
  return null;
}

function decodeNetwork([iface, mode, ip, subnet, gateway, mac]) {
  if (!iface || !mode) return null;
  const gw = address(gateway);
  return {
    kind: 'network',
    value: {
      interface: iface,
      mode,
      ip: address(ip),
      subnet: address(subnet),
      // 000.000.000.000 means no gateway is used
      gateway: gw === '0.0.0.0' ? null : gw,
      mac: mac ?? null,
    },
  };
}

// < SAMPLE ch ALL qual audBitmap audPeak audRms antStats (bitmap rssi)… >
//
// The tail describes itself: an antenna-status word of N letters is followed
// by N bitmap/RSSI pairs, and an FD-C channel simply appends a second such
// group for its second frequency. So one parser covers standard, Quadversity,
// FD-C and Quadversity + FD-C without being told which it is reading.
function decodeSample([chan, selector, quality, bitmap, peak, rms, ...rest]) {
  if (!isIndex(chan) || selector !== 'ALL') return null;
  const antennas = [];
  let i = 0;
  while (i < rest.length) {
    const status = rest[i];
    if (!/^[XRBN]+$/.test(status)) return null;
    i += 1;
    for (const letter of status) {
      if (i + 1 >= rest.length) return null; // a truncated sample
      antennas.push({
        status: letter,
        led: number()(rest[i]),
        rssi: level(rest[i + 1]),
      });
      i += 2;
    }
  }
  return {
    kind: 'sample',
    channel: Number(chan),
    quality: byte(quality),
    audioLedBitmap: number()(bitmap),
    audioPeak: level(peak),
    audioRms: level(rms),
    antennas,
  };
}
