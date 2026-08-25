import userEvent from '@testing-library/user-event';

/**
 * jsdom gaps that Radix and the command list rely on.
 *
 * The workspace setup file already provides `matchMedia` and `ResizeObserver`;
 * these are the extras this package needs. Call once at the top of a test file.
 */
export function installDomPolyfills(): void {
  if (typeof Element === 'undefined') return;

  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function scrollIntoView() {};
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = function hasPointerCapture() {
      return false;
    };
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = function setPointerCapture() {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = function releasePointerCapture() {};
  }
}

/**
 * A user-event instance with the pointer-events guard switched off: Radix sets
 * `pointer-events: none` on the body while a modal layer is open, which the
 * guard would otherwise reject even though a real user can click fine.
 */
export function createUser(): ReturnType<typeof userEvent.setup> {
  return userEvent.setup({ pointerEventsCheck: 0 });
}
