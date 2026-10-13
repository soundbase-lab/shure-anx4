// Shure ANX4 wireless receiver, over its Ethernet command-string port.
//
// The ANX4 measures nothing SoundBase can sweep, so this plugin has no
// spectrum-analyzer adapter: it is a ChannelMonitoring + PropertyControl
// device. driver/ holds everything about the wire; this file is the
// translation between what the receiver says and the state SoundBase draws.
//
//   REP (on connect, and unprompted on every change)  ->  onState(key, value)
//   SAMPLE (metering, at the configured interval)     ->  onState('meters', …)
//   setProperty(command)                              ->  SET; the REP that
//                                                         answers it is the
//                                                         state update
//
// State keys. A core key is used wherever the contract documents the value
// shape (channel-monitoring.openapi.yaml): channelName, frequency, mute,
// meters, battery, deviceName, connection, receivers. Everything else the
// ANX4 reports travels under four extension keys, declared in the manifest
// and bound by its layout, so nothing here guesses at a shape the contract
// does not spell out.

import { HttpError } from '@soundbase/plugin-shell';
import { Anx4Client, probe } from './driver/anx4-client.js';
import {
  DEFAULT_PORT,
  DEVICE_ID_MAX,
  GAIN_MAX_DB,
  GAIN_MIN_DB,
  INPUT_PAD_DB,
  METER_RATE_MAX_MS,
  METER_RATE_MIN_MS,
  NAME_MAX,
  OFFSET_MAX_DB,
  OFFSET_MIN_DB,
  SLOT_PROPERTIES,
  braced,
  command,
  sanitizeName,
} from './driver/protocol.js';

// The product this adapter announces its devices as. It MUST be a
// `deviceTypeId` declared in soundbase-plugin.json; `npm run rename` keeps
// the two in step and a test asserts they agree.
export const PRODUCT = 'plugin:shure-anx4/anx4';

const KEY = {
  channel: 'x.shure-anx4.channel', // receiver channel settings and status
  tx: 'x.shure-anx4.tx', // the transmitter a channel is receiving
  device: 'x.shure-anx4.device', // identity, licence, transmission mode
  network: 'x.shure-anx4.network', // control and Dante interfaces
};

const DEFAULT_METER_INTERVAL_MS = 100;
// How long to gather REPs before open() reports: until the unit has been
// quiet for QUIET_MS, capped so a unit that never goes quiet still opens.
const IDENTIFY_TIMEOUT_MS = 3_000;
const QUIET_MS = 250;
const SETTLE_MAX_MS = 4_000;
const SLOT_SETTLE_MAX_MS = 1_500;
// REPs arrive in bursts (a retune is two, a transmitter powering up is
// twenty); gather a burst into one patch per key.
const FLUSH_MS = 15;
const REJECTED_ATTRIBUTION_MS = 2_000;
const REJECTED_SHOWN_MS = 15_000;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const nearest = (value, list) =>
  list.reduce((best, c) =>
    Math.abs(c - value) < Math.abs(best - value) ? c : best,
  );

const badValue = (propertyId, expected) =>
  new HttpError(400, 'bad_value', `${propertyId} expects ${expected}`);

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------

// Units an adapter currently holds open, by address. Discovery answers for
// these from the live connection rather than opening a second one.
const openUnits = new Map();
// The shell asks once a second for as long as any device is open, and an
// ANX4 should not be answering a fresh TCP connection every second for the
// length of a show. So a probe's answer is kept for a while.
const probeCache = new Map();
const FOUND_TTL_MS = 30_000;
const MISSING_TTL_MS = 5_000;
const DISCOVERY_WAIT_MS = 700;

const addressKey = ({ host, port }) => `${host}:${port}`;
// `net:<host>` is the convention; the port only appears when it is unusual
const deviceIdFor = ({ host, port }) =>
  port === DEFAULT_PORT ? `net:${host}` : `net:${host}:${port}`;

/** "192.168.1.50, 192.168.1.51:2203" -> [{ host, port }, …] */
function parseAddresses(raw) {
  if (typeof raw !== 'string') return [];
  return raw
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((entry) => {
      const [host, port] = entry.split(':');
      return { host, port: Number(port) || DEFAULT_PORT };
    });
}

function identityAt(target) {
  const key = addressKey(target);
  const live = openUnits.get(key);
  if (live) return Promise.resolve(live);

  let cached = probeCache.get(key);
  if (!cached) {
    cached = { identity: null, at: 0, pending: null };
    probeCache.set(key, cached);
  }
  const ttl = cached.identity ? FOUND_TTL_MS : MISSING_TTL_MS;
  if (!cached.pending && Date.now() - cached.at >= ttl) {
    cached.pending = probe(target).then((identity) => {
      cached.identity = identity;
      cached.at = Date.now();
      cached.pending = null;
      return identity;
    });
  }
  if (!cached.pending) return Promise.resolve(cached.identity);
  // an address that swallows packets takes a while to give up on; answer
  // this poll with what was last known rather than stalling the picker
  return Promise.race([
    cached.pending,
    delay(DISCOVERY_WAIT_MS).then(() => cached.identity),
  ]);
}

