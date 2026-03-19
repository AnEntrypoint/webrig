const path = require('path')
const electronPath = process.platform === 'win32'
  ? path.join(__dirname, 'node_modules/electron/dist/electron.exe')
  : path.join(__dirname, 'node_modules/.bin/electron')

module.exports = {
  apps: [{
    name: 'webrig',
    script: electronPath,
    args: '. --remote-debugging-port=9229 --remote-debugging-address=127.0.0.1',
    cwd: __dirname,
    env_file: '.env',
    autorestart: false,
  }]
}
