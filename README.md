# Shure ANX4 — SoundBase plugin

Brings a Shure ANX4 wireless receiver into SoundBase's device monitoring:
every channel's name, frequency, audio and RF meters, the transmitter it is
receiving and that transmitter's battery, with the controls the receiver
offers over the network.

It talks to the receiver over Shure's
[command strings](https://www.shure.com/en-US/docs/commandstrings/ANX4), on
TCP port 2202.

> **Built from the published protocol, not against hardware.** No ANX4 was
> attached while this was written. Everything is exercised against
> `driver/fake-anx4.js`, which follows Shure's document; the first run
> against a real receiver is still to be done.

## Setting up

1. On the ANX4, turn command strings on: **Device Configuration > Network
   Services**. With them off the receiver refuses the connection.
2. In SoundBase, either add an ANX4 by its IP address, or list addresses in
   the plugin's **ANX4 addresses** setting and pick the receivers it finds.

```sh
npm install
npm run doctor      # is everything wired up?
npm test            # the whole stack, against the fake receiver
npm run smoke       # boots main.js as a child process, as the host does
```

To try it in SoundBase Desktop with no receiver, run the fake and point the
plugin at it:

```sh
npm run fake                                   # a four-channel ANX4 on 127.0.0.1:2202
# SB_PLUGIN_DIRS is the folder that *contains* this checkout
SB_PLUGIN_DIRS="$(dirname "$PWD")" open -a "SoundBase Desktop"
# then set "ANX4 addresses" to 127.0.0.1
```

[docs/running-in-soundbase.md](docs/running-in-soundbase.md) covers the plugin
manager and the logs.

## What it reports

Per channel:

| | |
|---|---|
| Name, frequency, mute | core state keys `channelName`, `frequency`, `mute` |
| Meters | audio RMS and peak (dBFS), overload lamp, RSSI per antenna (dBm), channel quality, which antennas are in use |
| Battery | percent, runtime, charging — bars stand in for percent on primary cells |
| Receiver channel | gain, RF band, group/channel, antenna configuration, frequency diversity mode and its second frequency, encryption mode, interference, encryption mismatch, unregistered transmitter, Dante channel name, identify |
| Transmitter | model, name, firmware, power level and source, offset, input pad, mute mode and button, talk switch, lock, polarity, high-pass filter, phantom power, battery type, bars, health, cycles, temperature |

Per registered transmitter (the eight slots of an Axient Digital channel):
status, model, name, battery, ShowLink signal, RF power and mode, RF mute,
offset, input pad, polarity, phantom power, high-pass filter.

Per device: Device ID, model, firmware and self-test result, transmission
mode, licensed and available channels, Dante device name, and the network
settings of the Shure Control and Dante interfaces.

Metering covers Quadversity (four antennas) and FD-C (a second frequency's
antennas) as well as the standard two.

## What it controls

| Property | Scope | |
|---|---|---|
| `channelName` | channel | 8 characters |
| `frequency` | channel | MHz |
| `mute` | channel | audio output mute |
| `gain` | channel | −18…+42 dB |
| `groupChannel` | channel | `"group,channel"`; the receiver reports the frequency it implies |
| `identify` | channel, or device when sent with no channel | flashes the front panel |
| `deviceName` | device | the Device ID, 31 characters |
| `deviceIdentify` | device | |
| `txName` | transmitter | 8 characters |
| `txOffset` | transmitter | −12…+21 dB |
| `txInputPad` | transmitter | −12, 0 or +12 dB |
| `txPolarity` | transmitter | `POSITIVE`, `NEGATIVE` |
| `txRfMute` | transmitter | |
| `txPowerMode` | transmitter | `LOW`, `NORMAL`, `HIGH` |

Transmitter properties need an ADX transmitter that is linked and switched on
— the receiver refuses them otherwise. A refusal shows as a warning on the
device for a few seconds, because the receiver's `REP ERR` is the only
feedback there is.

## Warnings

Raised on the device, and cleared when the condition does: interference on a
channel, encryption mismatch, an unregistered transmitter on a channel's
frequency, a transmitter that cannot read its battery, an incomplete
transmitter firmware update, a failed receiver self test, and a change the
receiver did not accept.

## What it does not do

- **Spectrum.** The command strings have no scan or sweep command, so there is
  no spectrum-analyzer adapter and nothing appears in the live-scan picker.
- **Change network settings.** They are shown, not written: changing the
  control address would leave the address saved in the project pointing at
  nothing, and changing a Dante interface reboots the receiver.
- **Find receivers by itself.** The protocol has no broadcast discovery;
  addresses are typed in.

## How state is keyed

A core state key is used wherever the contract documents the value's shape:
`channelName`, `frequency`, `mute`, `meters`, `battery`, `deviceName`,
`connection`, `receivers`. One exception: `channelCount` is sent as a plain
number when the receiver's set of channels changes while connected (a licence,
or a channel eclipsed by Quadversity or FD-C); the contract lists the key but
not its shape. Everything else travels under four extension keys
declared in the manifest and bound by its layout:

| Key | Scope | Carries |
|---|---|---|
| `x.shure-anx4.channel` | channel | receiver-channel settings and status |
| `x.shure-anx4.tx` | channel | the transmitter the channel is receiving |
| `x.shure-anx4.device` | device | identity, licence, transmission mode |
| `x.shure-anx4.network` | device | control and Dante interfaces |

SoundBase has core keys that look like homes for some of this (`gain`,
`groupChannel`, `fdMode`, `band`, `transmitterInfo`, `slotProperties`, …), but
`channel-monitoring.openapi.yaml` does not give their value shapes, so they
are not used. Moving a field onto one is a change to `#channelValue` in
`adapter.js` and one line of the manifest.

Registered transmitters are reported as `receivers` entities, each bound to
its channel. That is the only entity kind the contract opens to plugins; the
name fits an IEM's bodypacks better than a receiver's transmitters, but it is
what lets a slot appear under its channel and be addressed by `entityId`.

## Layout

```
soundbase-plugin.json   identity, the ANX4 product and its layout, config fields
main.js                 shell bootstrap — never edit
adapter.js              the ANX4 as SoundBase state: reports in, SETs out
driver/protocol.js      the wire: framing, encoding, decoding, offsets
driver/anx4-client.js   the TCP connection, its watchdog, and the discovery probe
driver/fake-anx4.js     a fake receiver for tests and for trying the plugin by hand
driver/protocol.md      how Shure's document was read, and where it bites
__tests__/              the codec on its own, and the plugin through the real shell
```

`examples/network-analyzer/` and `docs/` are the SoundBase plugin template's
own worked example and guide set, kept for reference.

## Scripts

| | |
|---|---|
| `npm start` | run the plugin |
| `npm run fake [port]` | run the fake ANX4 on loopback (default port 2202) |
| `npm test` | the codec, and the plugin through the real shell |
| `npm run doctor` | is this plugin well-formed? |
| `npm run smoke` | boot as a child process and handshake — what the host does |
| `npm run manifest` | validate `soundbase-plugin.json` against the contract schema |
| `npm run pack:release` | build the zip users install, and boot-check it |
| `npm run bump <x.y.z>` | move the version in every file that carries it |

## Licence

Business Source License 1.1 — see `LICENSE`. Shure, Axient and ANX4 are
trademarks of Shure Incorporated; this plugin is not affiliated with or
endorsed by Shure.
