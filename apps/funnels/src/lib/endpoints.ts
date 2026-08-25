/**
 * The runtime's own endpoints.
 *
 * A spec carries `submit.endpointPath` as authored data, but the runtime does
 * not follow it: the route that exists is the route this app implements, and
 * letting a stored document point the browser somewhere else is an open
 * redirect with extra steps. The spec value stays useful as documentation of
 * intent and is validated at publish time; the wire target is decided here.
 */
export const SUBMIT_ENDPOINT = '/api/submit';
export const COLLECT_ENDPOINT = '/api/collect';

/** Anchor the in-page CTAs of a hybrid page jump to. */
export const FORM_ANCHOR = 'formular';
