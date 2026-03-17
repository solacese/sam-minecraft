export class BlockPlacementQueue {
  private chain: Promise<void> = Promise.resolve();

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const resultPromise = this.chain.then(task);
    this.chain = resultPromise.then(
      () => undefined,
      () => undefined
    );
    return resultPromise;
  }

  async enqueueCommands(
    commands: string[],
    runCommand: (command: string) => Promise<void>,
    perCommandDelayMs = 15
  ): Promise<void> {
    for (const command of commands) {
      await this.enqueue(async () => {
        await runCommand(command);
        if (perCommandDelayMs > 0) {
          await this.delay(perCommandDelayMs);
        }
      });
    }
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