/**
 * ANX4s reachable right now, from the addresses in the plugin's settings.
 * An address with nothing on it — or with something that is not an ANX4 —
 * is a normal, empty result.
 */
export async function discoverDevices(pluginConfig = {}) {
  const targets = parseAddresses(pluginConfig.addresses);
  const found = await Promise.all(
    targets.map(async (target) => {
      const identity = await identityAt(target);
      if (!identity?.model?.toUpperCase().startsWith('ANX4')) return null;
      return {
        id: deviceIdFor(target),
        name: `${identity.deviceId || identity.model} (${target.host})`,
        product: PRODUCT,
        transport: { kind: 'network', host: target.host, port: target.port },
      };
    }),
  );
  return found.filter(Boolean);
}

/**
 * `device.config` holds the manifest's `deviceConfigFields`, filled in from
 * the SoundBase project. The id fallback covers a unit this plugin discovered
 * itself, whose id already encodes the address.
 */
function addressOf(device) {
  const config = device.config ?? {};
  if (typeof config.host === 'string' && config.host.trim()) {
    return {
      host: config.host.trim(),
      port: Number(config.port) || DEFAULT_PORT,
    };
  }
  const match = /^net:([^:]+)(?::(\d+))?$/.exec(device.id ?? '');
  if (match) return { host: match[1], port: Number(match[2]) || DEFAULT_PORT };
  throw new Error(
    `Device ${device.id} has no address: set its IP address in the device settings`,
  );
}

// ---------------------------------------------------------------------------
// what the wire's fields become
// ---------------------------------------------------------------------------

// channel fields with a core state key of their own
const CORE_CHANNEL_KEY = {
  name: 'channelName',
  frequency: 'frequency',
  muted: 'mute',
};
const BATTERY_FIELDS = new Set([
  'txBatteryPercent',
  'txBatteryBars',
  'txBatteryMinutes',
  'txBatteryType',
]);
const METER_FIELDS = new Set([
  'quality',
  'audioLedBitmap',
  'audioPeak',
  'audioRms',
  'antennaStatus',
]);
const WARNING_FIELDS = new Set([
  'name',
  'fdMode',
  'interference',
  'interference2',
  'encryptionError',
  'unregisteredTx',
  'unregisteredTx2',
  'txFirmware',
  'txBatteryMinutes',
]);

// TX_BATT_MINS above 65532 is a state, not a number of minutes
const BATTERY_COMMS_WARNING = 65533;
const BATTERY_CALCULATING = 65534;
const minutesOf = (raw) =>
  isNum(raw) && raw < BATTERY_COMMS_WARNING ? raw : null;

/** `{ percent, lifetimeInMinutes?, charging? }`, or null when nothing is known. */
function batteryState({ percent, bars, minutes, type }) {
  const out = {};
  // a transmitter on primary cells reports bars and no percentage
  if (isNum(percent)) out.percent = percent;
  else if (isNum(bars)) out.percent = clamp(bars * 20, 0, 100);
  const lifetime = minutesOf(minutes);
  if (lifetime !== null) out.lifetimeInMinutes = lifetime;
  // WARN is the device's word for "charging, on a dock or over USB"
  if (type === 'WARN') out.charging = true;
  return Object.keys(out).length ? out : null;
}

// the letters of the antenna LEDs: B(lue) is an antenna in use
const antennaInUse = (status) => status === 'B';

class Anx4Adapter {
  constructor(device, pluginConfig = {}) {
    // Addressing arrives explicitly, in the device the host asked for —
    // never from this machine, so the same project works on another one.
    const { host, port } = addressOf(device);
    this.host = host;
    this.port = port;
    this.meterIntervalMs = isNum(pluginConfig.meterIntervalMs)
      ? clamp(
          Math.round(pluginConfig.meterIntervalMs),
          METER_RATE_MIN_MS,
          METER_RATE_MAX_MS,
        )
      : DEFAULT_METER_INTERVAL_MS;

    this.client = null;
    this.died = null; // why the transport failed, if it did during open()
    this.reporting = false; // true once open() has sent the full state
    this.unit = {}; // device-level fields
    this.network = {}; // interface -> settings
    this.channels = new Map(); // channel number -> fields
    this.slots = new Map(); // 'slot:<channel>:<slot>' -> fields
    this.announced = new Map(); // entity id -> the entity as last reported
    this.pending = this.#nothingPending();
    this.flushTimer = null;
    this.lastSet = null;
    this.rejected = null;
    this.rejectedTimer = null;

    // assigned by the shell before open()
    this.onState = null;
    this.onWarnings = null;
    this.onFatal = null;
  }

