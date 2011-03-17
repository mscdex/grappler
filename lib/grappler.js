require.paths.unshift(__dirname);
var util = require('util'),
    http = require('http'),
    fs = require('fs'),
    EventEmitter = require('events').EventEmitter,
    common = require('common'),
    HttpClient;

// Dynamically generate the secret for securing HTTP cookies only once.
// We could keep from having to read in http.client.js twice every time
// if we just had some method to force require() to reload a single module
// from disk (only if HttpClient.cookieSecret == null).
var clientCode = fs.readFileSync(__dirname + '/http.client.js').toString();
if (clientCode.indexOf('.secret = null') > -1)
  fs.writeFileSync(__dirname + '/http.client.js', clientCode.replace('.secret = null', ".secret = '" + Math.floor(Math.random()*1e9).toString() + (new Date()).getTime().toString() + Math.floor(Math.random()*1e9).toString() + "'"));
HttpClient = require('http.client');

function noop() { return true; };
function noaction() { return false; };

function parseOrigins(allowedOrigins) {
  if (Array.isArray(allowedOrigins) && arguments.length === 1)
    return allowedOrigins.reduce(parseOrigins, []);
  else {
    var allowedHost = (arguments[1] ? arguments[1].split(':') : allowedOrigins.split(':')),
      allowedPort = (allowedHost.length === 2 ? allowedHost[1] : '*');
    allowedHost = allowedHost[0];
    return (arguments[1] ? allowedOrigins.concat([[allowedHost, allowedPort]]) : [[allowedHost, allowedPort]]);
  }
}

// When calling the Server() constructor, you must either give 1 or 3 arguments. Specify null for any callbacks you
// don't wish to handle or when you want to use the default behavior.
//
// fnHandleNormalHTTP(request, response) is a callback that gives the user a chance to handle any HTTP requests before
// they are assumed to be a "comet" request. If response is written to (i.e. headers are written), then the request will not
// continue to be handled by grappler.
//
// fnAcceptClient(stream) is a callback that determines if a given net.Stream is permitted to stay connected to the server,
// judging by the callback's return value. If a callback is not supplied, the default action is to accept all clients.
function Server(options/*, fnHandleNormalHTTP, fnAcceptClient*/) {
  EventEmitter.call(this);

  var logger;
  var cbAccept = (arguments[2] && typeof arguments[2] === 'function' ? arguments[2] : noop);
  var cbHandleHTTP = (arguments[1] && typeof arguments[1] === 'function' ? arguments[1] : noaction);
  var server;
  var self = this;

  this.options = common.extend({
    logger: noop, // function that receives debug messages of various kinds and passes in two arguments: the message and the
                  // debug level of the message (denoted by the common.LOG.* "constants")
    origins: '*:*', // which clients are allowed to connect? the port portion is only pertinent for HTTP clients
    pingInterval: 3000, // time in ms to ping the client for HTTP connections that need to do so
    storage: 'object' // use B+ Tree structure by default
  }, options || {});

  var Storage = require('./storage/storage.' + this.options.storage);
  var connections = this.connections = new Storage();

  this.options.origins = parseOrigins(this.options.origins);
  logger = this.options.logger;
  server = this._server = http.createServer();

  // Make sure our connection handler happens before the built-in one
  server.listeners('connection').unshift(function(socket) {
    var flashSocketTest = '';
    socket.on('data', function(chunk) {
      flashSocketTest += chunk;
      if (flashSocketTest.indexOf('<policy-file-request/>') === 0) {
        var allowedOrigins = self.options.origins.reduce(function(prev, cur) {
          return prev + '<allow-access-from domain="' + cur[0] + '" to-ports="' + cur[1] + '"/>';
        }, '');
        socket.end('<?xml version="1.0"?>\
                   <!DOCTYPE cross-domain-policy SYSTEM "http://www.adobe.com/xml/dtds/cross-domain-policy.dtd">\
                   <cross-domain-policy>' + allowedOrigins + '</cross-domain-policy>');
        socket.destroy();
      }
    });
    // Override http.Server's built-in socket timeout
    socket.setTimeout(0);

    socket.client = new Client(self, socket.remoteAddress);

    var fnClose = function() {
      if (typeof socket.isMarked === 'undefined') {
        var user = connections.get(socket.client._id);
        if (user)
          user.disconnect();
        socket.isMarked = true;
        logger('Server :: Connection closed: id == ' + socket.client._id, common.LOG.INFO);
      }
    };
    socket.on('close', fnClose);
    socket.on('end', fnClose);

    if (!cbAccept(socket)) {
      // The incoming connection was denied for one reason or another
      socket.destroy();
      logger('Server :: Incoming connection denied: id == ' + socket.client._id, common.LOG.INFO);
    } else {
      socket.client.state |= common.STATE.ACCEPTED;
      logger('Server :: Incoming connection accepted: id == ' + socket.client._id, common.LOG.INFO);
    }
  });

  server.on('request', function(req, res) {
    // Check if we have accepted the connection and have decided that this
    // is not a non-HTTP request
    if (req.connection.client.state & common.STATE.ACCEPTED) {
      req.connection.client.state |= common.STATE.PROTO_HTTP;
      req.connection.setTimeout(0);
      req.connection.removeAllListeners('timeout');
      req.connection.removeAllListeners('data');

      cbHandleHTTP(req, res);

      // Let grappler handle this request if it wasn't already handled by the callback
      if (!res._header)
        new HttpClient(req, res);
      else
        logger('Server :: HTTP connection handled by callback. id == ' + req.connection.client._id, common.LOG.INFO);
    }
  });

  server.on('upgrade', function(req, socket, head) {
    if (req.connection.client.state & common.STATE.ACCEPTED) {
      req.connection.setTimeout(0);
      req.connection.removeAllListeners('timeout');
      req.connection.removeAllListeners('data');

      cbHandleHTTP(req, socket);

      // Let grappler handle this request if it wasn't already handled by the callback
      if (req.connection.readyState === 'open')
        new HttpClient(req, socket, head);
      else
        logger('Server :: HTTP Upgrade request handled by callback. id == ' + req.connection.client._id, common.LOG.INFO);
    }
  });

  server.on('error', function(err) {
    self.emit('error', err);
  });

  this.shutdown = function() {
    server.close();
    connections.do(function(key, user) { user.disconnect(); });
  };
}
util.inherits(Server, EventEmitter);
exports.Server = Server;

Server.prototype.listen = function(port, host) {
  this._server.listen(port, host);
};

Server.prototype.broadcast = function(data, except) {
  this.connections.do(function(key, user) {
    if (!except || (key !== except && user !== except))
      user.write(data);
  });
};

function Client(srv, ip) {
  this._id = Math.floor(Math.random()*1e5).toString() + (new Date()).getTime().toString();
  this.state = common.STATE.TEMP;
  this.remoteAddress = ip;
  this.server = srv;
}
exports.Client = Client;