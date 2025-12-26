# StackMemory Integration for Open-Source AI Coding Tools

## 🚀 **Universal Integration Methods**

### **1. Continue.dev Integration**

Add to `~/.continue/config.json`:

```json
{
  "customCommands": [
    {
      "name": "get_context",
      "description": "Get StackMemory context",
      "command": "stackmemory context --query"
    },
    {
      "name": "add_decision",
      "description": "Add decision to StackMemory",
      "command": "stackmemory add --type decision --content"
    }
  ],
  "contextProviders": [
    {
      "name": "stackmemory",
      "type": "custom",
      "command": "stackmemory context --json"
    }
  ],
  "onStart": "stackmemory-init"
}
```

### **2. Codeium Integration**

Add to `~/.codeium/config.json`:

```json
{
  "extensions": {
    "stackmemory": {
      "enabled": true,
      "command": "stackmemory",
      "contextProvider": true,
      "autoInit": true
    }
  },
  "hooks": {
    "preQuery": "stackmemory context --query \"$QUERY\"",
    "postResponse": "stackmemory track --response \"$RESPONSE\""
  }
}
```

### **3. TabNine Integration**

Create `~/.tabnine/stackmemory.json`:

```json
{
  "enabled": true,
  "contextCommand": "stackmemory context --limit 5",
  "updateCommand": "stackmemory add --auto",
  "triggers": {
    "onFileOpen": true,
    "onProjectOpen": true,
    "onCommit": true
  }
}
```

### **4. GitHub Copilot (via VS Code)**

Add to `.vscode/settings.json`:

```json
{
  "github.copilot.enable": {
    "stackmemory": true
  },
  "terminal.integrated.env.osx": {
    "STACKMEMORY_ENABLED": "true"
  },
  "terminal.integrated.shellIntegration.enabled": true,
  "terminal.integrated.shellIntegration.decorationsEnabled": "both"
}
```

Create VS Code task in `.vscode/tasks.json`:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "StackMemory: Get Context",
      "type": "shell",
      "command": "stackmemory",
      "args": ["context", "--query", "${input:query}"],
      "presentation": {
        "reveal": "silent",
        "panel": "shared"
      }
    },
    {
      "label": "StackMemory: Add Decision",
      "type": "shell",
      "command": "stackmemory",
      "args": ["add", "--type", "decision", "--content", "${input:decision}"],
      "presentation": {
        "reveal": "silent"
      }
    }
  ],
  "inputs": [
    {
      "id": "query",
      "type": "promptString",
      "description": "What context do you need?"
    },
    {
      "id": "decision",
      "type": "promptString",
      "description": "What decision was made?"
    }
  ]
}
```

---

## 🔧 **Language Server Protocol (LSP) Integration**

For tools that support LSP, add StackMemory as a language server:

### **Create LSP Wrapper**

`~/.stackmemory/lsp-server.js`:

```javascript
#!/usr/bin/env node

const {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  TextDocumentSyncKind,
  InitializeResult,
  CodeActionKind
} = require('vscode-languageserver/node');

const { TextDocument } = require('vscode-languageserver-textdocument');
const { spawn } = require('child_process');

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let stackMemoryProcess;

connection.onInitialize((params) => {
  // Start StackMemory for this project
  const workspaceRoot = params.rootPath || process.cwd();
  
  stackMemoryProcess = spawn('stackmemory', ['lsp'], {
    cwd: workspaceRoot,
    env: { ...process.env, PROJECT_ROOT: workspaceRoot }
  });

  const result = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        resolveProvider: true,
        triggerCharacters: ['@', '#']
      },
      codeActionProvider: {
        codeActionKinds: [CodeActionKind.QuickFix]
      },
      hoverProvider: true
    }
  };
  return result;
});

// Provide context on hover
connection.onHover(async ({ textDocument, position }) => {
  const doc = documents.get(textDocument.uri);
  if (!doc) return null;

  const line = doc.getText({
    start: { line: position.line, character: 0 },
    end: { line: position.line + 1, character: 0 }
  });

  // Get relevant context from StackMemory
  const context = await getStackMemoryContext(line);
  
  return {
    contents: {
      kind: 'markdown',
      value: context
    }
  };
});

