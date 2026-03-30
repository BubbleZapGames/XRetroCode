// Intercept `require('vscode')` before any extension code loads.
// Mocha loads this via --require flag.
const Module = require('module');
const path = require('path');

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function(request: string, parent: any, isMain: boolean, options: any) {
  if (request === 'vscode') {
    return path.resolve(__dirname, 'vscode-mock.js');
  }
  return originalResolve.call(this, request, parent, isMain, options);
};
