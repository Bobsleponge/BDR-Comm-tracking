#!/usr/bin/env node
const os = require('os');
const ifaces = os.networkInterfaces();
for (const iface of Object.values(ifaces).flat()) {
  if (iface.family === 'IPv4' && !iface.internal) {
    console.log('\n  📱 Local network: http://' + iface.address + ':3000\n');
    break;
  }
}
