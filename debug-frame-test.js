// Test the actual issue with a simpler approach
import { v4 as uuidv4 } from 'uuid';

console.log('Testing simple UUID generation...');
const testId = uuidv4();
console.log('UUID result:', testId);
console.log('Type:', typeof testId);

// Let me check if this is a vitest issue
const simpleFunction = function () {
  return 'string-result';
};

const result = simpleFunction();
console.log('Simple function result:', result);
console.log('Simple function type:', typeof result);
