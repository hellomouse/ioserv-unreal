// @ts-check
"use strict";
// throw new Iovoid([]+!![]);
const EventEmitter = require('events');
const net = require('net');
const tls = require('tls');
const util = require('util');
const ipaddr = require('ipaddr.js');
// function to create new EventEmitter with unlimited max listeners
// function newEvent() {return new EventEmitter().setMaxListeners(0);}

// TYPE DEFINITIONS
/**
 * @typedef {object} Server
 * @property {string} name Server name
 * @property {string} sid Server SID
 * @property {string} description
 * @property {string} version
 * @property {Set<Server>} children
 * @property {Server | null} parent
 * @property {Set<Client>} clients
 * @property {Map<string, string>} metadata
 */

/**
 * @typedef {object} Client
 * @property {string} uid
 * @property {string} nick
 * @property {string} ident
 * @property {string} host
 * @property {string} realname
 * @property {string} servicesData
 * @property {string} modes
 * @property {number} ts
 * @property {Server} server
 * @property {string | null} vhost
 * @property {string | null} chost
 * @property {ipaddr.IPv4 | ipaddr.IPv6 | null} ip
 * @property {string | null} account
 * @property {Set<string>} channels
 * @property {Map<string, string>} metadata
 * @property {Map<string, string>} metadata_membership
 */

