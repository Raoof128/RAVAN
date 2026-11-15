import { statfs } from "node:fs/promises";
export class StorageBudget {
  private held = 0n;
  constructor(
    private directory: string,
    private max: bigint,
    private reserve: bigint,
    private used: () => bigint,
  ) {}
  async reserveBytes(_pool: "source" | "output", bytes: bigint) {
    if (bytes < 0n) throw new Error("Invalid reservation");
    const disk = await statfs(this.directory, { bigint: true });
    // No await between testing and reserving: admissions are atomic in this process.
    if (
      this.used() + this.held + bytes > this.max ||
      disk.bavail * disk.bsize - this.held - bytes < this.reserve
    )
      throw new Error("Storage budget exhausted");
    this.held += bytes;
    let released = false;
    return {
      release: async () => {
        if (!released) {
          released = true;
          this.held -= bytes;
        }
      },
    };
  }
}
