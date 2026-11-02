import { Injectable } from "@nestjs/common";
import { EventEmitter } from "node:events";
/** Process-local fan-out; payloads are read with each subscriber's authorization. */
@Injectable()
export class StudyEventsService {
  private readonly events = new EventEmitter();
  constructor() {
    this.events.setMaxListeners(0);
  }
  publish(projectId: string) {
    this.events.emit(projectId);
  }
  subscribe(projectId: string, listener: () => void) {
    this.events.on(projectId, listener);
    return () => {
      this.events.off(projectId, listener);
    };
  }
}
