# Apple Shortcuts: Add to Wiki

Two shortcuts for ingesting notes into StackMemory wiki via iMessage, Siri, or share sheet.

## Shortcut A: "Add to Wiki" (passive — next session picks it up)

### Setup in Shortcuts app:

1. **Name**: "Add to Wiki"
2. **Actions**:
   - `Ask for Input` → Type: Text, Prompt: "What to remember?"
   - `Get Current Date` → Format: `yyyy-MM-dd-HHmm`
   - `Save File` → Save to: `iCloud Drive/Obsidian/stackmemory/raw/` + `Current Date` + `-note.md`
3. **Trigger options**:
   - Add to Home Screen
   - "Hey Siri, add to wiki"
   - Add to Share Sheet (for sharing text/URLs from any app)

### What happens:
- File lands in `raw/` directory
- Obsidian vault adapter's `startWatching()` detects new .md file
- `wiki-update.js` hook compiles it on next Claude Code session stop

---

## Shortcut B: "Wiki Now" (instant — ingests immediately)

### Setup in Shortcuts app:

1. **Name**: "Wiki Now"
2. **Actions**:
   - `Ask for Input` → Type: Text, Prompt: "What to remember?"
   - `Text` → Combine: `---\ntitle: "` + Input + `"\ncreated: ` + Current Date (ISO) + `\ntags: [quick-capture]\n---\n\n` + Input
   - `Save File` → Save to `/tmp/wiki-quick-note.md`
   - `Run Shell Script`:
     ```bash
     /opt/homebrew/bin/node /opt/homebrew/lib/node_modules/@stackmemoryai/stackmemory/dist/src/cli/index.js wiki ingest /tmp/wiki-quick-note.md --wiki-dir ~/Dev/stackmemory-vault/stackmemory/wiki
     ```
3. **Trigger options**:
   - Same as above + Automation triggers (time of day, location, etc.)

### What happens:
- CLI runs immediately, creates wiki article
- Available in Obsidian instantly
- No need to wait for next session

---

## Shortcut C: "Wiki URL" (for sharing links)

### Setup:
1. **Name**: "Wiki URL"
2. **Input**: Accepts URLs from Share Sheet
3. **Actions**:
   - `Run Shell Script`:
     ```bash
     /opt/homebrew/bin/node /opt/homebrew/lib/node_modules/@stackmemoryai/stackmemory/dist/src/cli/index.js wiki ingest "$1" -n 5 --wiki-dir ~/Dev/stackmemory-vault/stackmemory/wiki
     ```

### What happens:
- Share any URL from Safari/Chrome → "Wiki URL"
- Crawls page + up to 5 linked pages
- Creates wiki articles immediately

---

## iMessage Integration

Send a text to yourself → Shortcut Automation picks it up:

1. Open Shortcuts → Automations → New Automation
2. **When**: Message received containing "#wiki"
3. **Action**: Extract text after "#wiki", run Shortcut B with that text
4. **Turn off "Ask Before Running"**

Now: text yourself `#wiki Saw Dr. Smith, blood pressure normal, next visit June` → wiki article created.

---

## Paths (adjust for your setup)

```
Obsidian vault raw/: ~/Dev/stackmemory-vault/stackmemory/raw/
Wiki dir:            ~/Dev/stackmemory-vault/stackmemory/wiki/
CLI binary:          /opt/homebrew/lib/node_modules/@stackmemoryai/stackmemory/dist/src/cli/index.js
Node:                /opt/homebrew/bin/node
```
