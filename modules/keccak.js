const { Keccak, KeccakRand } = require('../util/keccak');
const { promises: fsP } = require('fs');

const STATE_SYNC_CHANNEL = '#hellomouse-botwar';
const STATE_SYNC_INTERVAL = 15 * 60 * 1000;
const KECCAK_BITRATE = 512;

module.exports = function load(bot) {
  let keccak = new Keccak(12);
  let keccakRand = new KeccakRand(keccak, KECCAK_BITRATE);
  let state = {
    keccak,
    keccakRand,
    randomBytes: keccakRand.bytes.bind(keccakRand),
    randomTimer: null,
    randomFd: null,
    syncInterval: null,
    lastSync: 0,
    syncLeader: false
  };

  if (Object.prototype.hasOwnProperty.call(bot.config.modules, 'keccak.js')) {
    let prev = bot.config.modules['keccak.js'];
    // restore old state
    if (prev?.keccak?.state) state.keccak.state = prev.keccak.state;
    if (prev?.randomTimer) clearTimeout(prev.randomTimer);
    if (prev?.randomFd) prev.randomFd.close();
    if (prev?.syncInterval) clearInterval(prev.syncInterval);
    if (prev?.lastSync) state.lastSync = prev.lastSync;
  }

  // write irc messages to keccak, because why not
  bot.events.on('data', data => {
    let writeTimeBuf = Buffer.alloc(4);
    writeTimeBuf.writeUInt32LE(process.hrtime()[1]);
    keccakRand.write(writeTimeBuf);
    keccakRand.write(data);
  });

  async function randomStuff() {
    let time1 = process.hrtime()[1];
    let readBuf = Buffer.allocUnsafe(keccakRand.byterate);
    let writeBuf = keccakRand.bytesDirect(keccakRand.byterate);
    await Promise.all([
      state.randomFd.read(readBuf, 0, readBuf.length, null),
      state.randomFd.write(writeBuf)
    ]);
    keccakRand.seedDirect(readBuf);
    let timeBuf = keccakRand.bytes(2);
    let time = timeBuf.readUInt16BE();
    let time2 = process.hrtime()[1];
    if (time2 < time1) time2 += 1e9;
    let writeTimeBuf = Buffer.alloc(4);
    writeTimeBuf.writeUInt32LE(time2 - time1);
    keccakRand.write(writeTimeBuf);
    state.randomTimer = setTimeout(randomStuff, time * 10);
  }

  (async () => {
    state.randomFd = await fsP.open('/dev/urandom', 'r+');
    state.randomTimer = setTimeout(randomStuff);
  })();

  if (STATE_SYNC_CHANNEL) {
    state.syncInterval = setInterval(() => {
      if (!state.syncLeader && state.lastSync + STATE_SYNC_INTERVAL * 1.5 < Date.now()) {
        // existing leader is gone, 75% chance to become leader
        if (keccakRand.float() < 0.75) state.syncLeader = true;
      }
      if (state.syncLeader) {
        let s = keccakRand.bytes(64).toString('base64');
        bot.sendMsg(STATE_SYNC_CHANNEL, '!do-random-sync ' + s);
        state.lastSync = Date.now();
      }
    }, STATE_SYNC_INTERVAL);
  }

  // let sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  bot.privmsg.on(STATE_SYNC_CHANNEL, async event => {
    if (event.args.join(' ').includes('!do-random-sync')) {
      // someone else has assumed leader role
      state.syncLeader = false;
      state.lastSync = Date.now();
      let entropy = keccakRand.bytes(64).toString('base64');
      /*
      if (event.args.join(' ').replace(/[^a-zA-Z\s\/]/g, '').toLowerCase().includes('/dev/jeda')) {
        let [rand, delayMaybe] = keccakRand.floatMany(2);
        if (delayMaybe < 0.1) await sleep(delayMaybe * 100 * 1000);
        let offset = 0;
        if (rand < (offset += 0.25)) {
          // do nothing
        } else if (rand < (offset += 0.25)) {
          // everything is normal, somewhat
          event.sendBack('!random-sync ' + entropy);
          if (delayMaybe < 0.3) {
            await sleep(delayMaybe * 1000 * 1000);
            let moreEntropy = keccakRand.bytes(64).toString('base64');
            event.sendBack('!do-random-sync ' + moreEntropy);
          }
        } else if (rand < (offset += 0.25)) {
          // slightly normal
          event.sendBack('!do-random-sync ' + entropy);
        } else if (rand < (offset += 0.25)) {
          // fun
          let amount = Math.floor(keccakRand.float() * 192) + 32;
          let moreEntropy = keccakRand.bytes(Kamount).toString('base64');
          event.sendBack('!do-random-sync ' + moreEntropy)
        }
        return;
      }
      */
      event.sendBack('!random-sync ' + entropy);
    }
  });

  // fun
  Math.random = keccakRand.float.bind(keccakRand);

  bot.addCmd('random', 'keccak', event => {
    let args = event.args.map(a => a.toLowerCase());
    let short = false;
    let decimal = false;
    let encoding = 'hex';
    while (args.length) {
      switch (args.pop()) {
        case 'short': short = true; break;
        case 'long': short = false; break;
        case 'hex': decimal = false; encoding = 'hex'; break;
        case 'base64': decimal = false; encoding = 'base64'; break;
        case 'decimal': decimal = true; break;
        default: break;
      }
    }

    if (!decimal) {
      let length = 0;
      if (short) length = 8;
      else length = 64
      event.sendBack(keccak.squeeze(KECCAK_BITRATE, length).toString(encoding));
    } else {
      let rawState = new Uint32Array(keccak._buffer, 0, KECCAK_BITRATE / 32);
      if (short) rawState = rawState.subarray(0, 2);
      event.sendBack(
        rawState
        .reduce((acc, val, idx) => acc | (BigInt(val) << BigInt(idx * 32)), 0n)
        .toString()
      );
      keccak.keccakf();
    }
  }, 'a random 64-bit number, usage: random [short|long] [hex|decimal|base64]');

  bot.addCmd('roll', 'keccak', event => {
    let dice = event.args.map(m => {
      let spec = m.split('d');
      let count;
      if (spec[0].length) count = +spec[0];
      else count = 1;
      let sides = +spec[1];
      if (!Number.isFinite(count) || !Number.isFinite(sides)) return null;
      count = Math.floor(count);
      sides = Math.floor(sides);
      if (count <= 0 || count > 100) return null;
      if (sides <= 0 || sides > 1e9) return null;
      return [count, sides];
    }).filter(Boolean).slice(0, 5);
    for (let [count, sides] of dice) {
      let source = keccakRand.floatMany(count);
      let results = [];
      for (let pick of source) {
        let result = Math.floor(pick * sides) + 1;
        results.push(result);
      }
      event.sendBack(`\x02${count}d${sides}\x02: ${results.join(' ')}`);
    }
  }, 'roll dice, <count>d<sides>');

  return state;
};