// Provide completions with @context or #decision
connection.onCompletion(async ({ textDocument, position }) => {
  const doc = documents.get(textDocument.uri);
  if (!doc) return [];

  const line = doc.getText({
    start: { line: position.line, character: 0 },
    end: { line: position.line, character: position.character }
  });

  if (line.endsWith('@')) {
    // Return available contexts
    const contexts = await getAvailableContexts();
    return contexts.map(ctx => ({
      label: ctx.type,
      kind: 15, // Snippet
      detail: ctx.content.substring(0, 50),
      documentation: ctx.content
    }));
  }

  if (line.endsWith('#')) {
    // Return available decisions
    const decisions = await getDecisions();
    return decisions.map(dec => ({
      label: dec.title,
      kind: 14, // Keyword
      detail: 'Decision',
      documentation: dec.content
    }));
  }

  return [];
});

async function getStackMemoryContext(query) {
  return new Promise((resolve) => {
    const child = spawn('stackmemory', ['context', '--query', query]);
    let output = '';
    child.stdout.on('data', (data) => output += data);
    child.on('close', () => resolve(output));
  });
}

async function getAvailableContexts() {
  return new Promise((resolve) => {
    const child = spawn('stackmemory', ['list', '--json']);
    let output = '';
    child.stdout.on('data', (data) => output += data);
    child.on('close', () => {
      try {
        resolve(JSON.parse(output));
      } catch {
        resolve([]);
      }
    });
  });
}

async function getDecisions() {
  return new Promise((resolve) => {
    const child = spawn('stackmemory', ['decisions', '--json']);
    let output = '';
    child.stdout.on('data', (data) => output += data);
    child.on('close', () => {
      try {
        resolve(JSON.parse(output));
      } catch {
        resolve([]);
      }
    });
  });
}

documents.listen(connection);
connection.listen();
```

### **Register LSP with editors**

**Neovim** (`init.lua`):
```lua
vim.lsp.start({
  name = 'stackmemory',
  cmd = {'/home/user/.stackmemory/lsp-server.js'},
  root_dir = vim.fn.getcwd(),
})
```

**Emacs** (`init.el`):
```elisp
(require 'lsp-mode)
(add-to-list 'lsp-server-install-dir "~/.stackmemory/")
(lsp-register-client
 (make-lsp-client :new-connection (lsp-stdio-connection "~/.stackmemory/lsp-server.js")
                  :major-modes '(prog-mode)
                  :server-id 'stackmemory))
```

---

## 🎨 **OpenAI/GPT Integration**

### **Create OpenAI Function Wrapper**

`~/.stackmemory/openai-functions.js`:

```javascript
const functions = [
  {
    name: "stackmemory_get_context",
    description: "Get relevant project context from StackMemory",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to search for in context"
        },
        limit: {
          type: "number",
          description: "Maximum number of contexts to return"
        }
      },
      required: ["query"]
    }
  },
  {
    name: "stackmemory_add_decision",
    description: "Add a decision or important information to StackMemory",
    parameters: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["decision", "constraint", "learning"],
          description: "Type of information"
        },
        content: {
          type: "string",
          description: "The decision or information to record"
        }
      },
      required: ["type", "content"]
    }
  },
  {
    name: "stackmemory_start_task",
    description: "Start tracking a new task",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Description of the task"
        }
      },
      required: ["task"]
    }
  }
];

// Function implementations
async function stackmemory_get_context({ query, limit = 5 }) {
  const { execSync } = require('child_process');
  const result = execSync(`stackmemory context --query "${query}" --limit ${limit} --json`);
  return JSON.parse(result.toString());
}

async function stackmemory_add_decision({ type, content }) {
  const { execSync } = require('child_process');
  execSync(`stackmemory add --type ${type} --content "${content}"`);
  return { success: true, message: `Added ${type}: ${content}` };
}

