import { sha256 } from '../domain/canonical';
import {
  materializeReadonlyBehaviorEvents, parseReadonlyInput, READONLY_ADAPTER_ID, READONLY_ADAPTER_VERSION,
  type ReadonlyInputOptions, type ReadonlyMaterializationOptions, type ReadonlyParseResult,
} from '../domain/readonlySource';
import type { BehaviorEvent, Hash } from '../domain/types';

export interface ReadonlyAdapterPreview {
  readonly inputHash: Hash;
  readonly parsed: ReadonlyParseResult;
  readonly events: readonly BehaviorEvent[];
}

/** M2's one real-source adapter; raw source bytes never leave preview ownership. */
export class ReadonlyTestResultsAdapter {
  readonly id = READONLY_ADAPTER_ID;
  readonly version = READONLY_ADAPTER_VERSION;

  preview(utf8: string, input: ReadonlyInputOptions & ReadonlyMaterializationOptions): ReadonlyAdapterPreview {
    const parsed = parseReadonlyInput(utf8, input);
    return Object.freeze({ inputHash: sha256(utf8), parsed, events: materializeReadonlyBehaviorEvents(parsed, input) });
  }
}

export { materializeReadonlyBehaviorEvents, parseReadonlyInput } from '../domain/readonlySource';
