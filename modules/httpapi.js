const express = require('express'); // lol
const childProcess = require('child_process');
const bodyParser = require('body-parser');
const moduleName = require('path').basename(__filename);

function dumbEscape(str) {
  // idk how to better do this
  return JSON.stringify(str).slice(1, -1);
}

module.exports = function load(bot) {
  let app = null;
  let oldModule = bot.config.modules[moduleName];
  if (oldModule && oldModule.app) app = oldModule.app;
  else {
    app = express();
    app.listen(8035);

    app.use('/', (req, res, next) => {
      let router = bot.config.modules[moduleName]?.router;
      if (!router) res.type('text/plain').status(404).send('oh no');
      router(req, res, next);
    });
  }
  let router = express.Router(); // eslint-disable-line new-cap

  function findLinks() {
    // let visited = new Set();
    let links = [];
    let toVisit = [];
    // graph root
    toVisit.push(bot.server.remoteServer);
    while (toVisit.length) {
      let current = toVisit.pop();
      // if (visited.has(current.sid)) continue;
      // visited.add(current.sid);
      for (let child of current.children) {
        // if (visited.has(link)) continue;
        links.push([current, child]);
        toVisit.push(child);
      }
    }
    return links;
  }
  function createGraphviz() {
    let g = `graph {`;
    let push = s => g += '\n  ' + s;

    for (let server of bot.server.servers.values()) {
      push(`"${server.sid}" [label = "${dumbEscape(server.name)} (${dumbEscape(server.sid)})\\n` +
                `${dumbEscape(server.description)}\\n${dumbEscape(server.version)}", id = "\\N"]`);
    }

    let links = findLinks();
    for (let [from, to] of links) {
      push(`"${from.sid}" -- "${to.sid}"`);
    }

    g += `\n}`;
    return g;
  }
  let GRAPH_FORMATS = new Set(['svg', 'png']);
  let GRAPH_RENDERERS = new Set(['dot', 'neato', 'circo', 'fdp', 'twopi']);
  const NETWORK_INFO = 'pissnet (https://letspiss.net/)';

  router.get('/', (_req, res) => {
    res.type('application/json').send(JSON.stringify({
      _hello: 'greetings from IoServ',
      _network: NETWORK_INFO,
      _complainTo: 'iczero',
      serversCount: bot.server.servers.size,
      clientsCount: bot.server.clients.size,
      endpoints: [
        'GET /graph/raw',
        'GET /graph/json',
        `GET /graph?format={${[...GRAPH_FORMATS].join()}}&renderer={${[...GRAPH_RENDERERS].join()}}`
      ]
    }, null, 2));
  });
  router.get('/graph/raw', (_req, res) => res.type('text/plain').send(createGraphviz()));
  router.get('/graph/json', (_req, res) => {
    let links = findLinks().map(([a, b]) => [a.sid, b.sid]);
    let nodes = {};
    for (let [sid, server] of bot.server.servers) {
      nodes[sid] = {
        name: server.name,
        description: server.description,
        version: server.version,
        clients: server.clients.size
      };
    }
    res.set('Access-Control-Allow-Origin', '*');
    res.send({ nodes, links });
  });
  router.get('/graph', (req, res) => {
    let format = req.query.format || 'svg';
    let renderer = req.query.renderer || 'neato';
    if (!GRAPH_FORMATS.has(format)) {
      res.type('text/plain').status(400).send(`unknown format: ${format}`);
      return;
    }
    if (!GRAPH_RENDERERS.has(renderer)) {
      res.type('text/plain').status(400).send(`unknown renderer: ${renderer}`);
      return;
    }
    res.type(format);
    let graphviz = childProcess.spawn('dot', ['-T' + format, '-Goverlap=prism', '-Gsplines=spline'], {
      argv0: renderer,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    graphviz.stdin.write(createGraphviz());
    graphviz.stdin.end();
    graphviz.stderr.pipe(res, { end: false });
    graphviz.stdout.pipe(res);
    let killTimeout = setTimeout(() => graphviz.kill(), 60 * 1000);
    graphviz.on('exit', () => clearTimeout(killTimeout));
    res.on('close', () => graphviz.kill());
    /* imagemagick uses too many resources
    if (format === 'png') {
        let im = childProcess.spawn('convert', ['-define', 'png:compression-filter=2', 'png:-', 'png:-']);
        graphviz.stdout.pipe(im.stdin);
        im.stdout.pipe(res);
        im.stderr.pipe(res, { end: false });
    } else {
        graphviz.stdout.pipe(res);
    }
    */
  });
  router.post('/login', bodyParser.urlencoded({ extended: false }), (req, res) => {
    let username = req.body.username;
    let key = req.body.key;
    let target = req.body.target;
    if (
      typeof username !== 'string' ||
      typeof key !== 'string' ||
      typeof target !== 'string'
    ) {
      res.status(400).send({ status: 'error', error: 'invalid parameter' });
    }

    let found = bot.config.userLogin[username];
    if (found && found === key) {
      let user = bot.getUser(target);
      if (user) user.account = username;
      res.send({ status: 'ok' });
    } else {
      res.send({ status: 'error', error: 'invalid key' });
    }
  });

  return { findLinks, createGraphviz, app, router };
};