  #nothingPending() {
    return {
      unit: false,
      network: false,
      warnings: false,
      channels: new Map(), // channel number -> Set of state keys
      slots: new Set(),
    };
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  async open() {
    const client = new Anx4Client({ host: this.host, port: this.port });
    this.client = client;
    try {
      await client.connect();
      client.onMessage = (message) => this.#receive(message);
      // a connection that drops while the state is still being gathered
      // fails the open, with the transport's own account of why
      client.onFatal = (err) => {
        this.died = err;
      };

      // `GET 0 ALL` answers with every device and channel property; the
      // network settings are the one thing it leaves out, because they are
      // never REPorted unprompted either.
      for (const property of [
        'MODEL',
        'DEVICE_ID',
        'FW_VER',
        'NA_DEVICE_NAME',
        'TRANSMISSION_MODE',
        'AVAILABLE_CHANNELS',
        'NUMBER_CHANNELS_LICENSED',
      ])
        client.send(command('GET', property));
      for (const iface of ['SC', 'D1', 'D2'])
        client.send(command('GET', 'NET_SETTINGS', iface));
      client.send(command('GET', 0, 'ALL'));
      await this.#settle(SETTLE_MAX_MS, { mustIdentify: true });

      // Transmitter slots exist on Axient Digital channels only. If the unit
      // is in that mode and `ALL` did not cover them, ask outright.
      const axient = !/^ULXD/.test(this.unit.transmissionMode ?? '');
      if (axient && this.slots.size === 0) {
        for (const n of this.#channelNumbers())
          for (const property of SLOT_PROPERTIES)
            client.send(command('GET', n, property, 0));
        await this.#settle(SLOT_SETTLE_MAX_MS);
      }
      if (this.died) throw this.died;
    } catch (err) {
      await this.close();
      throw err;
    }

    // from here on, a dead transport is the shell's to hear about
    client.onFatal = (err) => this.onFatal?.(err);
    openUnits.set(addressKey(this), {
      model: this.unit.model,
      deviceId: this.unit.deviceId,
    });

    // the complete state first, so SoundBase renders a full card at once
    this.reporting = true;
    this.onState?.('connection', {
      connected: true,
      since: new Date().toISOString(),
    });
    this.#flush();

    // metering is off until asked for; channel 0 addresses every channel
    client.send(command('SET', 0, 'METER_RATE', this.meterIntervalMs));

    return {
      channelCount: this.#channelCount(),
      properties: this.#properties(),
      identity: {
        manufacturer: 'Shure',
        model: this.unit.model,
        firmware: this.unit.firmware?.replace(/\*$/, ''),
        name: this.unit.deviceId ?? undefined,
      },
    };
  }

  /**
   * Wait for the burst of REPs that answers what was just sent: until
   * something has arrived and the line has then been quiet for QUIET_MS.
   */
  async #settle(maxMs, { mustIdentify = false } = {}) {
    const startedAt = Date.now();
    for (;;) {
      await delay(25);
      if (this.died) throw this.died;
      if (!this.client) throw new Error(`${this.host}:${this.port} was closed`);
      const elapsed = Date.now() - startedAt;
      if (mustIdentify && !this.unit.model) {
        if (elapsed < IDENTIFY_TIMEOUT_MS) continue;
        throw new Error(
          `${this.host}:${this.port} accepted the connection but did not answer as an ANX4. ` +
            'Check the address, and that command strings are turned on in the ANX4: ' +
            'Device Configuration > Network Services.',
        );
      }
      const answered = this.client.lastReceivedAt >= startedAt;
      const quietFor = Date.now() - this.client.lastReceivedAt;
      if (answered && quietFor >= QUIET_MS) return;
      if (elapsed >= maxMs) return;
    }
  }

  async close() {
    const client = this.client;
    this.client = null;
    this.reporting = false;
    clearTimeout(this.flushTimer);
    clearTimeout(this.rejectedTimer);
    this.flushTimer = null;
    this.rejectedTimer = null;
    if (!client) return;
    openUnits.delete(addressKey(this));
    // closing the connection is what ends this client's metering
    client.close();
  }

  // -------------------------------------------------------------------------
  // the wire -> the model
  // -------------------------------------------------------------------------

