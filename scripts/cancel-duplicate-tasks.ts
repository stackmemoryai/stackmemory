#!/usr/bin/env node

/**
 * Script to cancel duplicate Linear tasks
 * Uses the actual Linear API to find and cancel duplicates
 */

import { readFileSync } from 'fs';
import { join } from 'path';

interface TaskGroup {
  pattern: string;
  keepFirst: boolean;
}

// Define patterns to identify duplicate tasks
const duplicatePatterns: TaskGroup[] = [
  { pattern: 'Linear API Integration', keepFirst: true },
  { pattern: 'Performance Optimization', keepFirst: true },
  { pattern: 'Security Audit', keepFirst: true },
  { pattern: '[HIGH] Implement Proper Error Handling', keepFirst: true },
  { pattern: '[HIGH] Implement Comprehensive Testing Suite', keepFirst: true },
];

async function cancelDuplicateTasks(dryRun = true) {
  const mode = dryRun ? '🔍 DRY RUN MODE' : '⚡ LIVE MODE';
  console.log(`\n${mode} - Cancel duplicate Linear tasks\n`);
  console.log('='.repeat(60));

  // Load Linear tokens
  const tokensPath = join(process.cwd(), '.stackmemory', 'linear-tokens.json');
  let accessToken: string;

  try {
    const tokensData = readFileSync(tokensPath, 'utf8');
    const tokens = JSON.parse(tokensData);
    accessToken = tokens.accessToken;
    console.log('✅ Loaded Linear authentication tokens\n');
  } catch {
    console.error(
      '❌ Failed to load Linear tokens. Please run: stackmemory linear setup'
    );
    process.exit(1);
  }

  // GraphQL helper
  const linearApiUrl = 'https://api.linear.app/graphql';

  async function graphqlRequest(query: string, variables: any = {}) {
    const response = await fetch(linearApiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      throw new Error(
        `Linear API error: ${response.status} ${response.statusText}`
      );
    }

    const result = (await response.json()) as {
      errors?: unknown[];
      data: unknown;
    };
    if (result.errors) {
      throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
    }

    return result.data;
  }

  // First, get all issues
  console.log('Fetching all issues...\n');
  const issuesQuery = `
    query {
      issues(first: 250, filter: { state: { type: { nin: ["completed", "canceled"] } } }) {
        nodes {
          id
          identifier
          title
          description
          createdAt
          state {
            id
            name
            type
          }
          team {
            id
            key
            states {
              nodes {
                id
                name
                type
              }
            }
          }
        }
      }
    }
  `;

  const issuesData = (await graphqlRequest(issuesQuery)) as {
    issues: { nodes: any[] };
  };
  const allIssues = issuesData.issues.nodes;

  console.log(`Found ${allIssues.length} active issues\n`);

  // Get canceled state from the first issue's team
  const canceledState = allIssues[0]?.team?.states?.nodes?.find(
    (s: any) => s.type === 'canceled'
  );
  if (!canceledState) {
    console.error('❌ No canceled state found in workflow');
    process.exit(1);
  }

  // Group issues by pattern
  const groupedIssues = new Map<string, any[]>();

  for (const pattern of duplicatePatterns) {
    const matches = allIssues.filter((issue: any) =>
      issue.title.includes(pattern.pattern)
    );

    if (matches.length > 1) {
      // Sort by creation date to keep the oldest
      matches.sort(
        (a: any, b: any) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
      groupedIssues.set(pattern.pattern, matches);
    }
  }

  // Process each group
  let totalCanceled = 0;
  let totalKept = 0;

  for (const [pattern, issues] of groupedIssues.entries()) {
    console.log(`\n📋 Pattern: "${pattern}"`);
    console.log(`   Found ${issues.length} matching issues:`);

    const [primary, ...duplicates] = issues;

    console.log(`   ✅ Keep: ${primary.identifier} - ${primary.title}`);
    totalKept++;

    for (const duplicate of duplicates) {
      console.log(
        `   ${dryRun ? '🔍' : '❌'} Cancel: ${duplicate.identifier} - ${duplicate.title}`
      );

      if (!dryRun) {
        try {
          const cancelMutation = `
            mutation CancelIssue($id: String!, $stateId: String!) {
              issueUpdate(
                id: $id,
                input: {
                  stateId: $stateId,
                  description: "Duplicate task - kept ${primary.identifier}"
                }
              ) {
                success
                issue {
                  identifier
                  state {
                    name
                  }
                }
              }
            }
          `;

          await graphqlRequest(cancelMutation, {
            id: duplicate.id,
            stateId: canceledState.id,
          });

          console.log(`      ✅ Successfully canceled ${duplicate.identifier}`);
          totalCanceled++;
        } catch (error: any) {
          console.log(
            `      ❌ Failed to cancel ${duplicate.identifier}: ${error.message}`
          );
        }
      } else {
        totalCanceled++;
      }
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log(`\n✨ ${dryRun ? 'DRY RUN' : 'CLEANUP'} COMPLETE!\n`);
  console.log('📊 Summary:');
  console.log(`   Duplicate groups found: ${groupedIssues.size}`);
  console.log(`   Tasks to keep: ${totalKept}`);
  console.log(
    `   Tasks ${dryRun ? 'to cancel' : 'canceled'}: ${totalCanceled}`
  );
  console.log(`   Total active tasks: ${allIssues.length}`);
  console.log(`   Tasks after cleanup: ${allIssues.length - totalCanceled}`);

  if (dryRun) {
    console.log('\n💡 To execute these changes, run with --execute flag');
  }
}

// Parse command line arguments
const isDryRun = !process.argv.includes('--execute');

// Run the cleanup
cancelDuplicateTasks(isDryRun).catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
