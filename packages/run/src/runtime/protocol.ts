import type {
  NormalizedRunOptions,
  RunDeterminismState,
  SerializableError,
} from '../types.js';

export interface WorkerRunMessage {
  type: 'run';
  invocationId: string;
  source: string;
  hostFunctionNamespaces: string[];
  determinism: RunDeterminismState;
  options: Pick<
    NormalizedRunOptions,
    | 'timeoutMs'
    | 'memoryLimitBytes'
    | 'maxStackSizeBytes'
    | 'maxResultBytes'
    | 'maxConsoleOutputBytes'
    | 'maxHostFunctionInputBytes'
  > & {
    executionTimeoutMs: number;
  };
}

export interface WorkerCancelMessage {
  type: 'cancel';
  invocationId: string;
}

export interface WorkerHostFunctionRequest {
  type: 'host-function-request';
  invocationId: string;
  requestId: string;
  hostFunctionName: string;
  inputJson: string;
}

export interface WorkerBridgeResponse {
  type: 'bridge-response';
  invocationId: string;
  requestId: string;
  success: boolean;
  dateNowMs: number;
  valueJson?: string;
  error?: SerializableError;
}

export interface WorkerResultMessage {
  type: 'result';
  invocationId: string;
  success: boolean;
  valueJson?: string;
  error?: SerializableError;
}

export interface WorkerReadyMessage {
  type: 'ready';
  invocationId: string;
}

export interface WorkerBridgeIdleMessage {
  type: 'bridge-idle';
  invocationId: string;
  requestCount: number;
}

export type WorkerToMainMessage =
  | WorkerHostFunctionRequest
  | WorkerBridgeIdleMessage
  | WorkerResultMessage
  | WorkerReadyMessage;

export type MainToWorkerMessage =
  | WorkerRunMessage
  | WorkerCancelMessage
  | WorkerBridgeResponse;
