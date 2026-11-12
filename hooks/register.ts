import { registerMod, type AddHook, type PluginOptions } from '../node_modules/@cmodjs/core/register.js'
import { rulebook } from '../src/mod.js'

export function register(addHook: AddHook, options: PluginOptions): void {
  registerMod(addHook, rulebook, options)
}
