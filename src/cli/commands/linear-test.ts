/**
 * Simple Linear sync test command
 */

import chalk from 'chalk';
import { Command } from 'commander';

export function registerLinearTestCommand(parent: Command) {
  parent
    .command('linear:test')
    .description('Test Linear API connection')
    .option('--api-key <key>', 'Linear API key')
    .action(async (options) => {
      try {
        const apiKey = options.apiKey || process.env.LINEAR_API_KEY;
        
        if (!apiKey) {
          console.log(chalk.red('❌ No API key provided'));
          console.log('Use --api-key or set LINEAR_API_KEY environment variable');
          return;
        }
        
        console.log(chalk.yellow('🔄 Testing Linear connection...'));
        
        // Simple GraphQL query to test connection
        const response = await fetch('https://api.linear.app/graphql', {
          method: 'POST',
          headers: {
            'Authorization': apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            query: `
              query Me {
                viewer {
                  id
                  name
                  email
                }
                teams {
                  nodes {
                    id
                    key
                    name
                  }
                }
              }
            `
          }),
        });
        
        if (!response.ok) {
          console.log(chalk.red(`❌ API Error: ${response.status} ${response.statusText}`));
          return;
        }
        
        const result: any = await response.json();
        
        if (result.errors) {
          console.log(chalk.red('❌ GraphQL Errors:'));
          result.errors.forEach((err: any) => console.log(`  - ${err.message}`));
          return;
        }
        
        if (result.data?.viewer) {
          console.log(chalk.green('✅ Connected to Linear!'));
          console.log(chalk.cyan('\n👤 User:'));
          console.log(`  Name: ${result.data.viewer.name}`);
          console.log(`  Email: ${result.data.viewer.email}`);
        }
        
        if (result.data?.teams?.nodes?.length > 0) {
          console.log(chalk.cyan('\n🏢 Teams:'));
          result.data.teams.nodes.forEach((team: any) => {
            console.log(`  - ${team.name} (${team.key})`);
          });
        }
        
        // Test creating a sample issue (optional)
        console.log(chalk.yellow('\n🔄 Testing issue creation...'));
        
        if (result.data?.teams?.nodes?.length > 0) {
          const teamId = result.data.teams.nodes[0].id;
          
          const createResponse = await fetch('https://api.linear.app/graphql', {
            method: 'POST',
            headers: {
              'Authorization': apiKey,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              query: `
                mutation CreateIssue($input: IssueCreateInput!) {
                  issueCreate(input: $input) {
                    success
                    issue {
                      id
                      identifier
                      title
                      url
                    }
                  }
                }
              `,
              variables: {
                input: {
                  teamId: teamId,
                  title: '[TEST] StackMemory Integration Test',
                  description: 'This is a test issue created by StackMemory to verify Linear integration.',
                  priority: 4, // Low priority
                }
              }
            }),
          });
          
          const createResult: any = await createResponse.json();
          
          if (createResult.data?.issueCreate?.success) {
            const issue = createResult.data.issueCreate.issue;
            console.log(chalk.green('✅ Test issue created successfully!'));
            console.log(`  ID: ${issue.identifier}`);
            console.log(`  Title: ${issue.title}`);
            console.log(`  URL: ${issue.url}`);
            
            // Optional: Delete the test issue
            console.log(chalk.gray('\n(You can delete this test issue from Linear)'));
          } else {
            console.log(chalk.yellow('⚠ Could not create test issue'));
          }
        }
        
        console.log(chalk.green('\n✅ Linear integration test completed!'));
        
      } catch (error) {
        console.error(chalk.red('❌ Test failed:'), (error as Error).message);
        process.exit(1);
      }
    });
}