  #channel(n) {
    let channel = this.channels.get(n);
    if (!channel) {
      channel = { antennas: [] };
      this.channels.set(n, channel);
    }
    return channel;
  }

  #mark(n, key) {
    let keys = this.pending.channels.get(n);
    if (!keys) {
      keys = new Set();
      this.pending.channels.set(n, keys);
    }
    keys.add(key);
  }

  #receive(message) {
    // a late report for a channel the unit no longer has must not bring it back
    if (message.channel !== undefined && !this.#hasChannel(message.channel))
      return;
    switch (message.kind) {
      case 'device': {
        const before = this.unit[message.field];
        if (same(before, message.value)) return;
        this.unit[message.field] = message.value;
        this.pending.unit = true;
        if (message.field === 'firmware') this.pending.warnings = true;
        if (message.field === 'availableChannels' && this.reporting)
          this.#channelsChanged(before ?? [], message.value);
        break;
      }

      case 'network':
        this.network[message.value.interface] = message.value;
        this.pending.network = true;
        break;

      case 'channel': {
        const { channel: n, field, value } = message;
        const channel = this.#channel(n);
        if (channel[field] === value) return;
        channel[field] = value;
        if (METER_FIELDS.has(field)) {
          if (field === 'antennaStatus') {
            // `BBNN`: one letter per antenna A–D, N for "not fitted"
            [...(value ?? '')].forEach((letter, i) => {
              if (letter === 'N') return;
              channel.antennas[i] = { ...channel.antennas[i], status: letter };
            });
          }
          this.#mark(n, 'meters');
        } else if (CORE_CHANNEL_KEY[field]) {
          this.#mark(n, CORE_CHANNEL_KEY[field]);
        } else if (field.startsWith('tx')) {
          this.#mark(n, KEY.tx);
          if (BATTERY_FIELDS.has(field)) this.#mark(n, 'battery');
        } else {
          this.#mark(n, KEY.channel);
        }
        if (WARNING_FIELDS.has(field)) this.pending.warnings = true;
        break;
      }

      case 'antenna': {
        const { channel: n, antenna, field, value } = message;
        const channel = this.#channel(n);
        channel.antennas[antenna - 1] = {
          ...channel.antennas[antenna - 1],
          [field]: value,
        };
        this.#mark(n, 'meters');
        break;
      }

      case 'sample': {
        const channel = this.#channel(message.channel);
        channel.quality = message.quality;
        channel.audioLedBitmap = message.audioLedBitmap;
        channel.audioPeak = message.audioPeak;
        channel.audioRms = message.audioRms;
        channel.antennas = message.antennas;
        // The one high-rate message, so it skips the gathering below and
        // goes straight out; the shell coalesces meters to 20 Hz itself.
        if (this.reporting) {
          this.onState?.('meters', {
            timestamp: Date.now(),
            channels: { [message.channel]: this.#meters(channel) },
          });
        } else {
          this.#mark(message.channel, 'meters');
        }
        return;
      }

      case 'slot': {
        const id = `slot:${message.channel}:${message.slot}`;
        let slot = this.slots.get(id);
        if (!slot) {
          slot = { id, channel: message.channel, slot: message.slot };
          this.slots.set(id, slot);
        }
        if (slot[message.field] === message.value) return;
        slot[message.field] = message.value;
        this.pending.slots.add(id);
        break;
      }

      case 'error':
        this.#rejected();
        return;

      default:
        return;
    }
    this.#schedule();
  }

  /**
   * `< REP ERR >` names nothing, so it is attributed to the SET that
   * immediately preceded it and shown for a while: the user changed a
   * control, the card did not follow, and this is the only way to say why.
   */
  #rejected() {
    const last = this.lastSet;
    if (!last || Date.now() - last.at > REJECTED_ATTRIBUTION_MS) return;
    this.lastSet = null;
    this.rejected = last.label;
    clearTimeout(this.rejectedTimer);
    this.rejectedTimer = setTimeout(() => {
      this.rejected = null;
      this.#reportWarnings();
    }, REJECTED_SHOWN_MS);
    this.rejectedTimer.unref?.();
    this.#reportWarnings();
  }

  #schedule() {
    // until open() has reported, changes just accumulate for its one flush
    if (this.flushTimer || !this.reporting) return;
    this.flushTimer = setTimeout(() => this.#flush(), FLUSH_MS);
    this.flushTimer.unref?.();
  }

  // -------------------------------------------------------------------------
  // the model -> state
  // -------------------------------------------------------------------------

  #flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const pending = this.pending;
    this.pending = this.#nothingPending();

    if (pending.unit) {
      if (this.unit.deviceId) this.onState?.('deviceName', this.unit.deviceId);
      this.onState?.(KEY.device, this.#unitView());
    }
    if (pending.network) this.onState?.(KEY.network, this.#networkView());

    // one patch per key, carrying every channel that changed
    const byKey = new Map();
    for (const [n, keys] of pending.channels) {
      for (const key of keys) {
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(n);
      }
    }
    for (const [key, numbers] of byKey) {
      if (key === 'battery') {
        this.#reportBatteries();
        continue;
      }
      const channels = {};
      for (const n of numbers) {
        const value = this.#channelValue(key, n);
        // a channel with nothing tuned has no frequency to report
        if (value !== null) channels[n] = value;
      }
      if (!Object.keys(channels).length) continue;
      this.onState?.(
        key,
        key === 'meters' ? { timestamp: Date.now(), channels } : { channels },
      );
    }

    if (pending.slots.size) this.#reportSlots(pending.slots);
    if (pending.warnings) this.#reportWarnings();
  }

  #channelValue(key, n) {
    const channel = this.#channel(n);
    switch (key) {
      case 'channelName':
        return channel.name ?? '';
      case 'frequency':
        return channel.frequency ?? null;
      case 'mute':
        return channel.muted === true;
      case 'meters':
        return this.#meters(channel);
      case KEY.tx:
        return this.#txView(channel);
      default:
        return this.#channelView(channel);
    }
  }

  /** NormalizedMeterData: `rf1…rf6` in dBm, `af` in dBFS, `lqi` 0–100. */
  #meters(channel) {
    const out = {};
    if (isNum(channel.audioRms)) out.af = channel.audioRms;
    if (isNum(channel.audioPeak)) out.afPeakLevel = channel.audioPeak;
    // the top LED of the audio meter is the overload lamp
    if (isNum(channel.audioLedBitmap))
      out.afPeak = (channel.audioLedBitmap & 0x80) !== 0;
    // CHAN_QUALITY is 0–5, and Axient Digital only
    if (isNum(channel.quality)) out.lqi = clamp(channel.quality * 20, 0, 100);
    // Antennas in wire order: A, B (then C, D with Quadversity), followed by
    // the second frequency's set on an FD-C channel. NormalizedMeterData has
    // six RF ports, which covers everything but C and D of the second
    // frequency on a channel that is both Quadversity and FD-C.
    channel.antennas.slice(0, 6).forEach((antenna, i) => {
      if (isNum(antenna?.rssi)) out[`rf${i + 1}`] = antenna.rssi;
    });
    const [a, b] = channel.antennas;
    if (a?.status) out.div1 = antennaInUse(a.status);
    if (b?.status) out.div2 = antennaInUse(b.status);
    // the sixth RSSI LED is the red overload lamp
    if (isNum(a?.led)) out.rf1Peak = (a.led & 0x20) !== 0;
    if (isNum(b?.led)) out.rf2Peak = (b.led & 0x20) !== 0;
    return out;
  }

  /** Receiver-channel settings and status: the `x.shure-anx4.channel` value. */
  #channelView(channel) {
    const quadversity = channel.antennaConfig === 'QUADVERSITY';
    const combining = channel.fdMode === 'FD-C';
    return {
      gain: channel.gain ?? null,
      rfBand: channel.rfBand ?? null,
      groupChannel: channel.groupChannel ?? null,
      antennaConfig: channel.antennaConfig ?? null,
      fdMode: channel.fdMode ?? null,
      // FD-C only: the second carrier, and its own group/channel and status
      frequency2: combining ? (channel.frequency2 ?? null) : null,
      groupChannel2: combining ? (channel.groupChannel2 ?? null) : null,
      interference: channel.interference === true,
      interference2: combining && channel.interference2 === true,
      encryptionMode: channel.encryptionMode ?? null,
      encryptionError: channel.encryptionError === true,
      unregisteredTx:
        channel.unregisteredTx === true ||
        (combining && channel.unregisteredTx2 === true),
      identify: channel.flash === true,
      danteChannelName: channel.danteChannelName ?? null,
      // which RF meters the layout shows, and what it calls them
      rfLayout: `${quadversity ? 'QUAD' : 'AB'}${combining ? '_FDC' : ''}`,
    };
  }

  /** The transmitter a channel is receiving: the `x.shure-anx4.tx` value. */
  #txView(channel) {
    const minutes = channel.txBatteryMinutes;
    return {
      present: Boolean(channel.txModel),
      model: channel.txModel ?? null,
      deviceId: channel.txDeviceId ?? null,
      firmware: channel.txFirmware?.replace(/\*$/, '') ?? null,
      batteryType: channel.txBatteryType ?? null,
      batteryBars: channel.txBatteryBars ?? null,
      batteryPercent: channel.txBatteryPercent ?? null,
      batteryMinutes: minutesOf(minutes),
      batteryCalculating: minutes === BATTERY_CALCULATING,
      batteryCycles: channel.txBatteryCycles ?? null,
      batteryHealth: channel.txBatteryHealth ?? null,
      batteryTempC: channel.txBatteryTempC ?? null,
      batteryTempF: channel.txBatteryTempF ?? null,
      inputPad: channel.txInputPad ?? null,
      offset: channel.txOffset ?? null,
      lock: channel.txLock ?? null,
      muteMode: channel.txMuteMode ?? null,
      muteButton: channel.txMuteButton ?? null,
      // muted at the transmitter, by either of the two ways it can be
      muted:
        channel.txMuteMode === 'MUTE' || channel.txMuteButton === 'PRESSED',
      polarity: channel.txPolarity ?? null,
      // mW from an Axient Digital transmitter, LOW/NORMAL/HIGH from a ULX-D one
      powerLevel: channel.txPowerLevel ?? null,
      powerSource: channel.txPowerSource ?? null,
      talkSwitch: channel.txTalkSwitch ?? null,
      // volts; 0 is off
      phantomPower: channel.txPhantomPower ?? null,
      // Hz; 0 is off
      highPassFilter: channel.txHighPassFilter ?? null,
    };
  }

  /**
   * `battery` is device-scoped with replace, so every report carries every
   * channel that has a battery to show.
   */
  #reportBatteries() {
    const channels = {};
    for (const [n, channel] of this.channels) {
      const state = batteryState({
        percent: channel.txBatteryPercent,
        bars: channel.txBatteryBars,
        minutes: channel.txBatteryMinutes,
        type: channel.txBatteryType,
      });
      if (state) channels[n] = state;
    }
    this.onState?.('battery', { channels });
  }

  #unitView() {
    const firmware = this.unit.firmware ?? null;
    return {
      model: this.unit.model ?? null,
      firmware: firmware?.replace(/\*$/, '') ?? null,
      // a trailing asterisk on the version is a failed self test
      selfTestPassed: firmware ? !firmware.endsWith('*') : null,
      transmissionMode: this.unit.transmissionMode ?? null,
      licensedChannels: this.unit.licensedChannels ?? null,
      availableChannels: this.unit.availableChannels ?? [],
      danteDeviceName: this.unit.danteDeviceName ?? null,
      identify: this.unit.flash === true,
    };
  }

  #networkView() {
    const view = {};
    for (const [iface, name] of [
      ['SC', 'control'],
      ['D1', 'dantePrimary'],
      ['D2', 'danteSecondary'],
    ]) {
      const settings = this.network[iface];
      if (!settings) continue;
      const { mode, ip, subnet, gateway, mac } = settings;
      view[name] = { mode, ip, subnet, gateway, mac };
    }
    return view;
  }

  // -------------------------------------------------------------------------
  // transmitter slots
  // -------------------------------------------------------------------------
  //
  // An Axient Digital channel has eight slots a transmitter can be registered
  // in. They are reported as `receivers` entities — the one entity kind the
  // contract opens to plugins — each bound to its channel, so a registered
  // transmitter appears under that channel's card with its own battery and
  // ShowLink reading, and can be addressed by `entityId` in a command.

  #slotEntity(slot) {
    const battery = batteryState({
      percent: slot.batteryPercent,
      bars: slot.batteryBars,
      minutes: slot.batteryMinutes,
      type: slot.batteryType,
    });
    return {
      id: slot.id,
      name: slot.deviceId || `Slot ${slot.slot}`,
      channel: slot.channel,
      slot: slot.slot,
      // EMPTY never gets here; STANDARD is an AD transmitter, LINKED.* an ADX
      status: slot.status,
      // only a linked, online transmitter takes changes from the rack
      active: slot.status === 'LINKED.ACTIVE',
      model: slot.model ?? null,
      battery: battery ?? {},
      // ShowLink signal is 1–5
      meters: isNum(slot.showLink)
        ? { lqi: clamp(slot.showLink * 20, 0, 100) }
        : {},
      batteryType: slot.batteryType ?? null,
      batteryBars: slot.batteryBars ?? null,
      batteryCycles: slot.batteryCycles ?? null,
      batteryHealth: slot.batteryHealth ?? null,
      inputPad: slot.inputPad ?? null,
      offset: slot.offset ?? null,
      polarity: slot.polarity ?? null,
      rfMuted: slot.rfOutput ? slot.rfOutput === 'RF_MUTE' : null,
      rfPower: slot.rfPower ?? null,
      rfPowerMode: slot.rfPowerMode ?? null,
      phantomPower: slot.phantomPower ?? null,
      highPassFilter: slot.highPassFilter ?? null,
      showLink: slot.showLink ?? null,
    };
  }

  #reportSlots(ids) {
    const delta = { added: [], updated: [], removed: [] };
    for (const id of ids) {
      const slot = this.slots.get(id);
      const before = this.announced.get(id);
      const occupied = slot?.status && slot.status !== 'EMPTY';
      if (!occupied) {
        if (before) {
          delta.removed.push(id);
          this.announced.delete(id);
        }
        continue;
      }
      const entity = this.#slotEntity(slot);
      if (!before) {
        delta.added.push(entity);
      } else {
        const changes = {};
        for (const [field, value] of Object.entries(entity)) {
          if (!same(before[field], value)) changes[field] = value;
        }
        if (Object.keys(changes).length) delta.updated.push({ id, changes });
      }
      this.announced.set(id, entity);
    }
    if (delta.added.length || delta.updated.length || delta.removed.length)
      this.onState?.('receivers', delta);
  }

  // -------------------------------------------------------------------------
  // warnings
  // -------------------------------------------------------------------------

  /** The complete current set, every time: a cleared condition just stops being listed. */
  #reportWarnings() {
    const warnings = [];
    if (this.unit.firmware?.endsWith('*')) {
      warnings.push({
        id: 'self-test-failed',
        severity: 'warning',
        message:
          'The ANX4 reports that its power-on self test failed. Restart it, and contact Shure service if this persists.',
      });
    }
    for (const n of [...this.channels.keys()].sort((a, b) => a - b)) {
      const channel = this.channels.get(n);
      const label = channel.name
        ? `Channel ${n} (${channel.name})`
        : `Channel ${n}`;
      const combining = channel.fdMode === 'FD-C';
      if (channel.interference || (combining && channel.interference2)) {
        warnings.push({
          id: `interference-ch${n}`,
          severity: 'warning',
          message: `${label}: the receiver detects interference on its frequency. Move it to a clear frequency.`,
        });
      }
      if (channel.encryptionError) {
        warnings.push({
          id: `encryption-ch${n}`,
          severity: 'warning',
          message: `${label}: encryption mismatch, so there is no audio from this transmitter. Re-sync the transmitter to the channel.`,
        });
      }
      if (channel.unregisteredTx || (combining && channel.unregisteredTx2)) {
        warnings.push({
          id: `unregistered-tx-ch${n}`,
          severity: 'warning',
          message: `${label}: a transmitter that is not registered to this channel is on its frequency. Switch it off or register it.`,
        });
      }
      if (channel.txBatteryMinutes === BATTERY_COMMS_WARNING) {
        warnings.push({
          id: `tx-battery-ch${n}`,
          severity: 'info',
          message: `${label}: the transmitter cannot read its battery. Check the battery contacts.`,
        });
      }
      if (channel.txFirmware?.endsWith('*')) {
        warnings.push({
          id: `tx-firmware-ch${n}`,
          severity: 'info',
          message: `${label}: the transmitter's last firmware update did not complete. Update it again with Shure Update Utility.`,
        });
      }
    }
    if (this.rejected) {
      warnings.push({
        id: 'change-rejected',
        severity: 'info',
        message: `The ANX4 did not accept the last change (${this.rejected}). The value is outside what this unit allows, or the transmitter is not linked and switched on.`,
      });
    }
    this.onWarnings?.(warnings);
  }

  // -------------------------------------------------------------------------
  // PropertyControl
  // -------------------------------------------------------------------------

  #hasChannel(n) {
    const available = this.unit.availableChannels ?? [];
    return !available.length || available.includes(n);
  }

  /**
   * The set of channels changed while connected: a licence was installed, or
   * Quadversity or FD-C eclipsed a channel. `open()` only reports the count
   * once, so say so again, blank what went away, and bring what arrived up
   * to the same state as the rest — its properties, and its metering.
   */
  #channelsChanged(before, after) {
    for (const n of before.filter((b) => !after.includes(b))) {
      for (const id of this.slots.keys()) {
        if (this.slots.get(id).channel !== n) continue;
        this.slots.delete(id);
        this.pending.slots.add(id);
      }
      // an empty channel, reported once, is what clears its card
      this.channels.set(n, { antennas: [] });
      for (const key of ['channelName', 'mute', KEY.channel, KEY.tx, 'battery'])
        this.#mark(n, key);
    }
    this.pending.warnings = true;
    this.#flush();
    for (const n of [...this.channels.keys()])
      if (!after.includes(n)) this.channels.delete(n);

    const count = this.#channelCount();
    if (count !== undefined) this.onState?.('channelCount', count);
    this.client?.send(command('GET', 0, 'ALL'));
    this.client?.send(command('SET', 0, 'METER_RATE', this.meterIntervalMs));
  }

  #channelNumbers() {
    const available = this.unit.availableChannels ?? [];
    return available.length
      ? available
      : [...this.channels.keys()].sort((a, b) => a - b);
  }

  // Channels are addressed by number and the host draws 1…channelCount, so a
  // unit whose channel 8 is eclipsed by Quadversity still reports up to its
  // highest number.
  #channelCount() {
    const numbers = this.#channelNumbers();
    return numbers.length ? Math.max(...numbers) : undefined;
  }

  /** PropertyControl descriptors, in SoundBase's PropertyDescriptor shape. */
  #properties() {
    const property = (scope, id, stateBinding, value) => ({
      id,
      scope,
      access: 'readWrite',
      stateBinding,
      value,
    });
    const name = (maxLength) => ({ type: 'string', minLength: 1, maxLength });
    // a transmitter slot's field, within its `receivers` entity
    const slot = (field) => ({ key: 'receivers', path: [field] });
    return [
      property(
        'channel',
        'channelName',
        { key: 'channelName' },
        name(NAME_MAX),
      ),
      // range and step belong to the RF band fitted, which the protocol
      // names but does not describe; the unit refuses what it cannot tune
      property(
        'channel',
        'frequency',
        { key: 'frequency' },
        {
          type: 'number',
          step: 0.025,
          unit: 'MHz',
        },
      ),
      property('channel', 'mute', { key: 'mute' }, { type: 'boolean' }),
      property(
        'channel',
        'gain',
        { key: KEY.channel, path: ['gain'] },
        {
          type: 'number',
          min: GAIN_MIN_DB,
          max: GAIN_MAX_DB,
          step: 1,
          unit: 'dB',
        },
      ),
      property(
        'channel',
        'groupChannel',
        { key: KEY.channel, path: ['groupChannel'] },
        { type: 'string', pattern: '^[0-9]+,[0-9]+$' },
      ),
      property(
        'channel',
        'identify',
        { key: KEY.channel, path: ['identify'] },
        { type: 'boolean' },
      ),
      property(
        'device',
        'deviceName',
        { key: 'deviceName' },
        name(DEVICE_ID_MAX),
      ),
      property(
        'device',
        'deviceIdentify',
        { key: KEY.device, path: ['identify'] },
        { type: 'boolean' },
      ),
      // a linked, online ADX transmitter, addressed by its slot's entity id
      property('entity', 'txName', slot('name'), name(NAME_MAX)),
      property('entity', 'txOffset', slot('offset'), {
        type: 'number',
        min: OFFSET_MIN_DB,
        max: OFFSET_MAX_DB,
        step: 1,
        unit: 'dB',
      }),
      property('entity', 'txInputPad', slot('inputPad'), {
        type: 'enum',
        options: [...INPUT_PAD_DB],
        unit: 'dB',
      }),
      property('entity', 'txPolarity', slot('polarity'), {
        type: 'enum',
        options: ['POSITIVE', 'NEGATIVE'],
      }),
      property('entity', 'txRfMute', slot('rfMuted'), { type: 'boolean' }),
      property('entity', 'txPowerMode', slot('rfPowerMode'), {
        type: 'enum',
        options: ['LOW', 'NORMAL', 'HIGH'],
      }),
    ];
  }

  /**
   * `{ requestId, propertyId, channelIndex?, entityId?, value }` → a SET.
   *
   * Nothing is reported from here: the ANX4 answers every SET with a REP
   * carrying what it settled on, and that REP is the state update — so a
   * value the unit clamped or refused shows exactly as the unit has it.
   */
  async setProperty({ propertyId, channelIndex, entityId, value }) {
    if (!this.client)
      throw new Error(`${this.host}:${this.port} is not connected`);

    let line;
    let label;
    const perChannel = propertyId in CHANNEL_SETTERS;
    if (
      propertyId in DEVICE_SETTERS &&
      (channelIndex === undefined || !perChannel)
    ) {
      line = command('SET', ...DEVICE_SETTERS[propertyId](value));
      label = propertyId;
    } else if (propertyId in ENTITY_SETTERS) {
      const slot = this.announced.get(entityId);
      if (!slot) {
        throw new HttpError(
          400,
          'unknown_entity',
          `${propertyId} belongs to a registered transmitter, and this ANX4 has none with the id ${entityId}`,
        );
      }
      const [wireProperty, ...args] = ENTITY_SETTERS[propertyId](value);
      line = command('SET', slot.channel, wireProperty, slot.slot, ...args);
      label = `${propertyId} on ${slot.name}, channel ${slot.channel}`;
    } else if (perChannel) {
      const numbers = this.#channelNumbers();
      if (!numbers.includes(channelIndex)) {
        throw new HttpError(
          400,
          'unknown_channel',
          `${propertyId} is per channel; this ANX4 has channels ${numbers.join(', ') || '(none)'}`,
        );
      }
      line = command(
        'SET',
        channelIndex,
        ...CHANNEL_SETTERS[propertyId](value),
      );
      label = `${propertyId} on channel ${channelIndex}`;
    } else {
      throw new HttpError(
        400,
        'unknown_property',
        `No property ${propertyId} on ${PRODUCT}`,
      );
    }

    this.lastSet = { label, at: Date.now() };
    this.client.send(line);
  }
}

