/** A preparation runs before core reads or changes deployment files, under its lock. */
export type DeploymentPreparation = (
  gameId: string,
  operation: "deploy" | "purge" | "purge-type",
) => Promise<(succeeded: boolean) => Promise<void>>;

const preparations = new Set<DeploymentPreparation>();

/** Unlike notification events, these prerequisites must reject the operation on failure. */
export function registerDeploymentPreparation(prepare: DeploymentPreparation): () => void {
  preparations.add(prepare);
  return () => preparations.delete(prepare);
}

export async function withDeploymentPreparation<T>(
  gameId: string,
  operation: "deploy" | "purge" | "purge-type",
  run: () => Promise<T>,
): Promise<T> {
  const releases: Array<(succeeded: boolean) => Promise<void>> = [];
  let outcome: { succeeded: true; result: T } | { succeeded: false; error: unknown };
  try {
    for (const prepare of preparations) releases.push(await prepare(gameId, operation));
    outcome = { succeeded: true, result: await run() };
  } catch (error) {
    outcome = { succeeded: false, error };
  }
  // Release every completed preparation even if another cleanup fails.
  const errors: unknown[] = [];
  await Promise.all(
    releases.reverse().map(async (release) => {
      try {
        await release(outcome.succeeded);
      } catch (err) {
        errors.push(err);
      }
    }),
  );
  if (errors.length > 0) throw errors[0];
  if (outcome.succeeded === false) throw outcome.error;
  return outcome.result;
}
