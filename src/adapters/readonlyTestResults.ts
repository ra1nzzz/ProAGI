import { sha256 } from '../domain/canonical';
import {
  materializeReadonlyBehaviorEvents, parseReadonlyInput, READONLY_ADAPTER_ID, READONLY_ADAPTER_VERSION,
  type ReadonlyInputOptions, type ReadonlyMaterializationOptions,
} from '../domain/readonlySource';
import type { ReadonlyAdapterPreview, ReadonlyObservationAdapter } from '../application/ports';
export type { ReadonlyAdapterPreview } from '../application/ports';

/** M2's one real-source adapter; raw source bytes never leave preview ownership. */
export class ReadonlyTestResultsAdapter implements ReadonlyObservationAdapter {
  readonly id = READONLY_ADAPTER_ID;
  readonly version = READONLY_ADAPTER_VERSION;

  preview(utf8: string, input: ReadonlyInputOptions & ReadonlyMaterializationOptions): ReadonlyAdapterPreview {
    const parsed = parseReadonlyInput(utf8, input);
    return Object.freeze({ inputHash: sha256(utf8), parsed, events: materializeReadonlyBehaviorEvents(parsed, input) });
  }
}

export { materializeReadonlyBehaviorEvents, parseReadonlyInput } from '../domain/readonlySource';
