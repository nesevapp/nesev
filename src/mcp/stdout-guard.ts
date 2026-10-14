// stdout belongs to the MCP protocol (one JSON-RPC message per line). Some server modules log with console.log,
// so route console.log/info/debug to stderr. server.ts imports this module FIRST: ES modules evaluate in import
// order, so the redirect is in place before any server module runs.

const toStderr = (...args: unknown[]) => console.error(...args);
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;

export {};
