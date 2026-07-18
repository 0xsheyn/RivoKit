/**
 * Event store APPEND-ONLY untuk webhook masuk (`webhook_events`).
 * Wajib: verifikasi signature, idempotensi konsumen, toleransi out-of-order
 * (Register C2, PRD FR-WHK-3).
 */
export interface WebhookEvent {
  readonly id: string;
  readonly source: "circle" | "stablefx" | "cpn";
  readonly type: string;
  readonly payload: unknown;
  readonly sigValid: boolean;
  readonly processed: boolean;
}

export interface EventStore {
  append(event: WebhookEvent): Promise<void>;
  markProcessed(id: string): Promise<void>;
}
