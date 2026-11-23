/** An expected, explainable refusal of a block operation (carries an HTTP status and a stable code). */
export class BlocksError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
