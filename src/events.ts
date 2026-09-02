import { EventEmitter } from "node:events";

export type TallyEvent = {
  type: string;
  at: string;
  browserId?: string;
  payload: Record<string, unknown>;
};

class Hub extends EventEmitter {
  emitEvent(type: string, payload: Record<string, unknown> = {}, browserId?: string): TallyEvent {
    const ev: TallyEvent = { type, at: new Date().toISOString(), browserId, payload };
    this.emit("event", ev);
    if (browserId) this.emit(`browser:${browserId}`, ev);
    return ev;
  }
}

export const hub = new Hub();
hub.setMaxListeners(200);
