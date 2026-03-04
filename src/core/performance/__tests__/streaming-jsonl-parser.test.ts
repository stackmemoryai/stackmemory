import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StreamingJSONLParser } from '../streaming-jsonl-parser.js';

describe('StreamingJSONLParser', () => {
  let tmpDir: string;
  let parser: StreamingJSONLParser;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-test-'));
    parser = new StreamingJSONLParser();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeJsonl(name: string, lines: unknown[]): string {
    const fp = path.join(tmpDir, name);
    fs.writeFileSync(fp, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return fp;
  }

  describe('parseAll', () => {
    it('parses all lines from a JSONL file', async () => {
      const fp = writeJsonl('basic.jsonl', [
        { id: 1, name: 'a' },
        { id: 2, name: 'b' },
        { id: 3, name: 'c' },
      ]);

      const result = await parser.parseAll(fp);
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ id: 1, name: 'a' });
    });

    it('skips invalid JSON lines', async () => {
      const fp = path.join(tmpDir, 'bad.jsonl');
      fs.writeFileSync(fp, '{"ok":true}\nnot json\n{"ok":false}\n');

      const result = await parser.parseAll(fp);
      expect(result).toHaveLength(2);
    });

    it('skips empty lines', async () => {
      const fp = path.join(tmpDir, 'empty.jsonl');
      fs.writeFileSync(fp, '{"a":1}\n\n\n{"b":2}\n');

      const result = await parser.parseAll(fp);
      expect(result).toHaveLength(2);
    });

    it('applies filter', async () => {
      const fp = writeJsonl('filter.jsonl', [
        { type: 'error', msg: 'bad' },
        { type: 'info', msg: 'ok' },
        { type: 'error', msg: 'worse' },
      ]);

      const result = await parser.parseAll(fp, {
        filter: (obj) => obj.type === 'error',
      });
      expect(result).toHaveLength(2);
    });

    it('applies transform', async () => {
      const fp = writeJsonl('transform.jsonl', [{ x: 1 }, { x: 2 }]);

      const result = await parser.parseAll(fp, {
        transform: (obj) => ({ ...obj, doubled: obj.x * 2 }),
      });
      expect(result[0]).toEqual({ x: 1, doubled: 2 });
      expect(result[1]).toEqual({ x: 2, doubled: 4 });
    });
  });

  describe('parseStream', () => {
    it('yields batches of specified size', async () => {
      const lines = Array.from({ length: 10 }, (_, i) => ({ i }));
      const fp = writeJsonl('batch.jsonl', lines);

      const batches: unknown[][] = [];
      for await (const batch of parser.parseStream(fp, { batchSize: 3 })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(4); // 3+3+3+1
      expect(batches[0]).toHaveLength(3);
      expect(batches[3]).toHaveLength(1);
    });

    it('calls onProgress callback', async () => {
      const fp = writeJsonl('progress.jsonl', [{ a: 1 }, { a: 2 }, { a: 3 }]);
      const progressCalls: number[] = [];

      const results: unknown[] = [];
      for await (const batch of parser.parseStream(fp, {
        batchSize: 2,
        onProgress: (n) => progressCalls.push(n),
      })) {
        results.push(...batch);
      }

      expect(results).toHaveLength(3);
      expect(progressCalls.length).toBeGreaterThan(0);
    });

    it('skips oversized lines', async () => {
      const fp = path.join(tmpDir, 'oversized.jsonl');
      const bigLine = JSON.stringify({ data: 'x'.repeat(200) });
      const smallLine = JSON.stringify({ data: 'ok' });
      fs.writeFileSync(fp, `${smallLine}\n${bigLine}\n${smallLine}\n`);

      const result = await parser.parseAll(fp, { maxLineLength: 100 });
      expect(result).toHaveLength(2);
    });
  });

  describe('process', () => {
    it('processes batches with custom function', async () => {
      const fp = writeJsonl('process.jsonl', [{ v: 1 }, { v: 2 }, { v: 3 }]);

      const sums = await parser.process<{ v: number }, number>(
        fp,
        async (items) => items.reduce((s, i) => s + i.v, 0),
        { batchSize: 2 }
      );

      // batch1: 1+2=3, batch2: 3
      expect(sums).toEqual([3, 3]);
    });
  });

  describe('countLines', () => {
    it('counts all lines including empty', async () => {
      const fp = path.join(tmpDir, 'count.jsonl');
      fs.writeFileSync(fp, '{"a":1}\n{"a":2}\n{"a":3}\n');

      const count = await parser.countLines(fp);
      // 3 content lines + 1 trailing empty line from final \n
      expect(count).toBeGreaterThanOrEqual(3);
    });
  });

  describe('sampleLines', () => {
    it('throws for invalid sample rate', async () => {
      const fp = writeJsonl('sample.jsonl', [{ a: 1 }]);

      await expect(async () => {
        for await (const _ of parser.sampleLines(fp, 0)) {
          // consume
        }
      }).rejects.toThrow(/Sample rate must be between 0 and 1/);
    });

    it('yields subset of lines at rate 1.0', async () => {
      const lines = Array.from({ length: 5 }, (_, i) => ({ i }));
      const fp = writeJsonl('sample-all.jsonl', lines);

      const results: unknown[] = [];
      for await (const item of parser.sampleLines(fp, 1.0)) {
        results.push(item);
      }
      expect(results).toHaveLength(5);
    });
  });

  describe('createTransformStream', () => {
    it('transforms JSONL chunks in object mode', async () => {
      const transform = parser.createTransformStream({
        filter: (obj) => obj.keep,
      });

      const results: unknown[] = [];
      transform.on('data', (obj) => results.push(obj));

      await new Promise<void>((resolve, reject) => {
        transform.write('{"keep":true,"v":1}\n{"keep":false,"v":2}\n');
        transform.end(() => {
          resolve();
        });
        transform.on('error', reject);
      });

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ keep: true, v: 1 });
    });
  });
});
