export class SeededRandom {
  private state: number;

  constructor(seed = 1) {
    this.state = (seed >>> 0) || 1;
  }

  next(): number {
    this.state = (1664525 * this.state + 1013904223) >>> 0;
    return this.state / 0x100000000;
  }

  centered(amplitude: number): number {
    return (this.next() - 0.5) * amplitude * 2;
  }
}
