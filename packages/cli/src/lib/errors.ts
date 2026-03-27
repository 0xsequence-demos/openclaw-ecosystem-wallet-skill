import chalk from 'chalk'

/**
 * Wrap a commander action to catch errors and print them cleanly
 * instead of showing raw stack traces.
 */
export function handleErrors(fn: (...args: any[]) => Promise<void>): (...args: any[]) => Promise<void> {
  return async (...args: any[]) => {
    try {
      await fn(...args)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(chalk.red('Error:') + ' ' + message)
      process.exit(1)
    }
  }
}
