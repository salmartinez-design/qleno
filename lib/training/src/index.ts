/**
 * @workspace/training
 *
 * Server-side LMS helpers. Currently exports the server-authoritative
 * answer key; intended to grow with anything else the API needs but the
 * client must NOT see (e.g., webhook signing keys for LMS events).
 */
export * from "./answer-key";
