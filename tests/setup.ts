import { setDefaultSink } from '../src/log.js'

// Keep the suite off the real log file at ~/.local/state/deckd/deckd.log.
// Any module that uses the shared `log` would otherwise write to the user's
// home directory during a test run.
setDefaultSink(() => {})
