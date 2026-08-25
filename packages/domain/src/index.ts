/**
 * `@am/domain` — the shared contract of the A&M Marketing OS.
 *
 * Every other package depends on this one and nothing here depends on anything
 * else in the workspace. Types, enums and Zod schemas live together on purpose:
 * one definition drives runtime validation, database shapes, AI structured
 * outputs and the UI.
 */
export * from './ids';
export * from './enums';
export * from './primitives';
export * from './roles';
export * from './metrics';
export * from './campaign';
export * from './events';
export * from './attribution';
export * from './sales';
export * from './outbox';
export * from './errors';
export * from './experiments';
export * from './recommendations';
export * from './knowledge';
export * from './integrations';
export * from './audit';
export * from './approvals';
export * from './launch-qa';
export * from './consent';
