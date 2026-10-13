// A TCP client for the ANX4's command-string port.
//
// Unlike a request/reply instrument, the ANX4 talks whenever it likes: every
// property change arrives as an unprompted REP, and metering arrives as a
// stream of SAMPLEs. So this client does not pair replies with commands — it
// writes lines and hands every decoded message to `onMessage`.

import net from 'node:net';
import { DEFAULT_PORT, MessageFramer, command, decode } from './protocol.js';

const CONNECT_TIMEOUT_MS = 3_000;
// A unit that loses power does not close its socket. With metering on there
// is traffic several times a second; with it off there may be none for
// minutes, so after a quiet spell ask for something and expect an answer.
const IDLE_PROBE_MS = 5_000;
const IDLE_DEAD_MS = 15_000;

export class Anx4Client {
  #socket = null;
  #framer = new MessageFramer();
  #watchdog = null;
  #dead = false;

  constructor({ host, port = DEFAULT_PORT }) {
    this.host = host;
    this.port = port;
    this.lastReceivedAt = 0;
    /** called with every decoded message; see protocol.js `decode` */
    this.onMessage = null;
    /** called once when the transport dies unprompted */
    this.onFatal = null;
  }

  get address() {
    return `${this.host}:${this.port}`;
  }

  async connect(timeoutMs = CONNECT_TIMEOUT_MS) {
    this.#socket = await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          new Error(
            `No ANX4 answered at ${this.address} within ${timeoutMs / 1000}s. ` +
              'Check the address and that this computer is on the Shure Control network.',
          ),
        );
      }, timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.setNoDelay(true);
        socket.setKeepAlive(true, IDLE_PROBE_MS);
        resolve(socket);
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(
          err.code === 'ECONNREFUSED'
            ? new Error(
                `${this.address} refused the connection. Check the address, and that ` +
                  'command strings are turned on in the ANX4: Device Configuration > Network Services.',
              )
            : new Error(`Could not reach ${this.address}: ${err.message}`),
        );
      });
    });

    this.lastReceivedAt = Date.now();
    this.#socket.setEncoding('latin1');
    this.#socket.on('data', (chunk) => this.#consume(chunk));
    this.#socket.on('error', (err) =>
      this.#die(
        new Error(`Connection to ${this.address} failed: ${err.message}`),
      ),
    );
    this.#socket.on('close', () =>
      this.#die(new Error(`The ANX4 at ${this.address} closed the connection`)),
    );

    this.#watchdog = setInterval(() => this.#checkIdle(), IDLE_PROBE_MS / 2);
    this.#watchdog.unref?.();
  }

  #consume(chunk) {
    this.lastReceivedAt = Date.now();
    for (const body of this.#framer.push(chunk)) {
      const message = decode(body);
      if (message) this.onMessage?.(message);
    }
  }

  #checkIdle() {
    const idle = Date.now() - this.lastReceivedAt;
    if (idle >= IDLE_DEAD_MS) {
      this.#die(
        new Error(
          `The ANX4 at ${this.address} stopped responding. Check its power and network cable.`,
        ),
      );
    } else if (idle >= IDLE_PROBE_MS) {
      this.send(command('GET', 'MODEL'));
    }
  }

  #die(reason) {
    if (this.#dead) return;
    this.#dead = true;
    const notify = this.onFatal;
    this.close();
    notify?.(reason);
  }

  /** Write one command. A dead socket drops it; `onFatal` has said why. */
  send(line) {
    if (!this.#socket || this.#socket.destroyed) return false;
    // the angle brackets are the framing; the protocol has no line terminator
    this.#socket.write(line, 'latin1');
    return true;
  }

  close() {
    this.#dead = true; // a close we asked for is not a fatal error
    this.onFatal = null;
    this.onMessage = null;
    clearInterval(this.#watchdog);
    this.#watchdog = null;
    this.#socket?.destroy();
    this.#socket = null;
  }
}

/**
 * Is there an ANX4 at this address? Used by discovery, so it is quick and
 * never throws — an address that does not answer is simply an address with
 * nothing on it. Resolves `{ model, deviceId }` or null.
 */
export async function probe({ host, port = DEFAULT_PORT, timeoutMs = 1_500 }) {
  const client = new Anx4Client({ host, port });
  try {
    await client.connect(timeoutMs);
    return await new Promise((resolve) => {
      const identity = {};
      const timer = setTimeout(
        () => resolve(identity.model ? identity : null),
        timeoutMs,
      );
      client.onFatal = () => {
        clearTimeout(timer);
        resolve(null);
      };
      client.onMessage = (message) => {
        if (message.kind !== 'device') return;
        if (message.field === 'model') identity.model = message.value;
        if (message.field === 'deviceId') identity.deviceId = message.value;
        if (identity.model && 'deviceId' in identity) {
          clearTimeout(timer);
          resolve(identity);
        }
      };
      client.send(command('GET', 'MODEL'));
      client.send(command('GET', 'DEVICE_ID'));
    });
  } catch {
    return null;
  } finally {
    client.close();
  }
}
