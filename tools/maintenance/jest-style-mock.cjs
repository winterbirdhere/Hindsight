// Preserve CSS-module class names without loading styles into the test environment.
module.exports = new Proxy({}, {
  get(_target, key) {
    return key === "__esModule" ? false : key;
  },
});
