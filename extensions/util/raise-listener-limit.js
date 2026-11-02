'use strict'

// Antora's GeneratorContext is one shared EventEmitter for every registered
// extension, and Redpanda playbooks register enough of them that per-event
// listener counts legitimately exceed Node's default threshold of 10. Node
// then prints MaxListenersExceededWarning ("Possible EventEmitter memory
// leak detected. 11 contentClassified listeners added to [GeneratorContext]")
// in build logs even though each extension adds exactly one listener per
// event per build.
//
// Every extension in this package raises the limit before subscribing, so
// the suppression holds no matter which subset of extensions a playbook
// registers or in what order. The cap is bounded rather than unlimited (0)
// to keep Node's leak detection meaningful for pathological cases.
const GENERATOR_CONTEXT_MAX_LISTENERS = 64

function raiseListenerLimit (context) {
  if (
    typeof context.getMaxListeners === 'function' &&
    typeof context.setMaxListeners === 'function' &&
    context.getMaxListeners() !== 0 &&
    context.getMaxListeners() < GENERATOR_CONTEXT_MAX_LISTENERS
  ) {
    context.setMaxListeners(GENERATOR_CONTEXT_MAX_LISTENERS)
  }
}

module.exports = { raiseListenerLimit, GENERATOR_CONTEXT_MAX_LISTENERS }
