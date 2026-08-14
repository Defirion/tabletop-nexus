import { createServer } from "node:net";

export const PRIVATE_GAME_HOST = "127.0.0.1";

function listenOnEphemeralPort(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("private port probe did not bind a TCP port")));
        return;
      }
      resolve(address.port);
    };
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: PRIVATE_GAME_HOST, port: 0, exclusive: true });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function createPrivatePortProbe() {
  const server = createServer();
  const port = await listenOnEphemeralPort(server);
  return {
    port,
    close: () => closeServer(server),
  };
}

/**
 * Allocates loopback-only ports for one Nexus supervisor process.
 *
 * The OS probe is closed before a lease is returned so the game process can bind
 * the selected port. The live lease remains claimed inside this allocator until
 * release(), preventing Nexus from assigning the same port to two games at once.
 * External processes can still race the later game bind, so process startup must
 * treat bind failure as a startup failure when spawning is implemented.
 */
export class PrivatePortAllocator {
  #claimedPorts = new Set();
  #createProbe;

  constructor({ createProbe = createPrivatePortProbe } = {}) {
    if (typeof createProbe !== "function") {
      throw new TypeError("createProbe must be a function");
    }
    this.#createProbe = createProbe;
  }

  async allocate() {
    while (true) {
      const probe = await this.#createProbe();
      const { port } = probe;

      if (this.#claimedPorts.has(port)) {
        await probe.close();
        continue;
      }

      this.#claimedPorts.add(port);
      try {
        await probe.close();
      } catch (error) {
        this.#claimedPorts.delete(port);
        throw error;
      }

      let active = true;
      return Object.freeze({
        host: PRIVATE_GAME_HOST,
        port,
        release: () => {
          if (!active) {
            return false;
          }
          active = false;
          return this.#claimedPorts.delete(port);
        },
      });
    }
  }
}
