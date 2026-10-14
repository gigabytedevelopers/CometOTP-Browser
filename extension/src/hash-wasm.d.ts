// hash-wasm's ES module build, which the extension imports by file: browsers load it as it is
// published (the build copies it to lib/hash-wasm/), and Node runs it as a module in the tests.
// Its types are the package's own.
declare module 'hash-wasm/dist/index.esm.js' {
  export { argon2id } from 'hash-wasm';
}