// Each setter turns a value into the tail of a SET, clamping to what the
// documented range allows and throwing only for a value of the wrong type.

const nameArg = (propertyId, value, max) => {
  if (typeof value !== 'string') throw badValue(propertyId, 'a string');
  const name = sanitizeName(value, max);
  if (!name)
    throw badValue(propertyId, 'at least one character the ANX4 accepts');
  return braced(name);
};
const onOff = (value) => (value ? 'ON' : 'OFF');
const oneOf = (propertyId, value, options) => {
  const choice = String(value).toUpperCase();
  if (!options.includes(choice))
    throw badValue(propertyId, `one of ${options.join(', ')}`);
  return choice;
};
const decibels = (propertyId, value, min, max) => {
  if (!isNum(value)) throw badValue(propertyId, 'a number in dB');
  return clamp(Math.round(value), min, max);
};

const CHANNEL_SETTERS = {
  channelName: (value) => [
    'CHAN_NAME',
    nameArg('channelName', value, NAME_MAX),
  ],
  frequency: (value) => {
    if (!isNum(value) || value <= 0)
      throw badValue('frequency', 'a number in MHz');
    // the wire is whole kHz
    return ['FREQUENCY', Math.round(value * 1000)];
  },
  mute: (value) => ['AUDIO_MUTE', onOff(value)],
  gain: (value) => [
    'AUDIO_GAIN',
    decibels('gain', value, GAIN_MIN_DB, GAIN_MAX_DB) - GAIN_MIN_DB,
  ],
  groupChannel: (value) => {
    const match = /^\s*(\d+)\s*,\s*(\d+)\s*$/.exec(
      typeof value === 'string' ? value : '',
    );
    if (!match)
      throw badValue('groupChannel', 'a "group,channel" pair such as "6,100"');
    return ['GROUP_CHANNEL', braced(`${match[1]},${match[2]}`)];
  },
  identify: (value) => ['FLASH', onOff(value)],
};