/** just... don't bother, really */ // eslint-disable-line
function ircbot(config) {
  // this.version = "0.0.1";
  this.events = new EventEmitter(); // main events
  this.servmsg = new EventEmitter(); // server message
  this.privmsg = new EventEmitter(); // message to channel/user, not currently useful yet
  this.encapmsg = new EventEmitter();
  this.userEvent = new EventEmitter();
  let bot = this;
  this.server = {
    datapart: "",
    clients: new Map(),
    clientsByNick: new Map(),
    servers: new Map(),
    channels: new Map(),
    protoctl: new Map(),
    /** @type {Server | null} */
    remoteServer: null,
    preRegistrationSASL: new Map(),
    tkl: new Map(),
  };
  let ownServer = this._makeServer({
    name: config.sname,
    sid: config.sid,
    description: config.sdesc,
    version: 'IoServ'
  });
  this.client = {
    users: new Map(),
    uid: 1,
    capab: ["NOQUIT", "NICKv2", "SJOIN", "SJ3", "CLK", "TKLEXT", "TKLEXT2", "NICKIP", "ESVID", "MLOCK", "EXTSWHOIS"],
    ownServer,
    get sid() {
      return bot.client.ownServer.sid;
    },
    botUser: config.botUser,
    registered: false
  };
  this.client.ownServer = ownServer;
  this.config = config;
  this.cmds = Object.create(null);
  this.cmdgroups = Object.create(null);
  this.channels = Object.create(null);
  this.ctcp = Object.create(null);
  this.sendMsgQueue = [];
  this.sendCount = 0;
  // TODO: this is garbage, fix it
  // is it necessary to support non-tls connections?
  this.baseSocket = new net.Socket();
  let secureContext = tls.createSecureContext({ cert: config.cert, key: config.certkey });
  this.ircsock = new tls.TLSSocket(this.baseSocket, {
    secureContext,
    rejectUnauthorized: config.rejectUnauthorized
  });
  this.ircsock.on('connect', function() {
    console.log('Connected to server!');
    bot.send(`PASS :${config.password}`);
    bot.send(`PROTOCTL EAUTH=${config.sname},5002 SID=${bot.client.sid}`);
    bot.send(`PROTOCTL SERVERS=${bot.client.sid}`);
    bot.send(`PROTOCTL ${bot.client.capab.join(" ")}`);
    bot.send(`SERVER ${config.sname} 1 :${config.sdesc}`);
  }).on('data', function(data) {
    // TODO: this is beyond horrible, use irc-stream-parser or something and
    // fix the stupid head/msg crap
    var data = data.toString('utf-8');
    if (!data.endsWith('\n')) {
      bot.server.datapart = bot.server.datapart + data;
      return false;
    } else {
      data = (bot.server.datapart + data).replace(/(\r|\n)+$/,'');
      bot.server.datapart = '';
    }
    for (var line of data.split('\n')) {
      line = line.replace(/\r$/,'');
      bot.events.emit('data', line);
    }
  }).on('close', function() {
    console.log('[WARN] Connection closed.');
    bot.events.emit('connclosed');
  });

  // start expired cleanup timer
  this._cleanupExpired();
}
ircbot.prototype = {
  Command: require('./command'),
  PrivateMessageEvent: require('./pmevent'),
  addCmd(name,group,code,help,canExec,hidden) {
    this.cmds[name] = new this.Command(group,code,help,canExec);
    if (!hidden) {
      if (!this.cmdgroups[group]) {
        this.cmdgroups[group] = [];
      }
      if (this.cmdgroups[group].indexOf(name) == -1) {
        this.cmdgroups[group].push(name);
      }
    }
  },
  send(data) {
    this.ircsock.write(data + '\r\n');
    console.log('[SEND] ' + data);
  },
  _sendMsg(chan,src,msg) {
    this.send(`:${src} PRIVMSG ${chan} :${msg}`);
  },
  sendMsg(chan,msg,src,trunc) {
    if (!this.client.registered) return;
    src = src || this.client.botUser.uid;
    let srcUser = this.getUser(src);
    // seems like sane fallback but idk
    if (!srcUser) srcUser = bot.getUser(this.client.botUser.uid);
    if (chan === undefined || msg === undefined) throw new Error("Channel/message are required");
    msg = msg.toString();
    if (msg.match(/[\r\n]/)) {
      msg.split(/(?:\r\n)|[\r\n]/).forEach(line => this.sendMsg(chan,line,src,trunc));
      return;
    }
    if (msg == '') msg = ' ';
    // TODO: actually calculate length properly
    // 512 byte max length, 16 bytes for ":!@ PRIVMSG  :\r\n"
    let maxlen = 512 - 16 - srcUser.nick.length - srcUser.ident.length - srcUser.host.length - chan.length;
    if (msg.length > maxlen) {
      if (trunc) {
        this._sendMsg(chan,src,msg.slice(0,maxlen-21)+' \x02(message truncated)');
      } else {
        for (let i = 0; i <= msg.length; i += maxlen) {
          this._sendMsg(chan, src, msg.slice(i, i + maxlen));
        }
      }
    } else {
      this._sendMsg(chan,src,msg);
    }
    this.events.emit('msg');
  },
  mode(chan,mode,src) {
    src = src || this.client.sid;
    let channel = this.getChannel(chan);
    if (!channel) return;
    this.send(`:${src} MODE ${channel.name} ${mode} ${channel.ts}`);
  },
  kick(chan,nick,reason,src) {
    let user = this.getUser(nick);
    let channel = this.getChannel(chan);
    if (!user || !channel) return;
    src = src || this.client.botUser.uid;
    this.send(`:${src} KICK ${channel.name} ${user.uid} :${reason}`);
    this._handleChannelPart(channel, user);
  },
  /**
   * Handle removal of user
   * @param {Client} client
   */
  _handleRemoveClient(client) {
    if (!client) return;
    let uid = client.uid;
    for (let c of client.channels) {
      let channel = this.getChannel(c);
      if (channel) channel.users.delete(uid);
    }
    client.server.clients.delete(client);
    this.server.clients.delete(uid);
    this.client.users.delete(uid); // may not exist
    this.server.clientsByNick.delete(client.nick.toLowerCase());
  },
  kill(name, reason, src) {
    let user = this.getUser(name);
    if (user.server === this.client.ownServer) return false;
    if (!user) return false;
    if (!reason || !reason.length) reason = 'Killed';
    src = src || this.client.botUser.uid;
    this.send(`:${src} KILL ${user.uid} :${reason}`);
    this._handleRemoveClient(user);
    return true;
  },
  sendNotice(chan,src,msg,ctcp) {
    src = src || this.config.bname;
    if (ctcp) {
      this.send(':'+src+' NOTICE '+chan+' :\x01'+msg+'\x01');
    } else {
      this.send(':'+src+' NOTICE '+chan+' :'+msg);
    }
  },
  /*
  whois: util.deprecate(function whois(nick, cb) {
    if (this.getUser(nick)) return cb(null, user.ident, user.host, user.realname, user.nick, user.uid);
    cb(new Error('User not found!'));
  }, 'bot.whois is deprecated in IoServ, use bot.getUser instead'),
  */
  getUserByNick(nick) {
    let user = this.server.clientsByNick.get(nick.toLowerCase());
    return user || null;
  },
  getUser(nickOrUID) {
    if (!nickOrUID) throw new Error('argument cannot be undefined');
    if (typeof nickOrUID === 'object') return this.server.clients.get(nickOrUID.uid) || null;
    if (nickOrUID[0].match(/\d/)) return this.server.clients.get(nickOrUID) || null;
    else return this.getUserByNick(nickOrUID);
  },
  /**
   * Get server
   * @param {string | Server} nameOrSID
   * @return {Server | null}
   */
  getServer(nameOrSID) {
    if (!nameOrSID) throw new Error('argument cannot be undefined');
    if (typeof nameOrSID === 'object') return this.server.servers.get(nameOrSID.sid) || null;
    if (nameOrSID[0].match(/\d/) && nameOrSID.length === 3) {
      return this.server.servers.get(nameOrSID) || null;
    }
    let lowerName = nameOrSID.toLowerCase();
    for (let [_sid, server] of this.server.servers) {
      if (server.name.toLowerCase() === lowerName) return server;
    }
    return null;
  },
  /**
   * Test if string is valid SID
   * @param {string} str
   * @return {boolean}
   */
  isSID(str) {
    return Boolean(/^\d[\dA-Z]{2}$/.test(str));
  },
  isTrustedServer(serv) { // Only trust the parent server
    let server = this.getServer(serv);
    if (!server) return false; // Not even a server
    return this.client.ownServer.parent?.sid === server.sid;
  },
  changeHost(nickOrUID, host) {
    if (host.match(/\s/)) throw new Error('invalid hostname');
    let user = this.getUser(nickOrUID);
    user.host = host;
    this.send(`:${this.client.sid} CHGHOST ${user.uid} :${host}`);
  },
  changeIdent(nickOrUID, ident) {
    if (ident.match(/s/)) throw new Error('invalid ident');
    let user = this.getUser(nickOrUID);
    user.ident = ident;
    this.send(`:${this.client.sid} CHGIDENT ${user.uid} ${user.ident}`);
  },
  squit(name, reason = '') {
    let server = this.getServer(name);
    if (!server) return;
    this.send(`SQUIT ${server.name} :${reason}`);
    this._handleRemoveServer(server);
  },
  introduceServer(sid, name, description = 'IoServ') {
    if (!this.isSID(sid)) throw new Error('invalid SID');
    if (this.server.servers.has(sid)) throw new Error('sid already exists');
    if (this.getServer(name)) throw new Error('server name already exists');
    let server = this._makeServer({
      sid, name, description,
      version: 'IoServ'
    });
    server.parent = this.client.ownServer;
    this.client.ownServer.children.add(server);
    this.send(`:${this.client.sid} SID ${name} 2 ${sid} :${description}`);
    this.send(`:${sid} EOS`);
    return server;
  },
  getChannel(name) {
    return this.server.channels.get(name.toLowerCase()) || null;
  },
  // classes are hard. plus, this is old code
  _makeChannel(name, ts) {
    let c = {
      name,
      ts,
      users: new Map(),
      metadata: new Map(), // varname=>value channel metadata set by MD
      member_metadata: new Map(), // user=>varname=>value member metadata set by MD
      // TODO: modes when i get off my ass
    };
    this.server.channels.set(name.toLowerCase(), c);
    return c;
  },
  /**
   * Create Client object
   * @param {object} descriptor
   * @param {string} descriptor.uid
   * @param {string} descriptor.nick
   * @param {string} descriptor.ident
   * @param {string} descriptor.host
   * @param {string} descriptor.realname
   * @param {string} descriptor.servicesData
   * @param {string} descriptor.modes
   * @param {number} descriptor.ts
   * @param {Server} descriptor.server
   * @param {string} [descriptor.vhost]
   * @param {string} [descriptor.chost]
   * @param {ipaddr.IPv4 | ipaddr.IPv6} [descriptor.ip]
   * @return {Client}
   */
  _makeClient({
    uid, nick, ident, host, realname, modes, ts, server,
    vhost = '*', chost = '*', ip = null, servicesData = '0'
  }) {
    /** @type {Client} */
    let c = {
      uid, nick, ident, host, realname, modes, ts, server, vhost, chost, ip, servicesData,
      account: null,
      channels: new Set(),
      metadata: new Map(), // varname=>value metadata set by MD
      metadata_membership: new Map(), // channel_varname=>value membership metadata set by MD
    };
    server?.clients.add(c);
    this.server.clients.set(uid, c);
    this.server.clientsByNick.set(c.nick.toLowerCase(), c);
    return c;
  },
  /**
   * Create Server object
   * @param {object} descriptor
   * @param {string} descriptor.name
   * @param {string} descriptor.sid
   * @param {string} descriptor.description
   * @param {string} descriptor.version
   * @return {Server}
   */
  _makeServer({ name, sid, description, version = 'unknown' }) {
    /** @type {Server} */
    let s = {
      name, sid, description, version,
      children: new Set(),
      parent: null, // to be filled later
      clients: new Set(),
      metadata: new Map()
    };
    this.server.servers.set(s.sid, s);
    return s;
  },
  _handleChannelPart(channel, user) {
    if (!channel || !user) return;
    channel.users.delete(user.uid);
    if (!channel.users.size) this.server.channels.delete(channel.name.toLowerCase());
  },
  _handleNickChange(user, newNick, ts) {
    if (!user) return;
    this.server.clientsByNick.delete(user.nick.toLowerCase());
    user.nick = newNick;
    user.ts = ts;
    this.server.clientsByNick.set(user.nick.toLowerCase(), user);
  },
  /**
   * Handle removal of server
   * @param {Server | null} [server]
   */
  _handleRemoveServer(server) {
    if (!server) return;
    // remove children first
    for (let child of server.children) {
      this._handleRemoveServer(child);
    }
    // remove all clients
    for (let client of server.clients) {
      this._handleRemoveClient(client);
    }
    // detach self from tree
    server.parent?.children.delete(server);
    this.server.servers.delete(server.sid);
  },
  /**
   * Makes new UID
   * @return {string}
   */
  makeUID() {
    // TODO: check if uid already exists, extremely unlikely but meh
    let uid = (this.client.uid++%1e6).toString(16);
    return (this.client.sid+"0".repeat(Math.abs(6-uid.length))+uid).toUpperCase();
  },
  /**
   * Get current TS
   * @return {number}
   */
  getTS() {
    return Math.floor(Date.now() / 1000);
  },
  // addUser(nick,ident,host,modes,realname) {
  addUser({
    nick,
    ident = this.config.sdesc,
    host = this.config.sname,
    modes = 'zi',
    realname = this.config.sdesc,
    servicesData = '0'
  }) {
    if (!nick) throw new Error('nick is required');
    let prevUser = this.getUser(nick);
    if (prevUser) {
      if (prevUser.server === this.client.ownServer) throw new Error('duplicate nick');
      else this.kill(nick, 'y u steal ioserv nick :(', '042');
    }
    let uid = this.makeUID();
    let ts = this.getTS();
    this.send(`:${this.client.sid} UID ${nick} 0 ${ts} ${ident} ${host} ${uid} ${servicesData} +${modes} * * * :${realname}`);
    let client = this._makeClient({
      uid,
      nick,
      ident,
      host,
      realname,
      modes,
      ts,
      server: this.client.ownServer,
      servicesData
    });
    this.client.users.set(uid, client);
    return uid;
  },
  delUser(uid, reason) {
    let user = this.getUser(uid);
    if (!user) return;
    this.send(`:${user.uid} QUIT :${reason || 'Shutting down...'}`);
    this._handleRemoveClient(user);
  },
  changeNick(uidOrNick, newNick, force = false) {
    if (newNick.match(/\s/)) throw new Error('invalid nick');
    let user = this.getUser(uidOrNick);
    if (!user || user.server !== this.client.ownServer) throw new Error('nonlocal user');
    let collided = this.getUser(newNick);
    if (collided) {
      if (!force) throw new Error('nick collision');
      if (collided.server === this.config.sname) this.delUser(collided.uid);
      else this.kill(collided.uid, 'your nick has been stolen by IoServ!');
    }
    let ts = this.getTS();
    this.send(`:${user.uid} NICK ${newNick} ${ts}`);
    this._handleNickChange(user, newNick, ts);
  },
  join(uidOrNick, chan) {
    let user = this.getUser(uidOrNick);
    if (!user || user.server !== this.client.ownServer) return false;
    let channel = this.getChannel(chan);
    if (!channel) channel = this._makeChannel(chan, this.getTS());
    if (channel.users.has(user.uid)) return false;
    channel.users.set(user.uid, '');
    user.channels.add(channel.name);
    this.send(`:${this.client.sid} SJOIN ${channel.ts} ${channel.name} :${user.uid}`);
    return true;
  },
  part(uidOrNick, chan, reason = '') {
    let user = this.getUser(uidOrNick);
    if (!user || user.server !== this.client.ownServer) return;
    let channel = this.getChannel(chan);
    this.send(`:${user.uid} PART ${chan} :${reason}`);
    this._handleChannelPart(channel, user); 
  },
  addTKL(type, ident, host, source = this.client.ownServer.name, expireTS = 0, reason = '') {
    let setTS = this.getTS();
    let key = `${type}/${ident}@${host}`;
    if (this.server.tkl.has(key)) return false;
    let tkl = { type, ident, host, source, setTS, expireTS, reason };
    this.server.tkl.set(key, tkl);
    this.send(`:${this.client.ownServer.name} TKL + ${tkl.type} ${tkl.ident} ${tkl.host} ${tkl.source} ${tkl.expireTS} ${tkl.setTS} :${tkl.reason}`);
    return true;
  },
  removeTKL(type, ident, host, source = this.client.ownServer.name) {
    let key = `${type}/${ident}@${host}`;
    let tkl = this.server.tkl.get(key);
    if (!tkl) return false;
    this.server.tkl.delete(key);
    this.send(`:${this.client.ownServer.name} TKL - ${tkl.type} ${tkl.ident} ${tkl.host} ${source} ${tkl.expireTS} ${tkl.setTS} :${tkl.reason}`);
    return true;
  },
  _start() {
    this.baseSocket.connect({ host: this.config.host, port: this.config.port });
  },
  start() {
    this._start();
    this.init();
    return this;
  },
  _cleanupExpired() {
    let now = this.getTS();
    for (let [key, value] of this.server.preRegistrationSASL) {
      if (value.expires <= now) this.server.preRegistrationSASL.delete(key);
    }
    for (let [key, value] of this.server.tkl) {
      if (value.expireTS !== 0 && value.expireTS <= now) this.server.tkl.delete(key);
    }
    setTimeout(() => this._cleanupExpired(), 5 * 60 * 1000);
  },
  init() {
    let bot = this;
    this.addCmd('echo','general',function(event) {event.reply(event.args.join(' '));},"Echoes something");
    this.addCmd('ping','general',"pong","Requests a pong from the bot");
    this.addCmd('pong','general',"Did you mean ping? Anyways ping","<AegisServer2> It's ping you moron.");
    this.addCmd('eval','general',function(event) {
      try {
        var result = eval(event.args.join(' '));
        util.inspect(result).split('\n').forEach(function(line) {event.sendBack(line);});
      } catch(e) {
        event.sendBack(e.name+': '+e.message);
      }
    },"(level 11) Runs javascript code in the bot",11);
    this.addCmd('flushq','general',function(event) {
      bot.sendMsgQueue.length = 0;
      event.reply("Send queue flushed");
    },"Flushes the send queue");
    this.addCmd('help','general',function(event) {
      if (event.args[0] != undefined) {
        if (bot.cmds[event.args[0]]) {
          event.reply(bot.cmds[event.args[0]].help);
        } else {
          event.reply("That command does not exist!");
        }
      } else {
        event.reply("Use 'help <command>'");
      }
    });
    this.addCmd('list','general',function(event) {
      if (event.args[0]) {
        if (bot.cmdgroups[event.args[0]]) {
          event.reply(bot.cmdgroups[event.args[0]].join(' '));
        } else {
          event.reply("No such group, use list");
        }
      } else {
        event.reply("Command groups (use list <group>): "+Object.keys(bot.cmdgroups).join(' '));
      }
    });

    this.events.on('data', function(line) {
      console.log('[RECV] '+line);
      var dsplit = line.split(' :');
      var head = dsplit[0];
      dsplit.splice(0,1);
      var msg = dsplit.join(' :');
      head = head.split(' ');
      msg = msg.split(' ');
      if (line.startsWith(':')) {
        var from = head[0].replace(/^:/,'');
        head.splice(0,1);
        bot.servmsg.emit(head[0],head,msg,from,line);
      } else {
        var from = false;
        bot.servmsg.emit(head[0],head,msg,from,line);
      }
    });

    this.servmsg.on('PING', function(head,msg,from) {
      bot.send(`:${msg[1] || bot.config.sname} PONG ${msg[1]} ${msg[0]}`);
    }).on('PROTOCTL', (head, msg, from) => {
      let pairs = head.slice(1);
      for (let pair of pairs) {
        let split = pair.split('=');
        if (split.length > 2) split[1] = split.slice(1).join('=');
        bot.server.protoctl.set(split[0], split[1]);
      }
    }).on('SERVER', (head, msg, from) => {
      let remoteName = head[1];
      if (remoteName.toLowerCase() !== bot.config.usname.toLowerCase()) {
        console.error(`[ERROR] Remote server name mismatch: ${remoteName} is not ${bot.config.usname}`);
        process.exit(10);
      }
      let sid = bot.server.protoctl.get('SID');
      if (!sid) throw new Error('expected PROTOCTL to have SID');
      let remoteEAUTH = bot.server.protoctl.get('EAUTH');
      let version = 'unknown';
      if (remoteEAUTH) {
        let parts = remoteEAUTH.split(',');
        if (parts[3]) version = parts[3];
      }
      // the server we are connecting to is the root of the server tree
      let remoteServer = bot._makeServer({
        name: remoteName,
        sid,
        description: msg.slice(1).join(' '),
        version
      });
      bot.server.remoteServer = remoteServer;
      remoteServer.children.add(bot.client.ownServer);
      // add server as own link
      bot.client.ownServer.parent = remoteServer;
    }).on('SINFO', (head, msg, from) => {
      let server = bot.server.servers.get(from);
      if (!server) return;
      server.version = msg.join(' ') || head[6];
    }).on('EOS', (head, msg, from) => {
      if (from !== bot.server.remoteServer.sid) return;
      bot.client.botUser = bot.getUser(bot.addUser(bot.config.botUser));
      bot.send(`:${bot.client.sid} EOS`);
      bot.client.registered = true;
      bot.events.emit('regdone');
    }).on('PRIVMSG', function(head,msg,from,raw) {
      var event = new bot.PrivateMessageEvent(bot,head,msg,from,raw);
      if (!event.valid) return;
      bot.privmsg.emit(event.chan,event);
      bot.events.emit('privmsg',event);
      if (event.type == 'ctcp') {
        if (bot.ctcp[event.cmd]) {
          bot.ctcp[event.cmd](event.args,event.chan,event.host); // use the old api for now
        }
      } else if (event.type == 'command') {
        if (bot.cmds[event.cmd]) {
          try {
            var res = bot.cmds[event.cmd].run(event);
            if (!res && ~res) {
              event.reply("You do not have permission to use this command.");
            }
          } catch(e) {
            if (bot.getChannel(bot.config.logchannel)) {
						    bot.sendMsg(event.chan || bot.config.logchannel,"An error occured while processing your command: "+e);
						    bot.sendMsg(bot.config.logchannel,e.stack);
						    bot.sendMsg(bot.config.logchannel,'Caused by '+event.host[0]+'!'+event.host[1]+'@'+event.host[2]+' using command '+event.cmd+' with arguments ['+event.args.toString()+'] in channel '+event.chan);
					    }
          }
        }
      }
    }).on('UID',function(head,msg,from,raw) {
      let sid = head[6].slice(0, 3);
      let ipEncoded = head[11];
      let ip = null;
      if (ipEncoded !== '*') {
        let buf = Buffer.from(ipEncoded, 'base64');
        ip = ipaddr.fromByteArray(buf);
      }
      let client = bot._makeClient({
        nick: head[1],
        ts: head[3],
        ident: head[4],
        host: head[5],
        uid: head[6],
        servicesData: head[7],
        modes: head[8],
        vhost: head[9],
        chost: head[10],
        ip,
        realname: msg.join(' '),
        server: bot.server.servers.get(sid)
      });
      let sasl = bot.server.preRegistrationSASL.get(client.uid);
      if (sasl) {
        const [authz, authn, passwd] = Buffer.from(sasl.key, "base64").toString().split('\0');
        if (bot.config.userLogin[authz] && bot.config.userLogin[authz] === passwd) client.account = authz;
        bot.server.preRegistrationSASL.delete(head[6]);
      }
      if (client.vhost === '*') client.vhost = null;
      if (client.chost === '*') client.chost = null;
      bot.events.emit('newClient', client);
    }).on('SID', function(head,msg,from) {
      let fromServer = bot.server.servers.get(from);
      if (!fromServer) return;
      let newServer = bot._makeServer({
        name: head[1],
        sid: head[3],
        description: msg.join(' '),
        version: 'unknown'
      });
      newServer.parent = fromServer;
      fromServer.children.add(newServer);
      bot.events.emit('newServer', newServer);
    }).on('SQUIT', (head, msg, from) => {
      let target = bot.getServer(head[1]);
      bot._handleRemoveServer(target);
    }).on('CHGHOST',function(head,msg,from,raw) {
      // is this used in unreal? yes
      var parts = raw.split(" ");
      let user = bot.getUser(parts[2]);
      if (user) user.vhost = parts[3]; // user.vhost?
    }).on('CHGIDENT', (head, msg, from) => {
      let newIdent = head[2];
      let user = bot.getUser(head[1]);
      if (user) user.ident = newIdent;
    }).on('CHGNAME', (head, msg, from) => {
      let newRealname = msg.join(' ');
      let user = bot.getUser(head[1]);
      if (user) user.realname = newRealname;
    }).on('SJOIN', (head, msg, from) => {
      let ts = +head[1];
      let name = head[2];
      let modes = head[3];
      let usersList = msg.filter(Boolean).filter(a => !a.match(/^[&"']/)).map(a => a.replace(/^[~&@%\+\*]+/, ''));

      let channel = bot.getChannel(name);
      if (!channel) channel = bot._makeChannel(name, ts);
      else channel.ts = Math.min(channel.ts, ts);

      for (let user of usersList) {
        let userObj = bot.getUser(user);
        if (!userObj) continue;
        channel.users.set(user, '');
        userObj.channels.add(channel.name);
      }
    }).on('PART', (head, msg, from) => {
      let user = bot.getUser(from);
      let channel = bot.getChannel(head[1]);
      bot._handleChannelPart(channel, user);
    }).on('MD', (head, msg, from) => {
      let type = head[1];
      switch (type) {
        case 'client': {
          if (bot.isSID(head[2])) {
            let server = bot.getServer(head[2]);
            if (!server) return;
            server.metadata.set(head[3], msg.join(' '));
          } else {
            let user = bot.getUser(head[2]);
            if (!user) return;
            user.metadata.set(head[3], msg.join(' '));
          }
          break;
        }
        case 'channel': {
          let channel = bot.getChannel(head[2]);
          if (!channel) return;
          channel.metadata.set(head[3], msg.join(' '));
          break;
        }
        case 'member': {
          let channel = bot.getChannel(head[2]);
          if (!channel) return;
          if (!channel.member_metadata.has(head[3])) channel.member_metadata.set(head[3], new Map());
          channel.metadata_membership.get(head[3]).set(head[4], msg.join(' '));
          break;
        }
        case 'membership': {
          let user = bot.getUser(head[2]);
          if (!user) return;
          if (!user.metadata_membership.has(head[3])) user.metadata_membership.set(head[3], new Map());
          user.metadata_membership.get(head[3]).set(head[4], msg.join(' '));
          break;
        }
      }
    }).on('SASL', (head, msg, from) => {
      if (!bot.isTrustedServer(from)) {
        bot.send(`:${bot.client.sid} SASL ${from} ${head[2]} D F`);
      } // No tricks.
      let user = bot.getUser(head[2]);
      switch (head[3]) {
        case 'H': break; // User IP, we already know that and don't care
        case 'S': // Start SASL
          bot.send(`:${bot.client.sid} SASL ${from} ${head[2]} C +`);
          break;
        case 'C':
          if (user) {
            const [authz, authn, passwd] = Buffer.from(head[4], "base64").toString().split('\0');
            if (bot.config.userLogin[authz] && bot.config.userLogin[authz] === passwd) user.account = authz;
          } else {
            bot.server.preRegistrationSASL.set(head[2], {
              key: head[4],
              expires: bot.getTS() + 60 * 5
            });
          }
          bot.send(`:${bot.client.sid} SASL ${from} ${head[2]} D S`);
          break;
      }
    }).on("MOTD", (head, msg, from) => {
      let motd = bot.config.motd.split("\n");
      for (let line of motd) {
        bot.send(`372 ${from} :${line}`);
      }
    }).on('KICK',function(head,msg,from) {
      let user = bot.getUser(head[2]);
      let channel = bot.getChannel(head[1]);
      if (!user || !channel) return;
      bot._handleChannelPart(channel, user);
      if (user.server === bot.client.ownServer) setImmediate(() => bot.join(user.uid, channel.name));
    }).on('NICK',function(head,msg,from,raw) {
      let user = bot.getUser(from);
      let newNick = head[1];
      let ts = +msg[0];
      bot._handleNickChange(user, newNick, ts);
    }).on('QUIT',function(head,msg,from,raw) {
      let user = bot.getUser(from);
      if (user) bot._handleRemoveClient(user);
    }).on('KILL',function(head,msg,from,raw) {
      let user = bot.getUser(head[1]);
      if (!user) return;
      if (user.server === bot.client.ownServer) {
        let channels = [...user.channels];
        queueMicrotask(() => {
          let newuid = bot.addUser(user);
          if (user.uid === bot.client.botUser.uid) bot.client.botUser = bot.getUser(newuid);
          for (let channel of channels) bot.join(newuid, channel);
        });
      }
      bot._handleRemoveClient(user);
    }).on('TKL', (head, msg, from) => {
      let action = head[1]; // either + or -
      let type = head[2];
      let ident = head[3];
      let host = head[4];
      let source = head[5];
      let setTS = +head[7];
      let expireTS = +head[6];
      let reason = msg.join(' ');
      if (action === '+') {
        bot.server.tkl.set(`${type}/${ident}@${host}`, {
          type, ident, host, source, setTS, expireTS, reason
        });
      } else if (action === '-') {
        bot.server.tkl.delete(`${type}/${ident}@${host}`);
      }
    });
  }
};

module.exports = ircbot;
