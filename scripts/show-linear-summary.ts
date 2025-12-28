#!/usr/bin/env node

/**
 * Show Linear task summary with all statuses
 */

import { readFileSync } from 'fs';
import { join } from 'path';

async function showLinearSummary() {
  // Load Linear tokens
  const tokensPath = join(process.cwd(), '.stackmemory', 'linear-tokens.json');
  let accessToken: string;

  try {
    const tokensData = readFileSync(tokensPath, 'utf8');
    const tokens = JSON.parse(tokensData);
    accessToken = tokens.accessToken;
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

  // Get issues grouped by state
  const issuesQuery = `
    query {
      issues(first: 250) {
        nodes {
          identifier
          title
          state {
            name
            type
          }
          createdAt
          updatedAt
        }
      }
    }
  `;

  const data = (await graphqlRequest(issuesQuery)) as {
    issues: { nodes: any[] };
  };
  const issues = data.issues.nodes;

  // Group by state type
  const grouped = new Map<string, any[]>();

  for (const issue of issues) {
    const stateType = issue.state.type;
    if (!grouped.has(stateType)) {
      grouped.set(stateType, []);
    }
    grouped.get(stateType)!.push(issue);
  }

  // Display summary
  console.log('\n📊 Linear Task Summary\n');
  console.log('='.repeat(60));

  const stateOrder = [
    'backlog',
    'unstarted',
    'started',
    'completed',
    'canceled',
  ];

  for (const state of stateOrder) {
    const stateIssues = grouped.get(state) || [];
    if (stateIssues.length === 0) continue;

    const emoji =
      {
        backlog: '📋',
        unstarted: '⏳',
        started: '🔄',
        completed: '✅',
        canceled: '❌',
      }[state] || '⚪';

    console.log(
      `\n${emoji} ${state.toUpperCase()} (${stateIssues.length} tasks)`
    );
    console.log('-'.repeat(40));

    // Show recent items (last 5)
    const recent = stateIssues
      .sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      )
      .slice(0, state === 'canceled' ? 20 : 5);

    for (const issue of recent) {
      const updatedDate = new Date(issue.updatedAt).toLocaleDateString();
      console.log(
        `  ${issue.identifier.padEnd(10)} ${issue.title.slice(0, 50).padEnd(50)} ${updatedDate}`
      );
    }

    if (stateIssues.length > recent.length) {
      console.log(`  ... and ${stateIssues.length - recent.length} more`);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('\n📈 Total Issues: ' + issues.length);
  const activeCount =
    (grouped.get('started')?.length ?? 0) +
    (grouped.get('unstarted')?.length ?? 0) +
    (grouped.get('backlog')?.length ?? 0);
  console.log('   Active: ' + activeCount);
  console.log('   Completed: ' + (grouped.get('completed')?.length ?? 0));
  console.log('   Canceled: ' + (grouped.get('canceled')?.length ?? 0));
}

// Run
showLinearSummary().catch((error) => {
  console.error('❌ Error:', error);
  process.exit(1);
});