const DEVICE_SETTERS = {
  deviceName: (value) => [
    'DEVICE_ID',
    nameArg('deviceName', value, DEVICE_ID_MAX),
  ],
  deviceIdentify: (value) => ['FLASH', onOff(value)],
  // `identify` with no channel is the whole unit
  identify: (value) => ['FLASH', onOff(value)],
};

const ENTITY_SETTERS = {
  txName: (value) => ['SLOT_TX_DEVICE_ID', nameArg('txName', value, NAME_MAX)],
  txOffset: (value) => [
    'SLOT_OFFSET',
    decibels('txOffset', value, OFFSET_MIN_DB, OFFSET_MAX_DB) - OFFSET_MIN_DB,
  ],
  txInputPad: (value) => {
    if (!isNum(value)) throw badValue('txInputPad', 'a number in dB');
    return ['SLOT_INPUT_PAD', nearest(value, INPUT_PAD_DB) + 12];
  },
  txPolarity: (value) => [
    'SLOT_POLARITY',
    oneOf('txPolarity', value, ['POSITIVE', 'NEGATIVE']),
  ],
  txRfMute: (value) => ['SLOT_RF_OUTPUT', value ? 'RF_MUTE' : 'RF_ON'],
  txPowerMode: (value) => [
    'SLOT_RF_POWER_MODE',
    oneOf('txPowerMode', value, ['LOW', 'NORMAL', 'HIGH']),
  ],
};

export function createMonitoringAdapter(device, pluginConfig) {
  return new Anx4Adapter(device, pluginConfig);
}
