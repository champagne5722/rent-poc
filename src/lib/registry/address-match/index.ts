export { normalizeAddress } from './normalize';
export type { AddressParts, NormalizedAddress } from './normalize';
export {
  DEFAULT_DISTANCE_THRESHOLD_METERS,
  detectSuspectedDuplicate,
  findSuspectedDuplicates,
  haversineMeters,
} from './match';
export type {
  BatchMatch,
  Coordinate,
  DuplicateMatchOptions,
  DuplicateMatchResult,
  DuplicateReason,
  RegistryAddress,
} from './match';
