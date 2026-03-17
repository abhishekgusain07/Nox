export type DomainError =
  | { readonly tag: "TaskNotFound"; readonly taskId: string }
  | { readonly tag: "QueueNotFound"; readonly queueId: string }
  | { readonly tag: "RunNotFound"; readonly runId: string }
  | { readonly tag: "QueuePaused"; readonly queueId: string }
  | { readonly tag: "InvalidTransition"; readonly from: string; readonly to: string }
  | { readonly tag: "DuplicateIdempotencyKey"; readonly key: string }
  | { readonly tag: "StaleVersion"; readonly runId: string; readonly expected: number; readonly actual: number }
  | { readonly tag: "ValidationError"; readonly message: string };

export const domainError = {
  taskNotFound: (taskId: string): DomainError => ({ tag: "TaskNotFound", taskId }),
  queueNotFound: (queueId: string): DomainError => ({ tag: "QueueNotFound", queueId }),
  runNotFound: (runId: string): DomainError => ({ tag: "RunNotFound", runId }),
  queuePaused: (queueId: string): DomainError => ({ tag: "QueuePaused", queueId }),
  invalidTransition: (from: string, to: string): DomainError => ({ tag: "InvalidTransition", from, to }),
  duplicateIdempotencyKey: (key: string): DomainError => ({ tag: "DuplicateIdempotencyKey", key }),
  staleVersion: (runId: string, expected: number, actual: number): DomainError => ({ tag: "StaleVersion", runId, expected, actual }),
  validationError: (message: string): DomainError => ({ tag: "ValidationError", message }),
};
