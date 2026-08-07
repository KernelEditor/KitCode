import pkg from '../package.json' with { type: 'json' }

declare const __KITCODE_COMMIT__: string

export const KITCODE_VERSION = pkg.version
export const KITCODE_REPOSITORY = 'KernelEditor/KitCode'
export const KITCODE_COMMIT =
  typeof __KITCODE_COMMIT__ === 'string' && __KITCODE_COMMIT__ !== ''
    ? __KITCODE_COMMIT__
    : 'development'
