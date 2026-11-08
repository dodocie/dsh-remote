/**
 * Re-export DSH Mobile's host half so this bundle owns the component.
 *
 * DSH publishes the browser bundle of whichever package an entry points at. By
 * pointing our patch at this file instead of at `dsh-mobile`, its gateway still
 * runs while its own sidebar entry never reaches the app — no fork, no copy of
 * upstream code, and upstream fixes arrive with a version bump.
 */
export { apply, name, inject, Config } from 'dsh-mobile';
