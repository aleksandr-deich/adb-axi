import { StringDecoder } from "node:string_decoder";
import type { Crash } from "../../android/crash.js";
import { FullOutputFile } from "../../core/truncate.js";

interface RecordEntry {
  crash: Crash;
  order: number;
  trace: number | null;
}

const compare = (a: RecordEntry, b: RecordEntry): number =>
  a.crash.epochMs - b.crash.epochMs || a.order - b.order;

export class CrashSpool {
  private readonly traces: FullOutputFile | undefined;
  private readonly active = new Map<number, { first: number; last: number }>();
  private readonly runs: (FullOutputFile | undefined)[] = [];
  private pending: RecordEntry[] = [];
  private pendingBytes = 0;

  constructor(full: boolean) {
    this.traces = full ? new FullOutputFile("crash-traces") : undefined;
  }

  line(order: number, message: string): void {
    if (this.traces === undefined) return;
    const body = Buffer.from(`${message}\n`);
    const position = this.traces.size;
    const header = Buffer.alloc(12);
    header.writeBigInt64BE(-1n);
    header.writeUInt32BE(body.length, 8);
    this.traces.write(header);
    this.traces.write(body);
    const block = this.active.get(order);
    if (block === undefined) this.active.set(order, { first: position, last: position });
    else {
      const next = Buffer.alloc(8);
      next.writeBigInt64BE(BigInt(position));
      this.traces.writeAt(block.last, next);
      block.last = position;
    }
  }

  report(order: number, crash: Crash | null): void {
    const trace = this.active.get(order)?.first ?? null;
    this.active.delete(order);
    if (crash === null) return;
    const entry = { order, crash: { ...crash, trace: [] }, trace };
    this.pending.push(entry);
    this.pendingBytes += Buffer.byteLength(JSON.stringify(entry));
    if (this.pendingBytes >= 4 * 1024 * 1024) this.flush();
  }

  *reports(): Iterable<RecordEntry> {
    this.flush();
    let merged: FullOutputFile | undefined;
    for (let level = 0; level < this.runs.length; level++) {
      const run = this.runs[level];
      if (run === undefined) continue;
      this.runs[level] = undefined;
      if (merged === undefined) merged = run;
      else merged = this.merge(merged, run);
      this.runs[level] = merged;
      for (let previous = 0; previous < level; previous++) this.runs[previous] = undefined;
    }
    if (merged !== undefined) yield* records(merged);
  }

  writeTrace(entry: RecordEntry, output: FullOutputFile): void {
    if (this.traces === undefined) return;
    let position = entry.trace;
    while (position !== null) {
      const header = this.traces.readAt(position, 12);
      output.write(this.traces.readAt(position + 12, header.readUInt32BE(8)));
      const next = header.readBigInt64BE();
      position = next < 0n ? null : Number(next);
    }
  }

  discard(): void {
    this.traces?.discard();
    for (const run of this.runs) run?.discard();
  }

  private flush(): void {
    if (this.pending.length === 0) return;
    let run = new FullOutputFile("crash-index");
    try {
      this.pending.sort(compare);
      for (const entry of this.pending) run.write(`${JSON.stringify(entry)}\n`);
      this.pending = [];
      this.pendingBytes = 0;
      let level = 0;
      for (;;) {
        const previous = this.runs[level];
        if (previous === undefined) {
          this.runs[level] = run;
          return;
        }
        run = this.merge(previous, run);
        this.runs[level++] = undefined;
      }
    } catch (error) {
      run.discard();
      throw error;
    }
  }

  private merge(left: FullOutputFile, right: FullOutputFile): FullOutputFile {
    const output = new FullOutputFile("crash-index");
    try {
      const a = records(left);
      const b = records(right);
      let x = a.next();
      let y = b.next();
      while (!x.done || !y.done) {
        if (y.done || (!x.done && compare(x.value, y.value) <= 0)) {
          output.write(`${JSON.stringify(x.value)}\n`);
          x = a.next();
        } else {
          output.write(`${JSON.stringify(y.value)}\n`);
          y = b.next();
        }
      }
      return output;
    } catch (error) {
      output.discard();
      throw error;
    } finally {
      left.discard();
      right.discard();
    }
  }
}

function* records(file: FullOutputFile): Generator<RecordEntry> {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  for (const chunk of file.chunks()) {
    pending += decoder.write(chunk);
    let end;
    while ((end = pending.indexOf("\n")) >= 0) {
      yield JSON.parse(pending.slice(0, end)) as RecordEntry;
      pending = pending.slice(end + 1);
    }
  }
}
