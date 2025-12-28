#!/usr/bin/env node

/**
 * Script to merge duplicate Linear tasks (with dry-run option)
 * Keeps the lowest-numbered task as primary and marks others as duplicates
 */

import { readFileSync } from 'fs';
import { join } from 'path';

interface DuplicateGroup {
  name: string;
  taskIds: string[];
  primaryId: string;
}

const duplicateGroups: DuplicateGroup[] = [
  {
    name: 'Linear API Integration',
    taskIds: ['STA-88', 'STA-74', 'STA-61', 'STA-46', 'STA-32', 'STA-9'],
    primaryId: 'STA-9',
  },
  {
    name: 'Performance Optimization',
    taskIds: [
      'STA-87',
      'STA-73',
      'STA-60',
      'STA-45',
      'STA-31',
      'STA-13',
      'STA-21',
      'STA-35',
      'STA-50',
      'STA-63',
      'STA-77',
    ],
    primaryId: 'STA-13',
  },
  {
    name: 'Security Audit and Input Validation',
    taskIds: ['STA-85', 'STA-71', 'STA-58', 'STA-43', 'STA-29'],
    primaryId: 'STA-29',
  },
  {
    name: 'Implement Proper Error Handling',
    taskIds: ['STA-84', 'STA-70', 'STA-57', 'STA-42', 'STA-28'],
    primaryId: 'STA-28',
  },
  {
    name: 'Implement Comprehensive Testing Suite',
    taskIds: ['STA-83', 'STA-69', 'STA-56', 'STA-41', 'STA-27'],
    primaryId: 'STA-27',
  },
];

async function mergeDuplicateTasks(dryRun = true) {
  const mode = dryRun ? '🔍 DRY RUN MODE' : '⚡ LIVE MODE';
  console.log(`\n${mode} - Linear duplicate task merge\n`);
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

  // Initialize Linear client using GraphQL directly
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

  // Get team and workflow states
  console.log('Fetching team information...');
  const teamQuery = `
    query {
      teams {
        nodes {
          id
          key
          name
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
  `;

  const teamData = (await graphqlRequest(teamQuery)) as {
    teams: { nodes: any[] };
  };
  const team = teamData.teams.nodes[0];

  if (!team) {
    console.error('❌ No team found');
    process.exit(1);
  }

  const canceledState = team.states.nodes.find(
    (s: any) => s.type === 'canceled'
  );
  if (!canceledState) {
    console.error('❌ No canceled state found in team workflow');
    process.exit(1);
  }

  console.log(`✅ Found team: ${team.name} (${team.key})`);
  console.log(`✅ Canceled state ID: ${canceledState.id}\n`);

  // Process each duplicate group
  let totalUpdates = 0;
  let totalCanceled = 0;

  for (const group of duplicateGroups) {
    console.log(`\n📋 Processing: ${group.name}`);
    console.log(`   Primary: ${group.primaryId}`);
    console.log(
      `   Will cancel: ${group.taskIds.filter((id) => id !== group.primaryId).join(', ')}`
    );

    if (dryRun) {
      console.log('   🔍 [DRY RUN] Would:');
      console.log(`      - Keep ${group.primaryId} as primary`);
      console.log(`      - Cancel ${group.taskIds.length - 1} duplicates`);
      console.log(`      - Merge any unique descriptions into primary`);
      totalCanceled += group.taskIds.length - 1;
    } else {
      try {
        // Get all issues in the group
        const issueQuery = `
          query GetIssue($identifier: String!) {
            issue(id: $identifier) {
              id
              identifier
              title
              description
              state {
                id
                name
                type
              }
            }
          }
        `;

        // Get primary issue
        const primaryData = (await graphqlRequest(issueQuery, {
          identifier: group.primaryId,
        })) as { issue: any };
        const primaryIssue = primaryData.issue;

        if (!primaryIssue) {
          console.log(
            `   ⚠️  Primary issue ${group.primaryId} not found, skipping group`
          );
          continue;
        }

        // Process duplicates
        const duplicateIds = group.taskIds.filter(
          (id) => id !== group.primaryId
        );
        const mergedDescriptions: string[] = [];

        for (const duplicateId of duplicateIds) {
          try {
            const dupData = (await graphqlRequest(issueQuery, {
              identifier: duplicateId,
            })) as { issue: any };
            const duplicateIssue = dupData.issue;

            if (!duplicateIssue) {
              console.log(`   ⚠️  Issue ${duplicateId} not found, skipping`);
              continue;
            }

            // Collect unique descriptions
            if (
              duplicateIssue.description &&
              duplicateIssue.description !== primaryIssue.description
            ) {
              mergedDescriptions.push(
                `[Merged from ${duplicateId}]\n${duplicateIssue.description}`
              );
            }

            // Cancel the duplicate
            const updateMutation = `
              mutation UpdateIssue($id: String!, $stateId: String!, $description: String!) {
                issueUpdate(
                  id: $id,
                  input: {
                    stateId: $stateId,
                    description: $description
                  }
                ) {
                  success
                  issue {
                    identifier
                    state {
                      name
                      type
                    }
                  }
                }
              }
            `;

            await graphqlRequest(updateMutation, {
              id: duplicateIssue.id,
              stateId: canceledState.id,
              description: `Duplicate of ${group.primaryId}\n\n${duplicateIssue.description || ''}`,
            });

            console.log(`   ✅ Canceled ${duplicateId} as duplicate`);
            totalCanceled++;
          } catch (error: any) {
            console.log(
              `   ❌ Failed to process ${duplicateId}: ${error.message}`
            );
          }
        }

        // Update primary with merged descriptions if any
        if (mergedDescriptions.length > 0) {
          const newDescription = [
            primaryIssue.description || '',
            '',
            '--- Merged Content ---',
            ...mergedDescriptions,
          ]
            .filter(Boolean)
            .join('\n\n');

          const updatePrimaryMutation = `
            mutation UpdatePrimaryIssue($id: String!, $description: String!) {
              issueUpdate(
                id: $id,
                input: {
                  description: $description
                }
              ) {
                success
              }
            }
          `;

          await graphqlRequest(updatePrimaryMutation, {
            id: primaryIssue.id,
            description: newDescription,
          });

          console.log(
            `   ✅ Updated ${group.primaryId} with merged descriptions`
          );
          totalUpdates++;
        }
      } catch (error: any) {
        console.error(`   ❌ Error processing group: ${error.message}`);
      }
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log(`\n✨ ${dryRun ? 'DRY RUN' : 'MERGE'} COMPLETE!\n`);
  console.log('📊 Summary:');
  console.log(`   Groups processed: ${duplicateGroups.length}`);
  console.log(`   Primary tasks kept: ${duplicateGroups.length}`);
  console.log(
    `   Tasks ${dryRun ? 'to cancel' : 'canceled'}: ${dryRun ? duplicateGroups.reduce((acc, g) => acc + g.taskIds.length - 1, 0) : totalCanceled}`
  );
  if (!dryRun) {
    console.log(`   Primary tasks updated: ${totalUpdates}`);
  }

  if (dryRun) {
    console.log('\n💡 To execute these changes, run with --execute flag');
  }
}

// Parse command line arguments
const isDryRun = !process.argv.includes('--execute');

// Run the merge
mergeDuplicateTasks(isDryRun).catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
