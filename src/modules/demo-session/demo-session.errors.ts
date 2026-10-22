export class DemoSessionError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
  ) { super(message); }
}

export class DemoSessionUnavailableError extends DemoSessionError {
  constructor() { super('DEMO_SESSION_UNAVAILABLE', 401, 'Demo session unavailable'); }
}

export class DemoResourceUnavailableError extends DemoSessionError {
  constructor() { super('DEMO_RESOURCE_UNAVAILABLE', 404, 'Demo resource unavailable'); }
}

export class DemoSessionQueueFullError extends DemoSessionError {
  constructor() { super('DEMO_SESSION_QUEUE_FULL', 429, 'Demo session queue capacity reached'); }
}