async function stackmemory_start_task({ task }) {
  const { execSync } = require('child_process');
  const result = execSync(`stackmemory task --start "${task}"`);
  return { success: true, frameId: result.toString().trim() };
}

module.exports = { functions, stackmemory_get_context, stackmemory_add_decision, stackmemory_start_task };
```

### **Use with OpenAI API**

```javascript
const OpenAI = require('openai');
const { functions } = require('~/.stackmemory/openai-functions');

const openai = new OpenAI();

async function callWithStackMemory(message) {
  const response = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [
      {
        role: "system",
        content: "You are a helpful coding assistant. Always check project context using stackmemory_get_context before answering questions."
      },
      {
        role: "user",
        content: message
      }
    ],
    functions: functions,
    function_call: "auto"
  });
  
  // Handle function calls
  if (response.choices[0].message.function_call) {
    const functionName = response.choices[0].message.function_call.name;
    const functionArgs = JSON.parse(response.choices[0].message.function_call.arguments);
    
    // Execute the function
    const functionResult = await require('~/.stackmemory/openai-functions')[functionName](functionArgs);
    
    // Continue conversation with result
    const finalResponse = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        ...messages,
        response.choices[0].message,
        {
          role: "function",
          name: functionName,
          content: JSON.stringify(functionResult)
        }
      ]
    });
    
    return finalResponse;
  }
  
  return response;
}
```

---

## 🐚 **Shell Integration for Any Tool**

Add to `~/.bashrc` or `~/.zshrc`:

```bash
# StackMemory shell functions
stackmemory-context() {
  stackmemory context --query "$*"
}

stackmemory-decision() {
  stackmemory add --type decision --content "$*"
}

stackmemory-task() {
  stackmemory task --start "$*"
}

# Alias for quick access
alias smc='stackmemory-context'
alias smd='stackmemory-decision'
alias smt='stackmemory-task'

# Auto-initialize in git repos
cd() {
  builtin cd "$@" && {
    if [ -d .git ] && [ ! -d .stackmemory ]; then
      echo "Git repo detected. Initialize StackMemory? (y/n)"
      read -n 1 -r
      echo
      if [[ $REPLY =~ ^[Yy]$ ]]; then
        stackmemory-init
      fi
    fi
  }
}
```

---

## 🔌 **REST API for Web-Based Tools**

Start StackMemory API server:

```bash
stackmemory serve --port 7437
```

Then any tool can use:

```bash
# Get context
curl http://localhost:7437/context?query=authentication

# Add decision
curl -X POST http://localhost:7437/decision \
  -H "Content-Type: application/json" \
  -d '{"type": "decision", "content": "Using OAuth2 for auth"}'

# Start task
curl -X POST http://localhost:7437/task \
  -H "Content-Type: application/json" \
  -d '{"task": "Implement login flow"}'
```

---

## 📱 **Browser Extension for Web IDEs**

For CodeSandbox, Replit, GitHub Codespaces, create a browser extension:

`manifest.json`:
```json
{
  "manifest_version": 3,
  "name": "StackMemory for Web IDEs",
  "version": "1.0",
  "permissions": ["storage", "activeTab"],
  "host_permissions": ["http://localhost:7437/*"],
  "content_scripts": [
    {
      "matches": ["*://github.dev/*", "*://codespaces.new/*", "*://replit.com/*"],
      "js": ["stackmemory-inject.js"]
    }
  ]
}
```

---

## 🚀 **Quick Setup for Any Tool**

1. **Install globally:**
   ```bash
   ./install-global.sh
   ```

2. **Initialize in your project:**
   ```bash
   cd your-project
   stackmemory-init
   ```

3. **Use via CLI in any tool:**
   ```bash
   stackmemory context --query "your question"
   stackmemory add --type decision --content "your decision"
   ```

4. **Or via API:**
   ```bash
   stackmemory serve
   # Now accessible at http://localhost:7437
   ```

The system works with ANY tool that can:
- Execute shell commands
- Call HTTP APIs  
- Use Language Server Protocol
- Support custom extensions

This makes StackMemory truly universal across all AI coding assistants!