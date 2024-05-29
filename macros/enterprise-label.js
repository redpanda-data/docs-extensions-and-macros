'use strict';

module.exports.register = function (registry) {
  registry.inlineMacro(function () {
    const self = this;
    self.named('enterprise-label');
    self.process((parent, target, attrs) => {
      return `<span class="inline-enterprise-label">Enterprise</span>`;
    });
  });
};
