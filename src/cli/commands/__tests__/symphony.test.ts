import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Command } from 'commander';
import { createConductorCommands } from '../orchestrate.js';

describe('symphony (conductor) --version', () => {
  let consoleSpy: { log: ReturnType<typeof vi.spyOn> };

  beforeEach(() => {
    consoleSpy = { log: vi.spyOn(console, 'log').mockImplementation(() => {}) };
  });

  it('prints symphony-adapter version', async () => {
    const program = new Command();
    program.exitOverride(); // prevent process.exit
    program.addCommand(createConductorCommands());

    await program.parseAsync(['node', 'stackmemory', 'conductor', '--version']);

    expect(consoleSpy.log).toHaveBeenCalledWith('symphony-adapter 0.2.0');
  });
});
