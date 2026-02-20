import { Command } from 'commander';
import chalk from 'chalk';
import open from 'open';
import inquirer from 'inquirer';

export function registerSignupCommand(program: Command): void {
  program
    .command('signup')
    .alias('register')
    .description('Sign up for StackMemory hosted service')
    .option('--no-open', 'Do not automatically open browser')
    .action(async (options) => {
      console.log(chalk.cyan('🚀 StackMemory Hosted Service Signup\n'));

      const signupUrl = 'https://stackmemory.ai/signup';

      if (options.open !== false) {
        console.log(chalk.gray('Opening signup page in your browser...'));
        try {
          await open(signupUrl);
          console.log(chalk.green('✓ Opened: ') + chalk.cyan(signupUrl));
        } catch (error) {
          console.log(chalk.yellow('Could not open browser automatically.'));
          console.log(chalk.gray('Please visit: ') + chalk.cyan(signupUrl));
        }
      } else {
        console.log(chalk.gray('Visit this URL to sign up:'));
        console.log(chalk.cyan(signupUrl));
      }

      console.log(chalk.gray('\nAfter signing up, you can login with:'));
      console.log(chalk.cyan('  stackmemory login'));

      // Optional: Ask if they want to login now
      const { proceed } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'proceed',
          message: 'Have you completed signup and want to login now?',
          default: false,
        },
      ]);

      if (proceed) {
        // Import and run login command
        const { registerLoginCommand } = await import('./login.js');
        const loginCmd = new Command();
        registerLoginCommand(loginCmd);

        // Execute login
        console.log(chalk.cyan('\n🔐 Proceeding to login...\n'));
        await loginCmd.parseAsync(['node', 'stackmemory', 'login']);
      } else {
        console.log(
          chalk.gray('\nWhen ready, run: ') + chalk.cyan('stackmemory login')
        );
      }
    });
}
