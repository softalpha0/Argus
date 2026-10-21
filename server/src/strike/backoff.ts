export class Backoff {
  private attempt = 0;
  constructor(private readonly minMs = 1000, private readonly maxMs = 30_000) {}

  /** Next delay with full jitter on the upper half. */
  next(): number {
    const base = Math.min(this.maxMs, this.minMs * 2 ** this.attempt);
    this.attempt++;
    return Math.round(base / 2 + Math.random() * (base / 2));
  }

  reset(): void {
    this.attempt = 0;
  }
}
