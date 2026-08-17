/**
 * A stand-in for Next's `server-only` package.
 *
 * That package exists to make a build fail if server code is imported into a
 * client bundle. It has no runtime behaviour and no presence outside a Next
 * build, so importing it from a test resolves to nothing at all.
 */
export {};
