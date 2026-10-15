import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('loads the Vite configuration in plain Node without importing the sensor implementation', () => {
  // Vitest transforms TS itself; a separate Node process catches config-loading failures it can hide.
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { loadConfigFromFile } from 'vite';
    const result = await loadConfigFromFile({ command: 'serve', mode: 'development' }, 'apps/experiment-app/vite.config.ts');
    if (!result) throw new Error('Vite configuration was not loaded');
    console.log('config-loaded');
  `], { cwd: fileURLToPath(new URL('../../../', import.meta.url)), encoding: 'utf8', timeout: 10000 })
  expect(output.trim()).toBe('config-loaded')
})
