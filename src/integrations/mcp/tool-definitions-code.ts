/**
 * Code Execution Tool Definitions for MCP Server
 */

export const codeExecutionTools = [
  {
    name: 'code.execute',
    description:
      'Execute Python, JavaScript, or TypeScript code in a sandboxed environment',
    inputSchema: {
      type: 'object',
      properties: {
        language: {
          type: 'string',
          enum: ['python', 'javascript', 'typescript'],
          description: 'Programming language to execute',
        },
        code: {
          type: 'string',
          description: 'Code to execute',
        },
        workingDirectory: {
          type: 'string',
          description: 'Optional working directory for execution',
        },
        timeout: {
          type: 'number',
          description: 'Execution timeout in milliseconds (default: 30000)',
        },
        force: {
          type: 'boolean',
          description: 'Force execution even if code validation fails',
        },
      },
      required: ['language', 'code'],
    },
  },
  {
    name: 'code.validate',
    description: 'Validate code for potential security issues',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'Code to validate',
        },
      },
      required: ['code'],
    },
  },
  {
    name: 'code.sandbox_status',
    description: 'Get status of the code execution sandbox',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'code.clean_sandbox',
    description: 'Clean temporary files from the sandbox',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

/**
 * Example of using code execution in restricted mode
 */
export const codeOnlyModeExample = `
# When in code_only mode, Claude can ONLY execute code

## Example Python execution:
\`\`\`python
import numpy as np
import matplotlib.pyplot as plt

# Generate data
x = np.linspace(0, 10, 100)
y = np.sin(x)

# Create visualization (won't display but will execute)
plt.plot(x, y)
plt.title('Sine Wave')
plt.xlabel('X')
plt.ylabel('Y')

# Calculate statistics
mean_y = np.mean(y)
std_y = np.std(y)
print(f"Mean: {mean_y:.4f}")
print(f"Std: {std_y:.4f}")
\`\`\`

## Example JavaScript execution:
\`\`\`javascript
// Process data
const data = Array.from({length: 10}, (_, i) => i ** 2);

// Calculate sum
const sum = data.reduce((a, b) => a + b, 0);
console.log('Sum of squares:', sum);

// Async operation
async function fetchData() {
  // Simulate API call
  await new Promise(resolve => setTimeout(resolve, 100));
  return { status: 'success', data: [1, 2, 3] };
}

fetchData().then(result => {
  console.log('Async result:', result);
});
\`\`\`

## Benefits of code_only mode:
1. Safe computational environment
2. No file system modifications
3. No network access
4. Pure problem-solving focus
5. Ideal for algorithms, data analysis, and mathematical computations
`;
