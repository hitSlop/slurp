import { createClient } from '../src/index.ts'
import { runConformance } from './conformance-runner.ts'

// The same scenarios every other SDK runs: sdks/conformance/delivery.json.
runConformance({ name: 'js', create: createClient })
