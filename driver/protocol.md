# The ANX4 command-string protocol, as this driver uses it

Source: <https://www.shure.com/en-US/docs/commandstrings/ANX4>. That document
is the reference; this page records how it was read and where it is easy to
get wrong. No ANX4 was attached while this driver was written — everything
below was built from the document and exercised against `fake-anx4.js`.

## Transport

TCP, port **2202**, ASCII. Command strings must be turned on in the receiver:
**Device Configuration > Network Services**. With them off the port refuses
the connection.

Messages are framed by `< ` and ` >` and nothing else — there is no line
terminator. Four types:

| | |
|---|---|
| `< GET x PROPERTY >` | ask for a property |
| `< SET x PROPERTY value >` | change one |
| `< REP x PROPERTY value >` | the answer to either, **and** what the receiver sends unprompted whenever the value changes |
| `< SAMPLE x ALL … >` | one metering sample |

`x` is the channel, 1–24 (1–16 in ULX-D transmission mode). `0` means every
channel. Device-level properties have no `x` at all.

Because every change is REPorted unprompted, the driver never polls. It sends
`< GET 0 ALL >` once on connect and then listens.

## Things that are easy to get wrong

- **Strings travel in braces and are padded**: `{Lead Vox                       }`.
  The allowed characters include `<` and `>`, so a `>` inside braces does not
  end the message. Braces and `|` are not in the set.
- **`SET` takes 8 characters of name**, though `REP` pads to 31.
- **Numbers are fixed-width and zero-padded**, and several carry an offset:

  | Property | Wire | Meaning |
  |---|---|---|
  | `AUDIO_GAIN` | `000`–`060` | −18…+42 dB (subtract 18) |
  | `AUDIO_LEVEL_PEAK`, `AUDIO_LEVEL_RMS` | `000`–`120` | −120…0 dBFS (subtract 120) |
  | `RSSI` | `000`–`120` | −120…0 dBm (subtract 120) |
  | `TX_OFFSET`, `SLOT_OFFSET` | `000`–`033` | −12…+21 dB (subtract 12) |
  | `TX_INPUT_PAD`, `SLOT_INPUT_PAD` | `000`, `012`, `024` | −12, 0, +12 dB (subtract 12) |
  | `TX_BATT_TEMP_C`, `TX_BATT_TEMP_F` | `000`–`254` | subtract 40 |
  | `FREQUENCY` | `0578350` | kHz |

- **"Unknown" has many spellings**: `255`, `65535`, `UNKNOWN`, `UNKN`, or a
  string of spaces. `protocol.js` turns all of them into `null`.
- **`TX_BATT_MINS` has two states above its range**: `65533` is a battery
  communication warning and `65534` is "calculating".
- **`TX_POWER_LEVEL` changes type**: mW from an Axient Digital transmitter
  (`010`), a word from a ULX-D one (`NORMAL`).
- **`FREQUENCY` and `GROUP_CHANNEL` report each other.** Setting a frequency
  reverts the group/channel to `--,--` and REPorts both; setting a
  group/channel REPorts the frequency it implies.
- **`< REP ERR >` names nothing.** It is the answer to any command the receiver
  will not carry out, and it does not say which. The adapter attributes it to
  the SET sent just before it.
- **`NET_SETTINGS` is never REPorted unprompted** and is not part of `ALL`; it
  has to be asked for by interface (`SC`, `D1`, `D2`).
- **Metering is off until asked for.** `< SET 0 METER_RATE 00100 >` starts a
  `SAMPLE` every 100 ms per channel; 100 ms is the fastest it goes.

## `SAMPLE`

```
< SAMPLE ch ALL qual audBitmap audPeak audRms antStats (rfBitmap rfRssi)… >
< SAMPLE 1 ALL 005 031 102 102 BB 31 086 31 065 >
```

The tail describes itself. `antStats` is one letter per antenna (`B` blue,
`R` red, `X` off) and is followed by that many bitmap/RSSI pairs: two
normally, four with Quadversity. An FD-C channel appends a second complete
group for its second frequency. So there are four shapes, and one parser
reads all of them by counting the letters.

## Transmitter slots

Axient Digital channels only. Each channel has eight slots a transmitter can
be registered in; `< GET x SLOT_STATUS z >` with `z` = 1–8, or 0 for all.

| `SLOT_STATUS` | |
|---|---|
| `EMPTY` | nothing registered |
| `STANDARD` | an AD transmitter; model and name are readable, nothing is settable |
| `LINKED.INACTIVE` | an ADX transmitter that is not online |
| `LINKED.ACTIVE` | an ADX transmitter that is online — the only state in which `SET` works |

A `SET` on a slot in any other state answers `< REP ERR >`.

## Not used

- `SET NET_SETTINGS`. Changing the control address drops the connection and
  leaves the address stored in the SoundBase project pointing at nothing;
  changing a Dante interface reboots the receiver. The settings are read and
  shown, not written.
- `INC` / `DEC` forms of `AUDIO_GAIN` and `SLOT_OFFSET`. The adapter sets
  absolute values.
- `AUDIO_MUTE TOGGLE`, for the same reason.
