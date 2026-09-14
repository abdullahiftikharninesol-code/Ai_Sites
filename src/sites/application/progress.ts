import type { JobId, SiteId } from "../../shared/types.js";
import type { WorkflowState } from "../domain/workflow.js";

export interface SiteProgressEvent {
  readonly jobId: JobId;
  readonly siteId: SiteId;
  readonly state: WorkflowState;
  readonly progress: number;
  readonly message: string;
  readonly timestamp: Date;
}
export interface SiteProgressPublisher {
  publish(event: SiteProgressEvent): void;
}
export type SiteProgressListener = (event: SiteProgressEvent) => void;

export class InMemoryProgressBus implements SiteProgressPublisher {
  readonly #listeners = new Set<SiteProgressListener>();
  readonly events: SiteProgressEvent[] = [];
  subscribe(listener: SiteProgressListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  publish(event: SiteProgressEvent): void {
    this.events.push(event);
    for (const listener of this.#listeners) listener(event);
  }
}
