# StackMemory Instructions for AI Agents

## 🤖 **For All AI Agents (Claude, GPT, etc.)**

This document provides instructions for AI agents to effectively use the StackMemory context system.

---

## 🎯 **Core Principles**

1. **Always Check Context First** - Before answering, retrieve relevant context
2. **Record Important Decisions** - Capture decisions that affect the project
3. **Track Your Work** - Start frames for tasks you're working on
4. **Learn From Usage** - The system learns what context matters

---

## 📋 **Available Tools (MCP)**

### **1. get_context**
Retrieves relevant project context based on query.

```typescript
// Usage
get_context({
  query: "authentication implementation",
  limit: 10
})

// Returns
{
  contexts: Array<{
    type: string,
    content: string,
    importance: number
  }>
}
```

**When to use:**
- Beginning of any coding task
- When asked about project decisions
- Before making architectural choices
- When debugging issues

### **2. add_decision**
Records important decisions or constraints.

```typescript
// Usage
add_decision({
  type: "decision" | "constraint" | "learning",
  content: "Using PostgreSQL with pgvector for embeddings"
})
```

**When to use:**
- After making technology choices
- When establishing constraints
- After learning something important
- When user confirms a decision

### **3. start_task**
Begins tracking a new task or feature.

```typescript
// Usage
start_task({
  task: "Implementing OAuth authentication flow"
})
```

**When to use:**
- Starting any multi-step task
- Beginning a debugging session
- Starting a new feature
- Beginning analysis work

---

## 🔄 **Workflow Patterns**

### **Pattern 1: Starting a Task**
```
1. get_context({ query: "related to [task]" })
2. Review existing decisions/constraints
3. start_task({ task: "[task description]" })
4. Implement solution
5. add_decision() for any important choices
```

### **Pattern 2: Answering Questions**
```
1. get_context({ query: "[question topic]" })
2. Check if already decided/documented
3. Provide answer based on context
4. If new decision made, add_decision()
```

### **Pattern 3: Debugging**
```
1. get_context({ query: "errors OR bugs OR issues" })
2. Check previous debugging attempts
3. start_task({ task: "Debug: [issue]" })
4. Once solved, add_decision() with solution
```

---

## 🧠 **Context Importance Signals**

The system tracks which context actually helps. To improve learning:

### **High-Value Context Patterns**
- Decisions that affect multiple files
- Constraints that limit options
- Previous bug fixes for similar issues
- Architecture decisions
- API contracts

### **Low-Value Context Patterns**
- Temporary TODOs (already completed)
- Old debugging logs
- Superseded decisions
- Personal notes without project impact

---

## 📝 **Best Practices**

### **DO:**
- ✅ Check context before starting any task
- ✅ Record decisions immediately after making them
- ✅ Use specific queries for better context retrieval
- ✅ Track multi-step tasks with start_task
- ✅ Add learned constraints and gotchas

### **DON'T:**
- ❌ Skip context check for "simple" tasks
- ❌ Forget to record important decisions
- ❌ Add redundant/duplicate decisions
- ❌ Store sensitive information (passwords, keys)
- ❌ Add temporary debugging output as decisions

---

## 🎨 **Response Templates**

### **When Starting Work:**
```
I'll check the project context first to understand any existing decisions.

[get_context]

Based on the context, I can see that:
- [relevant decision 1]
- [relevant constraint 1]

Let me start working on this task.
[start_task]
```

### **When Making Decisions:**
```
For [technical choice], considering the project context, I recommend [option].

This is because:
- [reasoning based on context]

Let me record this decision:
[add_decision]
```

### **When Finding Important Information:**
```
I discovered that [important finding].

This should be remembered for future work:
[add_decision with type="learning"]
```

---

## 🔍 **Context Categories**

### **Decision**
Technology choices, architecture decisions, design patterns
```
Example: "Using WebRTC for P2P synchronization"
```

### **Constraint**
Limitations, requirements, boundaries
```
Example: "Must support Safari 14+ for enterprise users"
```

### **Learning**
Discovered gotchas, important findings, lessons learned
```
Example: "SQLite performance degrades significantly after 10GB"
```

---

## 📊 **Attention Tracking**

The system automatically tracks:
- Which contexts you reference in responses
- Which contexts lead to successful solutions
- Which contexts are never used

This helps the system learn what matters over time.

---

## 🔌 **Integration Examples**

### **For Claude Code (via MCP)**
```typescript
// Automatic on every message
on_message = async (user_message) => {
  const context = await get_context({ 
    query: extract_intent(user_message) 
  });
  
  // Context influences response
  const response = generate_with_context(context, user_message);
  
  // Track any decisions made
  if (contains_decision(response)) {
    await add_decision({ 
      type: "decision",
      content: extract_decision(response)
    });
  }
}
```

### **For Continue.dev / Codeium**
```typescript
// Add to .continue/config.json
{
  "customCommands": [
    {
      "name": "stackmemory",
      "description": "Get project context",
      "command": "node /path/to/stackmemory/cli.js get-context"
    }
  ]
}
```

### **For OpenAI Function Calling**
```typescript
const tools = [
  {
    type: "function",
    function: {
      name: "stackmemory_get_context",
      description: "Get relevant project context",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" }
        }
      }
    }
  },
  {
    type: "function", 
    function: {
      name: "stackmemory_add_decision",
      description: "Record important decision",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["decision", "constraint", "learning"] },
          content: { type: "string" }
        }
      }
    }
  }
];
```

---

## 🚀 **Quick Reference Card**

| Situation | Action |
|-----------|--------|
| Starting any task | `get_context()` then `start_task()` |
| User asks question | `get_context()` first |
| Making tech choice | `add_decision(type: "decision")` |
| Found limitation | `add_decision(type: "constraint")` |
| Discovered gotcha | `add_decision(type: "learning")` |
| Debugging issue | `get_context(query: "error OR bug")` |
| Completed task | Check if any decisions to record |

---

## 📈 **Success Metrics**

Your effectiveness with StackMemory is measured by:
- **Context hit rate**: How often retrieved context is useful
- **Decision capture rate**: Important decisions recorded
- **Attention score**: Your responses reference relevant context
- **Learning velocity**: System improves at suggesting context

---

## 🔧 **Troubleshooting**

### **No context returned**
- Project might be new - start adding decisions
- Query might be too specific - try broader terms

### **Wrong context returned**
- Context importance still learning - will improve over time
- Add more specific decisions to improve retrieval

### **System feels slow**
- Check if database needs optimization: `npm run analyze`
- Consider archiving old contexts

---

## 💡 **Advanced Tips**

1. **Batch Related Decisions**: When making multiple related choices, add them in sequence for better pattern recognition

2. **Use Semantic Queries**: Instead of "auth", use "authentication OAuth JWT" for better retrieval

3. **Reference Context in Responses**: Mention retrieved context in your responses to reinforce importance

4. **Track Failed Attempts**: Record what didn't work as learnings to avoid repetition

5. **Link Related Frames**: When continuing previous work, reference the earlier frame ID

---

*This system learns and improves with every interaction. The more consistently you use it, the better it becomes at providing relevant context.*