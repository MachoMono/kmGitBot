'use strict';
module.exports = {
  testDir: __dirname,
  testMatch: /.*\.spec\.js/,
  timeout: 120000,
  workers: 1,
  reporter: [['list']],
  expect: { timeout: 15000 },
};
