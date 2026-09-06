import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { log } from "./log.js";

/**
 * One `upgrade` listener per server, shared by everything that wants a WebSocket path.
 *
 * Node runs every 'upgrade' listener, so two independent handlers cannot each answer "not
 * mine" by closing the socket -- the first one to decide destroys a socket the second was
 * going to claim. A handler here returns true when it has taken responsibility for the
 * socket (upgraded it, or refused it explicitly); the router closes whatever nobody claims,
 * so an unrouted upgrade still cannot be parked forever against the fd limit.
 */
export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;

const registered = new WeakMap<Server, UpgradeHandler[]>();

export function onUpgrade(server: Server, handler: UpgradeHandler): void {
  const existing = registered.get(server);
  if (existing) {
    existing.push(handler);
    return;
  }
  const handlers: UpgradeHandler[] = [handler];
  registered.set(server, handlers);
  server.on("upgrade", (req, socket, head) => {
    for (const h of handlers) {
      try {
        if (h(req, socket, head)) return;
      } catch (e) {
        log.warn("upgrade handler failed", { error: (e as Error).message });
        socket.destroy();
        return;
      }
    }
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
  });
}
