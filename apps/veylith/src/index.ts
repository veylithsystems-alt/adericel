/**
 * Veylith's own deployment, as a library.
 *
 * Exported so the separation can be tested from the outside: a suite builds the
 * product server, hands it this registrar, and checks that the company surface
 * appears and is still bounded by the surface rules. Without an export the only
 * way to test a company deployment would be to start a second process.
 */
export { registerVeylithRoutes } from './routes.js';
