---
name: commander-cli
version: 2025.12.1
domain: cli
expires: 2026-12-01
activates_on: [commander, cli, command, option, argument, subcommand, parse, program, action]
sources:
  - https://github.com/tj/commander.js#readme
context7: tj/commander.js
---

# Commander.js CLI Framework

## Basic Setup
```ts
import { Command } from 'commander';
const program = new Command();
program
  .name('mycli')
  .version('1.0.0')
  .description('description');
```

## Commands
```ts
program
  .command('serve')
  .description('Start server')
  .option('-p, --port <number>', 'port', '3000')
  .option('-v, --verbose', 'verbose output')
  .argument('<dir>', 'directory to serve')
  .action((dir, options) => {
    console.log(dir, options.port, options.verbose);
  });
```

## Subcommands
```ts
const parent = program.command('db');
parent.command('migrate').action(() => { ... });
parent.command('seed').action(() => { ... });
// Usage: mycli db migrate
```

## Options
- Required value: `-p, --port <number>` (angle brackets)
- Optional value: `-p, --port [number]` (square brackets)
- Boolean flag: `-v, --verbose` (no value)
- Variadic: `-f, --files <items...>` (collects into array)
- Default: `.option('-p, --port <n>', 'desc', '3000')`
- Choices: `.addOption(new Option('--env <e>').choices(['dev', 'prod']))`
- Negatable: `--no-color` (sets `options.color = false`)

## Patterns for This Project
- 70+ commands — use subcommand groups (`skill`, `frame`, `session`, `linear`, etc.)
- Action handlers: async functions with try/catch + `process.exit(1)` on error
- Global options: define on `program` before subcommands
- Help: auto-generated — add `.addHelpText('after', text)` for examples

## Gotchas
- Option values are strings by default — parse with `.argParser(parseInt)` or coerce in action
- `program.parse()` must be called last (or `program.parseAsync()` for async actions)
- `.command('*')` for catch-all unknown commands
- Negative options: `--no-foo` creates `options.foo = false` — conflicts if `--foo` also defined
- ESM: Commander works fine, but ensure `#!/usr/bin/env node` in bin entry
